'use strict';

/*
 * 服务端权威锦标赛（v1.7.3 的核心）。
 *
 * 之前锦标赛的分数是客户端自己算完「上报」的 —— 云端只当记分本，
 * 懂行的人用 curl 直插数据库就能伪造 99999 分（2026-10-07 的 hacker 事件）。
 * 这一版把整局搬到服务端：
 *
 *   · 引擎状态、规则裁决、困难 AI 全在这里跑，客户端只发「意图」（买/跳/放皮革）；
 *   · 分数由服务端 engine.finalResult 算出，结算后服务端直接落库 tw_games；
 *   · 客户端从头到尾没有「报分」的权力 —— 想作弊只能把 AI 打赢，那是本事不是漏洞。
 *
 * 传输全走普通 HTTP（POST /api/tw/start、POST /api/tw/action），
 * 不依赖 WebSocket —— 静态托管加一层 API 就能跑，反向代理不用支持 WS 升级。
 *
 * 会话是内存态：沙箱/服务重启会丢进行中的局（一局就几分钟，可接受）。
 * 每尾号每天一次由两层把守：start 时的云端查重 + 落库时数据库唯一索引兜底。
 */

const crypto = require('crypto');
const engine = require('./engine');
const ai = require('./ai');

const TWC_BASE = process.env.TWC_BASE || 'https://patchwork-online.app.workbuddy.host';
const TWC_KEY = process.env.TWC_KEY || 'wbpk_UY01JVqxYKljhxdEMCrcWt_Q1CcTbFcW9DE9cXDLCVKdVqRDf0kNM1C';
const ACTION_CAP = 200;
const SESSION_TTL_MS = 3 * 60 * 60 * 1000; // 3 小时没动静的会话直接回收
const BOT_LOOP_GUARD = 500;                // AI 连走手数的安全上限（理论上到不了）

/** token → 会话。会话里存引擎状态、身份、开始时间、流水文本。 */
const sessions = new Map();

/* ------------------------- 云端 REST（PostgREST 风格） ------------------------- */

const cloudHeaders = () => ({
  'x-wb-webapp-access-key': TWC_KEY,
  'Content-Type': 'application/json',
});

async function cloudSelect(queryString) {
  const r = await fetch(`${TWC_BASE}/.cloud/database/rest/tw_games?${queryString}`, {
    headers: cloudHeaders(),
  });
  if (!r.ok) throw new Error(`cloud ${r.status}`);
  return r.json();
}

/**
 * 每日预约：往 tw_entries 插一行，唯一索引 (phone6, day) 当场拦下重复。
 * 关键设计：预约发生在「开始对局」时而不是结算时 —— 中途退出同样占掉今天的名额，
 * 「快打完就退出、反复重开刷好成绩」的循环从此不存在。
 * 返回 'ok' | 'dup'；抛错表示云端连不上。
 */
async function reserveEntry(token, phone6, name) {
  const r = await fetch(`${TWC_BASE}/.cloud/database/rest/tw_entries`, {
    method: 'POST',
    headers: Object.assign({ Prefer: 'return=minimal' }, cloudHeaders()),
    body: JSON.stringify({ token, phone6, name }),
  });
  if (r.ok) return 'ok';
  const txt = await r.text().catch(() => '');
  if (txt.includes('23505')) return 'dup';
  throw new Error(`cloud ${r.status}`);
}

/** 落库一局。返回 'ok' | 'dup'（23505 唯一索引） | 'fail'。 */
async function cloudInsert(row) {
  try {
    const r = await fetch(`${TWC_BASE}/.cloud/database/rest/tw_games`, {
      method: 'POST',
      headers: Object.assign({ Prefer: 'return=minimal' }, cloudHeaders()),
      body: JSON.stringify(row),
    });
    if (r.ok) return 'ok';
    const txt = await r.text().catch(() => '');
    if (txt.includes('23505')) return 'dup';
    return 'fail';
  } catch (e) {
    return 'fail';
  }
}

/* ------------------------- 小工具 ------------------------- */

function beijingDay() {
  // 「一天」按北京时间算，与数据库 day 列的默认值保持一致
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function cleanName(raw) {
  const s = String(raw == null ? '' : raw).trim().slice(0, 12);
  return s;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) { reject(new Error('请求太大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(new Error('请求不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

/* ------------------------- 对局流水文本（与客户端纪要同款措辞） ------------------------- */

function eventText(e, s) {
  const names = s.room.playerNames;
  const who = (i) => names[i] || '玩家';
  switch (e.type) {
    case 'buy': return `${who(e.player)} 买下 ${String(e.patchId).toUpperCase()} 号补丁（付 ${e.cost} 纽扣，走 ${e.time} 格）`;
    case 'advance': return `${who(e.player)} 跳过，前进 ${e.gained} 格，领 ${e.gained} 纽扣`;
    case 'pass': return `${who(e.player)} 跳过，但已经在最前面了，没纽扣可领`;
    case 'income': return `　↳ 经过纽扣格 ${e.space}，收 ${e.gained} 纽扣`;
    case 'leather': return `　↳ 经过皮革格 ${e.space}，${who(e.player)} 拿到 1×1 补丁`;
    case 'bonusTile': return `　↳ ${who(e.player)} 拼出完整 7×7，拿走唯一一块奖励 +${(s.state.rules && s.state.rules.bonusBonus) || 7} 分`;
    case 'leatherPlaced': return `　↳ 1×1 补丁放在第 ${e.row + 1} 行第 ${e.col + 1} 列`;
    default: return null; // 混沌事件锦标赛（经典局）不会出现
  }
}

function appendLog(s, events) {
  (events || []).forEach((e) => {
    const line = eventText(e, s);
    if (line && s.log.length < ACTION_CAP) s.log.push(line);
  });
}

/* ------------------------- 引擎驱动 ------------------------- */

/** 服务端困难 AI 走一手（同步、无延时、不广播 —— 纯内存会话不需要） */
function botMoveNow(s) {
  const st = s.state;
  const seat = engine.currentPlayerIndex(st);
  if (seat !== 1 || engine.isGameOver(st)) return;
  try {
    let events = [];
    if (st.pendingLeather.length) {
      const cell = ai.chooseLeatherCell(st, seat, 'hard');
      if (!cell) {
        engine.legalActions(st); // 板满无处放，让引擎把皮革作废，绝不能让 bot 停摆
      } else {
        engine.placeLeather(st, seat, cell.row, cell.col);
        events = [{ type: 'leatherPlaced', row: cell.row, col: cell.col, player: seat }];
      }
    }
    if (!st.pendingLeather.length) {
      const action = ai.chooseAction(st, seat, 'hard');
      if (!action) return;
      events = action.type === 'advance'
        ? engine.advance(st, seat).events
        : engine.buyPatch(st, seat, action.patchId, action.oriIndex, action.row, action.col).events;
    }
    st.lastEvents = events;
    s.history.push(...events.map((e) => Object.assign({ player: seat }, e)));
    appendLog(s, events);
  } catch (err) {
    // 电脑偶尔挑到算不出的局面，跳过这一手，别把会话搞崩
    try { st.lastEvents = engine.advance(st, seat).events; } catch (e) { /* 放弃 */ }
  }
}

/** 把 bot 的回合一口气走完，直到重新轮到玩家（或终局） */
function resolveBots(s) {
  let guard = 0;
  while (!engine.isGameOver(s.state) && engine.currentPlayerIndex(s.state) === 1 && guard < BOT_LOOP_GUARD) {
    botMoveNow(s);
    guard += 1;
  }
}

/** 应用玩家的一手。非法操作直接抛错（信息会原样回到客户端日志）。 */
function applyPlayerAction(s, a) {
  const st = s.state;
  if (engine.isGameOver(st)) throw new Error('对局已结束');
  const want = engine.currentPlayerIndex(st);
  if (want !== 0) throw new Error('还没轮到你');
  const type = String(a && a.type || '');
  let events;
  if (st.pendingLeather.length) {
    if (type !== 'leather') throw new Error('请先放置 1x1 皮革补丁');
    engine.placeLeather(st, 0, Number(a.row) | 0, Number(a.col) | 0);
    events = [{ type: 'leatherPlaced', row: Number(a.row) | 0, col: Number(a.col) | 0, player: 0 }];
  } else if (type === 'advance') {
    events = engine.advance(st, 0).events;
  } else if (type === 'patch') {
    events = engine.buyPatch(st, 0, String(a.patchId || '').slice(0, 4), Number(a.oriIndex) | 0, Number(a.row) | 0, Number(a.col) | 0).events;
  } else {
    throw new Error('未知的操作');
  }
  st.lastEvents = events;
  s.history.push(...events.map((e) => Object.assign({ player: 0 }, e)));
  appendLog(s, events);
}

/** 服务端快照：字段与 server/index.js 的 serialize() 保持一致，客户端渲染零改造 */
function snapshot(s) {
  const st = s.state;
  const over = engine.isGameOver(st);
  return {
    type: 'state',
    room: '云端锦标赛',
    mode: 'solo',
    variant: 'classic',
    local: false,
    capacity: 2,
    slots: 1,
    started: true,
    phase: over ? 'over' : 'playing',
    full: true,
    canStart: false,
    seats: [
      { name: s.name, connected: true, host: true, bot: false, level: null },
      { name: ai.botName('hard'), connected: true, host: false, bot: true, level: 'hard' },
    ],
    playerNames: s.room.playerNames,
    botLevel: 'hard',
    neutral: st.neutral,
    circle: st.circle,
    visible: engine.visiblePatchIds(st),
    active: over ? null : engine.currentPlayerIndex(st),
    pendingLeather: st.pendingLeather.map((x) => ({ player: x.player })),
    leatherClaimed: st.leatherClaimed,
    rematchVotes: 0,
    players: st.players.map((p) => ({
      index: p.index,
      name: p.name,
      bot: p.bot,
      level: p.bot ? 'hard' : null,
      buttons: p.buttons,
      time: p.time,
      board: p.board,
      placed: p.placed,
      incomeIcons: p.incomeIcons,
      hasBonusTile: p.hasBonusTile,
      finished: p.finished,
      empty: engine.emptySpaces(p.board),
    })),
    bonusTileOwner: st.bonusTileOwner,
    rules: st.rules,
    result: over ? engine.finalResult(st) : null,
    lastEvents: st.lastEvents || [],
    history: [],
  };
}

/* ------------------------- 结算 ------------------------- */

async function settle(s) {
  if (s.submitted) return s.settle;
  const result = engine.finalResult(s.state);
  const me = result.scores[0];
  const bot = result.scores[1];
  const diff = (me.total || 0) - (bot.total || 0);
  const row = {
    name: s.name,
    phone6: s.phone6,
    diff,
    win: result.winner === 0,
    my_score: me.total || 0,
    bot_score: bot.total || 0,
    payload: {
      dur: Math.max(0, Date.now() - s.startedAt),
      actions: s.log.slice(0, ACTION_CAP),
      me: { buttons: me.buttons, bonus: me.bonus, penalty: me.penalty, total: me.total },
      bot: { buttons: bot.buttons, bonus: bot.bonus, penalty: bot.penalty, total: bot.total },
    },
  };
  const status = await cloudInsert(row);
  s.submitted = true;
  s.settle = { status, diff };
  sessions.delete(s.token); // 打完即收
  return s.settle;
}

/* ------------------------- 会话清扫 ------------------------- */

setInterval(() => {
  const now = Date.now();
  sessions.forEach((s, token) => {
    if (now - s.lastTouch > SESSION_TTL_MS) sessions.delete(token);
  });
}, 5 * 60 * 1000).unref();

/* ------------------------- HTTP 入口 ------------------------- */

/** POST /api/tw/start  {name, phone6} → {token, state} | {error} */
async function handleStart(req, res) {
  const body = await readBody(req);
  const name = cleanName(body.name);
  const phone6 = String(body.phone6 || '').trim();
  if (!name) { json(res, 400, { error: '先填一个参赛昵称' }); return; }
  if (!/^\d{6}$/.test(phone6)) { json(res, 400, { error: '手机号后 6 位要填满 6 个数字' }); return; }

  const day = beijingDay();
  const token = crypto.randomBytes(16).toString('hex');
  let reserved;
  try {
    reserved = await reserveEntry(token, phone6, name);
  } catch (e) {
    json(res, 502, { error: '榜单服务暂时连不上 —— 稍后再试，不然赢了也没处记分' });
    return;
  }
  if (reserved === 'dup') {
    json(res, 409, { error: '这个手机号今天已经挑战过了 —— 每个尾号每天只有一次机会（中途退出也算），明天再来' });
    return;
  }

  const state = engine.createGame(
    [{ name }, { name: ai.botName('hard'), bot: true }],
    Math.random,
    { variant: 'classic' },
  );
  const s = {
    token,
    name,
    phone6,
    day,
    startedAt: Date.now(),
    lastTouch: Date.now(),
    state,
    history: [],
    log: [`对局开始 · 云端权威 · 2 人 · 先行动：${name}`],
    room: { playerNames: [name, ai.botName('hard')] },
    submitted: false,
    settle: null,
  };
  sessions.set(token, s);
  resolveBots(s);
  json(res, 200, { token, state: snapshot(s) });
}

/** POST /api/tw/action  {token, action} → {state, settle?} | {error} */
async function handleAction(req, res) {
  const body = await readBody(req);
  if (body.action && body.action.type === 'rematch') {
    json(res, 400, { error: '锦标赛每个尾号每天只有一次挑战机会，明天再来' });
    return;
  }
  const s = sessions.get(String(body.token || ''));
  if (!s) { json(res, 404, { error: '对局不存在或已超时，请重新发起挑战' }); return; }
  s.lastTouch = Date.now();
  try {
    applyPlayerAction(s, body.action);
  } catch (err) {
    json(res, 400, { error: err.message || '非法操作' });
    return;
  }
  resolveBots(s);
  const out = { state: snapshot(s) };
  if (engine.isGameOver(s.state)) {
    out.settle = await settle(s);
  }
  json(res, 200, out);
}

/** GET /api/tw/ping → {ok:true} 部署后 curl 验证用 */
function handlePing(res) {
  json(res, 200, { ok: true, service: 'patchwork-tourney' });
}

/**
 * 路由入口：server/index.js 与 serve-web.js 都把 /api/tw/* 交给这里。
 * 返回 true 表示这个请求已处理。
 */
async function handle(req, res, urlPath) {
  if (urlPath === '/api/tw/ping') {
    if (req.method !== 'GET') { json(res, 405, { error: 'Method Not Allowed' }); return true; }
    handlePing(res);
    return true;
  }
  if (urlPath === '/api/tw/start') {
    if (req.method !== 'POST') { json(res, 405, { error: 'Method Not Allowed' }); return true; }
    try { await handleStart(req, res); } catch (e) { json(res, 500, { error: '服务器内部错误' }); }
    return true;
  }
  if (urlPath === '/api/tw/action') {
    if (req.method !== 'POST') { json(res, 405, { error: 'Method Not Allowed' }); return true; }
    try { await handleAction(req, res); } catch (e) { json(res, 500, { error: '服务器内部错误' }); }
    return true;
  }
  return false;
}

module.exports = { handle };
