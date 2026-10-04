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

/* ---------------- 全局状态 ---------------- */
const S = {
  ws: null,
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
  logEvents: [],
  lastEventKey: null,
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
function connect(handshake, onOpen) {
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
  if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(payload));
}

function setMenuMsg(text, ok) {
  const el = $('menuMsg');
  el.textContent = text || '';
  el.className = 'msg' + (ok ? ' ok' : '');
}

/* ---------------- 服务端消息 ---------------- */
function handleServerMessage(msg) {
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
  if (msg.type === 'state') {
    const prev = S.state;

    // 第一次拿到状态（或中途加入）时，用服务端给的历史流水补齐日志
    if (!prev && msg.history && msg.history.length) {
      $('log').innerHTML = '';
      S.lastEventKey = null;
      logEvents({ players: msg.players }, { players: msg.players, lastEvents: msg.history });
      logToBottom(); // 回放完直接停在最新一条
    }

    // 换局了（重开/开新局）就把上一局残留的选择与日志状态清干净
    if (prev && prev.phase === 'over' && msg.phase === 'playing') {
      S.selected = null;
      S.locked = null;
      S.hover = null;
      S.votedRematch = false;
      $('log').innerHTML = '';
      S.lastEventKey = null;
      setLogJump(false);
    }

    // 局面推进了，之前那句「这里放不下」就过期了，别留着误导
    clearHint();
    S.state = msg;
    // 新的一局（刚开局 / 刚重开）：日志是空的，先起个头
    if (msg.phase === 'playing' && !$('log').children.length) {
      const starter = (msg.players[msg.active] || {}).name || '先手玩家';
      pushLog(`<span class="hl">对局开始</span> · ${msg.players.length} 人 · ` +
        `先行动：${escapeHtml(starter)}`);
    }
    logEvents(prev, msg);
    render(prev);
    return;
  }
}

/* 把服务端的 lastEvents 翻成人话写进日志 */
function logEvents(prev, cur) {
  const ev = cur.lastEvents;
  if (!prev || !ev || !ev.length) return;
  // 同一批事件只记一次
  const key = JSON.stringify(ev);
  if (key === S.lastEventKey) return;
  S.lastEventKey = key;

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
    } else if (e.type === 'bonusTile') {
      pushLog(`&nbsp;&nbsp;↳ ${who(p)} <b>拼出完整 7×7</b>，拿走唯一一块奖励 +7 分`);
    } else if (e.type === 'leatherPlaced') {
      pushLog(`&nbsp;&nbsp;↳ 1×1 补丁放在第 ${e.row + 1} 行第 ${e.col + 1} 列`);
    }
  });
}

/* ---------------- 渲染 ---------------- */
function render() {
  const st = S.state;
  if (!st) return;
  const me = st.players[actSeat()];

  $('modeTag').textContent = modeLabel(st);
  $('boardWrap').dataset.n = String(st.players.length);
  $('btnCopy').style.display = st.mode === 'online' ? '' : 'none';

  const turn = $('turnTag');
  if (st.phase === 'waiting') {
    turn.textContent = '等待开局…';
    turn.className = 'turn-tag wait';
  } else if (st.phase === 'over') {
    turn.textContent = '对局结束';
    turn.className = 'turn-tag';
  } else if (canAct()) {
    const mine = st.local && st.players.length > 1
      ? `${nameOf(actSeat())} 行动`
      : '轮到你行动';
    turn.textContent = mine;
    turn.className = 'turn-tag mine';
  } else {
    turn.textContent = `等待 ${nameOf(st.active)} …`;
    turn.className = 'turn-tag wait';
  }

  // 皮革补丁必须由拿到它的人先放下去
  S.leatherMode = st.pendingLeather.some((x) => x.player === actSeat());
  if (S.leatherMode && !S.leatherAt) S.selected = null;

  renderPlayers();
  renderMarket();
  renderTimeboard();
  renderActionbar();
  renderWait();
  renderResult();
}

function modeLabel(st) {
  if (st.mode === 'solo') return '人机对战';
  if (st.mode === 'local') return '同机双人';
  return `${st.capacity} 人联机`;
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

function renderMarket() {
  const st = S.state;
  const row = $('marketRow');
  row.innerHTML = '';
  const me = st.players[actSeat()];

  const label = $('marketLabel');
  if (label) {
    label.textContent = '补丁市场';
    const rest = document.createElement('span');
    rest.className = 'market-rest';
    rest.textContent = `中立指示物前方 3 块 · 环上还剩 ${st.circle.length} 块`;
    label.appendChild(rest);
  }

  for (let i = 0; i < 3; i += 1) {
    const pid = st.visible[i];
    const card = document.createElement('div');
    if (!pid) {
      card.className = 'patch-card empty';
      row.appendChild(card);
      continue;
    }
    const patch = S.meta.patches.find((p) => p.id === pid);
    const affordable = me && me.buttons >= patch.cost;
    const canPlay = canAct() && affordable && !S.leatherMode;
    card.className = 'patch-card' + (canPlay ? '' : ' disabled') +
      (S.selected && S.selected.patchId === pid ? ' selected' : '');
    card.dataset.patchId = pid;

    // 第 1 张就是中立指示物正前方那块，标出来
    if (i === 0) card.classList.add('next-up');

    const ori = patch.orientations[S.selected && S.selected.patchId === pid ? S.oriIndex : 0];
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
    card.appendChild(grid);

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

    if (me && !affordable) {
      const warn = document.createElement('div');
      warn.className = 'patch-warn';
      warn.textContent = `差 ${patch.cost - me.buttons} 纽扣`;
      card.appendChild(warn);
    }

    if (canPlay) {
      card.onclick = () => {
        // 选中即进入预览态：鼠标在哪，补丁就跟着预览到哪
        S.selected = { patchId: pid };
        S.oriIndex = 0;
        S.locked = null;
        render(S.state);
      };
    }
    row.appendChild(card);
  }
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
  if (st.phase !== 'over' || !st.result) { $('overlay').classList.remove('show'); return; }
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

  $('ovBody').innerHTML =
    `<table class="score-table">
      <thead><tr><th></th><th>玩家</th><th>纽扣</th><th>7×7</th><th>空格</th><th>总分</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="score-note">最终得分 ＝ 剩余纽扣 ＋ 7×7 奖励 − 空格数 × 2。同分时先抵达终点者胜。</p>`;

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
  render(S.state);
}

function renderQuiltOnly() {
  const seat = actSeat();
  const card = $('playersWrap').querySelector(`.player-card[data-seat="${seat}"]`);
  if (card && S.state) renderQuilt(card._quilt, S.state.players[seat], seat, true);
}

/** 旋转：固定中的落点保留；转完若放不下就自动解除固定，让预览回到鼠标 */
function rotate() {
  if (!S.selected || !canAct()) return;
  const patch = S.meta.patches.find((p) => p.id === S.selected.patchId);
  S.oriIndex = (S.oriIndex + 1) % patch.orientations.length;
  dropLockIfInvalid();
  render(S.state);
}

function flip() {
  if (!S.selected || !canAct()) return;
  const patch = S.meta.patches.find((p) => p.id === S.selected.patchId);
  // 朝向数组前 4 个是旋转、后 4 个是镜像，只有手性补丁才镜像得出新形状
  if (patch.orientations.length >= 8) {
    S.oriIndex = (S.oriIndex + 4) % patch.orientations.length;
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
    v: 'v1.2',
    date: '当前',
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
    date: '上一版',
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
  connect(null, () => send(Object.assign({ type: 'create', name }, payload)));
}

$('btnSolo').onclick = () => {
  createRoom({ mode: 'solo', level: $('botLevel').value });
};

$('btnLocal').onclick = () => {
  const name = readName('玩家一');
  const name2 = (window.prompt('第二位玩家的名字', '玩家二') || '').trim() || '玩家二';
  rememberName(name);
  setMenuMsg('');
  connect(null, () => send({ type: 'create', name, name2, mode: 'local' }));
};

$('btnCreate').onclick = () => {
  createRoom({ mode: 'online', capacity: Number($('playerCount').value) || 2 });
};

$('btnJoin').onclick = () => {
  const name = readName('玩家二');
  const room = ($('roomCode').value || '').trim().toUpperCase();
  if (!room) { setMenuMsg('请先填房间码', false); return; }
  rememberName(name);
  setMenuMsg('');
  connect(null, () => send({ type: 'join', name, room }));
};

$('roomCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnJoin').click(); });
$('playerName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btnSolo').click();
});

$('btnStart').onclick = () => send({ type: 'start' });

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

$('btnRulesMenu').onclick = () => $('rulesModal').classList.add('show');
$('btnRules').onclick = () => $('rulesModal').classList.add('show');
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
};

/* ---------------- 启动 ---------------- */
async function boot() {
  const saved = localStorage.getItem('pwName');
  if (saved) $('playerName').value = saved;

  const sel = $('playerCount');
  for (let i = 2; i <= 6; i += 1) {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = i + ' 人';
    sel.appendChild(o);
  }
  sel.value = '2';

  renderChangelog();

  const res = await fetch('/api/info');
  S.meta = await res.json();
  autoJoinIfRequested();
}

/** 支持 ?join=房间码&name=名字 直接进房；刷新页面也能凭 token 回到原位 */
function autoJoinIfRequested() {
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
