'use strict';

/* Patchwork 前端：所有规则判定都在服务端，这里只负责渲染与发出意图。
 *
 * 三种模式共用一套界面：
 *   人机对战 / 同机双人 / 联机对战
 * 区别只在「现在该谁动手」：
 *   - 人机与联机：我固定是我那个座位，别人的回合我只能看
 *   - 同机双人：一台设备替全部座位操作，轮到谁界面就切到谁
 * 所以下面所有交互都走 actSeat() / canAct() 这一对函数，不再到处写 S.seat。
 */

const $ = (id) => document.getElementById(id);

/* ---------------- 补丁配色 ---------------- */
const PALETTE = {
  A: '#4f7fb8', B: '#5f9f8a', C: '#a9784f', D: '#8d6fb0', E: '#c08a4a',
  F: '#4e8fae', G: '#9a6f4e', H: '#6f8f5c', I: '#b06f7c', J: '#7f8fb8',
  K: '#5c8f6f', L: '#a8865a', M: '#7a6fa8', N: '#4f9f9f', O: '#b08a6f',
  P: '#6f7fb0', Q: '#9f7f4f', R: '#5f8f9f', S: '#8f6f8f', T: '#7fa86f',
  U: '#a86f6f', V: '#6f9f8f', W: '#8f7f5f', X: '#5f7f8f', Y: '#9f8f6f',
  Z: '#7f6f9f', a: '#6f8f8f', b: '#a87f5f', c: '#8f9f6f', d: '#8f6f9f',
  e: '#5f8f7f', f: '#9f6f7f', g: '#6f7f9f', h: '#8a6a44',
};

/* 时间令牌的座位配色，最多 6 人 */
const SEAT_COLORS = ['#e8b563', '#5c9dd6', '#5fbf8f', '#c98be0', '#e08a5f', '#8fb7e0'];

/* ---------------- 音效（v1.5） ----------------
 * 全部用 WebAudio 现场合成，一个音频文件都不引。
 * 这个项目立身之本就是「零依赖、双击 bat 就能玩」，塞一堆 mp3 进来等于
 * 把加载失败、路径大小写、编码错这些坑一次性全请回来。合成音又小又稳。
 * 每种音效无非两三段正弦/三角/方波，几十毫秒，播完就丢，不占内存。
 */
const SFX = {
  on: true,
  ctx: null,
  master: null,
  /** 浏览器要求「用户先有过交互」才准出声，所以第一次真要点的时候才建上下文 */
  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try {
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      // 总音量压得很低：这是游戏音效不是音乐，吵到人就该被关掉了
      this.master.gain.value = 0.14;
      this.master.connect(this.ctx.destination);
    } catch (e) { this.ctx = null; }
    return this.ctx;
  },
  /** 一个固定音高的音。at = 相对现在往后延多少秒（用来拼琶音） */
  tone(freq, dur, type, at, gain) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime + (at || 0);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    // 起手先给一个极小值再指数衰减；直接 0 → 目标值会「啪」一声爆音
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, gain || 1), t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  },
  /** 一段滑音，用来做「跳过」的下坠和「不行」的钝响 */
  slide(f0, f1, dur, type) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type || 'triangle';
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.9, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  },
  /** 报一个音效名。没开、或浏览器不支持 WebAudio 时静默返回，绝不影响玩法 */
  play(name) {
    if (!this.on) return;
    if (!this.ensure()) return;
    const t = (f, d, ty, at, gn) => this.tone(f, d, ty, at, gn);
    const arp = (list, step, dur, ty) => list.forEach((f, i) => t(f, dur, ty, i * step));
    switch (name) {
      case 'click': t(780, 0.05, 'square', 0, 0.5); break;
      case 'pick': t(560, 0.07, 'triangle'); t(840, 0.09, 'triangle', 0.05); break;
      case 'place': t(430, 0.08, 'triangle'); t(650, 0.11, 'triangle', 0.06); break;
      case 'buy': arp([523, 659, 784], 0.06, 0.11, 'triangle'); break;
      case 'skip': this.slide(430, 235, 0.17); break;
      case 'income': t(1046, 0.06, 'square', 0, 0.4); t(1318, 0.10, 'square', 0.05, 0.36); break;
      case 'leather': arp([392, 523, 659, 784], 0.05, 0.13, 'sine'); break;
      case 'turn': t(523, 0.09, 'sine'); t(784, 0.13, 'sine', 0.09); break;
      // 混沌格的音色刻意做得怪一点：四度跳来跳去，一听就知道没好事
      case 'chaos': arp([880, 1245, 660, 1320], 0.055, 0.09, 'square'); break;
      case 'win': arp([523, 659, 784, 1046, 1318], 0.11, 0.26, 'triangle'); break;
      case 'lose': arp([440, 370, 294], 0.14, 0.24, 'sine'); break;
      case 'error': this.slide(210, 130, 0.14, 'sawtooth'); break;
      default: break;
    }
  },
};

/** 音效开关。主菜单和对局页各有一个，两处状态永远同步（改一个全改）。 */
function setSfx(on, remember) {
  SFX.on = Boolean(on);
  if (remember !== false) {
    try { localStorage.setItem('pwSfx', SFX.on ? '1' : '0'); } catch (e) { /* 忽略 */ }
  }
  Array.from(document.querySelectorAll('[data-sfx-toggle]')).forEach((btn) => {
    btn.classList.toggle('off', !SFX.on);
    btn.setAttribute('aria-pressed', SFX.on ? 'true' : 'false');
    btn.title = SFX.on ? '音效已开 · 点一下静音' : '音效已关 · 点一下打开';
    const txt = btn.querySelector('.sfx-txt');
    if (txt) txt.textContent = SFX.on ? '音效开' : '音效关';
  });
  return SFX.on;
}

/* ---------------- 全局状态 ---------------- */
const S = {
  ws: null,
  // 规则数值（补丁表、时间板、变体参数）。静态版下**在脚本加载的时候就同步填好**，
  // 不等 boot()：否则用户手快、在 boot 跑完前就点了「人机对战」，
  // render 会读到 null 的 meta 直接崩（踩过）。
  meta: (typeof window !== 'undefined' && window.PW_LOCAL)
    ? new window.PW_LOCAL.LocalServer().info()
    : null,
  room: null,
  seat: -1,
  token: null,
  state: null,
  meta: null,
  selected: null,        // { patchId } 当前选中的补丁
  oriIndex: 0,           // 当前朝向索引
  hover: null,           // { row, col } 鼠标所在格 —— 未固定时预览跟随它
  locked: null,          // { row, col } 左键固定下来的落点（补丁外接框左上角）
  leatherMode: false,    // 是否处于选择皮革补丁落点的状态
  leatherAt: null,
  votedRematch: false,   // 本局是否已经投过「再来一局」
  cursors: {},           // 其他座位正在考虑放置的补丁（联机时的实时预览）
  logEvents: [],
  lastEventKey: null,
  // 环绕方式：'ring' 环着时间板／'frame' 圆角矩形绕着两块拼布板。
  // 纯观感，只影响自己这块屏幕，所以存在本地、不进房间状态。
  // v1.5 起默认 'frame' —— 双人局一进来就是「绕拼布板」，补丁大、看得清。
  layout: 'frame',
  // 本局的规则变体（'classic' | 'chaos'），由服务端在 state 里带过来
  variant: 'classic',
};

/* ---------------- 三块屏幕 ---------------- */
function showScreen(name) {
  ['menu', 'game'].forEach((id) => $(id).classList.toggle('active', id === name));
}

/* ---------------- 谁能动手 ---------------- */
/** 我现在代表哪个座位操作：同机模式跟着当前行动方走 */
function actSeat() {
  const st = S.state;
  if (!st) return S.seat;
  if (st.local) return st.active === null ? S.seat : st.active;
  return S.seat;
}

/** 现在能不能操作（选补丁、落子、跳过） */
function canAct() {
  const st = S.state;
  if (!st || st.phase !== 'playing') return false;
  if (st.local) return true;              // 热座：轮到谁就替谁操作
  return st.active === S.seat;
}

/** 轮到别人时给个提示用的名字 */
function nameOf(seat) {
  const st = S.state;
  return (st && st.players[seat] && st.players[seat].name) || `玩家${seat + 1}`;
}

/* ---------------- 连接 ---------------- */

/**
 * 静态托管模式（GitHub Pages / Vercel 等纯前端托管）：
 * 页面上没有服务端，于是把「服务端」放进同一个页面里跑（见 local-server.js）。
 * 判据不是「有没有 localhost」，而是**页面上有没有那个本地服务端** ——
 * 本地起 node 服务时不会加载 local-server.js，所以自动走真 WebSocket，行为完全不变。
 */
const PW_STATIC = typeof window !== 'undefined' && !!window.PW_LOCAL;

/** 静态版里把联机相关的入口藏掉（没有服务端就没有房间） */
function applyStaticMode() {
  if (!PW_STATIC) return;
  document.documentElement.classList.add('pw-static');
  const onlineCol = document.querySelector('.online-col, [data-col="online"]');
  if (onlineCol) onlineCol.hidden = true;
  // 兜底：按文案找联机相关的按钮/区块，找不到也无所谓
  Array.from(document.querySelectorAll('.mode-card, .menu-col')).forEach((el) => {
    if (/创建房间|加入房间/.test(el.textContent || '')) el.hidden = true;
  });
}

function connect(handshake, onOpen) {
  if (PW_STATIC) {
    // 本地服务端：同页函数调用，没有网络，也就不会有断线
    const server = new window.PW_LOCAL.LocalServer();
    S.localServer = server;
    server.onmessage = (msg) => handleServerMessage(msg);
    const ws = server.connect({ onopen: onOpen });
    S.ws = ws;
    return ws;
  }

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);
  S.ws = ws;
  ws.onopen = () => onOpen();
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    handleServerMessage(msg);
  };
  ws.onclose = () => {
    if (S.room) {
      $('turnTag').textContent = '连接断开';
      pushLog('<span class="lose">连接已断开</span>，刷新页面可重新连上');
    } else {
      setMenuMsg('连接不上服务器，确认服务窗口还开着。', false);
    }
  };
  ws.onerror = () => {};
  return ws;
}

function send(payload) {
  if (!S.ws) return;
  // 静态版：本地服务端的 readyState 恒为 1（打开）
  if (S.ws.readyState === 1 || S.ws.readyState === WebSocket.OPEN) {
    S.ws.send(JSON.stringify(payload));
  }
}

function setMenuMsg(text, ok) {
  const el = $('menuMsg');
  el.textContent = text || '';
  el.className = 'msg' + (ok ? ' ok' : '');
}

/* ---------------- 服务端消息 ---------------- */
function handleServerMessage(msg) {
  maybeCountGame(msg);
  if (msg.type === 'joined') {
    S.room = msg.room;
    S.seat = msg.seat;
    S.token = msg.token;
    S.state = null;
    S.selected = null;
    S.locked = null;
    S.hover = null;
    S.votedRematch = false;
    S.lastEventKey = null;
    S.cursors = {};
    try { localStorage.setItem('pwSeat', JSON.stringify({ room: msg.room, token: msg.token })); } catch (e) { /* 忽略 */ }
    $('log').innerHTML = '';
    $('roomTag').textContent = '房间 ' + msg.room;
    showScreen('game');
    setMenuMsg('');
    return;
  }
  if (msg.type === 'error') {
    if (S.room) pushLog(`<span class="lose">${escapeHtml(msg.message)}</span>`);
    else setMenuMsg(msg.message, false);
    return;
  }
  if (msg.type === 'chat') {
    pushLog(`<span class="hl">${escapeHtml(msg.name)}</span>：${escapeHtml(msg.text)}`);
    return;
  }
  // 别人的实时预览：只重画他那块拼布板，不整屏刷
  if (msg.type === 'cursor') {
    if (!S.state) return;
    if (msg.patchId === null) delete S.cursors[msg.seat];
    else {
      S.cursors[msg.seat] = {
        patchId: msg.patchId, oriIndex: msg.oriIndex, row: msg.row, col: msg.col,
      };
    }
    renderCursorSeat(msg.seat);
    renderTurnTag();
    return;
  }
  if (msg.type === 'state') {
    const prev = S.state;

    // 第一次拿到状态（或中途加入）时，用服务端给的历史流水补齐日志
    if (!prev && msg.history && msg.history.length) {
      $('log').innerHTML = '';
      S.lastEventKey = null;
      // 补历史是「快进回放」，不该为几十手以前的事叮当一遍，所以静音
      logEvents({ players: msg.players }, { players: msg.players, lastEvents: msg.history }, true);
      logToBottom(); // 回放完直接停在最新一条
    }

    // 换局了（重开/开新局）就把上一局残留的选择与日志状态清干净
    if (prev && prev.phase === 'over' && msg.phase === 'playing') {
      S.selected = null;
      S.locked = null;
      S.hover = null;
      S.votedRematch = false;
      S.cursors = {};
      $('log').innerHTML = '';
      S.lastEventKey = null;
      setLogJump(false);
    }

    // 局面一动，还在别人屏幕上飘着的旧预览就该过期了 —— 只留当前行动方那一份
    Object.keys(S.cursors).forEach((k) => {
      if (Number(k) !== msg.active) delete S.cursors[k];
    });

    // 局面推进了，之前那句「这里放不下」就过期了，别留着误导
    clearHint();
    const someoneElseActing = prev && prev.active !== null && prev.active !== msg.active;
    const wasMyTurn = prev ? prev.active === actSeat() : false;
    S.state = msg;
    S.variant = msg.variant || 'classic';
    // 新的一局（刚开局 / 刚重开）：日志是空的，先起个头
    if (msg.phase === 'playing' && !$('log').children.length) {
      const starter = (msg.players[msg.active] || {}).name || '先手玩家';
      const tag = msg.variant === 'chaos' ? ' · <b class="chaos-word">魔改版</b>' : '';
      pushLog(`<span class="hl">对局开始</span> · ${msg.players.length} 人${tag} · ` +
        `先行动：${escapeHtml(starter)}`);
    }
    logEvents(prev, msg);
    render(prev);
    // 轮到我了，来一声轻提示。上一手还是别人（或还没开局）才算「轮到我」，
    // 否则同一个人连走几步会一路叮到底。
    if (msg.phase === 'playing' && canAct() && !wasMyTurn && (someoneElseActing || !prev)) {
      SFX.play('turn');
    }
    return;
  }
}

/* 把服务端的 lastEvents 翻成人话写进日志 */
function logEvents(prev, cur, silent) {
  const ev = cur.lastEvents;
  if (!prev || !ev || !ev.length) return;
  // 同一批事件只记一次
  const key = JSON.stringify(ev);
  if (key === S.lastEventKey) return;
  S.lastEventKey = key;
  if (!silent) playForEvents(ev);

  const who = (i) => `<span class="hl">${escapeHtml((cur.players[i] || {}).name || '玩家')}</span>`;

  ev.forEach((e) => {
    const p = typeof e.player === 'number' ? e.player : null;
    if (e.type === 'buy') {
      pushLog(`${who(p)} 买下 <b>${String(e.patchId).toUpperCase()}</b> 号补丁（付 ${e.cost} 纽扣，走 ${e.time} 格）`);
    } else if (e.type === 'advance') {
      pushLog(`${who(p)} <b>跳过</b>，前进 ${e.gained} 格，领 ${e.gained} 纽扣`);
    } else if (e.type === 'pass') {
      pushLog(`${who(p)} <b>跳过</b>，但已经在最前面了，没纽扣可领`);
    } else if (e.type === 'income') {
      pushLog(`&nbsp;&nbsp;↳ 经过纽扣格 <b>${e.space}</b>，收 ${e.gained} 纽扣`);
    } else if (e.type === 'leather') {
      pushLog(`&nbsp;&nbsp;↳ 经过皮革格 <b>${e.space}</b>，${who(p)} 拿到 1×1 补丁`);
    } else if (e.type === 'chaos') {
      logChaos(e, who(p));
    } else if (e.type === 'bonusTile') {
      pushLog(`&nbsp;&nbsp;↳ ${who(p)} <b>拼出完整 7×7</b>，拿走唯一一块奖励 +${(cur.rules && cur.rules.bonusBonus) || 7} 分`);
    } else if (e.type === 'leatherPlaced') {
      pushLog(`&nbsp;&nbsp;↳ 1×1 补丁放在第 ${e.row + 1} 行第 ${e.col + 1} 列`);
    }
  });
}

/** 混沌事件的中文说法（v1.5 魔改版才有） */
function logChaos(e, whoHtml) {
  const tag = `<b class="chaos-word">混沌格 ${e.space}</b>`;
  if (e.kind === 'bonus') {
    pushLog(`&nbsp;&nbsp;↳ ${tag} · <span class="g">天赐</span>，${whoHtml} 白拿 ${e.gained} 纽扣`);
  } else if (e.kind === 'toll') {
    pushLog(`&nbsp;&nbsp;↳ ${tag} · <span class="lose">苛捐</span>，${whoHtml} 被扣走 ${e.paid} 纽扣`);
  } else if (e.kind === 'swap') {
    if (e.with === null) {
      pushLog(`&nbsp;&nbsp;↳ ${tag} · 命运交换，可惜场上没有别人`);
    } else {
      pushLog(`&nbsp;&nbsp;↳ ${tag} · <span class="hl">命运交换</span>，` +
        `${whoHtml} 与第 ${e.with + 1} 位对调口袋（现在各持 ${e.mine} / ${e.theirs} 纽扣）`);
    }
  } else if (e.kind === 'leap') {
    pushLog(`&nbsp;&nbsp;↳ ${tag} · <span class="hl">时间跃迁</span>，${whoHtml} 额外前进 ${e.advanced} 格`);
  }
}

/* 一波事件配一次声音。只挑最响的几件事报，不然一整串叮叮当当反而听不清。 */
function playForEvents(ev) {
  const has = (t) => ev.some((e) => e.type === t);
  if (has('bonusTile')) { SFX.play('win'); return; }
  if (has('chaos')) { SFX.play('chaos'); return; }
  if (has('leather')) { SFX.play('leather'); return; }
  if (has('buy')) { SFX.play('buy'); return; }
  if (has('advance')) { SFX.play('skip'); return; }
  if (has('income')) SFX.play('income');
}

/* ---------------- 渲染 ---------------- */
function render() {
  const st = S.state;
  if (!st) return;

  $('modeTag').textContent = modeLabel(st);
  $('modeTag').classList.toggle('chaos', st.variant === 'chaos');
  $('boardWrap').dataset.n = String(st.players.length);
  $('boardWrap').dataset.variant = st.variant || 'classic';
  $('btnCopy').style.display = st.mode === 'online' ? '' : 'none';

  renderTurnTag();

  // 皮革补丁必须由拿到它的人先放下去
  S.leatherMode = st.pendingLeather.some((x) => x.player === actSeat());
  if (S.leatherMode && !S.leatherAt) S.selected = null;

  renderPlayers();
  renderRing();
  renderTimeboard();
  renderActionbar();
  renderWait();
  renderResult();

  // 自己正在挑补丁时，顺手把「我打算放哪」发给同房的人看
  sendCursor();
}

/** 顶部那句「轮到谁 / 谁在放什么」，单独拎出来是因为实时预览也要刷新它 */
function renderTurnTag() {
  const st = S.state;
  if (!st) return;
  const turn = $('turnTag');
  if (st.phase === 'waiting') {
    turn.textContent = '等待开局…';
    turn.className = 'turn-tag wait';
    return;
  }
  if (st.phase === 'over') {
    turn.textContent = '对局结束';
    turn.className = 'turn-tag';
    return;
  }
  if (canAct()) {
    const mine = st.local && st.players.length > 1
      ? `${nameOf(actSeat())} 行动`
      : '轮到你行动';
    turn.textContent = mine;
    turn.className = 'turn-tag mine';
    return;
  }
  // 对手正在挑补丁 / 挪位置，就把他琢磨的这块报出来
  const cur = S.cursors && S.cursors[st.active];
  turn.textContent = cur && cur.patchId
    ? `${nameOf(st.active)} 正在放 ${String(cur.patchId).toUpperCase()} …`
    : `等待 ${nameOf(st.active)} …`;
  turn.className = 'turn-tag wait';
}

function modeLabel(st) {
  const base = st.mode === 'solo' ? '人机对战'
    : st.mode === 'local' ? '同机双人'
      : `${st.capacity} 人联机`;
  return st.variant === 'chaos' ? `${base} · 魔改` : base;
}

/** 两小时后桌面布局：自己尽量待在右边，跟以前的习惯一致 */
function playerOrder() {
  const st = S.state;
  const n = st.players.length;
  if (n === 2) {
    const primary = st.local ? 1 : S.seat;
    return primary === 0 ? [1, 0] : [0, 1];
  }
  // 座位号就是 players 数组的下标（服务端保证按 index 顺序给），
  // 不能再读 p.index —— 那个字段是引擎内部的，序列化时不会带出来。
  return st.players.map((_, i) => i);
}

function buildCard(seat) {
  const card = document.createElement('div');
  card.className = 'player-card';
  card.dataset.seat = String(seat);
  card.innerHTML = `
    <div class="pc-head">
      <span class="pc-name"></span>
      <div class="pc-stats">
        <span class="stat btns"><i></i><b class="s-buttons">0</b></span>
        <span class="stat time"><i></i><b class="s-time">0</b></span>
        <span class="stat inc"><i></i><b class="s-income">0</b></span>
      </div>
    </div>
    <div class="quilt"></div>
    <div class="pc-foot">
      <span class="s-empty">空 81 格</span>
      <span class="bonus s-bonus">7×7 奖励</span>
    </div>`;
  card._quilt = card.querySelector('.quilt');
  card._name = card.querySelector('.pc-name');
  card._buttons = card.querySelector('.s-buttons');
  card._time = card.querySelector('.s-time');
  card._income = card.querySelector('.s-income');
  card._empty = card.querySelector('.s-empty');
  card._bonus = card.querySelector('.s-bonus');
  return card;
}

function renderPlayers() {
  const st = S.state;
  const wrap = $('playersWrap');
  const order = playerOrder();
  const sig = order.join(',') + '|' + st.local + '|' + S.seat;

  if (wrap.dataset.sig !== sig) {
    wrap.innerHTML = '';
    order.forEach((seat) => {
      wrap.appendChild(buildCard(seat));
    });
    wrap.dataset.sig = sig;
  }

  order.forEach((seat) => {
    const card = wrap.querySelector(`.player-card[data-seat="${seat}"]`);
    const p = st.players[seat];
    // 等待房里 players 是空的，这时不该有卡片；万一状态错位也别把整屏渲染带崩
    if (!card || !p) return;
    const interactive = seat === actSeat() && st.phase === 'playing';
    const isMe = !st.local && seat === S.seat;

    card.classList.toggle('me', isMe);
    card.classList.toggle('active', st.active === seat && st.phase === 'playing');
    card.classList.toggle('done', p.finished);
    card._name.textContent = p.name;
    card._name.title = p.name;
    let tag = card.querySelector('.pc-tag');
    if (!tag) {
      tag = document.createElement('span');
      tag.className = 'pc-tag';
      card.querySelector('.pc-head').insertBefore(tag, card.querySelector('.pc-stats'));
    }
    tag.textContent = p.bot ? '电脑' : (isMe ? '你' : (st.local ? '' : ''));
    tag.hidden = !tag.textContent;
    tag.classList.toggle('bot', !!p.bot);

    card._buttons.textContent = p.buttons;
    card._time.textContent = p.time;
    card._income.textContent = p.incomeIcons;
    card._empty.textContent = `空 ${p.empty} 格`;
    card._bonus.classList.toggle('on', p.hasBonusTile);

    renderQuilt(card._quilt, p, seat, interactive);
  });
}

/* ---------------- 补丁环 ----------------
 * 原版桌面上那圈补丁：33 块沿环随机摆放，中立指示物停在「正前方」，
 * 它前面那 3 块就是这一轮能买的。买走一块，指示物前移一格，整圈跟着转。
 * 这里用「剩下的块数 N」把 360° 均分，正面永远落在 6 点钟方向。
 */
const RING = {
  radius: 168,  // 兜底半径。实际半径从 CSS 里 .ring-guide 的宽度反算（--ring-d / 2），
                // 所以调环的大小只需改 CSS 变量，这里不用动。
  tile: 6,      // 环上小补丁的格子边长
  gap: 1,       // 格子间隙
  minTile: 3.4, // 格子最小可视边长：块数多的时候别把远处的补丁缩成一个点。
                // v1.6.4 从 2.2 提到 3.4 —— 手机上环小、块数多，2.2px 缩完
                // 只剩几颗 3px 的碎点糊在远端圆周上，看着像「错位」的噪点。
};

/* 「绕拼布板」布局（v1.4.1 加，v1.5 放大）
   路径不是圆，是贴着两块拼布板的圆角矩形。补丁沿四条边等弧长摊开、
   全部正放、一样大 —— 这样每一块都看得清清楚楚。
     insetMax 路径离舞台边缘最多这么远（舞台小的时候会按比例收，见 frameInset）。
               补丁是「骑」在路径上的，往里往外各伸约半个身位（最大那块 5 格），
               所以 .players 让出来的空带必须 ≥ insetMax + 半身位 + 描边。
     corner   圆角半径。
     tile     框上小补丁的格子边长。v1.5 从 8px 提到 10px ——
              最大的 5×5 补丁就是 5×10+4 = 54px，隔着半米也认得出形状。
     gap      格子间隙。 */
const FRAME = { insetMax: 30, corner: 34, tile: 10, gap: 1 };

/**
 * 路径离舞台边缘多远。舞台越小越往回收一点（免得补丁顶到外面那圈拼布板的边），
 * 但下限必须**罩得住最宽那块补丁的半宽**，否则补丁会骑到舞台外面去。
 */
function frameInset(w, h) {
  const halfMax = Math.ceil(ringBaseMax(frameTile(), FRAME.gap) / 2) + 1;
  return Math.max(halfMax, Math.min(FRAME.insetMax, Math.round(Math.min(w, h) * 0.045)));
}

const _ringBaseCache = {};
/** 所有补丁里最宽的那一块，在 scale=1 时占多少 px —— 用来估算这条路径放不放得下 */
function ringBaseMax(tile, gap) {
  const key = tile + ':' + gap;
  if (_ringBaseCache[key]) return _ringBaseCache[key];
  let max = 0;
  S.meta.patches.forEach((p) => {
    const o = p.orientations[0];
    max = Math.max(max, o.cols * tile + (o.cols - 1) * gap, o.rows * tile + (o.rows - 1) * gap);
  });
  _ringBaseCache[key] = max || 29;
  return _ringBaseCache[key];
}

/**
 * 圆角矩形路径。从「上边正中」起步、按顺时针走一圈（第一步往右）。
 * v1.5 把起点从下边挪到了上边 —— 中立棋子因此落在拼布板**上方**那条轨道上，
 * 不再挤在两块板中间那道缝里，也就不会挡住任何一块补丁。
 * 返回 { total, at(s) }，at 按弧长取点，坐标系是舞台左上角。
 */
function framePath(w, h, P) {
  const r = Math.max(0, Math.min(FRAME.corner, (w - 2 * P) / 2, (h - 2 * P) / 2));
  const half = w / 2;
  const L = P; const R = w - P; const T = P; const B = h - P;
  const quarter = (Math.PI / 2) * r;
  // 屏幕坐标 y 朝下，所以角度 0=右、π/2=下、π=左、3π/2=上
  const raw = [
    { line: [[half, T], [R - r, T]] },                       // 上边：正中 → 右上
    { arc: [[R - r, T + r], 1.5 * Math.PI, 2 * Math.PI] },    // 右上角
    { line: [[R, T + r], [R, B - r]] },                       // 右边
    { arc: [[R - r, B - r], 0, Math.PI / 2] },                // 右下角
    { line: [[R - r, B], [L + r, B]] },                       // 下边：右 → 左
    { arc: [[L + r, B - r], Math.PI / 2, Math.PI] },          // 左下角
    { line: [[L, B - r], [L, T + r]] },                       // 左边
    { arc: [[L + r, T + r], Math.PI, 1.5 * Math.PI] },        // 左上角
    { line: [[L + r, T], [half, T]] },                        // 上边：左 → 正中
  ];
  const parts = raw.map((g) => {
    if (g.line) {
      const [a, b] = g.line;
      return { kind: 'line', a, b, len: Math.hypot(b[0] - a[0], b[1] - a[1]) };
    }
    return { kind: 'arc', c: g.arc[0], a0: g.arc[1], a1: g.arc[2], len: quarter };
  });
  const total = parts.reduce((sum, g) => sum + g.len, 0);

  return {
    total,
    at(s) {
      if (!total) return { x: half, y: T };
      let t = ((s % total) + total) % total;      // 支持负数 / 超过一圈
      for (let i = 0; i < parts.length; i += 1) {
        const g = parts[i];
        if (g.len <= 0) continue;
        if (t > g.len) { t -= g.len; continue; }
        const k = t / g.len;
        if (g.kind === 'line') {
          return { x: g.a[0] + (g.b[0] - g.a[0]) * k, y: g.a[1] + (g.b[1] - g.a[1]) * k };
        }
        const ang = g.a0 + (g.a1 - g.a0) * k;
        return { x: g.c[0] + r * Math.cos(ang), y: g.c[1] + r * Math.sin(ang) };
      }
      return { x: half, y: T };
    },
  };
}

/**
 * 环绕布局要给 .players 留的那条空带有多宽 —— 这条带子就是「轨道」。
 * v1.5 把它整体放宽了一档：补丁格子从 8px 提到 10px，最大那块变成 54px 宽，
 * 往外要伸半个身位加金色描边（约 32px），所以带子必须比原来宽不少。
 * 带子宽了，补丁就能摆得更开、看得更清楚，代价是拼布板被挤窄一点 ——
 * 因此 frame 布局下中间那列也会同步收窄（见 CSS 的 .board-wrap.layout-frame）。
 * 宽度按 .players 的实际宽度给：它由 CSS 的 width: min(100%, 1000px) 定死，
 * 跟内边距无关，所以能安全地先量宽度再定内边距。
 *
 * v1.6.5：下限从写死的 66px 改成**按舞台尺寸算**，手机上才放得下。
 *   390px 宽的手机上 .players 只有 359px，再左右各留 66px 就只剩 227px
 *   给两块拼布板（每块 ~110px），板子会被压得看不清针脚。
 *   带子只要「罩得住最大那块补丁的半身位」就够 —— 手机把框上格子收到 7px，
 *   最大 5×5 补丁 = 5×7+4 = 39px，半身位约 20px，加描边给 24px 绰绰有余。
 */
function frameBand(players) {
  const w = players.getBoundingClientRect().width;
  const narrow = typeof window !== 'undefined' && window.innerWidth <= 480;
  if (narrow) {
    // 窄屏：带子跟着宽度走，20~30px 就够了（框上格子也同步收窄，见 frameTile）
    return Math.max(20, Math.min(30, Math.round(w * 0.07)));
  }
  return Math.max(66, Math.min(94, Math.round(w * 0.09)));
}

/** 把 #frameStage 精确贴到 .players 的矩形上（两者都住在 .board-wrap 里） */
function syncFrameBox() {
  const frame = $('frameStage');
  const wrap = $('boardWrap');
  const players = $('playersWrap');
  if (!frame || !wrap || !players) return null;
  const a = wrap.getBoundingClientRect();
  const b = players.getBoundingClientRect();
  const w = Math.round(b.width);
  const h = Math.round(b.height);
  frame.style.left = Math.round(b.left - a.left) + 'px';
  frame.style.top = Math.round(b.top - a.top) + 'px';
  frame.style.width = w + 'px';
  frame.style.height = h + 'px';
  return { w, h };
}

/** 框上小补丁的格子边长。桌面 10px（v1.5 定的，隔着半米也认得出形状）；
 *  手机上收一档 —— 舞台本来就只有 359×190，10px 的格子会让补丁大得挤在一起。
 *  这个值同时被 CSS 的 --rc-tile 用（见 renderRing 里写进 .ring-stage）。 */
function frameTile() {
  const narrow = typeof window !== 'undefined' && window.innerWidth <= 480;
  return narrow ? 7 : FRAME.tile;
}

/** 圆角矩形这一套的「摆哪儿」：等弧长摊开、全部正放、一样大 */
function buildFrameLayout(box, N) {
  const tile = frameTile();
  const inset = frameInset(box.w, box.h);
  const geo = framePath(box.w, box.h, inset);
  const arc = geo.total / Math.max(1, N);
  const scale = Math.min(1, Math.max(
    (arc * 0.92) / ringBaseMax(tile, FRAME.gap),
    RING.minTile / tile,
  ));
  const cx = box.w / 2;
  const cy = box.h / 2;
  return {
    arc,
    inset,
    corner: Math.max(0, Math.min(FRAME.corner, (box.w - 2 * inset) / 2, (box.h - 2 * inset) / 2)),
    pos(rel) {
      const p = geo.at(rel * arc);
      return { x: p.x - cx, y: p.y - cy, s: scale };
    },
    /** 中立棋子：停在起点「逆时针半格」的位置。
     *  起点（rel=0，也就是第一块可选补丁）在**上边正中**，
     *  所以它落在拼布板上方那条轨道上、紧挨着第一块补丁的左边 ——
     *  既不在下面挡视线的位置，又能一眼看出「往右数就是能买的」。 */
    neutral() {
      const p = geo.at(geo.total - arc / 2);
      return { x: p.x - cx, y: p.y - cy };
    },
  };
}

/** 圆环这一套的「摆哪儿」：正面永远在 6 点钟，越靠后画得越小 */
function buildRingLayout(stage, N) {
  const guide = stage.querySelector('.ring-guide');
  const R = guide && guide.offsetWidth ? guide.offsetWidth / 2 : RING.radius;
  const step = N ? 360 / N : 0;
  const arc = N > 1 ? (2 * Math.PI * R) / N : 96;
  const globalS = Math.min(1, (arc * 0.98) / ringBaseMax(RING.tile, RING.gap));
  // 33 块全在环上的时候，最远那几块会被缩成一个点，啥也看不出来。
  // 给一个「最小格子」地板保证它认得出来；地板不超过整体缩放，所以不会互相压到。
  const floor = Math.min(RING.minTile / RING.tile, globalS);
  return {
    R,
    seg: step,
    pos(rel) {
      const d = Math.min(rel, N - rel);            // 离正面有多远（按步数）
      const dist = 0.45 + 0.55 * (1 - (d / Math.max(1, N / 2)) * 0.9);
      const s = Math.max(globalS * dist, floor);
      const th = ((180 + rel * step) * Math.PI) / 180;
      return { x: R * Math.sin(th), y: -R * Math.cos(th), s };
    },
  };
}

/** 环上／框上的一枚小补丁。
 *  格子边长不写死像素，交给容器上的 --rc-tile（环 6px、框 7px）——
 *  这样同一枚 chip 在两种布局之间搬来搬去会自动换档，不用重建。
 *  能不能点由 placeChips 决定：只有中立指示物前方、又买得起的那几块才可点。 */
function makeRingChip(patch) {
  const chip = document.createElement('div');
  chip.className = 'ring-chip';
  chip.dataset.patchId = patch.id;
  const o = patch.orientations[0];
  const grid = document.createElement('div');
  grid.className = 'rc-grid';
  grid.style.gridTemplateColumns = `repeat(${o.cols}, var(--rc-tile))`;
  grid.style.gridAutoRows = 'var(--rc-tile)';
  grid.style.gap = 'var(--rc-gap)';
  for (let r = 0; r < o.rows; r += 1) {
    for (let c = 0; c < o.cols; c += 1) {
      const cell = document.createElement('i');
      const on = o.cells.some(([cr, cc]) => cr === r && cc === c);
      if (on) cell.style.background = PALETTE[patch.id] || '#5b6b8f';
      else cell.classList.add('off');
      grid.appendChild(cell);
    }
  }
  chip.appendChild(grid);
  chip.title = `${patch.id.toUpperCase()} 号补丁 · ${patch.cost} 纽扣 · 占 ${patch.time} 时间` +
    ` · ${patch.income > 0 ? '每次经过纽扣格 +' + patch.income : '没有纽扣收益'}`;
  return chip;
}

/**
 * 把所有还没被买走的补丁摆到 host（就是 .ring-far）上。
 * layout.pos(rel) 负责说「相对正面第 rel 名的那一块摆哪儿、缩多少」，
 * 圆环和圆角矩形各自只提供自己的 pos，其余（建元素、标注、可点、退场）完全共用。
 */
function placeChips(host, ctx, layout, alive) {
  const { circle, N, neutral, visible } = ctx;
  const frontIds = new Set(visible);
  const me = S.state.players[actSeat()];
  const canPlayNow = canAct() && !S.leatherMode;

  for (let i = 0; i < N; i += 1) {
    const pid = circle[i];
    // 相对正面的名次：0 就是中立指示物正前方那一块
    const rel = (i - neutral + N) % N;
    // 环绕时间板时，正面那 3 块由下方的大卡片代表，环上不再画一遍
    // （环上补丁挨得紧，多画一遍会和金色指示物叠在一起）。
    // 绕拼布板时框上很空，就全画出来，顺便把可选的那 3 块标注上。
    if (ctx.skipFront && rel < 3 && frontIds.has(pid)) continue;

    const patch = S.meta.patches.find((p) => p.id === pid);
    if (!patch) continue;
    alive.add(pid);

    let chip = host.querySelector(`.ring-chip[data-patch-id="${pid}"]`);
    if (!chip) {
      chip = makeRingChip(patch);
      chip.style.opacity = '0';                   // 新补丁淡入
      host.appendChild(chip);
      requestAnimationFrame(() => { chip.style.opacity = ''; });
    }
    const p = layout.pos(rel);
    // left/top:50% 把原点摆在舞台正中，(x,y) 再把它挪到路径上；
    // scale 走 transform 才能平滑过渡
    chip.style.transform =
      `translate(calc(-50% + ${p.x.toFixed(1)}px), calc(-50% + ${p.y.toFixed(1)}px)) ` +
      `scale(${p.s.toFixed(3)})`;

    // ---- 标注：中立指示物前方那 3 块 ----
    // 买得起 → 金色实描边 + 呼吸光晕，而且可以直接点选；
    // 买不起 → 只给一圈细虚线，告诉你「轮到它们了」，但别给点。
    const inFront = frontIds.has(pid);
    const clickable = inFront && canPlayNow && Boolean(me) && me.buttons >= patch.cost;
    chip.classList.toggle('option', inFront);
    chip.classList.toggle('selectable', clickable);
    chip.classList.toggle('picked', Boolean(S.selected && S.selected.patchId === pid));
    chip.onclick = clickable ? () => pickPatch(pid) : null;
  }
}

/** 在环上／框上点中一块补丁 == 点下方那张大卡片 */
function pickPatch(pid) {
  SFX.play('pick');
  S.selected = { patchId: pid };
  S.oriIndex = 0;
  S.locked = null;
  render(S.state);
}

function renderRing() {
  const st = S.state;
  const stage = $('ringStage');
  const far = $('ringFar');
  const front = $('ringFront');
  const panel = $('boardPanel');
  const frame = $('frameStage');
  const tok = $('ringNeutral');
  if (!stage || !far || !front) return;   // 老版本页面缓存里可能没有这套节点

  const me = st.players[actSeat()];
  const circle = st.circle || [];
  const N = circle.length;
  const neutral = st.neutral || 0;
  // 魔改版前方是 4 块，经典版 3 块 —— 再也不写死，直接照着服务端给的长度来
  const visible = (st.visible || []).slice();

  // 环绕方式：「绕拼布板」只给双人局，人少了多了都退回「环绕时间板」
  const canSwitch = st.players.length === 2;
  /* v1.6.5：手机上**开放**「绕拼布板」。
     v1.6.3 曾一刀切禁掉它，理由是手机上 .players 只能单列纵向堆叠
     → #frameStage 变成长竖条 → 补丁绕它一圈顶出屏幕。
     但那一版同时把双人局的 .players 改成了**左右并排**（grid 1fr 1fr），
     现在手机上 .players 是 359×190 的横向矩形 —— 正是这套布局需要的形状。
     配套把空带（frameBand）和框上格子（frameTile）也按窄屏收窄，
     所以框架在手机上站得住了。窗口太窄（<320px）时仍会退回圆环，见下面 useFrame 的兜底。 */
  const wantFrame = canSwitch && S.layout === 'frame' && N > 0;
  const isNarrow = typeof window !== 'undefined' && window.innerWidth <= 480;
  const wrap = $('boardWrap');
  const players = $('playersWrap');
  // 顺序很要紧：先挂布局类（.players 的宽度当场就定死了，而且不随内边距变），
  // 再按这个宽度算出要留多宽的空带，最后才量舞台矩形。
  // 反过来会量到切换前的旧尺寸，第一帧补丁就全摆错了。
  if (wrap) wrap.classList.toggle('layout-frame', wantFrame);
  if (players) players.style.padding = wantFrame ? frameBand(players) + 'px' : '';
  let box = null;
  if (wantFrame) {
    const b = syncFrameBox();
    /* 舞台太扁/太窄就退回圆环 —— 圆角矩形路径要有足够的地方摊开补丁。
       手机上 .players 是 359×190，扣掉空带后舞台约 309×140，
       低于这个尺寸硬摆会把补丁挤成一坨，还不如圆环清楚。 */
    const minSide = isNarrow ? 110 : 120;
    if (b && b.w > minSide && b.h > minSide) box = b;
  }
  const useFrame = Boolean(box);
  const mode = useFrame ? 'frame' : 'ring';
  if (wrap) wrap.classList.toggle('layout-frame', useFrame);
  if (players && !useFrame) players.style.padding = '';

  // ---- 标题 + 环绕开关 ----
  const title = $('ringLabel');
  if (title) title.textContent = useFrame ? '补丁环 · 绕拼布板' : '补丁环 · 时间板';
  const rest = $('ringRest');
  if (rest) {
    rest.textContent = N
      ? `前方 ${visible.length} 块 · 环上剩 ${N} 块`
      : '补丁已经全部买完';
  }
  const sw = $('layoutSwitch');
  if (sw) {
    /* v1.6.5：手机上重新放出来 —— 现在 frame 布局在窄屏也能站住，
       用户想切就切（默认仍然走 CSS 给的那个）。 */
    sw.hidden = !canSwitch;
    Array.from(sw.children).forEach((b) => {
      b.classList.toggle('on', b.dataset.layout === mode);
    });
  }

  // ---- 舞台归位：环 ⇄ 框，顺手把补丁和中立指示物搬过去 ----
  if (panel) panel.classList.toggle('layout-frame', useFrame);
  if (frame) frame.hidden = !useFrame;
  const host = useFrame && frame ? frame : stage;
  if (far.parentNode !== host) host.appendChild(far);
  if (tok && tok.parentNode !== host) host.appendChild(tok);

  // 补丁格子的边长也在这里定：环上 6px、框上 8px。
  // 写成 CSS 变量挂在装补丁的那一层上，chip 本身不用重建就能换档。
  far.style.setProperty('--rc-tile', (useFrame ? frameTile() : RING.tile) + 'px');
  far.style.setProperty('--rc-gap', (useFrame ? FRAME.gap : RING.gap) + 'px');

  const alive = new Set();
  const ctx = { circle, N, neutral, visible, skipFront: !useFrame };
  const layout = useFrame ? buildFrameLayout(box, N) : buildRingLayout(stage, N);

  // 虚线路径要跟补丁脚下的路完全重合，所以这几个值由 JS 说了算
  if (useFrame && frame) {
    frame.style.setProperty('--fp', layout.inset + 'px');
    frame.style.setProperty('--fcr', layout.corner + 'px');
  }

  placeChips(far, ctx, layout, alive);

  // 被买走的补丁从舞台上摘掉（下一帧才真正移除，先淡出）
  Array.from(far.children).forEach((chip) => {
    if (alive.has(chip.dataset.patchId)) return;
    chip.classList.remove('option', 'selectable', 'picked');
    chip.onclick = null;
    chip.style.opacity = '0';
    chip.style.transform += ' scale(.2)';
    setTimeout(() => chip.remove(), 220);
  });

  // ---- 中立棋子 ----
  if (tok) {
    tok.classList.toggle('on-top', useFrame);
    if (!N) {
      tok.hidden = true;
    } else {
      tok.hidden = false;
      let x;
      let y;
      if (useFrame) {
        // 绕拼布板：棋子就压在方框上边那条轨道上（buildFrameLayout.neutral 给的点）
        const p = layout.neutral();
        x = Math.round(p.x);
        y = Math.round(p.y);
      } else {
        const th = ((180 - layout.seg / 2) * Math.PI) / 180;
        // 环着时间板：放在环内侧。环内正好是「时间板外沿 → 轨道」之间那条空带，
        // 棋子停在这儿既不压到棋盘，也紧贴着它指向的那几格。
        const rTok = Math.max(30, layout.R - 14);
        x = Math.round(rTok * Math.sin(th));
        y = Math.round(-rTok * Math.cos(th));
      }
      tok.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
    }
  }

  renderRingFront(front, visible, me);
}

/** 正面那几块（经典 3 块 / 魔改 4 块）：放大、带完整数字、可点 */
function renderRingFront(front, visible, me) {
  front.innerHTML = '';
  const n = visible.length;
  // 列数跟着可见数走：魔改版就是 4 列。留个兜底，免得 0 块时算出 repeat(0, 1fr)
  front.style.gridTemplateColumns = `repeat(${Math.max(1, n)}, 1fr)`;
  for (let i = 0; i < n; i += 1) {
    const pid = visible[i];
    const card = document.createElement('div');
    if (!pid) {
      card.className = 'patch-card empty';
      front.appendChild(card);
      continue;
    }
    const patch = S.meta.patches.find((p) => p.id === pid);
    if (!patch) continue;
    const affordable = Boolean(me) && me.buttons >= patch.cost;
    const canPlay = canAct() && affordable && !S.leatherMode;
    card.className = 'patch-card' + (canPlay ? '' : ' disabled') +
      (S.selected && S.selected.patchId === pid ? ' selected' : '');
    card.dataset.patchId = pid;

    const ori = patch.orientations[S.selected && S.selected.patchId === pid ? S.oriIndex : 0];
    // 形状套一层固定高度的壳：卡片高度不能随补丁大小 / 那句「差 N 纽扣」变来变去
    const shape = document.createElement('div');
    shape.className = 'patch-shape';
    const grid = document.createElement('div');
    grid.className = 'patch-grid';
    grid.style.gridTemplateColumns = `repeat(${ori.cols}, auto)`;
    for (let r = 0; r < ori.rows; r += 1) {
      for (let c = 0; c < ori.cols; c += 1) {
        const cell = document.createElement('div');
        const on = ori.cells.some(([cr, cc]) => cr === r && cc === c);
        cell.className = 'pc-cell' + (on ? '' : ' off');
        if (on) cell.style.setProperty('--pc', PALETTE[pid] || '#5b6b8f');
        grid.appendChild(cell);
      }
    }
    shape.appendChild(grid);

    if (me && !affordable) {
      const warn = document.createElement('div');
      warn.className = 'patch-warn';
      warn.textContent = `差 ${patch.cost - me.buttons} 纽扣`;
      shape.appendChild(warn);
    }
    card.appendChild(shape);

    const meta = document.createElement('div');
    meta.className = 'patch-meta';
    meta.innerHTML = `<span class="cost">${patch.cost} 纽扣</span>` +
      `<span class="t">${patch.time} 时间</span>` +
      `<span class="inc">${patch.income > 0 ? '+' + patch.income : '—'}</span>`;
    card.appendChild(meta);

    const id = document.createElement('div');
    id.className = 'patch-id';
    id.textContent = pid.toUpperCase();
    card.appendChild(id);

    if (canPlay) {
      // 选中即进入预览态：鼠标在哪，补丁就跟着预览到哪
      card.onclick = () => pickPatch(pid);
    }
    front.appendChild(card);
  }
}

/**
 * 这一回合是不是「只能跳过」——三块可见的补丁一块都买不起。
 * 最容易忘的就是这一步，所以要让「跳过」按钮跳出来提醒。
 */
function onlyAdvancePossible() {
  const st = S.state;
  if (!st || st.phase !== 'playing') return false;
  if (!canAct() || S.leatherMode) return false;
  const me = st.players[actSeat()];
  if (!me) return false;
  const vis = st.visible || [];
  if (!vis.length) return true;                 // 补丁卖光了，只剩跳过
  return vis.every((id) => {
    const p = S.meta.patches.find((x) => x.id === id);
    return !p || me.buttons < p.cost;
  });
}

/**
 * 一格上可能同时站着好几个人的令牌（多人局很常见），位置得自己算：
 *   - 2 人：左右各一个，跟旧版观感一致
 *   - 3 人以上：一格内排成两行，最多一行 3 个，保证每枚都有 10px 上下
 */
function placeToken(tok, i, n) {
  if (n <= 2) {
    tok.style.width = '42%';
    tok.style.height = '42%';
    tok.style.top = '29%';
    tok.style.left = i === 0 ? '6%' : 'auto';
    tok.style.right = i === 0 ? 'auto' : '6%';
    return;
  }
  const cols = Math.ceil(n / 2);          // 3~4 人两列、5~6 人三列
  const rows = Math.ceil(n / cols);
  tok.style.width = Math.floor(84 / cols) + '%';
  tok.style.height = Math.floor(84 / rows) + '%';
  tok.style.left = (8 + (i % cols) * (84 / cols)) + '%';
  tok.style.top = (8 + Math.floor(i / cols) * (84 / rows)) + '%';
  tok.style.right = 'auto';
}

function renderTimeboard() {
  const st = S.state;
  const tb = $('timeboard');
  tb.innerHTML = '';
  const total = S.meta.lastSpace + 1;
  // 魔改版在时间板上多埋了 3 个混沌格（位置由服务端 rules 带过来），
  // 这些格子在 TIME_BOARD 表里是 'normal'，得单独套一层标记。
  const chaosSpaces = (st.rules && st.rules.chaosSpaces) || [];
  for (let n = 0; n < total; n += 1) {
    const cell = document.createElement('div');
    let cls = 'tb-cell';
    const kind = S.meta.timeBoard[n];
    if (kind === 'income') cls += ' income';
    if (kind === 'leather') {
      cls += ' leather';
      if (st.leatherClaimed[n]) cls += ' claimed';
    }
    if (n === S.meta.lastSpace) cls += ' end';
    if (chaosSpaces.indexOf(n) >= 0) cls += ' chaos';
    cell.className = cls;

    st.players.forEach((p, i) => {
      if (p.time !== n) return;
      const tok = document.createElement('div');
      tok.className = 'tok' + (st.active === i && st.phase === 'playing' ? ' top' : '');
      tok.style.background = SEAT_COLORS[i % SEAT_COLORS.length];
      tok.title = p.name;
      placeToken(tok, i, st.players.length);
      cell.appendChild(tok);
    });

    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = n;
    cell.appendChild(num);

    tb.appendChild(cell);
  }
}

function renderQuilt(el, player, seat, interactive) {
  el.innerHTML = '';
  if (!player) return;
  el.onmouseleave = interactive ? onQuiltLeave : null;
  el.oncontextmenu = interactive ? onQuiltContext : null;
  el.classList.toggle('interactive', interactive);

  const st = S.state;
  const canPreview = interactive && S.selected && !S.leatherMode &&
    st.active === seat && st.phase === 'playing';
  const preview = canPreview ? currentOrientation() : null;
  // 落点：左键固定后就不再跟手，否则跟随鼠标；两者都没有时不画预览
  const anchor = preview ? currentAnchor(preview) : null;
  const valid = anchor ? canPreviewPlace(preview, anchor.row, anchor.col, player) : false;
  const locked = Boolean(S.locked);

  // 别人的回合：把他正在琢磨的补丁画成半透明的「幽灵」，看得见他在干什么
  const cur = !interactive && st.phase === 'playing' ? S.cursors[seat] : null;
  let ghost = null;
  let ghostAnchor = null;
  if (cur && cur.patchId) {
    const gp = S.meta.patches.find((p) => p.id === cur.patchId);
    if (gp) {
      ghost = gp.orientations[cur.oriIndex] || gp.orientations[0];
      if (cur.row !== null && cur.row !== undefined) ghostAnchor = { row: cur.row, col: cur.col };
    }
  }

  for (let r = 0; r < S.meta.boardSize; r += 1) {
    for (let c = 0; c < S.meta.boardSize; c += 1) {
      const cell = document.createElement('div');
      cell.className = 'qcell';
      const occ = player.board[r][c];
      if (occ) {
        cell.classList.add('filled');
        cell.style.background = PALETTE[occ.id] || '#5b6b8f';
        if (occ.income) {
          const wrap = document.createElement('span');
          wrap.className = 'pins';
          for (let i = 0; i < occ.income; i += 1) {
            const pin = document.createElement('i');
            pin.className = 'pin';
            wrap.appendChild(pin);
          }
          cell.appendChild(wrap);
        }
      }

      // 落点预览：整个形状一起着色。绿=能放，红=放不下（放不下时不允许固定）
      if (preview && anchor) {
        const on = preview.cells.some(([dr, dc]) => anchor.row + dr === r && anchor.col + dc === c);
        if (on) {
          cell.classList.add(valid ? 'valid' : 'invalid');
          if (locked) cell.classList.add('locked');
        }
      }
      // 已固定时，鼠标所在格给个淡标记，方便看清正打算挪去哪
      if (interactive && locked && S.hover && S.hover.row === r && S.hover.col === c) {
        const onShape = preview && preview.cells.some(
          ([dr, dc]) => anchor.row + dr === r && anchor.col + dc === c
        );
        if (!onShape) cell.classList.add('cursor');
      }

      // 对手的幽灵预览：落在他的板上，用的是他那一刻的真实落点
      if (ghost && ghostAnchor) {
        const on = ghost.cells.some(
          ([dr, dc]) => ghostAnchor.row + dr === r && ghostAnchor.col + dc === c
        );
        if (on) {
          cell.classList.add('ghost');
          cell.style.setProperty('--ghost', SEAT_COLORS[seat % SEAT_COLORS.length]);
        }
      }

      if (interactive) {
        cell.onmouseenter = () => onCellEnter(r, c, seat);
        cell.onclick = () => onCellClick(r, c, seat);
      }
      el.appendChild(cell);
    }
  }
}

function currentOrientation() {
  const patch = S.meta.patches.find((p) => p.id === S.selected.patchId);
  return patch.orientations[S.oriIndex] || patch.orientations[0];
}

function canPreviewPlace(ori, row, col, player) {
  for (const [dr, dc] of ori.cells) {
    const r = row + dr;
    const c = col + dc;
    if (r < 0 || c < 0 || r >= S.meta.boardSize || c >= S.meta.boardSize) return false;
    if (player.board[r][c] !== null) return false;
  }
  return true;
}

/*
 * 形状"握把"：最上一行里最靠左的那一格。
 * 引擎收到的是「补丁外接框左上角」的坐标，但玩家想的是「补丁盖住我指的那一格」，
 * 所以鼠标位置要先换算成锚点，这样预览永远压在鼠标底下，不会被推到旁边去。
 * 注：可放置的位置集合完全不变——只是换了一格来"抓"这块补丁。
 */
function gripOf(ori) {
  let best = ori.cells[0];
  for (const cell of ori.cells) {
    if (cell[0] < best[0] || (cell[0] === best[0] && cell[1] < best[1])) best = cell;
  }
  return { row: best[0], col: best[1] };
}

/** 把「鼠标停的格子」换算成引擎要的锚点 */
function anchorOf(cell, ori) {
  if (!cell) return null;
  const g = gripOf(ori || currentOrientation());
  return { row: cell.row - g.row, col: cell.col - g.col };
}

/** 当前预览的锚点：已固定就用固定点，否则由鼠标位置换算 */
function currentAnchor(ori) {
  if (S.locked) return S.locked;
  return anchorOf(S.hover, ori);
}

function renderActionbar() {
  const st = S.state;
  const myTurn = canAct();
  const me = st.players[actSeat()];
  const onlySkip = onlyAdvancePossible();

  // 只剩跳过可做的时候，把这个按钮放大高亮 —— 这一步最容易忘
  const adv = $('btnAdvance');
  adv.classList.toggle('only-option', onlySkip);
  // 可见块数经典 3 块、魔改 4 块，文案跟着走，别再写死「三块」
  const visCount = ((st.visible || []).length) || 3;
  adv.title = onlySkip ? visCount + ' 块补丁一块都买不起，只能跳过领纽扣' : '';

  // 上一条短暂提示（"这里放不下"之类）有时效，过期就清掉
  if (S.hintUntil && Date.now() > S.hintUntil) { S.hintText = null; S.hintUntil = 0; }

  if (st.phase === 'waiting') {
    $('selInfo').innerHTML = '等人来齐就可以开始了…';
    ['btnRotate', 'btnFlip', 'btnConfirm', 'btnAdvance'].forEach((id) => { $(id).disabled = true; });
    return;
  }

  if (S.leatherMode) {
    $('selInfo').innerHTML = '拿到了 1×1 皮革补丁，<b>点击拼布板上任意空格</b>放下它';
    $('btnRotate').disabled = true;
    $('btnFlip').disabled = true;
    $('btnConfirm').disabled = true;
    $('btnAdvance').disabled = true;
  } else if (S.selected) {
    const patch = S.meta.patches.find((p) => p.id === S.selected.patchId);
    const ori = currentOrientation();
    const anchor = currentAnchor(ori);
    const valid = Boolean(anchor) && canPreviewPlace(ori, anchor.row, anchor.col, me);
    let tip;
    if (S.locked) {
      tip = valid
        ? '位置已固定，点<b>确认放置</b>落子（右键可解除固定）'
        : '<span class="warn">这个位置放不下，换个地方</span>';
    } else if (anchor) {
      tip = valid
        ? '<b>左键点一下</b>固定位置'
        : '<span class="warn">这里放不下，挪一挪</span>';
    } else {
      tip = '鼠标移到拼布板上即可预览落点';
    }
    $('selInfo').innerHTML = `已选 <b>${patch.id.toUpperCase()}</b> 号补丁 · ` +
      `花费 <b>${patch.cost}</b> 纽扣 · 占 ${patch.time} 时间 · ${tip}`;
    $('btnRotate').disabled = !myTurn;
    $('btnFlip').disabled = !myTurn;
    $('btnConfirm').disabled = !(myTurn && S.locked && valid);
    $('btnAdvance').disabled = !myTurn;
  } else if (onlySkip) {
    $('selInfo').innerHTML = '<b>' + (((S.state.visible || []).length) || 3) + ' 块补丁一块都买不起</b>，只能跳过领纽扣';
    $('btnRotate').disabled = true;
    $('btnFlip').disabled = true;
    $('btnConfirm').disabled = true;
    $('btnAdvance').disabled = !myTurn;
  } else {
    $('selInfo').textContent = myTurn ? '选一块补丁，或跳过领纽扣' : `等待 ${nameOf(st.active)} 行动…`;
    $('btnRotate').disabled = true;
    $('btnFlip').disabled = true;
    $('btnConfirm').disabled = true;
    $('btnAdvance').disabled = !myTurn;
  }

  if (S.hintText) {
    $('selInfo').innerHTML = `<span class="warn">${S.hintText}</span>`;
  }
}

/** 立刻清掉操作条上的提示（成功操作后调用，避免残留误导） */
function clearHint() {
  if (!S.hintText && !S.hintTimer) return;
  clearTimeout(S.hintTimer);
  S.hintTimer = null;
  S.hintText = null;
  S.hintUntil = 0;
  if (S.state) renderActionbar();
}

/** 操作条上短暂显示一句提示，不写进日志 */
function flashHint(text, ms = 1600) {
  SFX.play('error');   // 「放不下」「先选个位置」这类驳回，配一声钝响
  S.hintText = escapeHtml(text);
  S.hintUntil = Date.now() + ms;
  renderActionbar();
  clearTimeout(S.hintTimer);
  S.hintTimer = setTimeout(() => {
    S.hintText = null;
    S.hintUntil = 0;
    if (S.state) renderActionbar();
  }, ms + 40);
}

/* ---------------- 联机等待房 ---------------- */
function renderWait() {
  const st = S.state;
  const show = st.phase === 'waiting';
  $('waitModal').classList.toggle('show', show);
  if (!show) return;

  $('waitCode').textContent = S.room || '----';
  const list = $('waitList');
  list.innerHTML = '';
  st.seats.forEach((s, i) => {
    if (!s) return;
    const row = document.createElement('div');
    row.className = 'wait-row';
    row.innerHTML = `<span class="wait-seat">${i + 1}</span>` +
      `<span class="wait-name">${escapeHtml(s.name)}</span>` +
      `<span class="wait-tags">${i === 0 ? '房主' : ''}${i === 0 && !s.connected ? ' · ' : ''}${s.connected ? '' : '离线'}</span>`;
    list.appendChild(row);
  });
  for (let i = st.seats.filter(Boolean).length; i < st.slots; i += 1) {
    const row = document.createElement('div');
    row.className = 'wait-row empty';
    row.innerHTML = `<span class="wait-seat">${i + 1}</span><span class="wait-name">等待加入…</span><span class="wait-tags"></span>`;
    list.appendChild(row);
  }

  const btn = $('btnStart');
  const isHost = S.seat === 0;
  btn.disabled = !(isHost && st.canStart);
  btn.textContent = isHost
    ? (st.canStart ? `开始对局（当前 ${st.seats.filter(Boolean).length} 人）` : '至少 2 人才能开始')
    : '等待房主开始';
}

/* ---------------- 结算 ---------------- */
function renderResult() {
  const st = S.state;
  if (st.phase !== 'over' || !st.result) {
    $('overlay').classList.remove('show');
    S.resultAnnounced = false;
    return;
  }
  // 结算只播一次音：render() 会被各种原因反复调用，
  // 不拦住的话每重绘一次就重奏一段胜利进行曲。
  if (!S.resultAnnounced) {
    S.resultAnnounced = true;
    const w = st.result.winner;
    const mine = st.local ? null : S.seat;
    if (w === null) SFX.play('turn');
    else if (st.local ? true : w === mine) SFX.play('win');
    else SFX.play('lose');
  }
  showResult(st.result);
}

function showResult(result) {
  const st = S.state;
  const win = result.winner === S.seat;
  const local = st.local;
  let title;
  if (result.winner === null) title = '平局';
  else if (local) title = `${nameOf(result.winner)} 赢了`;
  else title = win ? '你赢了' : '你输了';

  $('ovTitle').textContent = title;
  $('ovTitle').style.color = result.winner === null
    ? 'var(--text)'
    : (local ? 'var(--gold)' : (win ? 'var(--green)' : 'var(--red)'));

  const rows = result.ranking.map((seat, idx) => {
    const s = result.scores[seat];
    const p = st.players[seat];
    const medal = idx === 0 ? '1' : String(idx + 1);
    const you = (!local && seat === S.seat) ? ' <span class="tag-you">你</span>' : '';
    return `<tr class="${idx === 0 ? 'first' : ''}">
      <td class="rk">${medal}</td>
      <td class="nm">${escapeHtml(p.name)}${p.bot ? '<span class="tag-you">电脑</span>' : ''}${you}</td>
      <td>${s.buttons}</td>
      <td>${s.bonus}</td>
      <td>−${s.penalty}</td>
      <td class="tt">${s.total}</td>
    </tr>`;
  }).join('');

  const r = (st.rules || {});
  const bonusPts = r.bonusBonus || 7;
  const penaltyPts = r.emptyPenalty || 2;
  $('ovBody').innerHTML =
    `<table class="score-table">
      <thead><tr><th></th><th>玩家</th><th>纽扣</th><th>7×7</th><th>空格</th><th>总分</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="score-note">最终得分 ＝ 剩余纽扣 ＋ 7×7 奖励（+${bonusPts}） − 空格数 × ${penaltyPts}。同分时先抵达终点者胜。</p>`;

  const need = st.local ? 0 : st.seats.filter(Boolean).length;
  const ov = $('overlay');
  ov.classList.add('show');
  const note = $('ovNote');
  if (local) {
    note.textContent = '';
  } else if (S.votedRematch) {
    note.textContent = `已提交，等待其他人确认…（${st.rematchVotes}/${need}）`;
  } else {
    note.textContent = `点「再来一局」开新的一局，需要大家都同意（${st.rematchVotes}/${need}）`;
  }
  const btn = $('btnRematch');
  btn.disabled = Boolean(S.votedRematch);
  btn.textContent = S.votedRematch ? '已提交' : '再来一局';
}

/* ---------------- 交互 ---------------- */
/** 鼠标进入某格：未选中补丁时也记下位置，
 *  这样在市场上点选补丁的瞬间就能立刻看到预览，不用先晃一下鼠标。 */
function onCellEnter(r, c, seat) {
  if (seat !== actSeat()) return;
  const prev = S.hover;
  S.hover = { row: r, col: c };
  if (!S.selected || S.leatherMode) return;
  if (prev && prev.row === r && prev.col === c) return;
  renderQuiltOnly();
  renderActionbar(); // 操作条那句提示也依赖落点，得跟着一起刷新
  sendCursor();      // 联机时让对手看到我在往哪挪
}

/** 鼠标移出拼布板：清掉跟随用的位置（已固定的落点不受影响） */
function onQuiltLeave() {
  if (!S.hover) return;
  S.hover = null;
  renderQuiltOnly();
  renderActionbar();
}

/**
 * 拼布板上右键：拦掉浏览器菜单，改为「取消」。
 * 已固定 → 解除固定、预览重新跟手；未固定 → 直接取消选择。
 */
function onQuiltContext(e) {
  if (e) e.preventDefault();
  if (!canAct()) return;
  if (S.locked) {
    S.locked = null;
    flashHint('已解除固定，移动鼠标重新选位置');
  } else if (S.selected) {
    S.selected = null;
    S.hover = null;
  } else {
    return;
  }
  render(S.state);
}

/**
 * 左键：把当前预览的位置固定下来，之后预览不再跟手，可以去点「确认放置」。
 * 对着已固定的同一格再点一次，等同于直接放置。
 */
function onCellClick(r, c, seat) {
  const st = S.state;
  if (!canAct() || seat !== actSeat()) return;

  if (S.leatherMode) {
    clearHint();
    send({ type: 'leather', row: r, col: c });
    S.leatherMode = false;
    S.leatherAt = null;
    return;
  }
  if (!S.selected) return;

  const ori = currentOrientation();
  const anchor = anchorOf({ row: r, col: c }, ori);

  // 点回已固定的那一格 = 直接落子
  if (S.locked && S.locked.row === anchor.row && S.locked.col === anchor.col) {
    confirmPlace();
    return;
  }

  if (!canPreviewPlace(ori, anchor.row, anchor.col, st.players[actSeat()])) {
    // 放不下时不刷日志（鼠标划过很容易误触），只在操作条上给一句提示
    flashHint('这里放不下，换个位置试试');
    return;
  }
  clearHint();
  S.locked = anchor;
  S.hover = { row: r, col: c };
  SFX.play('click');   // 落点被钉住的那一下，给个手感
  render(S.state);
}

function renderQuiltOnly() {
  const seat = actSeat();
  const card = $('playersWrap').querySelector(`.player-card[data-seat="${seat}"]`);
  if (card && S.state) renderQuilt(card._quilt, S.state.players[seat], seat, true);
}

/** 只重画某一个座位的拼布板（收别人的实时预览时用，免得整屏都在闪） */
function renderCursorSeat(seat) {
  const st = S.state;
  if (!st || seat === actSeat()) return;      // 自己那块板由本地预览负责
  const card = $('playersWrap').querySelector(`.player-card[data-seat="${seat}"]`);
  const p = st.players[seat];
  if (!card || !p) return;
  renderQuilt(card._quilt, p, seat, false);
}

/* ---------------- 把自己的实时预览广播出去 ----------------
 * 联机时对手只能看到「轮到我出手了」，看不到我在挑哪块、想放哪。
 * 这里把当前选中 + 朝向 + 落点节流后发给服务端，由服务端转发给同房其他人。
 * 同机双人 / 人机没有第二块屏幕，不用发。
 */
let cursorTimer = null;
let lastCursorKey = '';

function sendCursor() {
  const st = S.state;
  if (!st || st.mode !== 'online' || st.phase !== 'playing') return;
  if (!canAct() || S.leatherMode) {
    if (lastCursorKey !== '') { lastCursorKey = ''; send({ type: 'cursor', patchId: null }); }
    return;
  }
  const sel = S.selected;
  let key = 'none';
  let payload = { type: 'cursor', patchId: null };
  if (sel) {
    const ori = currentOrientation();
    const anchor = currentAnchor(ori);
    key = `${sel.patchId}|${S.oriIndex}|${anchor ? anchor.row + ',' + anchor.col : '-'}`;
    payload = {
      type: 'cursor',
      patchId: sel.patchId,
      oriIndex: S.oriIndex,
      row: anchor ? anchor.row : null,
      col: anchor ? anchor.col : null,
    };
  }
  if (key === lastCursorKey) return;
  lastCursorKey = key;
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => send(payload), 70);   // 节流，别把鼠标每一动都发出去
}

/** 旋转：固定中的落点保留；转完若放不下就自动解除固定，让预览回到鼠标 */
function rotate() {
  if (!S.selected || !canAct()) return;
  const patch = S.meta.patches.find((p) => p.id === S.selected.patchId);
  S.oriIndex = (S.oriIndex + 1) % patch.orientations.length;
  SFX.play('click');
  dropLockIfInvalid();
  render(S.state);
}

function flip() {
  if (!S.selected || !canAct()) return;
  const patch = S.meta.patches.find((p) => p.id === S.selected.patchId);
  // 朝向数组前 4 个是旋转、后 4 个是镜像，只有手性补丁才镜像得出新形状
  if (patch.orientations.length >= 8) {
    S.oriIndex = (S.oriIndex + 4) % patch.orientations.length;
    SFX.play('click');
    dropLockIfInvalid();
    render(S.state);
  } else {
    pushLog('<span class="hl">这块补丁镜像后形状不变</span>');
  }
}

/** 形状变了之后，原先固定的落点若已放不下就解除固定 */
function dropLockIfInvalid() {
  if (!S.locked) return;
  const ori = currentOrientation();
  const me = S.state.players[actSeat()];
  if (!canPreviewPlace(ori, S.locked.row, S.locked.col, me)) S.locked = null;
}

function confirmPlace() {
  if (!S.selected || !canAct()) return;
  const ori = currentOrientation();
  const anchor = currentAnchor(ori);
  if (!anchor) { flashHint('先把鼠标移到拼布板上选个位置'); return; }
  if (!canPreviewPlace(ori, anchor.row, anchor.col, S.state.players[actSeat()])) {
    flashHint('这个位置放不下，换个地方');
    return;
  }
  clearHint();
  send({
    type: 'patch',
    patchId: S.selected.patchId,
    oriIndex: S.oriIndex,
    row: anchor.row,
    col: anchor.col,
  });
  S.selected = null;
  S.locked = null;
  S.hover = null;
}

function doAdvance() {
  if (!canAct()) return;
  clearHint();
  send({ type: 'advance' });
  S.selected = null;
  S.locked = null;
  S.hover = null;
}

/* ---------------- 日志 ---------------- */
/** 用户是否停在日志底部附近 —— 决定新条目要不要自动跟随滚动 */
function logAtBottom() {
  const el = $('log');
  return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

function setLogJump(show) {
  const btn = $('btnLogJump');
  if (btn) btn.hidden = !show;
}

/**
 * 追加一条事件纪要。
 * 停底部时就跟着往下滚；用户正往上翻看历史时不抢滚动位置，
 * 改成亮一个「有新动态」按钮，点一下回到最新。
 */
function pushLog(html) {
  const el = $('log');
  const stick = logAtBottom(); // 必须在插入前判断，插完高度就变了
  const d = document.createElement('div');
  d.innerHTML = html;
  el.appendChild(d);
  while (el.children.length > 200) el.removeChild(el.firstChild);

  // 内容还没超出一屏，不需要滚动提示
  if (el.scrollHeight - el.clientHeight <= el.scrollTop + 1) {
    setLogJump(false);
    return;
  }
  if (stick) {
    el.scrollTop = el.scrollHeight;
    setLogJump(false);
  } else {
    setLogJump(true);
  }
}

/** 一键回到最新一条 */
function logToBottom() {
  const el = $('log');
  el.scrollTop = el.scrollHeight;
  setLogJump(false);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ---------------- 更新日志 ---------------- */
const CHANGELOG = [
  {
    v: 'v1.6.6',
    date: '当前',
    items: [
      '<b>人机多了「困难」档</b>：主菜单的单机选择里，除了「轻松 / 普通」，现在还有<b>困难（很强）</b> —— 这位是真的会算。</p>',
      '<b>困难人机每一手都会「想两步」</b>：先假设自己这么下，再替对手挑出最凶的还击，把局面照着「现在就是终局」算一遍净差（我减你最差），最后叠上剩下的空位还能填多少、收入还能吃几轮。不是拍脑袋，是把我方与对方的分数都推演过再定。',
      '<b>它顺势就抢</b>：空位能不能严丝合缝塞进去、会不会在别处炸出更多孤立小洞、你接下里能吃多少步、横向能铺多宽 —— 这些在困难的评估里都有权重，所以它常常先把好位置占掉，逼你接不上。',
      '<b>实测强度</b>：300 局打下来，对「轻松」胜率 <b>81.3%</b>（净分 +17.3），对「普通」胜率 <b>73.7%</b>（净分 +10.8）—— 是真的很难赢。',
      '<b>不卡手</b>：每一步都给困难人机设了时间预算，平均 33~41ms 落子、最慢不超过 0.4 秒，再长的对局也不会等它。</p>',
    ],
  },
  {
    v: 'v1.6.5',
    date: '上一版',
    items: [
      '<b>手机上也能「绕拼布板」了</b>：v1.6.3 曾把这条路在窄屏封掉（怕补丁排到屏幕外），现在解开了 —— 因为双人局的拼布板早就是<b>左右并排</b>的横向矩形，正好是这套布局要的形状。',
      '<b>框上补丁不再挤成一团</b>：手机上把轨道空带从 66~94px 收到 20~30px、框上格子从 10px 降到 7px，两块拼布板才不会为了腾轨道被压扁。',
      '<b>点「旋转」终于看得出来变了</b>：手机上框上格子只有 7px，一枚 3×3 补丁才 21px 见方 —— 转了朝向但太小看不出来，容易以为「按了没反应」。现在<b>被选中的那枚会放大 1.35 倍、套上金色描边</b>。',
      '<b>环绕方式开关回来了</b>：双人局在手机上也能在「环绕时间板 / 绕拼布板」之间切。',
      '太窄的屏幕（舞台不足 110px）仍会自动退回圆环 —— 那种尺寸下圆角矩形挤不下，圆环更清楚。',
    ],
  },
  {
    v: 'v1.6.4',
    date: '上一版',
    items: [
      '<b>手机上的补丁环终于圆了</b>：之前环的直径被写死 236px，只用掉屏幕宽度的 69% —— 环周长不够摊开那么多补丁，远处的就被透视缩成 3px 的小点，糊在圆周上看着像「错位」。现在环撑满可用宽度（341px），补丁大小均匀、位置清清楚楚。',
      '<b>环上的补丁不再缩成一个点</b>：最小格子从 2.2px 提到 3.4px，配上更大的环，最小的补丁也有 4px（原来只有 3px）。',
      '<b>旋转 / 镜像不用再往下滑了</b>：手机上的拼布板再收一档（46vw → 34vw），把高度让给补丁环 —— 现在两块板、整个环、时间板、四个操作按钮<b>全在首屏</b>。',
      '<b>时间板跟着环一起缩放</b>：以前环和时间板各写各的尺寸，手机上时间板会顶到圆周上；现在两者按同一比例联动。',
      '顺手清掉一个自己埋的坑：防溢出兜底规则里写进了 <code>.quilt</code>，把「拼布板缩一档」那条给冲掉了（同名属性、特异性一样，兜底在后）。',
    ],
  },
  {
    v: 'v1.6.3',
    date: '更早',
    items: [
      '<b>手机上对局不再「错位」了</b>：真机上打开双人局，补丁会绕着拼布板排出去、顶到屏幕两边。原因是「绕拼布板」这套布局要求两块板<b>左右并排</b>，而手机只能上下叠 —— 那块区域被拉成一根又高又瘦的竖条，33 块补丁绕它一圈自然就豁出去了。',
      '<b>窄屏自动换回「环绕时间板」</b>：手机上一律走那条能自适应缩放的路线，布局开关也一并收起来，不会再误切到不合适的模式。',
      '<b>拼布板不再瘦成一条</b>：手机上的板子收小了一档、双人局两张卡<b>并排成一行</b>，玩家区高度从 824px 压到 216px —— 补丁环和时间板打开就在首屏。',
    ],
  },
  {
    v: 'v1.6.2',
    date: '更早',
    items: [
      '<b>手机上能好好玩了</b>：以前这个页面只在电脑上测过，手机打开是坏的 —— 整页能左右拖动、主菜单被截断、对局的补丁环滚不到、按钮小得点不准。这一版专门修了手机。',
      '<b>横向溢出没了</b>：顶栏那排按钮在窄屏会换行，底部操作条也改成两列，整页再也不会左右晃。',
      '<b>主菜单不再被截断</b>：标题布片、分隔线、卡片留白都收了一档，<b>打开就能看到「人机对战」和「创建房间」</b>，不用先划半屏。',
      '<b>对局先看见自己的拼布板</b>：手机上玩家板排在上面，往下滑就是补丁环和时间板（以前补丁环会被挤没，怎么划都出不来）。',
      '<b>手指点得准</b>：所有按钮、输入框、下拉框最小都做到 <b>44px</b> 高，输入框字号提到 16px（iOS 上不会再自动放大）。',
      '刘海屏和底部手势条也躲开了，横屏竖屏都能用。',
    ],
  },
  {
    v: 'v1.6.1',
    date: '更早',
    items: [
      '<b>把颜色给对了人</b>：原来主菜单里<b>魔改版是紫的</b>（紫底紫边、标题也是浅紫），经典版却和普通卡片一样是灰的 —— 偏偏经典版排在前面、又是主菜，结果第一眼全落在魔改版上。现在<b>金调给了经典版</b>：人机对战、同机双人、创建房间·经典版三张卡都是金边金字；<b>魔改版退回中性灰</b>，不再抢戏。',
      '「<b>魔改版 · 混沌拼布</b>」那枚分组小牌也从紫色渐变改成了灰色描边，跟它的入口一样低调。',
      '只动了主菜单。对局里的「魔改版」标签、时间板上的混沌格、日志里的魔改用词，这些还需要一眼分清版本的紫色<b>都保持原样</b>。',
    ],
  },
  {
    v: 'v1.6',
    date: '更早',
    items: [
      '<b>单机版能看到「有多少人玩过」了</b>：主菜单底部多一枚小胶囊 —— <b>N 次访问 · M 局已开</b>。数字来自云服务，是全世界所有玩过这个链接的人加起来的，不是你自己本地的记录。',
      '「访问」按<b>会话</b>算：同一个标签页里按 F5 刷新不会重复计数，关掉重开才算新的一次。',
      '「开局」按<b>局</b>算：人机对战、同机双人、魔改版、以及结束后的「再来一局」，每开一局记一次；一局里走多少步都只算这一局。',
      '<b>统计坏了不影响玩</b>：断网、加载失败、云端异常，一律静默跳过 —— 面板不显示，游戏该怎么玩怎么玩。',
      '联机版不受影响：统计只在单机版里跑。',
    ],
  },
  {
    v: 'v1.5.1',
    date: '更早',
    items: [
      '<b>规则按版本分开显示</b>：从<b>主菜单</b>点「规则与图例」，看到的是完整的 —— <b>经典规则全部排在前</b>，魔改版单独一节压在最后。进对局后再点「规则」，就<b>只显示这一局用的那一套</b>：经典局看不到混沌格那节，魔改局才看得到，标题右边还会挂一枚「魔改版」小标签。',
      '两套规则不一致的地方（得分公式、7×7 奖励、前方能看到几块、环上多少块补丁）现在会<b>跟着版本自动换</b>，不再是一句「魔改版把这条改成了…」的补充说明。两套一起看时，每处差异前面会标上它属于哪一版。',
      '<b>主菜单标题做成拼布</b>：「拼」「布」两个字各坐一枚布片，斜纹布底 + 一圈虚线缝脚，两块微微错开角度像是缝在一起的；底下一条五色拼布带，配一颗带线孔的纽扣和一只砂漏。仍然是纯 CSS，没有任何图片或字体文件。',
      '<b>主菜单分区用粗线隔开</b>：标题、名字、玩法、底部按钮四块之间各压一条带金色缝脚的粗线，单机与联机两栏中间那条竖线也加粗了；「规则与图例」按钮挪到底部正中间并放大，不再是个不起眼的小按钮。',
    ],
  },
  {
    v: 'v1.5',
    date: '上一版',
    items: [
      '<b>魔改版 · 混沌拼布</b>（主菜单新增入口，单机与联机都有）：规则被整套换掉 —— <b>0 纽扣起步</b>、前方 <b>4 选 1</b>、补丁池每局只抽 <b>26 块</b>、7×7 奖励翻倍成 <b>+14</b>、每空一格罚 <b>3 分</b>。时间板上还多埋了 <b>3 个混沌格</b>（12 / 30 / 48 格），踩到就随机发牌：<b>天赐</b>白拿 6 纽扣、<b>苛捐</b>扣 4 纽扣、<b>命运交换</b>跟纽扣最多的对手对调口袋、<b>时间跃迁</b>额外冲两格。',
      '<b>音效</b>：买补丁、跳过、收纽扣、轮到你、混沌格、终局胜负…… 都有声了。全部是现场合成的，没有引入任何音频文件，双击 bat 就能玩这一点没变。主菜单右上角和对局页顶栏各有一个开关，<b>每个界面都能开关</b>，改一处两处一起变，选择记在本地下次还生效。',
      '<b>双人局默认就是「绕拼布板」</b>：以前进来是圆环，要自己去点开关才换成看得清的那种。现在默认就是它，轨迹和补丁一起放大了 —— 补丁格子从 8px 提到 <b>10px</b>（最大那块 54px），轨道空带从 56px 加到 <b>66~94px</b>，中间那列同步收窄把地方让出来，两块拼布板的大小基本没缩水。',
      '<b>中立指示物变成一个棋子了</b>，而且挪到了<b>拼布板上方那条轨道</b>上：圆角矩形的起点从「下边正中」移到「上边正中」，棋子就停在第一块可选补丁的左边 —— 不再挤在两块板中间那道缝里，也压不到任何一块补丁。',
      '<b>主菜单重做</b>：标题做成艺术字（渐变 + 描边的纯 CSS 效果）；<b>单机与联机两块左右并排</b>，每块里都同时摆着经典版和魔改版的入口，想玩哪种一眼就能找到。',
      '<b>魔改版的说明是照着服务端数值生成的</b>，不再是写死在页面上的文字 —— 以后调平衡改一处即可。',
    ],
  },
  {
    v: 'v1.4.1',
    date: '上一版',
    items: [
      '<b>双人局多了一种环绕方式：绕拼布板</b>。补丁环不再只是那个圆 —— 现在整个环从圆变成贴着两块拼布板的<b>圆角矩形</b>，补丁沿四条边等距摊开、<b>全部正着放、一样大</b>，所以每一块都看得清清楚楚，再没有「缩成一个小点」的角落。在棋盘标题右边那个「环绕时间板 / 绕拼布板」开关里切，<b>只影响自己这块屏幕</b>。',
      '<b>可以选的补丁被标出来了</b>。中立指示物前方那 3 块，在环上／框上都会加一圈金色描边；<b>买得起的那几块还能直接点</b>，点一下就跟点下方那张大卡片一样进入落点预览。买不起的只画一圈细虚线，告诉你「轮到它们了」但不给点。',
      '<b>绕拼布板时补丁比环上大一档</b>：格子从 6px 放到 8px（最大那块 44px），加上四条直边本来就放得开，形态一眼可辨。',
      '<b>环绕舞台精确贴合拼布板区域</b>：两块板外面留出一条空带，补丁骑在这条带子上转，不会压到棋盘；窗口一缩放就重新量一遍，位置不会错位。',
      '<b>人机对手改名 wzzzhhhhh</b>。轻松难度会显示成 wzzzhhhhh·轻松。',
      '<b>版本号说明</b>：编号是连续的 <b>1.0 → 1.1 → 1.2 → 1.3 → 1.4 → 1.4.1</b>。1.1 的源码在归档流程建起来之前就被后一版原地覆盖了，没有留下独立产物，归档里因此从 1.0 直接跳到 1.2 —— 这一条只是说明，不是功能。',
    ],
  },
  {
    v: 'v1.4',
    date: '更早',
    items: [
      '<b>补丁环不再单独挂在边上，而是把时间板整个包进环心</b>：环当外圈、时间板缩成圆心那块棋盘，两者合成一块「棋盘」。买走一块补丁，中立指示物沿环前移一格，整圈平滑地转过去。',
      '<b>时间板改成 9 列 × 6 行</b>，正好 54 格，一格不剩不空。格子仍然是 26px，比原来还大一点，数字更好认。',
      '<b>环上的小补丁放大一档</b>：环变大以后格子跟着放到 6px，最远那几块也还认得出形状。',
      '<b>环心的「还剩 N 块」搬进了标题</b>：环心让给棋盘了，标题现在同时写着「补丁环 · 时间板」，右边照旧标着中立指示物前方几块、环上还剩几块。',
      '<b>窄屏（≤1080px）下环和时间板一起等比缩</b>：环的半径是从轨道宽度反算的，所以只改两个 CSS 变量就行，JS 不用跟。',
      '<b>版本号整理成连续的</b>：早前跳过了 1.2，现在把编号整体前移一位补上 —— 1.0 → 1.1 → 1.2 → 1.3 → 1.4，不再跳号。',
    ],
  },
  {
    v: 'v1.3',
    date: '更早',
    items: [
      '<b>补上可视的旋转补丁环</b>：中间那圈不再是三张孤零零的卡片，而是完整的补丁环 —— 所有还没被买走的补丁沿环排布、离正面越远画得越小，环心写着还剩几块。买走一块，中立指示物前移一格，整圈平滑地转过去。',
      '<b>按原版修正了环的顺序</b>：环每局重新洗牌（位置都不一样）；那块 2×1 的补丁应该排在环的最后一块，开局可选的三块里没有它。以前把它摆在环首，等于白送。',
      '<b>「跳过领纽扣」会自己跳出来</b>：当你三块补丁一块都买不起、只能跳过时，这个按钮会放大、变金、持续闪动 —— 这一步最容易忘。',
      '<b>联机地址显示在主菜单</b>：以前那个「给朋友」的网址只印在 PowerShell 黑窗口里，窗口一关就找不到了。现在直接显示在联机区，还带一键复制。',
      '<b>能看见对手在琢磨什么</b>：联机时你选中补丁、把鼠标挪到落点上，对手那块拼布板上会出现一块半透明的预览，跟着你动；顶栏也会写「某某正在放 X」。',
    ],
  },
  {
    v: 'v1.2',
    date: '更早',
    items: [
      '<b>修好了「再来一局」</b>：以前点它没有任何反应 —— 服务端把重开请求挡在了「对局已结束」的判断后面，永远走不到。',
      '<b>新增人机对战</b>：内置电脑对手，会挑收益高、好拼的补丁，也会躲开拼不上的死角；可以选普通 / 轻松。',
      '<b>新增同机双人</b>：一台设备两人轮流操作，轮到谁界面自动切到谁，不用两台电脑。',
      '<b>新增 2~6 人联机</b>：房主可以提前开始，人坐满也会自动开始。回合顺序、跳过领纽扣、皮革格先到先得都推广到了多人。',
      '<b>重做主界面</b>：单机与联机的入口统一到一个菜单里，不用再先想「创建还是加入」。',
      '<b>修好事件纪要</b>：以前日志框的高度没有锁死，它会跟着内容一起长高、把整页往下顶，所以永远看不到最新几条。',
      '<b>规则修正</b>：7×7 奖励全场只有一块，先拼出来的人拿走（以前是每人各得 +7）；已经领先全场时「跳过」不再把你倒着挪回去。',
    ],
  },
  {
    v: 'v1.1',
    date: '更早',
    items: [
      '<b>修正时间板数据</b>：纽扣格应为 9 个、皮革格应为 5 个（原来写反了），终点格 53 本身就是最后一枚纽扣格。',
      '<b>放置交互改成</b>：选中补丁即时预览 → 左键固定落点 → 点「确认放置」，不再依赖右键。',
      '<b>补上规则图例</b>，并把事件纪要改成可滚动、新条目自动跟随。',
    ],
  },
  {
    v: 'v1.0',
    date: '初版',
    items: ['完整原版规则、局域网双人联机、零依赖运行。'],
  },
];

function renderChangelog() {
  $('changelogBody').innerHTML = CHANGELOG.map((c) => `
    <div class="ver">
      <h3>${c.v}<span class="ver-date">${c.date}</span></h3>
      <ul>${c.items.map((t) => `<li>${t}</li>`).join('')}</ul>
    </div>`).join('');
}

/* ---------------- 菜单事件 ---------------- */
function readName(fallback) {
  const v = ($('playerName').value || '').trim();
  return v || fallback;
}

function rememberName(name) {
  try { localStorage.setItem('pwName', name); } catch (e) { /* 忽略 */ }
}

function createRoom(payload) {
  const name = readName('玩家一');
  rememberName(name);
  setMenuMsg('');
  SFX.play('click');
  connect(null, () => send(Object.assign({ type: 'create', name }, payload)));
}

/**
 * 主菜单上所有「开一局」的按钮都走这一条，靠 data-* 说明自己是谁：
 *   data-mode    solo | local | online
 *   data-variant classic | chaos
 * 加一种玩法只需要在 HTML 里再摆一个 <button>，不用往 JS 里再塞一份绑定。
 */
function startFromButton(btn) {
  const mode = btn.dataset.mode;
  const variant = btn.dataset.variant || 'classic';
  if (mode === 'local') {
    const name = readName('玩家一');
    const name2 = (window.prompt('第二位玩家的名字', '玩家二') || '').trim() || '玩家二';
    rememberName(name);
    setMenuMsg('');
    SFX.play('click');
    connect(null, () => send({ type: 'create', name, name2, mode: 'local', variant }));
    return;
  }
  const payload = { mode, variant };
  if (mode === 'online') payload.capacity = Number($('playerCount').value) || 2;
  else payload.level = $('botLevel').value;
  createRoom(payload);
}

Array.from(document.querySelectorAll('[data-mode]')).forEach((btn) => {
  btn.onclick = () => startFromButton(btn);
});

$('btnJoin').onclick = () => {
  const name = readName('玩家二');
  const room = ($('roomCode').value || '').trim().toUpperCase();
  if (!room) { setMenuMsg('请先填房间码', false); SFX.play('error'); return; }
  rememberName(name);
  setMenuMsg('');
  SFX.play('click');
  connect(null, () => send({ type: 'join', name, room }));
};

// 音效开关：主菜单和对局页各一个，两处永远同步
Array.from(document.querySelectorAll('[data-sfx-toggle]')).forEach((btn) => {
  btn.onclick = () => {
    const on = setSfx(!SFX.on);
    if (on) SFX.play('click');   // 打开的那一下给个即时反馈，好确认真的响了
  };
});

$('roomCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnJoin').click(); });
$('playerName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btnSolo').click();
});

$('btnStart').onclick = () => send({ type: 'start' });

/**
 * 静态单机版的「开局数」计数点。
 *
 * 判据是 `state.gameSeq`（本地服务端每开一局自增一次，见 local-server.js 的
 * start()）的**单调递增**。这是唯一可靠的信号：
 *   · 不能挂按钮 —— 开局路径有「人机对战」（一点即开局）、「开始游戏」、
 *     以及「再来一局」（rematch）三条，挂按钮必漏；
 *   · 不能看消息类型 `started` —— 服务端从不单独发这种消息，它只是 state
 *     上的布尔字段；
 *   · 不能只看 `started === true` —— rematch 之后它仍然是 true，
 *     区分不出「还在同一局」和「又开了一局」。
 * gameSeq 每局都新建，所以「比上次大」就等于「开了新的一局」，一次不多一次不少。
 */
let _lastGameSeq = 0;
function maybeCountGame(msg) {
  if (!PW_STATIC || !window.PW_STATS) return;
  if (!msg || msg.type !== 'state') return;
  const seq = Number(msg.gameSeq) || 0;
  if (seq > _lastGameSeq) {
    _lastGameSeq = seq;
    try { window.PW_STATS.countGame(); } catch (e) { /* 统计不能影响游戏 */ }
  }
}

function leaveToMenu() {
  try { localStorage.removeItem('pwSeat'); } catch (e) { /* 忽略 */ }
  send({ type: 'release' });
  location.href = location.pathname;
}

$('btnLeave').onclick = leaveToMenu;
$('btnBack').onclick = () => {
  if (S.state && S.state.phase === 'playing' &&
      !window.confirm('这一局还没结束，确定要离开吗？')) return;
  leaveToMenu();
};

/* ---------------- 对局操作 ---------------- */
$('btnRotate').onclick = rotate;
$('btnFlip').onclick = flip;
$('btnConfirm').onclick = confirmPlace;
$('btnAdvance').onclick = doAdvance;

/**
 * 双人局的环绕方式开关：环绕时间板（圆）⇄ 绕拼布板（圆角矩形）。
 * 纯观感，只影响自己这块屏幕，所以直接存本地，不发给服务端。
 */
$('layoutSwitch').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-layout]');
  if (!btn || btn.classList.contains('on')) return;
  S.layout = btn.dataset.layout === 'frame' ? 'frame' : 'ring';
  try { localStorage.setItem('pwLayout', S.layout); } catch (err) { /* 忽略 */ }
  if (S.state) render(S.state);
});

// 窗口尺寸一变，环的半径（从 CSS 反算）和圆角矩形的舞台都得重新量一遍，
// 否则补丁会继续停在旧位置上。防抖一下，拖窗口时别每帧都重排。
let _ringResizeTimer = 0;
window.addEventListener('resize', () => {
  if (!S.state || !$('game').classList.contains('active')) return;
  clearTimeout(_ringResizeTimer);
  _ringResizeTimer = setTimeout(() => { if (S.state) render(S.state); }, 120);
});

// 日志区：滚回底部就收掉提示按钮
$('log').addEventListener('scroll', () => { if (logAtBottom()) setLogJump(false); });
$('btnLogJump').onclick = logToBottom;

$('btnCopy').onclick = async () => {
  const text = `拼布 Patchwork，房间码 ${S.room}，打开 ${location.origin} 加入`;
  try {
    await navigator.clipboard.writeText(text);
    pushLog('<span class="g">邀请信息已复制到剪贴板</span>');
  } catch (e) {
    pushLog(`<span class="g">邀请信息：${escapeHtml(text)}</span>`);
  }
};

$('btnRematch').onclick = () => {
  send({ type: 'rematch' });
  S.votedRematch = true;
  S.selected = null;
  S.locked = null;
  S.hover = null;
  render(S.state);
};

$('btnClose').onclick = () => $('overlay').classList.remove('show');

/**
 * 规则与图例。
 *
 * 主菜单和对局页共用这一个弹层，区别只在「看多少」：
 *   · 从主菜单打开 → both：经典规则在前、魔改版整节压在最后，两套都看
 *   · 从对局里打开 → 只看当前这一局用的那套（classic / chaos）
 * 具体哪些段落、哪些数字该显示，交给 CSS 按 #rulesModal 的 data-scope 处理，
 * 这里只负责把 scope 和标题右边那枚小标签摆好。
 */
function openRules(scope) {
  const modal = $('rulesModal');
  const use = scope === 'chaos' ? 'chaos' : (scope === 'classic' ? 'classic' : 'both');
  modal.dataset.scope = use;

  const tag = $('rulesScopeTag');
  if (tag) {
    if (use === 'both') {
      tag.hidden = true;
      tag.textContent = '';
    } else {
      const meta = S.meta && S.meta.variants && S.meta.variants[use];
      tag.textContent = (meta && meta.label) || (use === 'chaos' ? '魔改版' : '经典版');
      tag.className = 'scope-tag ' + use;
      tag.hidden = false;
    }
  }
  modal.classList.add('show');
}

$('btnRulesMenu').onclick = () => { SFX.play('click'); openRules('both'); };
$('btnRules').onclick = () => { SFX.play('click'); openRules(S.variant); };
$('btnRulesClose').onclick = () => $('rulesModal').classList.remove('show');
$('btnChangelog').onclick = () => $('changelogModal').classList.add('show');
$('btnChangelogClose').onclick = () => $('changelogModal').classList.remove('show');

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (!$('game').classList.contains('active')) return;
  const k = e.key.toLowerCase();
  if (k === 'r') { e.preventDefault(); rotate(); }
  if (k === 'f') { e.preventDefault(); flip(); }
  if (k === 'enter') { e.preventDefault(); confirmPlace(); }
  if (k === 'escape') {
    // 第一次按先解除固定，再按一次才取消选择
    if (S.locked) S.locked = null;
    else { S.selected = null; S.hover = null; }
    if (S.state) render(S.state);
  }
  if (k === ' ') { e.preventDefault(); doAdvance(); }
});

/* ----------------------------------------------------------------
 * 给浏览器联调脚本开的只读观察窗口。
 * 本文件是普通脚本，顶层的 const S 不会挂到 window 上，
 * 外面的自动化脚本就没法读局面；这里显式开一个口子，全部只读，
 * 不改变任何游戏行为。
 * ---------------------------------------------------------------- */
window.__pw = {
  get state() { return S.state; },
  get seat() { return S.seat; },
  get room() { return S.room; },
  get meta() { return S.meta; },
  get selected() { return S.selected; },
  get locked() { return S.locked; },
  get hover() { return S.hover; },
  /** 当前环绕方式：'ring' | 'frame' */
  get layout() { return S.layout; },
  /** 本局规则变体：'classic' | 'chaos' */
  get variant() { return S.variant; },
  /** 音效是否开着 */
  get sfxOn() { return SFX.on; },
  /** 当前生效的规则数值（经典/魔改），等待房时是 null */
  get rules() { return (S.state && S.state.rules) || null; },
  /** 规则弹层当前的显示范围：'both' | 'classic' | 'chaos' */
  get rulesScope() { return $('rulesModal').dataset.scope || ''; },
  /** 规则弹层的只读体检：哪几节在显示、哪几处变体差异是显示着的 */
  rulesView() {
    const modal = $('rulesModal');
    const shown = (el) => Boolean(el && el.offsetParent !== null);
    const body = modal.querySelector('.rules-body');
    return {
      scope: modal.dataset.scope || '',
      open: modal.classList.contains('show'),
      tag: (() => {
        const t = $('rulesScopeTag');
        return t && !t.hidden ? t.textContent : '';
      })(),
      sections: Array.from(body.querySelectorAll('.rules-sec')).map((s) => ({
        title: (s.querySelector('h3') || {}).textContent || '',
        rules: s.dataset.rules || 'both',
        shown: shown(s),
      })),
      variants: Array.from(body.querySelectorAll('.rv')).map((s) => ({
        kind: s.classList.contains('rv-chaos') ? 'chaos' : 'classic',
        shown: shown(s),
      })),
      // 魔改版专属的图例行（混沌格）
      chaosLegend: shown(body.querySelector('.tb-chaos')),
    };
  },
  /** 中立棋子的实时位置（相对舞台中心），测「它到底在不在上方」用 */
  neutralPos() {
    const tok = $('ringNeutral');
    if (!tok || tok.hidden) return null;
    const host = tok.parentNode;
    if (!host) return null;
    const b = tok.getBoundingClientRect();
    const hb = host.getBoundingClientRect();
    return {
      cx: b.left + b.width / 2,
      cy: b.top + b.height / 2,
      w: b.width,
      h: b.height,
      // 相对宿主舞台中心的偏移：y 为负表示在上半部分
      dx: b.left + b.width / 2 - (hb.left + hb.width / 2),
      dy: b.top + b.height / 2 - (hb.top + hb.height / 2),
      hostH: hb.height,
      label: tok.getAttribute('title') || '',
    };
  },
  /** 「绕拼布板」布局下舞台与补丁的实际几何，给联调脚本量尺寸用 */
  frameGeom() {
    const frame = $('frameStage');
    const far = $('ringFar');
    if (!frame || frame.hidden || !far) return null;
    const r = frame.getBoundingClientRect();
    const chips = Array.from(far.querySelectorAll('.ring-chip')).map((c) => {
      const b = c.getBoundingClientRect();
      return {
        id: c.dataset.patchId,
        cls: c.className,
        cx: b.left + b.width / 2,
        cy: b.top + b.height / 2,
        w: b.width,
        h: b.height,
      };
    });
    return { x: r.left, y: r.top, w: Math.round(r.width), h: Math.round(r.height), chips };
  },
  actSeat,
  canAct,
  /** 当前该谁动手的那块拼布板元素 */
  myQuilt() {
    return document.querySelector(`.player-card[data-seat="${actSeat()}"] .quilt`);
  },
  /** 某个座位拼布板里的格子（用于点击 / 悬停） */
  quiltCells(seat) {
    const q = document.querySelector(`.player-card[data-seat="${seat}"] .quilt`);
    return q ? Array.from(q.children) : [];
  },
  /** 静态单机版的访问量/开局数统计状态（联机版为 null） */
  get stats() { return (PW_STATIC && window.PW_STATS) ? window.PW_STATS._s : null; },
  /** 静态单机版的同页服务端（联机版为 null）—— 供测试直接驱动 rematch 等 */
  get localServer() { return S.localServer || null; },
};

/* ---------------- 启动 ---------------- */
async function boot() {
  const saved = localStorage.getItem('pwName');
  if (saved) $('playerName').value = saved;

  // 环绕方式是个人的观感偏好，跟着浏览器留着。
  // v1.5 起默认「绕拼布板」：双人局一进来就是补丁最大的那种摆法；
  // 想切回圆环点一下标题右边的开关就行，切过之后按你的选择记着。
  try {
    if (localStorage.getItem('pwLayout') === 'ring') S.layout = 'ring';
  } catch (e) { /* 忽略 */ }

  // 音效开关同样记在本地。默认开，明确存过 '0' 才算关。
  try {
    if (localStorage.getItem('pwSfx') === '0') SFX.on = false;
  } catch (e) { /* 忽略 */ }
  setSfx(SFX.on, false);
  // 浏览器在用户真正点过页面之前不许出声，所以第一次点击时补一次 resume
  document.addEventListener('pointerdown', () => SFX.ensure(), { once: true });

  const sel = $('playerCount');
  for (let i = 2; i <= 6; i += 1) {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = i + ' 人';
    sel.appendChild(o);
  }
  sel.value = '2';

  renderChangelog();
  renderVariantHints();

  if (PW_STATIC) {
    // 静态版没有 /api/info 这个接口，规则数值在脚本加载时已经从本地服务端取好
    // （见上面 S.meta 的初始化），这里只补做界面调整。
    if (!S.meta) S.meta = new window.PW_LOCAL.LocalServer().info();
    applyStaticMode();
  } else {
    const res = await fetch('/api/info');
    S.meta = await res.json();
  }
  renderNetHint();
  renderVariantHints();
  autoJoinIfRequested();

  // 访问量统计（仅静态单机版；模块不存在时静默跳过）
  if (PW_STATIC && window.PW_STATS) {
    try { window.PW_STATS.boot(); } catch (e) { /* 统计不能影响游戏 */ }
  }
}

/**
 * 主菜单那两张「魔改版」卡片下面的小字，按服务端真正的数值写。
 * 以前这种说明都是硬编码在 HTML 里的，改一次规则就得改两处、还容易忘。
 */
function renderVariantHints() {
  const v = S.meta && S.meta.variants && S.meta.variants.chaos;
  if (!v) return;
  const ev = (S.meta && S.meta.chaosEvents) || {};
  Array.from(document.querySelectorAll('[data-chaos-hint]')).forEach((el) => {
    el.textContent = `${v.startButtons} 纽扣起步 · 前方 ${v.marketVisible} 选 1 · ` +
      `${v.chaosSpaces.length} 个混沌格 · 7×7 奖励 +${v.bonusBonus}`;
  });
  const evEl = $('chaosEventHint');
  if (evEl) {
    evEl.innerHTML =
      `<b>天赐</b> 白拿 ${ev.bonus} 纽扣 · <b>苛捐</b> 扣 ${ev.toll} 纽扣 · ` +
      `<b>命运交换</b> 与纽扣最多的对手对调 · <b>时间跃迁</b> 额外前进 ${ev.leap} 格`;
  }
}

/**
 * 主菜单直接显示「让朋友打开这个地址」。
 * 以前这个地址只印在 PowerShell 黑窗口里，关掉窗口就找不到了。
 */
function renderNetHint() {
  const box = $('netHint');
  if (!box) return;
  const urls = ((S.meta && S.meta.netUrls) || []).slice(0, 2);
  if (!urls.length) { box.hidden = true; return; }
  box.hidden = false;
  $('netUrl').textContent = urls[0];
  $('btnCopyUrl').onclick = async () => {
    try {
      await navigator.clipboard.writeText(urls.join('\n'));
      setMenuMsg('联机地址已复制，发给朋友就行', true);
    } catch (e) {
      setMenuMsg('复制失败，手动输入：' + urls.join(' / '), false);
    }
  };
}

/** 支持 ?join=房间码&name=名字 直接进房；刷新页面也能凭 token 回到原位 */
function autoJoinIfRequested() {
  // 静态版没有房间可进，直接跳过（免得跑去找一个不存在的服务端）
  if (PW_STATIC) return;

  const params = new URLSearchParams(location.search);
  let room = (params.get('join') || '').toUpperCase();
  let token = null;
  try {
    const saved = JSON.parse(localStorage.getItem('pwSeat') || 'null');
    if (saved && saved.room) {
      if (!room) room = saved.room;
      if (saved.room === room) token = saved.token;
    }
  } catch (e) { /* 忽略解析失败 */ }

  if (!room) return;
  const name = params.get('name') || localStorage.getItem('pwName') || '玩家';
  localStorage.setItem('pwName', name);
  $('playerName').value = name;
  connect(null, () => send({ type: 'join', name, room, token }));
}

boot();
