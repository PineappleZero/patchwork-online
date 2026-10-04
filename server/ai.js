'use strict';

/*
 * 电脑对手。
 *
 * 不是什么棋力怪物，目标只有一个：**看起来像个会玩的人** ——
 * 会挑收益高、好拼的补丁，会躲开拼不上的孤格，也不会傻到一直往前冲。
 * 规则判定全部交给 engine，这里只负责「挑一个合法动作」。
 */

const engine = require('./engine');
const { BOARD_SIZE, LAST_SPACE } = require('./data');

/** 空格里有多少是「死格」：四邻都被占死，任何补丁都填不进去（1x1 皮革除外） */
function deadCells(board) {
  let n = 0;
  for (let r = 0; r < BOARD_SIZE; r += 1) {
    for (let c = 0; c < BOARD_SIZE; c += 1) {
      if (board[r][c] !== null) continue;
      const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      const free = nb.filter(([dr, dc]) => {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= BOARD_SIZE || cc >= BOARD_SIZE) return false;
        return board[rr][cc] === null;
      });
      if (free.length === 0) n += 1;
    }
  }
  return n;
}

/*
 * 打分用的权重。单位统一成「分」：
 * 终局每格空格扣 2 分，所以盖住一格 ≈ +2 分，1 个纽扣 ≈ 1 分。
 * 注意所有项目都必须是**增量** —— 一旦放绝对值（比如「当前总空格数」），
 * 每块补丁都会得一个巨大的负数，AI 就永远不买了。
 */
const W = {
  income: 6.5,  // 每点纽扣收益：之后每次经过纽扣格都能收，是复利
  cell: 2.0,    // 每覆盖一格
  cost: 1.0,    // 每花掉 1 个纽扣
  time: 1.1,    // 每消耗 1 点时间（约等于少一轮）
  dead: 4.0,    // 每新增一个填不进去的死格
  seven: 28,    // 拼出完整 7x7
};

/** 评估「买下这块补丁并放在这里」值不值 */
function scoreBuy(state, player, action, level) {
  const patch = engine.PATCH_BY_ID.get(action.patchId);
  const ori = patch.orientations[action.oriIndex];

  // 在副本上模拟落子
  const board = player.board.map((row) => row.slice());
  for (const [dr, dc] of ori.cells) board[action.row + dr][action.col + dc] = { id: patch.id };

  const deadDelta = deadCells(board) - deadCells(player.board);
  const grantsSeven = state.bonusTileOwner === null && engine.hasFilledSquare(board, 7);

  let s = 0;
  s += patch.income * W.income;
  s += ori.cells.length * W.cell;
  s -= patch.cost * W.cost;
  s -= patch.time * W.time;
  s -= deadDelta * W.dead;
  if (grantsSeven) s += W.seven;

  if (level === 'easy') s += (Math.random() - 0.5) * 26;
  else s += (Math.random() - 0.5) * 3;         // 一点点抖动，别每局一模一样
  return s;
}

/** 评估「跳过领纽扣」 */
function scoreAdvance(state, player, level) {
  let frontier = null;
  for (const p of state.players) {
    if (p.index === player.index) continue;
    if (p.time < player.time) continue;
    if (frontier === null || p.time < frontier) frontier = p.time;
  }
  if (frontier === null) return -999;          // 已经领先全场，跳过毫无意义
  const target = Math.min(frontier + 1, LAST_SPACE);
  const gained = Math.max(0, target - player.time);

  let s = gained * 1.0;
  // 手头太紧时更想领纽扣，宽裕时更想拼板子
  if (player.buttons <= 4) s += 5;
  if (player.buttons >= 12) s -= 3;
  // 快走到终点了就别再空跑，早点结束能少给对手机会
  if (target >= LAST_SPACE - 6) s -= 4;
  if (level === 'easy') s += (Math.random() - 0.5) * 18;
  else s += (Math.random() - 0.5) * 3;
  return s;
}

/** 挑一个动作：买补丁 or 跳过 */
function chooseAction(state, playerIndex, level) {
  const player = state.players[playerIndex];
  const actions = engine.legalActions(state);
  let best = null;
  let bestScore = -Infinity;

  actions.forEach((a) => {
    const s = a.type === 'advance'
      ? scoreAdvance(state, player, level)
      : scoreBuy(state, player, a, level);
    if (s > bestScore) { bestScore = s; best = a; }
  });
  return best;
}

/**
 * 皮革补丁落点：优先填「会被彻底围死」的格子，
 * 其次挑周围已有补丁最多的位置，让拼布板尽量方正。
 */
function chooseLeatherCell(state, playerIndex) {
  const board = state.players[playerIndex].board;
  let best = { row: 0, col: 0 };
  let bestScore = -Infinity;
  for (let r = 0; r < BOARD_SIZE; r += 1) {
    for (let c = 0; c < BOARD_SIZE; c += 1) {
      if (board[r][c] !== null) continue;
      const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      const free = nb.filter(([dr, dc]) => {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= BOARD_SIZE || cc >= BOARD_SIZE) return false;
        return board[rr][cc] === null;
      }).length;
      // 空格子填上一个能立刻消掉的，比什么都强
      let s = (free === 0 ? 12 : 0) + (4 - free) * 1.6;
      s += Math.random() * 0.4;
      if (s > bestScore) { bestScore = s; best = { row: r, col: c }; }
    }
  }
  return best;
}

module.exports = { chooseAction, chooseLeatherCell, scoreBuy, scoreAdvance, deadCells };
