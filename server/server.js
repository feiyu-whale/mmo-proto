/* 浏览器 3D MMO 原型 · 服务端
 * 目标：跑通登录、位置同步、聊天
 * 依赖：仅 Node 内置模块 + ws（若不可用则降级为原生 websocket 实现）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8896;
const TICK_RATE = 20;                  // 20 次/秒下发
const TICK_MS = 1000 / TICK_RATE;
const MAX_PLAYERS = 64;
const WORLD = { w: 200, h: 200 };      // 世界边界（米）

// ---------- 极简 WebSocket 实现（RFC 6455，仅服务端帧） ----------
function wsAccept(key) {
  return crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

function encodeFrame(str, opcode = 0x1) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeFrames(state) {
  const out = [];
  let buf = state.buf;
  while (buf.length >= 2) {
    const b0 = buf[0], b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) break;
      len = buf.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (buf.length < 10) break;
      len = Number(buf.readBigUInt64BE(2)); off = 10;
    }
    const need = off + (masked ? 4 : 0) + len;
    if (buf.length < need) break;

    let payload;
    if (masked) {
      const mask = buf.slice(off, off + 4);
      payload = Buffer.alloc(len);
      for (let i = 0; i < len; i++) payload[i] = buf[off + 4 + i] ^ mask[i % 4];
    } else {
      payload = buf.slice(off, off + len);
    }
    buf = buf.slice(need);
    out.push({ opcode, fin, payload });
  }
  state.buf = buf;
  return out;
}

// ---------- 世界状态 ----------
const players = new Map();   // id -> {id,name,x,z,ry,hp,token,sock}
let nextId = 1;

function spawnPoint() {
  const a = Math.random() * Math.PI * 2;
  const r = 5 + Math.random() * 15;
  return { x: Math.cos(a) * r, z: Math.sin(a) * r };
}

// ---------- HTTP 服务（静态文件） ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png'
};

const root = path.join(__dirname, '..', 'client');

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = path.join(root, p);
  if (!fp.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }

  fs.readFile(fp, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    res.end(data);
  });
});

// ---------- WebSocket 升级 ----------
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  if (players.size >= MAX_PLAYERS) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    socket.destroy();
    return;
  }

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n'
  );
  socket.setNoDelay(true);

  const state = { buf: Buffer.alloc(0) };
  const player = {
    id: 0,
    name: '',
    x: 0, z: 0, ry: 0,
    hp: 100,
    maxHp: 100,
    sock: socket,
    alive: true,
    lastMove: 0,
    joined: false
  };

  const send = (obj) => {
    if (!player.alive) return;
    try { socket.write(encodeFrame(JSON.stringify(obj))); } catch (e) { player.alive = false; }
  };
  player.send = send;

  socket.on('data', chunk => {
    state.buf = Buffer.concat([state.buf, chunk]);
    for (const f of decodeFrames(state)) {
      if (f.opcode === 0x8) { player.alive = false; socket.end(); return; }
      if (f.opcode === 0x9) { socket.write(encodeFrame(f.payload.toString(), 0xA)); continue; }
      if (f.opcode !== 0x1) continue;
      let msg;
      try { msg = JSON.parse(f.payload.toString('utf8')); } catch (e) { continue; }
      handle(player, msg);
    }
  });

  const onClose = () => {
    player.alive = false;
    if (player.id) {
      players.delete(player.id);
      broadcast({ t: 'leave', id: player.id });
      log(`✖ ${player.name || '未登录'} 离开（在线 ${players.size}）`);
    }
  };
  socket.on('close', onClose);
  socket.on('error', onClose);
  socket.on('end', onClose);

  // 握手
  send({ t: 'hello', server: 'mmoproto', tick: TICK_RATE, world: WORLD });
});

// ---------- 消息处理 ----------
function handle(player, msg) {
  switch (msg.t) {
    case 'login': {
      if (player.joined) return;
      const name = String(msg.name || '').slice(0, 16).replace(/[<>&"']/g, '') || '无名者';
      player.id = nextId++;
      player.name = name;
      const sp = spawnPoint();
      player.x = sp.x; player.z = sp.z;
      player.ry = 0;
      player.joined = true;
      players.set(player.id, player);

      // 告诉新玩家他是谁 + 现有玩家列表
      player.send({
        t: 'welcome',
        id: player.id,
        name: player.name,
        x: player.x, z: player.z,
        players: [...players.values()].filter(p => p.id !== player.id).map(snap)
      });
      // 广播新玩家
      broadcast({ t: 'join', p: snap(player) }, player.id);
      log(`✔ ${name} 进入世界（在线 ${players.size}）`);
      break;
    }
    case 'move': {
      if (!player.joined) return;
      const x = Number(msg.x), z = Number(msg.z), ry = Number(msg.ry) || 0;
      if (!isFinite(x) || !isFinite(z)) return;
      // 反作弊：限速
      const now = Date.now();
      const dt = Math.max(0.001, (now - player.lastMove) / 1000);
      player.lastMove = now;
      const dx = x - player.x, dz = z - player.z;
      const dist = Math.hypot(dx, dz);
      const maxDist = 12 * Math.min(dt, 0.5);   // 最快 12 米/秒
      if (dist > maxDist + 0.5) {
        // 超速，拉回
        const k = (maxDist + 0.5) / dist;
        player.x += dx * k;
        player.z += dz * k;
      } else {
        player.x = x; player.z = z;
      }
      // 世界边界
      player.x = Math.max(-WORLD.w / 2, Math.min(WORLD.w / 2, player.x));
      player.z = Math.max(-WORLD.h / 2, Math.min(WORLD.h / 2, player.z));
      player.ry = ry;
      break;
    }
    case 'chat': {
      if (!player.joined) return;
      const text = String(msg.text || '').slice(0, 120);
      if (!text) return;
      broadcast({ t: 'chat', id: player.id, name: player.name, text });
      break;
    }
    case 'ping': {
      player.send({ t: 'pong', c: msg.c });
      break;
    }
  }
}

function snap(p) {
  return { id: p.id, name: p.name, x: +p.x.toFixed(2), z: +p.z.toFixed(2), ry: +p.ry.toFixed(2), hp: p.hp };
}

function broadcast(obj, exceptId) {
  const data = JSON.stringify(obj);
  for (const p of players.values()) {
    if (p.id === exceptId) continue;
    try { p.sock.write(encodeFrame(data)); } catch (e) { p.alive = false; }
  }
}

// ---------- 世界心跳 ----------
setInterval(() => {
  if (players.size === 0) return;
  const list = [...players.values()].map(snap);
  broadcast({ t: 'state', players: list });
}, TICK_MS);

// ---------- 日志 ----------
const t0 = Date.now();
function log(s) {
  const sec = ((Date.now() - t0) / 1000).toFixed(0).padStart(5);
  console.log(`[${sec}s] ${s}`);
}

server.listen(PORT, '0.0.0.0', () => {
  log(`🌍 3D MMO 原型服务端启动 http://0.0.0.0:${PORT}`);
  log(`   世界尺寸 ${WORLD.w}×${WORLD.h} 米 · 心跳 ${TICK_RATE}Hz · 上限 ${MAX_PLAYERS} 人`);
});
