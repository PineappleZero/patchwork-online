'use strict';

/*
 * Patchwork 联机服务端
 *
 * 设计要点：
 * - 零依赖：只用 Node 内置模块，避免校园网装不上包。
 * - WebSocket 用 Node 内置 http + crypto 手写握手（RFC 6455），
 *   只支持文本帧，够这款游戏用。
 * - 服务端权威：所有规则判定都在服务端完成，客户端只发意图。
 * - 房间制：4 位房间码，最多 2 人；断线可凭 token 重连。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const engine = require('./engine');
const { PATCHES, LEATHER, TIME_BOARD, LEATHER_SPACES, INCOME_SPACES, BOARD_SIZE, LAST_SPACE } = require('./data');

const PORT = Number(process.env.PORT || 3178);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/* ------------------------------------------------------------------ */
/* 极简 WebSocket 实现                                                  */
/* ------------------------------------------------------------------ */

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
}

/** 解析客户端发来的帧（仅处理文本帧，自动处理掩码与分片） */
function createFrameParser(onMessage, onClose) {
  let buffer = Buffer.alloc(0);
  let fragments = [];

  return function feed(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const first = buffer[0];
      const opcode = first & 0x0f;
      const fin = (first & 0x80) !== 0;
      const masked = (buffer[1] & 0x80) !== 0;
      let len = buffer[1] & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > 1048576n) { onClose(); return; } // 超过 1MB 直接断开
        len = Number(big);
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      if (buffer.length < offset + maskLen + len) return;

      const maskKey = masked ? buffer.slice(offset, offset + 4) : null;
      offset += maskLen;
      const payload = Buffer.from(buffer.slice(offset, offset + len));
      if (masked) {
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
      }
      buffer = buffer.slice(offset + len);

      if (opcode === 0x8) { onClose(); return; }
      if (opcode === 0x9) continue; // ping：本实现不做 pong，客户端会定期重连
      if (opcode === 0xa) continue; // pong

      if (opcode === 0x0) fragments.push(payload);
      else fragments = [payload];

      if (fin) {
        const text = Buffer.concat(fragments).toString('utf8');
        fragments = [];
        if (text.length) onMessage(text);
      }
    }
  };
}

function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x81; // FIN + text
  return Buffer.concat([header, payload]);
}

/* ------------------------------------------------------------------ */
/* 静态文件                                                            */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath).replace(/^([/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ */
/* 房间管理                                                            */
/* ------------------------------------------------------------------ */

const rooms = new Map();

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i += 1) code += alphabet[crypto.randomInt(alphabet.length)];
    if (!rooms.has(code)) return code;
  }
}

function makeToken() {
  return crypto.randomBytes(12).toString('hex');
}

function createRoom() {
  const code = makeRoomCode();
  const room = {
    code,
    state: null,
    seats: [null, null], // { name, token, socket, connected }
    rematchVotes: new Set(),
    history: [], // 对局事件流水，供中途加入的人回看
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function seatOfToken(room, token) {
  return room.seats.findIndex((s) => s && s.token === token);
}

/** 对外广播的视图：隐藏对手的私有信息（本作无隐藏信息，全部可见） */
function serialize(room) {
  const st = room.state;
  return {
    type: 'state',
    room: room.code,
    seats: room.seats.map((s) => (s ? { name: s.name, connected: s.connected } : null)),
    started: !!st,
    phase: st ? (engine.isGameOver(st) ? 'over' : 'playing') : 'waiting',
    neutral: st ? st.neutral : 0,
    circle: st ? st.circle : [],
    visible: st ? engine.visiblePatchIds(st) : [],
    active: st && !engine.isGameOver(st)
      ? (st.pendingLeather.length ? st.pendingLeather[0].player : engine.activePlayerIndex(st))
      : null,
    pendingLeather: st ? st.pendingLeather.map((x) => ({ player: x.player })) : [],
    leatherClaimed: st ? st.leatherClaimed : [],
    topPlayer: st ? st.topPlayer : 0,
    players: st ? st.players.map((p) => ({
      name: p.name,
      buttons: p.buttons,
      time: p.time,
      board: p.board,
      placed: p.placed,
      incomeIcons: p.incomeIcons,
      hasBonusTile: p.hasBonusTile,
      finished: p.finished,
      empty: engine.emptySpaces(p.board),
    })) : [],
    result: st && engine.isGameOver(st) ? engine.finalResult(st) : null,
    lastEvents: st ? st.lastEvents || [] : [],
    /** 对局事件流水（中途加入的人用它补齐日志） */
    history: room.history || [],
  };
}

function send(socket, payload) {
  if (!socket || socket.destroyed) return;
  try { socket.write(encodeFrame(JSON.stringify(payload))); } catch (e) { /* 忽略写失败 */ }
}

function broadcast(room) {
  const msg = serialize(room);
  room.seats.forEach((s) => { if (s && s.socket) send(s.socket, msg); });
}

/**
 * 定期清扫：把「标记为未连接」的座位真正释放掉，
 * 避免客户端异常掉线时座位被永久占住。
 * 尚未开局 → 立即释放；对局中 → 给 5 分钟重连窗口。
 */
const RELEASE_GRACE_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, code) => {
    let changed = false;
    room.seats.forEach((s, i) => {
      if (!s || s.connected || s.socket) return;
      if (!s.disconnectedAt) s.disconnectedAt = now;
      const since = now - s.disconnectedAt;
      if (!room.state) {
        // 还没开局：短暂等待后直接释放，方便刷新/换设备重新加入
        if (since > 1200) { room.seats[i] = null; changed = true; }
      } else if (since > RELEASE_GRACE_MS) {
        s.released = true; // 开局后超时未回，允许他人接管座位
        changed = true;
      } else {
        changed = true;
      }
    });
    if (room.seats.every((s) => s === null)) {
      rooms.delete(code);
      changed = false;
    }
    if (changed) broadcast(room);
  });
}, 600).unref();

function handleMessage(room, seatIndex, msg) {
  const st = room.state;
  if (msg.type === 'chat') {
    room.seats.forEach((s, i) => {
      if (s && s.socket) send(s.socket, { type: 'chat', from: i, name: s.name, text: String(msg.text).slice(0, 200) });
    });
    return;
  }
  if (!st) return;
  if (engine.isGameOver(st)) return;

  // 记录最近若干条对局事件，供中途加入/刷新的人回看
  const remember = (events, actor) => {
    (events || []).forEach((e) => {
      const item = Object.assign({}, e);
      if (item.player === undefined) item.player = actor;
      room.history.push(item);
    });
    if (room.history.length > 200) {
      room.history.splice(0, room.history.length - 200);
    }
  };

  try {
    // 有皮革补丁待放置时，只有该补丁的所有者可以操作（且必须操作）
    if (st.pendingLeather.length) {
      const owner = st.pendingLeather[0].player;
      if (msg.type !== 'leather') throw new Error('请先放置 1x1 皮革补丁');
      if (owner !== seatIndex) throw new Error('还没轮到你');
      engine.placeLeather(st, seatIndex, msg.row, msg.col);
      const ev = [{ type: 'leatherPlaced', row: msg.row, col: msg.col, player: seatIndex }];
      st.lastEvents = ev;
      remember(ev, seatIndex);
      broadcast(room);
      return;
    }

    if (msg.type === 'advance') {
      const pi = engine.activePlayerIndex(st);
      if (pi !== seatIndex) throw new Error('还没轮到你');
      const res = engine.advance(st, pi);
      st.lastEvents = res.events;
      remember(res.events, pi);
    } else if (msg.type === 'patch') {
      const pi = engine.activePlayerIndex(st);
      if (pi !== seatIndex) throw new Error('还没轮到你');
      const res = engine.buyPatch(st, pi, msg.patchId, msg.oriIndex, msg.row, msg.col);
      st.lastEvents = res.events;
      remember(res.events, pi);
    } else if (msg.type === 'rematch') {
      room.rematchVotes.add(seatIndex);
      if (room.rematchVotes.size >= 2) {
        room.state = engine.createGame(room.seats.map((s) => (s ? s.name : '玩家')));
        room.rematchVotes.clear();
        room.history = [];
      }
    } else {
      throw new Error('未知的操作');
    }
    broadcast(room);
  } catch (err) {
    send(room.seats[seatIndex] && room.seats[seatIndex].socket, { type: 'error', message: err.message });
  }
}

/* ------------------------------------------------------------------ */
/* HTTP + 升级                                                          */
/* ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  if (req.url.split('?')[0] === '/api/info') {
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    res.end(JSON.stringify({
      patches: PATCHES,
      leather: LEATHER,
      timeBoard: TIME_BOARD,
      leatherSpaces: LEATHER_SPACES,
      incomeSpaces: INCOME_SPACES,
      boardSize: BOARD_SIZE,
      lastSpace: LAST_SPACE,
      rooms: rooms.size,
    }));
    return;
  }
  serveStatic(req, res);
});

const upgradeHeaders = [];

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    '',
    '',
  ].join('\r\n'));

  socket.setNoDelay(true);
  let room = null;
  let seatIndex = -1;

  const cleanup = () => {
    if (room && seatIndex >= 0 && room.seats[seatIndex] && room.seats[seatIndex].socket === socket) {
      const seat = room.seats[seatIndex];
      seat.connected = false;
      seat.socket = null;
      seat.disconnectedAt = Date.now();
      broadcast(room);
    }
  };

  const parser = createFrameParser(
    (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch (e) { return; }

      if (msg.type === 'create') {
        room = createRoom();
        seatIndex = 0;
        room.seats[0] = {
          name: String(msg.name || '玩家一').slice(0, 12) || '玩家一',
          token: makeToken(),
          socket,
          connected: true,
        };
        send(socket, { type: 'joined', room: room.code, seat: 0, token: room.seats[0].token });
        broadcast(room);
        return;
      }

      if (msg.type === 'join') {
        const code = String(msg.room || '').toUpperCase();
        const target = rooms.get(code);
        if (!target) { send(socket, { type: 'error', message: '房间不存在' }); return; }

        // 1) 凭 token 重连自己的座位（对局中刷新页面也能回到原位）
        let seat = -1;
        if (msg.token) {
          seat = target.seats.findIndex((s) => s && s.token === msg.token);
        }
        // 2) 否则找空座位：真正为 null，或有人断线且座位已被标记释放
        if (seat < 0) {
          seat = target.seats.findIndex((s) => s === null || (s && !s.connected && s.released));
        }
        if (seat < 0) {
          send(socket, { type: 'error', message: '房间已满' });
          return;
        }

        room = target;
        seatIndex = seat;
        const prev = room.seats[seat];
        room.seats[seat] = {
          name: String(msg.name || (prev && prev.name) || (seat === 0 ? '玩家一' : '玩家二')).slice(0, 12),
          token: prev ? prev.token : makeToken(),
          socket,
          connected: true,
          released: false,
        };
        // 两人到齐且尚未开局则自动开局
        if (!room.state && room.seats.every((s) => s)) {
          room.state = engine.createGame(room.seats.map((s) => s.name));
        }
        send(socket, { type: 'joined', room: room.code, seat, token: room.seats[seat].token });
        broadcast(room);
        return;
      }

      if (!room) { send(socket, { type: 'error', message: '请先创建或加入房间' }); return; }

      // 主动让座：用于把座位腾给他人（演示与换设备场景）
      if (msg.type === 'release') {
        const s = room.seats[seatIndex];
        if (s) {
          s.connected = false;
          s.socket = null;
          s.released = true;
          broadcast(room);
        }
        return;
      }

      handleMessage(room, seatIndex, msg);
    },
    cleanup
  );

  socket.on('data', parser);
  socket.on('error', cleanup);
  socket.on('close', cleanup);
  socket.on('end', cleanup);
});

server.listen(PORT, '0.0.0.0', () => {
  const nets = require('os').networkInterfaces();
  const addrs = [];
  Object.keys(nets).forEach((name) => {
    (nets[name] || []).forEach((net) => {
      if (net.family === 'IPv4' && !net.internal) addrs.push({ name, address: net.address });
    });
  });

  // Windows 的 cmd 默认用 GBK(936) 解码，而 Node 输出的是 UTF-8 字节，中文会乱码。
  // 启动脚本里已经先执行过 chcp 65001，这里再确认一次，保证输出正确。
  ensureUtf8Console();

  const lines = [];
  lines.push('');
  lines.push('  拼布 Patchwork 联机服务已启动');
  lines.push('  ============================================');
  lines.push(`  你自己（本机）：  http://localhost:${PORT}`);
  addrs.forEach((a) => {
    lines.push(`  给朋友（局域网）：http://${a.address}:${PORT}   [${a.name}]`);
  });
  lines.push('  ============================================');
  lines.push('');
  lines.push('  怎么开局：');
  lines.push('    1. 你自己先用「本机」地址打开页面，点「创建房间」拿到 4 位房间码');
  lines.push('    2. 把上面那条「给朋友」的地址 + 房间码发给朋友');
  lines.push('    3. 朋友连同一个 WiFi 打开地址，填入房间码，点「加入房间」就开局了');
  lines.push('');
  lines.push('  朋友打不开？多半是系统防火墙拦了 Node，允许「专用网络」即可。');
  lines.push('  关掉这个黑窗口就等于关掉服务。');
  lines.push('');
  process.stdout.write(lines.join('\n') + '\n');
});

/** 让 Windows 控制台按 UTF-8 解码，中文才不会乱码。 */
function ensureUtf8Console() {
  if (process.platform !== 'win32') return;
  try {
    const { execSync } = require('child_process');
    execSync('chcp 65001', { stdio: 'ignore' });
  } catch (e) { /* 切不了就算了 */ }
}

// 单个连接出错不应拖垮整个服务
server.on('clientError', (err, socket) => {
  try { socket.destroy(); } catch (e) { /* 忽略 */ }
});

process.on('uncaughtException', (err) => {
  console.error('[未捕获异常] ' + err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[未处理的 Promise 拒绝] ' + (err && err.message ? err.message : err));
});

