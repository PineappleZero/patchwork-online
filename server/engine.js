'use strict';

const {
  PATCHES,
  LEATHER,
  TIME_BOARD,
  BOARD_SIZE,
  LAST_SPACE,
  SEVEN_BY_SEVEN_BONUS,
  START_BUTTONS,
  EMPTY_PENALTY,
  MARKET_VISIBLE,
} = require('./data');

const PATCH_BY_ID = new Map(PATCHES.map((p) => [p.id, p]));

function shuffle(list, rng = Math.random) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 建立补丁环（每局随机打乱，与原版一致）。
 *
 * 原版规则书：「找到最小的那块补丁（1×2），把中立指示物放在**它和顺时针方向下一块之间**」。
 * 可选的三块指的是中立指示物之后、顺时针方向的三块 —— 所以那块 2×1 补丁本身
 * 不在开局的三块里，它应该是环上的**最后一块**（紧挨着中立指示物的逆时针一侧）。
 *
 * 数据模型：circle[neutral] 就是中立指示物顺时针方向的第一块，可见的三块即
 * circle[neutral..neutral+2]。
 */
function buildCircle(rng) {
  const rest = shuffle(PATCHES.filter((p) => p.id !== 'A').map((p) => p.id), rng);
  return [...rest, 'A'];
}

function createPlayer(name, index, isBot) {
  return {
    index,
    name: name || `玩家${index + 1}`,
    bot: Boolean(isBot),
    buttons: START_BUTTONS,
    time: 0,
    /** 拼布板：每格记录 complement / 补丁 id / 该补丁的朝向索引 */
    board: Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null)),
    /** 已放置补丁列表（用于渲染与计分） */
    placed: [],
    /** 已放置补丁上的纽扣图标总数（按钮收益基数） */
    incomeIcons: 0,
    /** 是否已拿过 7x7 奖励 */
    hasBonusTile: false,
    /** 是否已抵达终点 */
    finished: false,
  };
}

/** 某一格是否被覆盖 */
function isCovered(grid, r, c) {
  return grid[r][c] !== null;
}

/** 校验补丁朝向能否放在 (row, col) */
function canPlaceCells(grid, cells, row, col) {
  for (const [dr, dc] of cells) {
    const r = row + dr;
    const c = col + dc;
    if (r < 0 || c < 0 || r >= BOARD_SIZE || c >= BOARD_SIZE) return false;
    if (grid[r][c] !== null) return false;
  }
  return true;
}

/** 该补丁在当前拼布板上所有合法落点 */
function legalPlacements(grid, patch) {
  const results = [];
  patch.orientations.forEach((ori, oriIndex) => {
    for (let r = 0; r + ori.rows <= BOARD_SIZE; r += 1) {
      for (let c = 0; c + ori.cols <= BOARD_SIZE; c += 1) {
        if (canPlaceCells(grid, ori.cells, r, c)) {
          results.push({ oriIndex, row: r, col: c });
        }
      }
    }
  });
  return results;
}

function hasAnyLegalPlacement(player, patch) {
  const ori = patch.orientations;
  for (let oi = 0; oi < ori.length; oi += 1) {
    for (let r = 0; r + ori[oi].rows <= BOARD_SIZE; r += 1) {
      for (let c = 0; c + ori[oi].cols <= BOARD_SIZE; c += 1) {
        if (canPlaceCells(player.board, ori[oi].cells, r, c)) return true;
      }
    }
  }
  return false;
}

/** 检查拼布板上是否存在完整无洞的 size×size 方块 */
function hasFilledSquare(grid, size) {
  for (let r = 0; r + size <= BOARD_SIZE; r += 1) {
    for (let c = 0; c + size <= BOARD_SIZE; c += 1) {
      let ok = true;
      for (let dr = 0; dr < size && ok; dr += 1) {
        for (let dc = 0; dc < size; dc += 1) {
          if (grid[r + dr][c + dc] === null) { ok = false; break; }
        }
      }
      if (ok) return true;
    }
  }
  return false;
}

function emptySpaces(grid) {
  let n = 0;
  for (let r = 0; r < BOARD_SIZE; r += 1) {
    for (let c = 0; c < BOARD_SIZE; c += 1) if (grid[r][c] === null) n += 1;
  }
  return n;
}

/** 中立指示物前方的 3 块可选补丁 */
function visiblePatchIds(state) {
  const n = state.circle.length;
  const ids = [];
  for (let i = 0; i < MARKET_VISIBLE && i < n; i += 1) {
    ids.push(state.circle[(state.neutral + i) % n]);
  }
  return ids;
}

/**
 * 轮到谁行动：时间最靠后（落后）的先行动；
 * 时间相同时，**后到达（叠在上方）**的那位先行动。
 * 用 arrival 记录每位玩家最后一次落位的先后序号，人数 2 或更多都成立。
 */
function activePlayerIndex(state) {
  let best = -1;
  for (const p of state.players) {
    if (best < 0) { best = p.index; continue; }
    const b = state.players[best];
    if (p.time < b.time) best = p.index;
    else if (p.time === b.time && state.arrival[p.index] > state.arrival[best]) best = p.index;
  }
  return best;
}

/** 记录某位玩家刚落位，用于上面那条「同格谁在上」的判定 */
function markArrival(state, playerIndex) {
  state.moveSeq += 1;
  state.arrival[playerIndex] = state.moveSeq;
}

/**
 * 现在到底该谁动手：有待放置的皮革补丁时，只有那个人能操作（且必须操作）；
 * 否则就是时间最落后的那位。服务端判定归属、前端高亮，都用这一条。
 */
function currentPlayerIndex(state) {
  if (state.pendingLeather.length) return state.pendingLeather[0].player;
  return activePlayerIndex(state);
}

function isGameOver(state) {
  return state.players.every((p) => p.finished);
}

/** 结算时间板事件：从 from 前进到 to（含 to），返回事件列表 */
function resolveTimeEvents(state, player, from, to) {
  const events = [];
  for (let space = from + 1; space <= to; space += 1) {
    const kind = TIME_BOARD[space];
    if (kind === 'income') {
      player.buttons += player.incomeIcons;
      events.push({ type: 'income', space, gained: player.incomeIcons, player: player.index });
    } else if (kind === 'leather' && !state.leatherClaimed[space]) {
      state.leatherClaimed[space] = true;
      // 先登记待放置，落点由该玩家在下一步自行选择
      state.pendingLeather.push({ player: player.index, space });
      events.push({ type: 'leather', space, player: player.index });
    }
  }
  return events;
}

/** 玩家为待放置的 1x1 皮革补丁选择落点 */
function placeLeather(state, playerIndex, row, col) {
  const qi = state.pendingLeather.findIndex((x) => x.player === playerIndex);
  if (qi < 0) throw new Error('当前没有待放置的皮革补丁');
  const player = state.players[playerIndex];
  if (row < 0 || col < 0 || row >= BOARD_SIZE || col >= BOARD_SIZE) throw new Error('落点越界');
  if (player.board[row][col] !== null) throw new Error('该格已被占用');
  player.board[row][col] = { id: LEATHER.id, oriIndex: 0, leather: true };
  player.placed.push({ id: LEATHER.id, oriIndex: 0, row, col, leather: true });
  state.pendingLeather.splice(qi, 1);
  return { action: 'leatherPlaced', row, col };
}

function placeOnBoard(player, patch, oriIndex, row, col, isLeather) {
  if (isLeather) {
    // 皮革补丁由玩家自行选择落点，这里由调用方传入
    player.board[row][col] = { id: patch.id, oriIndex, leather: true };
    player.placed.push({ id: patch.id, oriIndex, row, col, leather: true });
    return;
  }
  const ori = patch.orientations[oriIndex];
  for (const [dr, dc] of ori.cells) {
    player.board[row + dr][col + dc] = { id: patch.id, oriIndex };
  }
  // 纽扣图标画在补丁的第一格上，前端据此渲染收益标记
  if (patch.income > 0) {
    const [fr, fc] = ori.cells[0];
    player.board[row + fr][col + fc].income = patch.income;
  }
  player.placed.push({ id: patch.id, oriIndex, row, col });
  player.incomeIcons += patch.income;
}

/**
 * 行动 A：前进到「你前面最近的那位玩家」前方一格并领纽扣。
 * - 两人时，你前面最近的玩家就是对手，行为和原版完全一致。
 * - 多人时取「所有时间 >= 你 的玩家里最靠后的那位」（含同格的人），
 *   因此不会出现一次跳过大半个赛场的情况。
 * - 如果你已经领先所有人（前面没人），这步不前进、也不领纽扣，只当作过牌。
 *   原实现会把你**倒着挪回去**，这是个 bug，这里一并用 max 挡住。
 */
function advance(state, playerIndex) {
  const player = state.players[playerIndex];
  let frontier = null;
  for (const p of state.players) {
    if (p.index === playerIndex) continue;
    if (p.time < player.time) continue;
    if (frontier === null || p.time < frontier) frontier = p.time;
  }
  const target = frontier === null ? player.time : Math.min(frontier + 1, LAST_SPACE);
  const gained = Math.max(0, target - player.time);
  const from = player.time;
  player.time = target;
  player.buttons += gained;
  const events = resolveTimeEvents(state, player, from, target);
  if (player.time >= LAST_SPACE && !player.finished) {
    player.finished = true;
    state.finishOrder.push(playerIndex);
  }
  if (gained > 0) markArrival(state, playerIndex);
  return {
    action: 'advance',
    gained,
    events: [{ type: gained > 0 ? 'advance' : 'pass', gained, player: playerIndex }].concat(events),
  };
}

/** 行动 B：买下并放置补丁 */
function buyPatch(state, playerIndex, patchId, oriIndex, row, col) {
  const player = state.players[playerIndex];
  const patch = PATCH_BY_ID.get(patchId);
  if (!patch) throw new Error('补丁不存在');
  const visible = visiblePatchIds(state);
  if (!visible.includes(patchId)) throw new Error('该补丁不在可选范围内');
  if (player.buttons < patch.cost) throw new Error('纽扣不足');
  const idx = state.circle.indexOf(patchId);
  if (idx < 0) throw new Error('补丁已被拿走');
  const ori = patch.orientations[oriIndex];
  if (!ori) throw new Error('朝向非法');
  if (!canPlaceCells(player.board, ori.cells, row, col)) throw new Error('放不下');

  player.buttons -= patch.cost;
  placeOnBoard(player, patch, oriIndex, row, col, false);
  state.circle.splice(idx, 1);
  // 中立指示物移动到被买走补丁的位置（买走后环缩短，索引自然指向下一块）
  state.neutral = idx % state.circle.length;

  const from = player.time;
  const target = Math.min(from + patch.time, LAST_SPACE);
  player.time = target;
  const events = resolveTimeEvents(state, player, from, target);

  // 7x7 奖励牌全场只有一块，先拼出来的人独占（原版规则）。
  // 注意必须显式比 null —— 座位号 0 是 falsy，用 !bonusTileOwner 判会被 0 号骗过去。
  if (state.bonusTileOwner === null && hasFilledSquare(player.board, 7)) {
    state.bonusTileOwner = playerIndex;
    player.hasBonusTile = true;
    events.push({ type: 'bonusTile', player: playerIndex });
  }
  if (player.time >= LAST_SPACE && !player.finished) {
    player.finished = true;
    state.finishOrder.push(playerIndex);
  }
  markArrival(state, playerIndex);
  return {
    action: 'patch',
    patchId,
    events: [{ type: 'buy', patchId, player: playerIndex, cost: patch.cost, time: patch.time }].concat(events),
  };
}

/**
 * 开一局。players 可以是 ['甲','乙'] 这样的名字数组，
 * 也可以是 [{ name, bot }] —— 多人局和人机局都走这一条。
 */
function createGame(players, rng = Math.random) {
  const raw = (players && players.length ? players : ['玩家一', '玩家二']);
  const list = raw.map((p) => (typeof p === 'string' ? { name: p } : (p || {})));
  const state = {
    circle: buildCircle(rng),
    neutral: 0, // 中立指示物夹在 circle[length-1] 与 circle[0] 之间；可见的是 0,1,2
    players: list.map((p, i) => createPlayer(p.name, i, p.bot)),
    leatherClaimed: TIME_BOARD.map((k) => k !== 'leather'),
    pendingLeather: [], // 已获得但还没选落点的 1x1 皮革补丁
    bonusTileOwner: null,
    finishOrder: [],
    /** 每位玩家最后一次落位的先后序号（同格时判定谁在上） */
    arrival: list.map(() => 0),
    moveSeq: 0,
    turnCount: 0,
    log: [],
  };
  return state;
}

/** 当前玩家的全部合法动作 */
function legalActions(state) {
  if (isGameOver(state)) return [];
  // 若有待放置的皮革补丁，必须先选落点
  const pending = state.pendingLeather[0];
  if (pending) {
    const player = state.players[pending.player];
    const cells = [];
    for (let r = 0; r < BOARD_SIZE; r += 1) {
      for (let c = 0; c < BOARD_SIZE; c += 1) {
        if (player.board[r][c] === null) cells.push({ type: 'leather', player: pending.player, row: r, col: c });
      }
    }
    return cells;
  }
  const pi = activePlayerIndex(state);
  const player = state.players[pi];
  const actions = [{ type: 'advance', player: pi }];
  visiblePatchIds(state).forEach((id) => {
    const patch = PATCH_BY_ID.get(id);
    if (player.buttons < patch.cost) return;
    patch.orientations.forEach((ori, oriIndex) => {
      for (let r = 0; r + ori.rows <= BOARD_SIZE; r += 1) {
        for (let c = 0; c + ori.cols <= BOARD_SIZE; c += 1) {
          if (canPlaceCells(player.board, ori.cells, r, c)) {
            actions.push({ type: 'patch', player: pi, patchId: id, oriIndex, row: r, col: c });
          }
        }
      }
    });
  });
  return actions;
}

function score(state, playerIndex) {
  const player = state.players[playerIndex];
  const empty = emptySpaces(player.board);
  const bonus = player.hasBonusTile ? SEVEN_BY_SEVEN_BONUS : 0;
  return {
    buttons: player.buttons,
    bonus,
    empty,
    penalty: empty * EMPTY_PENALTY,
    total: player.buttons + bonus - empty * EMPTY_PENALTY,
  };
}

/**
 * 终局结算，支持任意人数。
 * winner 为 null 表示真·并列第一（总分相同、且到达终点的先后也一样）。
 * ranking 是按名次排好的座位号，前端直接照着渲染排行榜。
 */
function finalResult(state) {
  const scores = state.players.map((p, i) => score(state, i));
  const rankOfFinish = (i) => {
    const k = state.finishOrder.indexOf(i);
    return k < 0 ? Number.MAX_SAFE_INTEGER : k;
  };

  const order = state.players.map((p) => p.index).sort((a, b) => {
    if (scores[b].total !== scores[a].total) return scores[b].total - scores[a].total;
    return rankOfFinish(a) - rankOfFinish(b); // 同分看谁先到终点
  });

  const top = order[0];
  const second = order[1];
  let winner = top;
  if (second !== undefined && scores[second].total === scores[top].total &&
      rankOfFinish(second) === rankOfFinish(top)) {
    winner = null; // 真并列
  }

  return { scores, winner, ranking: order, finishOrder: state.finishOrder.slice() };
}

module.exports = {
  createGame,
  activePlayerIndex,
  currentPlayerIndex,
  isGameOver,
  legalActions,
  visiblePatchIds,
  advance,
  buyPatch,
  placeLeather,
  score,
  finalResult,
  hasFilledSquare,
  emptySpaces,
  hasAnyLegalPlacement,
  legalPlacements,
  PATCH_BY_ID,
};
