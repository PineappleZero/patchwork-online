'use strict';

/* Patchwork 联机前端：所有规则判定都在服务端，这里只负责渲染与发出意图。 */

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

/* ---------------- 全局状态 ---------------- */
const S = {
  ws: null,
  room: null,
  seat: -1,
  token: null,
  state: null,
  meta: null,
  selected: null,        // { patchId, oriIndex, row, col } 当前选中的补丁
  oriIndex: 0,           // 当前朝向索引
  hover: null,           // { row, col } 悬停的落点
  leatherMode: false,    // 是否处于选择皮革补丁落点的状态
  leatherAt: null,
  anchored: false,
};

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
    setLobbyMsg('连接已断开，刷新页面可重新连上。', false);
    if (S.room) $('turnTag').textContent = '连接断开';
  };
  ws.onerror = () => {};
  return ws;
}

function send(payload) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(payload));
}

function setLobbyMsg(text, ok) {
  const el = $('lobbyMsg');
  el.textContent = text || '';
  el.className = 'msg' + (ok ? ' ok' : '');
}

/* ---------------- 服务端消息 ---------------- */
function handleServerMessage(msg) {
  if (msg.type === 'joined') {
    S.room = msg.room;
    S.seat = msg.seat;
    S.token = msg.token;
    try { localStorage.setItem('pwSeat', JSON.stringify({ room: msg.room, token: msg.token })); } catch (e) { /* 忽略 */ }
    $('lobby').classList.remove('active');
    $('game').classList.add('active');
    $('roomTag').textContent = '房间 ' + msg.room;
    S.logEvents = [];
    S.lastEventKey = null;
    setLobbyMsg('');
    return;
  }
  if (msg.type === 'error') {
    if (S.room) pushLog(`<span class="lose">${msg.message}</span>`);
    else setLobbyMsg(msg.message, false);
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
    }

    // 局面推进了，之前那句「这里放不下」就过期了，别留着误导
    clearHint();
    S.state = msg;
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
    } else if (e.type === 'income') {
      pushLog(`&nbsp;&nbsp;↳ 经过纽扣格 <b>${e.space}</b>，收 ${e.gained} 纽扣`);
    } else if (e.type === 'leather') {
      pushLog(`&nbsp;&nbsp;↳ 经过皮革格 <b>${e.space}</b>，${who(p)} 拿到 1×1 补丁`);
    } else if (e.type === 'bonusTile') {
      pushLog(`&nbsp;&nbsp;↳ ${who(p)} <b>拼出完整 7×7</b>，得 +7 分`);
    } else if (e.type === 'leatherPlaced') {
      pushLog(`&nbsp;&nbsp;↳ 1×1 补丁放在第 ${e.row + 1} 行第 ${e.col + 1} 列`);
    }
  });
}

/* ---------------- 渲染 ---------------- */
function render(prevState) {
  const st = S.state;
  const me = st.players[S.seat];
  const opp = st.players[1 - S.seat];

  $('meName').textContent = me ? me.name : '我';
  $('oppName').textContent = opp ? opp.name : '对手';

  if (me) {
    $('meButtons').textContent = me.buttons;
    $('meTime').textContent = me.time;
    $('meIncome').textContent = me.incomeIcons;
    $('meEmpty').textContent = `空 ${me.empty} 格`;
    $('meBonus').classList.toggle('on', me.hasBonusTile);
  }
  if (opp) {
    $('oppButtons').textContent = opp.buttons;
    $('oppTime').textContent = opp.time;
    $('oppIncome').textContent = opp.incomeIcons;
    $('oppEmpty').textContent = `空 ${opp.empty} 格`;
    $('oppBonus').classList.toggle('on', opp.hasBonusTile);
  }

  $('cardMe').classList.toggle('active', st.active === S.seat);
  $('cardOpp').classList.toggle('active', st.active === (1 - S.seat));

  const turn = $('turnTag');
  if (st.phase === 'waiting') {
    turn.textContent = '等待对手加入…';
    turn.className = 'turn-tag wait';
  } else if (st.phase === 'over') {
    turn.textContent = '对局结束';
    turn.className = 'turn-tag';
  } else if (st.active === S.seat) {
    turn.textContent = '轮到你行动';
    turn.className = 'turn-tag mine';
  } else {
    turn.textContent = '等待对手行动…';
    turn.className = 'turn-tag wait';
  }

  S.leatherMode = st.pendingLeather.some((x) => x.player === S.seat);
  if (S.leatherMode && !S.leatherAt) {
    S.selected = null;
  }

  renderMarket();
  renderTimeboard();
  renderQuilt($('meQuilt'), me, true);
  renderQuilt($('oppQuilt'), opp, false);
  renderActionbar();
  renderResult();
}

function renderMarket() {
  const st = S.state;
  const row = $('marketRow');
  row.innerHTML = '';
  const visible = st.visible;
  const me = st.players[S.seat];

  // 中立指示物现在压在哪一块上、往前还剩几块
  const label = $('marketLabel');
  if (label) {
    label.textContent = '补丁市场';
    const rest = document.createElement('span');
    rest.className = 'market-rest';
    rest.textContent = `中立指示物前方 3 块 · 环上还剩 ${st.circle.length} 块`;
    label.appendChild(rest);
  }

  for (let i = 0; i < 3; i += 1) {
    const pid = visible[i];
    const card = document.createElement('div');
    if (!pid) {
      card.className = 'patch-card empty';
      row.appendChild(card);
      continue;
    }
    const patch = S.meta.patches.find((p) => p.id === pid);
    const affordable = me && me.buttons >= patch.cost;
    const canPlay = st.active === S.seat && st.phase === 'playing' && affordable && !S.leatherMode;
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

    if (!affordable) {
      const warn = document.createElement('div');
      warn.className = 'patch-warn';
      warn.textContent = `差 ${patch.cost - me.buttons} 纽扣`;
      card.appendChild(warn);
    }

    if (canPlay) {
      card.onclick = () => {
        S.selected = { patchId: pid, oriIndex: 0 };
        S.oriIndex = 0;
        S.hover = null;
        S.anchored = false;
        render(S.state);
      };
    }
    row.appendChild(card);
  }
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
      if (p.time === n) {
        const tok = document.createElement('div');
        tok.className = 'tok ' + (i === S.seat ? 'me' : 'opp') + (st.topPlayer === i ? ' top' : '');
        cell.appendChild(tok);
      }
    });

    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = n;
    cell.appendChild(num);

    tb.appendChild(cell);
  }
}

function renderQuilt(el, player, mine) {
  el.innerHTML = '';
  if (!player) return;
  el.onmouseleave = mine ? onQuiltLeave : null;
  const sel = S.selected;
  const preview = mine && sel && !S.leatherMode ? currentOrientation() : null;
  const anchor = S.anchored ? S.hover : null;

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
      // 购买补丁的落点预览（以锚点左上角为起点）
      if (preview && anchor) {
        const on = preview.cells.some(([dr, dc]) => anchor.row + dr === r && anchor.col + dc === c);
        if (on) {
          const valid = canPreviewPlace(preview, anchor.row, anchor.col, player);
          cell.classList.add(valid ? 'valid' : 'invalid');
        }
      }
      if (mine && preview && !anchor) {
        // 未定锚点时：悬停的位置就是补丁左上角，能放才点亮整块形状
        if (S.hover && S.hover.row === r && S.hover.col === c) {
          const cells = canPreviewPlace(preview, r, c, player)
            ? preview.cells.map(([dr, dc]) => [r + dr, c + dc])
            : [[r, c]];
          const on = cells.some(([rr, cc]) => rr === r && cc === c);
          if (on) cell.classList.add(canPreviewPlace(preview, r, c, player) ? 'valid' : 'invalid');
        }
      }
      if (mine) {
        cell.onmouseenter = () => onCellEnter(r, c);
        cell.onclick = () => onCellClick(r, c);
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

function renderActionbar() {
  const st = S.state;
  const myTurn = st.active === S.seat && st.phase === 'playing';
  const me = st.players[S.seat];

  // 上一条短暂提示（"这里放不下"之类）有时效，过期就清掉
  if (S.hintUntil && Date.now() > S.hintUntil) { S.hintText = null; S.hintUntil = 0; }

  if (S.leatherMode) {
    $('selInfo').innerHTML = '你拿到了 1×1 皮革补丁，<b>点击自己板上任意空格</b>放下它';
    $('btnRotate').disabled = true;
    $('btnFlip').disabled = true;
    $('btnConfirm').disabled = true;
    $('btnAdvance').disabled = true;
  } else if (S.selected) {
    const patch = S.meta.patches.find((p) => p.id === S.selected.patchId);
    $('selInfo').innerHTML = `已选 <b>${patch.id.toUpperCase()}</b> 号补丁 · ` +
      `花费 <b>${patch.cost}</b> 纽扣 · 占 ${patch.time} 时间 · ` +
      (S.anchored ? '再点一次确认落点' : '点击拼布板放下');
    $('btnRotate').disabled = !myTurn;
    $('btnFlip').disabled = !myTurn;
    $('btnConfirm').disabled = !(myTurn && S.anchored);
    // 已经选了补丁也允许改主意去领纽扣，按 Esc 或点「跳过」即可
    $('btnAdvance').disabled = !myTurn;
  } else {
    $('selInfo').textContent = myTurn ? '选一块补丁，或跳过领纽扣' : '等待对手…';
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

function renderResult() {
  const st = S.state;
  if (st.phase !== 'over' || !st.result) { $('overlay').classList.remove('show'); return; }
  if ($('overlay').classList.contains('show') && $('overlay').dataset.kind === 'over') return;
  showResult(st.result);
}

function showResult(result) {
  const st = S.state;
  const me = result.scores[S.seat];
  const opp = result.scores[1 - S.seat];
  const win = result.winner === S.seat;
  const title = result.winner === null ? '平局' : (win ? '你赢了' : '你输了');
  $('ovTitle').textContent = title;
  $('ovTitle').style.color = result.winner === null ? 'var(--text)' : (win ? 'var(--green)' : 'var(--red)');

  const row = (label, a, b) =>
    `<div class="row"><span>${label}</span><span class="v">${a} / ${b}</span></div>`;

  $('ovBody').innerHTML =
    `<div class="row"><span>玩家</span><span class="v">${escapeHtml(st.players[S.seat].name)} / ${escapeHtml(st.players[1 - S.seat].name)}</span></div>` +
    row('剩余纽扣', me.buttons, opp.buttons) +
    row('7×7 奖励', me.bonus, opp.bonus) +
    row('空格扣分', -me.penalty, -opp.penalty) +
    `<div class="row total"><span>最终得分</span><span class="v">${me.total} / ${opp.total}</span></div>` +
    `<div class="row"><span>结果</span><span class="v ${win ? 'win' : 'lose'}">${title}</span></div>`;

  const ov = $('overlay');
  ov.dataset.kind = 'over';
  ov.classList.add('show');
}

/* ---------------- 交互 ---------------- */
function onCellEnter(r, c) {
  if (!S.selected || S.leatherMode) return;
  // 悬停时把光标格当作补丁左上角
  const prev = S.hover;
  S.hover = { row: r, col: c };
  if (prev && prev.row === r && prev.col === c) return;
  renderQuiltOnly();
}

/** 鼠标移出拼布板就清掉预览，避免残留上一处落点 */
function onQuiltLeave() {
  if (S.anchored || !S.hover) return;
  S.hover = null;
  renderQuiltOnly();
}

function onCellClick(r, c) {
  const st = S.state;
  if (st.active !== S.seat || st.phase !== 'playing') return;

  if (S.leatherMode) {
    clearHint();
    send({ type: 'leather', row: r, col: c });
    S.leatherMode = false;
    S.leatherAt = null;
    return;
  }
  if (!S.selected) return;
  const ori = currentOrientation();
  if (!canPreviewPlace(ori, r, c, st.players[S.seat])) {
    // 放不下时不刷日志（鼠标划过很容易误触），只在操作条上给一句提示
    flashHint('这里放不下，换个位置试试');
    return;
  }
  clearHint();
  S.hover = { row: r, col: c };
  S.anchored = true;
  render(S.state);
}

function renderQuiltOnly() {
  renderQuilt($('meQuilt'), S.state.players[S.seat], true);
}

function rotate() {
  if (!S.selected) return;
  const patch = S.meta.patches.find((p) => p.id === S.selected.patchId);
  S.oriIndex = (S.oriIndex + 1) % patch.orientations.length;
  S.anchored = false;
  S.hover = null;
  render(S.state);
}

function flip() {
  if (!S.selected) return;
  const patch = S.meta.patches.find((p) => p.id === S.selected.patchId);
  // 朝向数组前 4 个是旋转、后 4 个是镜像，只有手性补丁才镜像得出新形状
  if (patch.orientations.length >= 8) {
    S.oriIndex = (S.oriIndex + 4) % patch.orientations.length;
    S.anchored = false;
    S.hover = null;
    render(S.state);
  } else {
    pushLog('<span class="hl">这块补丁镜像后形状不变</span>');
  }
}

function confirmPlace() {
  if (!S.selected || !S.anchored) return;
  const ori = currentOrientation();
  const anchor = S.hover;
  if (!canPreviewPlace(ori, anchor.row, anchor.col, S.state.players[S.seat])) return;
  clearHint();
  send({
    type: 'patch',
    patchId: S.selected.patchId,
    oriIndex: S.oriIndex,
    row: anchor.row,
    col: anchor.col,
  });
  S.selected = null;
  S.anchored = false;
  S.hover = null;
}

function doAdvance() {
  clearHint();
  send({ type: 'advance' });
  S.selected = null;
  S.anchored = false;
}

/* ---------------- 日志 ---------------- */
function pushLog(html) {
  const el = $('log');
  const d = document.createElement('div');
  d.innerHTML = html;
  el.appendChild(d);
  while (el.children.length > 120) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ---------------- 大厅事件 ---------------- */
$('btnCreate').onclick = () => {
  const name = ($('playerName').value || '').trim() || '玩家一';
  localStorage.setItem('pwName', name);
  connect(null, () => send({ type: 'create', name }));
};

$('btnJoin').onclick = () => {
  const name = ($('playerName').value || '').trim() || '玩家二';
  const room = ($('roomCode').value || '').trim().toUpperCase();
  if (!room) { setLobbyMsg('请填写房间码', false); return; }
  localStorage.setItem('pwName', name);
  connect(null, () => send({ type: 'join', name, room }));
};

$('roomCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnJoin').click(); });
$('playerName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnCreate').click(); });

/* ---------------- 对局操作 ---------------- */
$('btnRotate').onclick = rotate;
$('btnFlip').onclick = flip;
$('btnConfirm').onclick = confirmPlace;
$('btnAdvance').onclick = doAdvance;

$('btnCopy').onclick = async () => {
  const text = `拼布 Patchwork 联机，房间码 ${S.room}，打开 ${location.origin} 加入`;
  try {
    await navigator.clipboard.writeText(text);
    pushLog('<span class="g">邀请信息已复制到剪贴板</span>');
  } catch (e) {
    pushLog(`<span class="g">邀请信息：${escapeHtml(text)}</span>`);
  }
};

$('btnRematch').onclick = () => {
  send({ type: 'rematch' });
  $('overlay').classList.remove('show');
  $('log').innerHTML = '';
  S.selected = null;
  S.anchored = false;
  S.hover = null;
  S.lastEventKey = null; // 新一局的同款事件不应被当成重复而吞掉
};

$('btnClose').onclick = () => $('overlay').classList.remove('show');

$('btnRules').onclick = () => $('rulesModal').classList.add('show');
$('btnRulesClose').onclick = () => $('rulesModal').classList.remove('show');

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (k === 'r') { e.preventDefault(); rotate(); }
  if (k === 'f') { e.preventDefault(); flip(); }
  if (k === 'enter') { e.preventDefault(); confirmPlace(); }
  if (k === 'escape') { S.selected = null; S.anchored = false; render(S.state); }
  if (k === ' ') { e.preventDefault(); doAdvance(); }
});

/* ---------------- 启动：拉取原版数据 ---------------- */
async function boot() {
  const saved = localStorage.getItem('pwName');
  if (saved) $('playerName').value = saved;
  const res = await fetch('/api/info');
  S.meta = await res.json();
  autoJoinIfRequested();
}

/** 支持 ?join=房间码&name=名字 直接进房（便于分享与截图） */
function autoJoinIfRequested() {
  const params = new URLSearchParams(location.search);
  let room = (params.get('join') || '').toUpperCase();
  let token = null;
  // 刷新页面时自动回到原来的座位
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
