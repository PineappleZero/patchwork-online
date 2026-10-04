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
 * 建立补丁环：中立指示物放在最小的 A 补丁之后，因此 A 排在第 0 位。
 */
function buildCircle(rng) {
  const rest = shuffle(PATCHES.filter((p) => p.id !== 'A').map((p) => p.id), rng);
  return ['A', ...rest];
}

function createPlayer(name, index) {
  return {
    index,
    name: name || (index === 0 ? '玩家一' : '玩家二'),
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

function activePlayerIndex(state) {
  const [p0, p1] = state.players;
  if (p0.time < p1.time) return 0;
  if (p1.time < p0.time) return 1;
  return state.topPlayer; // 同一格时，后到达（叠在上方）的玩家先行动
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

/** 行动 A：前进到对手前方一格并领纽扣 */
function advance(state, playerIndex) {
  const player = state.players[playerIndex];
  const other = state.players[1 - playerIndex];
  const target = Math.min(other.time + 1, LAST_SPACE);
  const gained = Math.max(0, target - player.time);
  const from = player.time;
  player.time = target;
  player.buttons += gained;
  const events = resolveTimeEvents(state, player, from, target);
  if (player.time >= LAST_SPACE && !player.finished) {
    player.finished = true;
    state.finishOrder.push(playerIndex);
  }
  state.topPlayer = playerIndex;
  return { action: 'advance', gained, events: [{ type: 'advance', gained, player: playerIndex }].concat(events) };
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

  if (!player.hasBonusTile && hasFilledSquare(player.board, 7)) {
    player.hasBonusTile = true;
    state.bonusTileOwner = playerIndex;
    events.push({ type: 'bonusTile', player: playerIndex });
  }
  if (player.time >= LAST_SPACE && !player.finished) {
    player.finished = true;
    state.finishOrder.push(playerIndex);
  }
  state.topPlayer = playerIndex;
  return {
    action: 'patch',
    patchId,
    events: [{ type: 'buy', patchId, player: playerIndex, cost: patch.cost, time: patch.time }].concat(events),
  };
}

function createGame(names, rng = Math.random) {
  const state = {
    circle: buildCircle(rng),
    neutral: 0, // 中立指示物位于 index-1（即最后一块之后）；可见的是 0,1,2
    players: [createPlayer(names && names[0], 0), createPlayer(names && names[1], 1)],
    leatherClaimed: TIME_BOARD.map((k) => k !== 'leather'),
    pendingLeather: [], // 已获得但还没选落点的 1x1 皮革补丁
    bonusTileOwner: null,
    finishOrder: [],
    topPlayer: 0,
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

function finalResult(state) {
  const scores = [score(state, 0), score(state, 1)];
  let winner = null;
  if (scores[0].total > scores[1].total) winner = 0;
  else if (scores[1].total > scores[0].total) winner = 1;
  else {
    const first = state.finishOrder[0];
    if (first !== undefined) winner = first;
  }
  return { scores, winner, finishOrder: state.finishOrder };
}

module.exports = {
  createGame,
  activePlayerIndex,
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
