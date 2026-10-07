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
const ai = require('./ai');
const tourney = require('./tourney');
const { PATCHES, LEATHER, TIME_BOARD, LEATHER_SPACES, INCOME_SPACES, BOARD_SIZE, LAST_SPACE, VARIANTS, CHAOS_EVENTS } = require('./data');

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

/*
 * 三种模式：
 *   solo   人机对战   —— 1 个连接槽，对局 2 人（第 2 位是电脑）
 *   local  同机双人   —— 1 个连接槽，对局 2 人（热座，同一台设备轮流操作）
 *   online 联机对战   —— N 个连接槽，对局 N 人（2~6 人），坐满自动开局，房主也能提前开
 *
 * slots    = 连接槽数量（能连几台设备）
 * capacity = 对局里有多少位玩家
 * 这两个在联机模式下相等，在单机模式下 slots=1 / capacity=2。
 */
const MODES = {
  solo: { slots: 1, capacity: 2, local: false, botSeats: [1], label: '人机对战' },
  local: { slots: 1, capacity: 2, local: true, botSeats: [], label: '同机双人' },
  online: { slots: null, capacity: null, local: false, botSeats: [], label: '联机对战' },
};
const MIN_ONLINE = 2;
const MAX_ONLINE = 6;
/** 电脑思考多久再落子，太快要看不清它在干什么 */
const BOT_DELAY_MS = Number(process.env.PATCHWORK_BOT_DELAY || 750);

/**
 * 本机在局域网里的 IPv4 地址（排除回环）。
 * 启动横幅和主菜单都要用同一份，抽出来避免两处各写一遍。
 */
function lanAddresses() {
  const nets = require('os').networkInterfaces();
  const out = [];
  Object.keys(nets).forEach((name) => {
    (nets[name] || []).forEach((net) => {
      if (net.family === 'IPv4' && !net.internal) out.push({ name, address: net.address });
    });
  });
  return out;
}

/** 局域网可访问的完整地址，给朋友用 */
function lanUrls() {
  return lanAddresses().map((a) => `http://${a.address}:${PORT}`);
}

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

function cleanName(v, fallback) {
  const s = String(v == null ? '' : v).trim().slice(0, 12);
  return s || fallback;
}

function createRoom(opts) {
  const mode = MODES[opts.mode] ? opts.mode : 'online';
  const def = MODES[mode];
  const capacity = mode === 'online'
    ? Math.max(MIN_ONLINE, Math.min(MAX_ONLINE, Number(opts.capacity) || MIN_ONLINE))
    : def.capacity;
  const room = {
    code: makeRoomCode(),
    mode,
    // 规则变体：'classic' 原版 / 'chaos' 魔改。和 mode 是两条互相独立的轴，
    // 所以「魔改版的人机」「魔改版的联机」都只是换这一个字段。
    variant: VARIANTS[opts.variant] ? opts.variant : 'classic',
    capacity,
    local: def.local,
    slots: mode === 'online' ? capacity : def.slots,
    state: null,
    seats: [],
    playerNames: [],
    localNames: [],
    botSeats: new Set(def.botSeats),
    botLevel: ai.normalizeLevel(opts.level),
    botTimer: null,
    rematchVotes: new Set(),
    history: [], // 对局事件流水，供中途加入的人回看
    cursors: {}, // 各座位「正在考虑放哪」的实时预览，只转发不落库
    createdAt: Date.now(),
  };
  room.seats = new Array(room.slots).fill(null);
  rooms.set(room.code, room);
  return room;
}

function seatOfToken(room, token) {
  return room.seats.findIndex((s) => s && s.token === token);
}

function joinedCount(room) {
  return room.seats.filter(Boolean).length;
}

/** 按下单机/联机规则凑出对局里的玩家名单，然后开局 */
function startGame(room) {
  room.seats = room.seats.filter(Boolean);
  const list = [];
  for (let i = 0; i < room.capacity; i += 1) {
    if (room.botSeats.has(i)) {
      list.push({ name: ai.botName(room.botLevel), bot: true });
    } else if (room.local) {
      list.push({ name: cleanName(i === 0 ? room.localNames[0] : room.localNames[i], `玩家${i + 1}`) });
    } else {
      list.push({ name: (room.seats[i] && room.seats[i].name) || `玩家${i + 1}` });
    }
  }
  room.playerNames = list.map((x) => x.name);
  room.state = engine.createGame(list, Math.random, { variant: room.variant });
  room.history = [];
  room.rematchVotes.clear();
  room.cursors = {};
  room.botTimer = null;
}

/** 终局后重开一局：人数、名字、电脑座位都保持不变 */
function newRound(room) {
  const wasBot = new Set(room.botSeats);
  room.botSeats = wasBot;
  room.state = engine.createGame(
    room.playerNames.map((n, i) => ({ name: n, bot: wasBot.has(i) })),
    Math.random,
    { variant: room.variant },
  );
  room.history = [];
  room.rematchVotes.clear();
  room.cursors = {};
}

/**
 * 把某个座位的实时预览转发给同房间的其他人。
 * 刻意不走 broadcast：这东西每几十毫秒就可能变一次，
 * 走整包 state 会让所有人的界面跟着重绘，得不偿失。
 */
function relayCursor(room, fromSeat, payload) {
  room.seats.forEach((s, i) => {
    if (!s || !s.socket || i === fromSeat) return;
    send(s.socket, Object.assign({ type: 'cursor', seat: fromSeat }, payload));
  });
}

/** 某个座位动作已落定 / 掉线了，把他留在别人屏幕上的幽灵预览擦掉 */
function clearCursor(room, seat) {
  if (!room.cursors || !room.cursors[seat]) return;
  room.cursors[seat] = null;
  relayCursor(room, seat, { patchId: null });
}

/** 对外广播的视图：隐藏对手的私有信息（本作无隐藏信息，全部可见） */
function serialize(room) {
  const st = room.state;
  const over = st ? engine.isGameOver(st) : false;
  return {
    type: 'state',
    room: room.code,
    mode: room.mode,
    variant: room.variant,
    local: room.local,
    capacity: room.capacity,
    slots: room.slots,
    started: !!st,
    phase: st ? (over ? 'over' : 'playing') : 'waiting',
    full: joinedCount(room) >= room.slots,
    canStart: room.mode === 'online' && !st && joinedCount(room) >= MIN_ONLINE,
    seats: room.seats.map((s, i) => (s
      ? { name: s.name, connected: s.connected, host: i === 0, bot: room.botSeats.has(i),
          level: room.botSeats.has(i) ? room.botLevel : null }
      : null)),
    playerNames: room.playerNames,
    botLevel: room.botLevel,
    neutral: st ? st.neutral : 0,
    circle: st ? st.circle : [],
    visible: st ? engine.visiblePatchIds(st) : [],
    active: st && !over ? engine.currentPlayerIndex(st) : null,
    pendingLeather: st ? st.pendingLeather.map((x) => ({ player: x.player })) : [],
    leatherClaimed: st ? st.leatherClaimed : [],
    rematchVotes: room.rematchVotes.size,
    players: st ? st.players.map((p) => ({
      index: p.index,
      name: p.name,
      bot: p.bot,
      level: p.bot ? room.botLevel : null,   // 电脑席位的难度，供界面挂徽章
      buttons: p.buttons,
      time: p.time,
      board: p.board,
      placed: p.placed,
      incomeIcons: p.incomeIcons,
      hasBonusTile: p.hasBonusTile,
      finished: p.finished,
      empty: engine.emptySpaces(p.board),
    })) : [],
    bonusTileOwner: st ? st.bonusTileOwner : null,
    /** 这一局生效的规则（经典/魔改的数值全在这儿，前端照着渲染「魔改」标记与混沌格） */
    rules: st ? st.rules : null,
    result: st && over ? engine.finalResult(st) : null,
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
 * 定期清扫：
 * 1) 把「标记为未连接」的座位处理掉 —— 还没开局就直接释放，开局中给 5 分钟重连窗口。
 * 2) 整个房间一个人都不剩时按 TTL 回收。
 *    这一步是必须的：开局后的座位永远不会变成 null，
 *    只看「座位是否全空」的话死房间会一直堆在内存里。
 */
const RELEASE_GRACE_MS = 5 * 60 * 1000;
const ROOM_TTL_ONLINE_MS = 20 * 60 * 1000; // 联机局全离线后还留 20 分钟等重连
const ROOM_TTL_SOLO_MS = 90 * 1000;        // 单机房没人了就尽快回收（本来就没人能加进来）
const ROOM_TTL_IDLE_MS = 1500;             // 压根没开局的空房

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
      }
    });

    const alive = room.seats.some((s) => s && (s.connected || s.socket));
    if (!alive) {
      if (!room.emptySince) { room.emptySince = now; changed = true; }
      const ttl = room.state
        ? (room.mode === 'online' ? ROOM_TTL_ONLINE_MS : ROOM_TTL_SOLO_MS)
        : ROOM_TTL_IDLE_MS;
      if (now - room.emptySince > ttl) {
        if (room.botTimer) clearTimeout(room.botTimer);
        rooms.delete(code);
        return;
      }
    } else if (room.emptySince) {
      room.emptySince = 0;
    }

    if (room.seats.every((s) => s === null)) {
      if (room.botTimer) clearTimeout(room.botTimer);
      rooms.delete(code);
      return;
    }
    if (changed) broadcast(room);
  });
}, 600).unref();

/** 记录对局事件流水，供中途加入/刷新的人回看 */
function remember(room, events, actor) {
  (events || []).forEach((e) => {
    const item = Object.assign({}, e);
    if (item.player === undefined) item.player = actor;
    room.history.push(item);
  });
  if (room.history.length > 300) {
    room.history.splice(0, room.history.length - 300);
  }
}

/** 这个连接现在能替哪些对局座位操作 */
function controlledSeats(room, connIndex) {
  // 同机双人：一台设备控制全部座位，轮到谁就替谁操作
  if (room.local) return room.state.players.map((p) => p.index);
  return [connIndex];
}

/* ------------------------- 电脑对手 ------------------------- */

function maybeRunBot(room) {
  if (!room.botSeats.size) return;
  const st = room.state;
  if (!st || engine.isGameOver(st)) return;
  if (room.botTimer) return;
  const seat = engine.currentPlayerIndex(st);
  if (!room.botSeats.has(seat)) return;
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    runBot(room);
  }, BOT_DELAY_MS);
  if (room.botTimer.unref) room.botTimer.unref();
}

function runBot(room) {
  const st = room.state;
  if (!st || engine.isGameOver(st)) return;
  const seat = engine.currentPlayerIndex(st);
  if (!room.botSeats.has(seat)) return;
  try {
    let events = [];
    if (st.pendingLeather.length) {
      const cell = ai.chooseLeatherCell(st, seat, room.botLevel);
      if (!cell) {
        // 板子已填满，这枚皮革无处可放 —— 让引擎把它作废（legalActions 会 shift 掉），
        // 然后当作普通回合继续，绝不能直接 return（那样 bot 循环会停摆）。
        engine.legalActions(st);
      } else {
        engine.placeLeather(st, seat, cell.row, cell.col);
        events = [{ type: 'leatherPlaced', row: cell.row, col: cell.col, player: seat }];
      }
    }
    if (!st.pendingLeather.length) {
      const action = ai.chooseAction(st, seat, room.botLevel);
      if (!action) { broadcast(room); maybeRunBot(room); return; }
      events = action.type === 'advance'
        ? engine.advance(st, seat).events
        : engine.buyPatch(st, seat, action.patchId, action.oriIndex, action.row, action.col).events;
    }
    st.lastEvents = events;
    remember(room, events, seat);
  } catch (err) {
    // 电脑偶尔挑到算不出的局面，直接跳过这一手，别把房间搞崩
    try {
      st.lastEvents = engine.advance(st, seat).events;
    } catch (e) { return; }
  }
  broadcast(room);
  maybeRunBot(room);
}

/* ------------------------- 消息处理 ------------------------- */

function handleMessage(room, connIndex, msg) {
  const st = room.state;
  if (msg.type === 'chat') {
    room.seats.forEach((s, i) => {
      if (s && s.socket) send(s.socket, { type: 'chat', from: i, name: s.name, text: String(msg.text).slice(0, 200) });
    });
    return;
  }

  // 联机房间：房主提前开局
  if (msg.type === 'start') {
    if (room.mode !== 'online') return;
    if (room.state) return;
    if (connIndex !== 0) { send(room.seats[connIndex] && room.seats[connIndex].socket, { type: 'error', message: '只有房主能开始' }); return; }
    if (joinedCount(room) < MIN_ONLINE) { send(room.seats[connIndex].socket, { type: 'error', message: `至少 ${MIN_ONLINE} 人才能开始` }); return; }
    room.capacity = joinedCount(room);
    startGame(room);
    broadcast(room);
    return;
  }

  if (!st) return;

  // 实时预览：只是「我正在考虑把哪块补丁放到哪」，不改变任何局面。
  // 直接转发给同房间其他座位，让大家能看到对手正在琢磨什么。
  if (msg.type === 'cursor') {
    if (room.mode !== 'online') return;
    const payload = msg.patchId ? {
      patchId: String(msg.patchId).slice(0, 4),
      oriIndex: Number(msg.oriIndex) | 0,
      row: Number.isInteger(msg.row) ? msg.row : null,
      col: Number.isInteger(msg.col) ? msg.col : null,
    } : { patchId: null };
    room.cursors[connIndex] = payload;
    relayCursor(room, connIndex, payload);
    return;
  }

  // 「再来一局」必须在「已结束」判断**之前**处理 ——
  // 它本来就是终局后才点的，放在后面等于永远走不到（v1.1 的 bug）。
  if (msg.type === 'rematch') {
    startRematch(room, connIndex);
    return;
  }

  if (engine.isGameOver(st)) return;

  try {
    // 现在该谁动手：有待放置皮革就是皮革主人，否则是时间最落后的那位
    const want = engine.currentPlayerIndex(st);
    if (!controlledSeats(room, connIndex).includes(want)) throw new Error('还没轮到你');

    if (st.pendingLeather.length) {
      if (msg.type !== 'leather') throw new Error('请先放置 1x1 皮革补丁');
      engine.placeLeather(st, want, msg.row, msg.col);
      const ev = [{ type: 'leatherPlaced', row: msg.row, col: msg.col, player: want }];
      st.lastEvents = ev;
      remember(room, ev, want);
      clearCursor(room, want);
      broadcast(room);
      maybeRunBot(room);
      return;
    }

    if (msg.type === 'advance') {
      const res = engine.advance(st, want);
      st.lastEvents = res.events;
      remember(room, res.events, want);
    } else if (msg.type === 'patch') {
      const res = engine.buyPatch(st, want, msg.patchId, msg.oriIndex, msg.row, msg.col);
      st.lastEvents = res.events;
      remember(room, res.events, want);
    } else {
      throw new Error('未知的操作');
    }
    clearCursor(room, want);
    broadcast(room);
    maybeRunBot(room);
  } catch (err) {
    send(room.seats[connIndex] && room.seats[connIndex].socket, { type: 'error', message: err.message });
  }
}

/**
 * 终局后大家都要投「再来一局」，凑齐才算数。
 * 票数门槛是「有人的座位数」，不再写死 2。
 */
function startRematch(room, connIndex) {
  if (!room.state || !engine.isGameOver(room.state)) {
    send(room.seats[connIndex] && room.seats[connIndex].socket, { type: 'error', message: '这局还没结束' });
    return;
  }
  room.rematchVotes.add(connIndex);
  const needed = joinedCount(room);
  if (room.rematchVotes.size < needed) {
    broadcast(room);
    return;
  }
  room.rematchVotes.clear();
  newRound(room);
  broadcast(room);
  maybeRunBot(room);
}

/* ------------------------------------------------------------------ */
/* HTTP + 升级                                                          */
/* ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  // 服务端权威锦标赛（v1.7.3）：/api/tw/* 交给独立模块
  tourney.handle(req, res, req.url.split('?')[0]).then((handled) => {
    if (handled) return;
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
      // 两种规则变体的数值：主菜单的「魔改版」卡片直接照着它写说明，
      // 规则弹层也不用再抄一遍数字。
      variants: VARIANTS,
      chaosEvents: CHAOS_EVENTS,
      defaultVariant: 'classic',
      rooms: rooms.size,
      port: PORT,
      localUrl: `http://localhost:${PORT}`,
      // 局域网地址：主菜单直接显示出来，省得让用户回那个黑窗口里找
      netUrls: lanUrls(),
    }));
    return;
  }
  serveStatic(req, res);
  });
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
      clearCursor(room, seatIndex);
      broadcast(room);
    }
  };

  const parser = createFrameParser(
    (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch (e) { return; }

      if (msg.type === 'create') {
        room = createRoom({ mode: msg.mode, capacity: msg.capacity, level: msg.level, variant: msg.variant });
        seatIndex = 0;
        const name = cleanName(msg.name, '玩家一');
        room.seats[0] = { name, token: makeToken(), socket, connected: true };
        send(socket, {
          type: 'joined', room: room.code, seat: 0,
          token: room.seats[0].token, mode: room.mode, local: room.local,
          variant: room.variant,
        });
        if (room.mode !== 'online') {
          // 单机两种模式：建完房直接开局，不用等人
          room.localNames = [
            name,
            cleanName(msg.name2, room.mode === 'local' ? '玩家二' : 'wzzzhhhhh'),
          ];
          startGame(room);
        }
        broadcast(room);
        maybeRunBot(room);
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
        // 单机房间平时不接受新玩家，但**凭 token 回来接着打**要放行，
        // 否则刷新一下页面这局就没了。
        if (target.mode !== 'online' && seat < 0) {
          send(socket, { type: 'error', message: '这是单机房间，不能加入' });
          return;
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
        const fallback = seat === 0 ? '玩家一' : `玩家${seat + 1}`;
        room.seats[seat] = {
          name: cleanName(msg.name, prev ? prev.name : fallback),
          token: prev ? prev.token : makeToken(),
          socket,
          connected: true,
          released: false,
        };
        // 坐满了自动开局；没坐满就等房主点「开始」
        if (!room.state && joinedCount(room) >= room.slots) {
          startGame(room);
        }
        send(socket, {
          type: 'joined', room: room.code, seat,
          token: room.seats[seat].token, mode: room.mode, local: room.local,
          variant: room.variant,
        });
        broadcast(room);
        maybeRunBot(room);
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
  const addrs = lanAddresses();

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
  lines.push('    · 单机：直接在页面上选「人机对战」或「同机双人」，点一下就开始');
  lines.push('    · 联机：选「创建房间」，把上面那条「给朋友」的地址 + 4 位房间码发出去');
  lines.push('      朋友连同一个 WiFi 打开地址，输入房间码点「加入房间」即可，支持 2~6 人');
  lines.push('');
  lines.push('  朋友打不开？多半是系统防火墙拦了 Node，允许「专用网络」即可。');
  lines.push('  关掉这个黑窗口就等于关掉服务。');
  lines.push('');
  process.stdout.write(lines.join('\n') + '\n');

  // 从启动脚本双击进来的话顺手把页面弹出来，省得再手敲地址。
  // 只在 PATCHWORK_OPEN=1 时做（bat 里设了），跑测试起服务端时不会乱开窗口。
  openBrowserOnce(`http://localhost:${PORT}`);
});

/** 用系统默认浏览器打开一个地址（仅当显式开启时；失败也绝不影响服务） */
function openBrowserOnce(url) {
  if (process.platform !== 'win32') return;
  if (process.env.PATCHWORK_OPEN !== '1') return;
  try {
    const { spawn } = require('child_process');
    const p = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
    p.on('error', () => {});
    p.unref();
  } catch (e) { /* 弹不出来就让用户自己点，不影响服务 */ }
}

/** 让 Windows 控制台按 UTF-8 解码，中文才不会乱码。 */
function ensureUtf8Console() {
  if (process.platform !== 'win32') return;
  try {
    const { execSync } = require('child_process');
    execSync('chcp 65001', { stdio: 'ignore' });
  } catch (e) { /* 切不了就算了 */ }
}

// 端口被占用时给一句人话，别甩 EADDRINUSE 让用户懵（多半是上次那个黑窗口还开着）
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    process.stdout.write([
      '',
      `  端口 ${PORT} 已经被占用了 —— 多半是上一次的服务窗口还开着。`,
      '',
      '  怎么办：先关掉那个黑窗口（或按任意键结束本窗口），再重新双击本脚本。',
      '  想确认是谁占的：在命令行执行  netstat -ano | findstr :' + PORT,
      '',
    ].join('\n') + '\n');
  } else {
    process.stdout.write('\n  服务启动失败：' + (err && err.message ? err.message : err) + '\n\n');
  }
  process.exit(1);
});

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

