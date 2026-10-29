/* 浏览器 3D MMO 原型 · 客户端
 * THREE.js 场景 + WebSocket 联机
 */
import * as THREE from 'three';

// ==================== 常量 ====================
const MOVE_SPEED = 6;          // 米/秒
const RUN_MULT = 1.9;
const WORLD_W = 200, WORLD_H = 200;
const SEND_HZ = 15;

// ==================== 状态 ====================
const S = {
  me: null,                    // { id, name, x, z, ry }
  players: new Map(),          // id -> { mesh, nameSprite, data, target }
  ws: null,
  keys: {},
  camYaw: 0,
  camPitch: 0.42,
  camDist: 12,
  running: false,
  chatting: false,
  lastSend: 0,
  ping: 0,
  clock: new THREE.Clock()
};

// ==================== 场景 ====================
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1220);
scene.fog = new THREE.Fog(0x0b1220, 60, 160);

const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.1, 500);

// 光照
const hemi = new THREE.HemisphereLight(0x9fc4ff, 0x1a2030, 1.05);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff0d0, 1.35);
sun.position.set(45, 70, 30);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -70;
sun.shadow.camera.right = 70;
sun.shadow.camera.top = 70;
sun.shadow.camera.bottom = -70;
sun.shadow.camera.far = 220;
scene.add(sun);

// 地面
const groundGeo = new THREE.PlaneGeometry(WORLD_W, WORLD_H, 50, 50);
const groundMat = new THREE.MeshStandardMaterial({ color: 0x2b3f2e, roughness: 0.95 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// 地面网格线
const grid = new THREE.GridHelper(WORLD_W, 50, 0x3d5a45, 0x33483a);
grid.position.y = 0.02;
scene.add(grid);

// 地形起伏（趣味性）
{
  const pos = groundGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const d = Math.hypot(x, y);
    if (d > 75) continue;
    const h = Math.sin(x * 0.06) * Math.cos(y * 0.05) * 1.3
      + Math.sin(x * 0.14 + 1.3) * 0.5;
    pos.setZ(i, h);
  }
  pos.needsUpdate = true;
  groundGeo.computeVertexNormals();
}

// 树 / 石头
function makeTree(x, z) {
  const g = new THREE.Group();
  const trunkH = 2.2 + Math.random() * 1.4;
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.32, trunkH, 7),
    new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 1 })
  );
  trunk.position.y = trunkH / 2;
  trunk.castShadow = true;
  g.add(trunk);

  const leafMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(0.29 + Math.random() * 0.06, 0.42, 0.22 + Math.random() * 0.1),
    roughness: 0.9
  });
  for (let i = 0; i < 3; i++) {
    const r = 1.5 - i * 0.34;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(r, 1.9, 7), leafMat);
    cone.position.y = trunkH + 0.5 + i * 1.05;
    cone.castShadow = true;
    g.add(cone);
  }
  g.position.set(x, 0, z);
  g.rotation.y = Math.random() * Math.PI * 2;
  return g;
}

function makeRock(x, z) {
  const s = 0.6 + Math.random() * 1.2;
  const m = new THREE.Mesh(
    new THREE.DodecahedronGeometry(s, 0),
    new THREE.MeshStandardMaterial({ color: 0x5a6270, roughness: 1, flatShading: true })
  );
  m.position.set(x, s * 0.45, z);
  m.rotation.set(Math.random(), Math.random(), Math.random());
  m.castShadow = true;
  return m;
}

for (let i = 0; i < 150; i++) {
  const a = Math.random() * Math.PI * 2;
  const r = 14 + Math.random() * 80;
  scene.add(makeTree(Math.cos(a) * r, Math.sin(a) * r));
}
for (let i = 0; i < 80; i++) {
  const a = Math.random() * Math.PI * 2;
  const r = 8 + Math.random() * 85;
  scene.add(makeRock(Math.cos(a) * r, Math.sin(a) * r));
}

// 中央方尖碑
{
  const ob = new THREE.Mesh(
    new THREE.ConeGeometry(2.4, 9, 4),
    new THREE.MeshStandardMaterial({ color: 0x6fa8ff, emissive: 0x1c3a70, roughness: 0.35, metalness: 0.6 })
  );
  ob.position.y = 4.5;
  ob.castShadow = true;
  scene.add(ob);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(5, 0.14, 8, 60),
    new THREE.MeshStandardMaterial({ color: 0x8fd8ff, emissive: 0x2a6fae, roughness: 0.3 })
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.5;
  scene.add(ring);
}

// ==================== 角色模型 ====================
const NAME_CACHE = new Map();

function makeNameSprite(text) {
  const cw = 256, ch = 64;
  const cv = document.createElement('canvas');
  cv.width = cw; cv.height = ch;
  const c = cv.getContext('2d');
  c.font = 'bold 34px "PingFang SC","Microsoft YaHei",sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.lineWidth = 6;
  c.strokeStyle = 'rgba(0,0,0,.72)';
  c.strokeText(text, cw / 2, ch / 2);
  c.fillStyle = '#a8e8ff';
  c.fillText(text, cw / 2, ch / 2);

  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(2.4, 0.6, 1);
  sp.position.y = 2.85;
  sp.renderOrder = 999;
  return sp;
}

function makeAvatar(color) {
  const g = new THREE.Group();

  // 身体
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.42, 0.85, 6, 12),
    new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.08 })
  );
  body.position.y = 1.02;
  body.castShadow = true;
  g.add(body);

  // 头
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.36, 18, 14),
    new THREE.MeshStandardMaterial({ color: 0xf2d8b8, roughness: 0.8 })
  );
  head.position.y = 1.85;
  head.castShadow = true;
  g.add(head);

  // 朝向指示（鼻子）
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.1, 0.24, 6),
    new THREE.MeshStandardMaterial({ color: 0xffffff })
  );
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 1.85, 0.34);
  g.add(nose);

  // 腿
  const legMat = new THREE.MeshStandardMaterial({ color: 0x2a3550, roughness: 0.9 });
  [-0.17, 0.17].forEach(x => {
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 0.42, 4, 8), legMat);
    leg.position.set(x, 0.34, 0);
    leg.castShadow = true;
    g.add(leg);
  });

  // 脚下光圈
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.52, 0.66, 28),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  g.add(ring);
  g.userData.ring = ring;

  return g;
}

function colorFromId(id) {
  const h = (id * 137.508) % 360;
  return new THREE.Color().setHSL(h / 360, 0.62, 0.58);
}

const MY_COLOR = new THREE.Color(0x5aa8ff);

// ==================== 玩家管理 ====================
function addPlayer(data, isMe) {
  const avatar = makeAvatar(isMe ? MY_COLOR : colorFromId(data.id));
  avatar.position.set(data.x, 0, data.z);
  avatar.rotation.y = data.ry || 0;
  scene.add(avatar);

  const nameTag = makeNameSprite(isMe ? data.name + '（你）' : data.name);
  avatar.add(nameTag);

  S.players.set(data.id, {
    mesh: avatar,
    nameSprite: nameTag,
    data: { x: data.x, z: data.z, ry: data.ry || 0 },
    target: { x: data.x, z: data.z, ry: data.ry || 0 },
    isMe
  });

  if (isMe) S.me = { id: data.id, name: data.name, x: data.x, z: data.z, ry: data.ry || 0 };
}

function removePlayer(id) {
  const p = S.players.get(id);
  if (!p) return;
  scene.remove(p.mesh);
  p.mesh.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (o.material.map) o.material.map.dispose();
      o.material.dispose();
    }
  });
  S.players.delete(id);
}

// ==================== 网络 ====================
function connect(name) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws`;
  setConn('连接中…', '');

  let ws;
  try { ws = new WebSocket(url); } catch (e) { setConn('连接失败', 'bad'); return; }
  S.ws = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify({ t: 'login', name }));
    setConn('已连接', 'ok');
  };

  ws.onmessage = ev => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    onMessage(m);
  };

  ws.onclose = () => {
    setConn('已断开', 'bad');
    addChat('sys', '与服务器断开连接');
  };
  ws.onerror = () => setConn('连接错误', 'bad');
}

function onMessage(m) {
  switch (m.t) {
    case 'hello': break;

    case 'welcome': {
      addPlayer({ id: m.id, name: m.name, x: m.x, z: m.z, ry: 0 }, true);
      for (const p of m.players) if (!S.players.has(p.id)) addPlayer(p, false);
      document.getElementById('login').style.display = 'none';
      document.getElementById('hud').classList.add('on');
      addChat('sys', `欢迎进入世界，${m.name}！`);
      break;
    }
    case 'join': {
      if (!S.players.has(m.p.id)) {
        addPlayer(m.p, false);
        addChat('sys', `${m.p.name} 进入了世界`);
        refreshOnline();
      }
      break;
    }
    case 'leave': {
      const p = S.players.get(m.id);
      if (p && !p.isMe) {
        addChat('sys', `${p.data.name || '某人'} 离开了世界`);
        removePlayer(m.id);
        refreshOnline();
      }
      break;
    }
    case 'state': {
      for (const p of m.players) {
        if (p.id === S.me?.id) continue;
        const local = S.players.get(p.id);
        if (!local) { addPlayer(p, false); continue; }
        local.target.x = p.x;
        local.target.z = p.z;
        local.target.ry = p.ry;
      }
      refreshOnline();
      break;
    }
    case 'chat': {
      addChat('msg', `<span class="who">${esc(m.name)}：</span>${esc(m.text)}`);
      break;
    }
    case 'pong': {
      S.ping = Math.round(performance.now() - m.c);
      break;
    }
  }
}

function send(obj) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj));
}

// ==================== 输入 ====================
addEventListener('keydown', e => {
  if (S.chatting) return;
  S.keys[e.code] = true;
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') S.running = true;
  if (e.code === 'Enter' && S.me) { openChat(); e.preventDefault(); }
  if (['KeyW','KeyA','KeyS','KeyD','Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', e => {
  S.keys[e.code] = false;
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') S.running = false;
});

// 鼠标视角
let dragging = false, lastX = 0, lastY = 0;
renderer.domElement.addEventListener('mousedown', e => {
  if (S.chatting) return;
  dragging = true; lastX = e.clientX; lastY = e.clientY;
});
addEventListener('mouseup', () => dragging = false);
addEventListener('mousemove', e => {
  if (!dragging) return;
  const dx = e.clientX - lastX, dy = e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  S.camYaw -= dx * 0.005;
  S.camPitch = clamp(S.camPitch + dy * 0.004, 0.06, 1.25);
});
addEventListener('wheel', e => {
  S.camDist = clamp(S.camDist + e.deltaY * 0.012, 5, 34);
}, { passive: true });

// 触屏
let touchId = null, tLastX = 0, tLastY = 0;
renderer.domElement.addEventListener('touchstart', e => {
  const t = e.changedTouches[0];
  touchId = t.identifier; tLastX = t.clientX; tLastY = t.clientY;
}, { passive: true });
renderer.domElement.addEventListener('touchmove', e => {
  const t = Array.from(e.changedTouches).find(x => x.identifier === touchId);
  if (!t) return;
  const dx = t.clientX - tLastX, dy = t.clientY - tLastY;
  tLastX = t.clientX; tLastY = t.clientY;
  S.camYaw -= dx * 0.006;
  S.camPitch = clamp(S.camPitch + dy * 0.005, 0.06, 1.25);
}, { passive: true });
renderer.domElement.addEventListener('touchend', () => touchId = null);

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

// ==================== 聊天 ====================
const chatbox = document.getElementById('chatbox');
const chatIn = document.getElementById('chatIn');

function addChat(type, html) {
  const d = document.createElement('div');
  if (type === 'sys') d.className = 'sys';
  d.innerHTML = html;
  chatbox.appendChild(d);
  while (chatbox.children.length > 40) chatbox.removeChild(chatbox.firstChild);
  chatbox.scrollTop = chatbox.scrollHeight;
}

function openChat() {
  S.chatting = true;
  chatIn.classList.add('on');
  chatIn.value = '';
  chatIn.focus();
}

function closeChat() {
  S.chatting = false;
  chatIn.classList.remove('on');
  chatIn.blur();
  chatIn.value = '';
}

chatIn.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const v = chatIn.value.trim();
    if (v) send({ t: 'chat', text: v });
    closeChat();
    e.preventDefault();
  } else if (e.key === 'Escape') {
    closeChat();
    e.preventDefault();
  }
  e.stopPropagation();
});

// ==================== UI ====================
function setConn(text, cls) {
  const el = document.getElementById('conn');
  el.textContent = text;
  el.className = cls;
}
function refreshOnline() {
  document.getElementById('iOnline').textContent = S.players.size;
}
function esc(s) {
  return String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

document.getElementById('go').onclick = () => {
  const n = document.getElementById('name').value.trim() || '旅人';
  document.getElementById('loading').classList.add('on');
  connect(n);
  setTimeout(() => document.getElementById('loading').classList.remove('on'), 1200);
};
document.getElementById('name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('go').click();
});

// ==================== 主循环 ====================
function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

let lastPing = 0;

function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(S.clock.getDelta(), 0.1);
  const t = performance.now();

  // ---- 本地移动 ----
  const me = S.players.get(S.me?.id);
  if (me && !S.chatting) {
    let mx = 0, mz = 0;
    if (S.keys['KeyW'] || S.keys['ArrowUp']) mz -= 1;
    if (S.keys['KeyS'] || S.keys['ArrowDown']) mz += 1;
    if (S.keys['KeyA'] || S.keys['ArrowLeft']) mx -= 1;
    if (S.keys['KeyD'] || S.keys['ArrowRight']) mx += 1;

    if (mx || mz) {
      const len = Math.hypot(mx, mz);
      mx /= len; mz /= len;
      // 相对相机朝向
      const cy = S.camYaw;
      const wx = mx * Math.cos(cy) - mz * Math.sin(cy);
      const wz = mx * Math.sin(cy) + mz * Math.cos(cy);

      const spd = MOVE_SPEED * (S.running ? RUN_MULT : 1);
      me.target.x = clamp(me.target.x + wx * spd * dt, -WORLD_W / 2 + 2, WORLD_W / 2 - 2);
      me.target.z = clamp(me.target.z + wz * spd * dt, -WORLD_H / 2 + 2, WORLD_H / 2 - 2);
      me.target.ry = Math.atan2(wx, wz);

      // 腿部动画（简单上下浮动）
      me.mesh.position.y = Math.abs(Math.sin(t * 0.012 * (S.running ? 1.6 : 1))) * 0.08;
    } else {
      me.mesh.position.y *= 0.85;
    }

    // 发送位置
    if (t - S.lastSend > 1000 / SEND_HZ) {
      S.lastSend = t;
      S.me.x = me.target.x; S.me.z = me.target.z;
      send({ t: 'move', x: +me.target.x.toFixed(2), z: +me.target.z.toFixed(2), ry: +me.target.ry.toFixed(2) });
    }

    // 心跳
    if (t - lastPing > 2000) {
      lastPing = t;
      send({ t: 'ping', c: performance.now() });
    }
  }

  // ---- 插值所有玩家 ----
  for (const p of S.players.values()) {
    const k = p.isMe ? 0.5 : 0.22;
    p.data.x += (p.target.x - p.data.x) * k;
    p.data.z += (p.target.z - p.data.z) * k;

    // 角度插值
    let dr = p.target.ry - p.data.ry;
    while (dr > Math.PI) dr -= Math.PI * 2;
    while (dr < -Math.PI) dr += Math.PI * 2;
    p.data.ry += dr * 0.25;

    p.mesh.position.x = p.data.x;
    p.mesh.position.z = p.data.z;
    p.mesh.rotation.y = p.data.ry;

    if (p.mesh.userData.ring) {
      p.mesh.userData.ring.material.opacity = 0.35 + Math.sin(t * 0.003) * 0.12;
    }
  }

  // ---- 相机跟随 ----
  if (me) {
    const cx = me.data.x, cz = me.data.z;
    const dist = S.camDist;
    const h = Math.sin(S.camPitch) * dist;
    const r = Math.cos(S.camPitch) * dist;
    const camX = cx + Math.sin(S.camYaw) * r;
    const camZ = cz + Math.cos(S.camYaw) * r;
    camera.position.lerp(new THREE.Vector3(camX, h + 1.2, camZ), 0.16);
    camera.lookAt(cx, 1.3, cz);

    // HUD
    document.getElementById('iPos').textContent =
      `${me.data.x.toFixed(1)}, ${me.data.z.toFixed(1)}`;
    document.getElementById('iPing').textContent = S.ping ? S.ping + ' ms' : '-';
  }

  renderer.render(scene, camera);
}

loop();
