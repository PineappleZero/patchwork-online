'use strict';

/*
 * 电脑对手。
 *
 * 三档难度：
 *   easy   随手乱下，只看眼前收益，噪声很大 —— 给新手找自信。
 *   normal 目标只有一个：**看起来像个会玩的人** ——
 *          会挑收益高、好拼的补丁，会躲开拼不上的孤格，也不会傻到一直往前冲。
 *   hard   真的想赢。在 normal 的评估函数上做三件事：
 *            ① 评估函数更细（形状贴合度、续拼空间、纽扣的时间价值曲线、终局预判）；
 *            ② 加一层前瞻 —— 试算「我买这块」之后，对手最优的一步会怎么样；
 *            ③ 完全不抖随机数，同样的局面永远下同一步。
 *
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
/* let 而不是 const：进化脚本（evolve-ai.js）要在运行时换权重找更强的 hard。
   正常对局永远用默认值，只有显式 setWeights 才会变。 */
let W = {
  income: 6.5,  // 每点纽扣收益：之后每次经过纽扣格都能收，是复利
  cell: 2.0,    // 每覆盖一格
  cost: 1.0,    // 每花掉 1 个纽扣
  time: 1.1,    // 每消耗 1 点时间（约等于少一轮）
  dead: 4.0,    // 每新增一个填不进去的死格
  seven: 28,    // 拼出完整 7x7
};

/* hard 在 W 之上再追加的一组项 —— 单位对齐「分」（同样可被进化脚本覆盖） */
let HW = {
  fit: 1.5,        // 落点与已有布块的贴合（每一条共享边）
  pocket: 0.9,     // 填进「只剩这一处能塞」的角落，救回一个原本的死格
  fragment: 1.2,   // 每新增一块「孤立的小空洞」（面积 1~2），是未来填不满的前兆
  span: 0.55,      // 每减少一栏/一行跨度，板子更方正
  nopick: 5.0,     // 预算里没算到的一块补丁被抢走的估值损失（前瞻用）
};

/** 复制一份拼布板（board 是 9×9，每格 null 或 {id,...}） */
function cloneBoard(board) {
  return board.map((row) => row.slice());
}

/* —— 进化/调参专用（evolve-ai.js 用；正常对局不会调用）—— */
function getWeights() {
  return { W: { ...W }, HW: { ...HW } };
}

function setWeights(next) {
  W = { ...W, ...next.W };
  HW = { ...HW, ...next.HW };
}

/** 把一块补丁按朝向写到副本上，返回新副本 */
function boardWith(player, patch, ori, row, col) {
  const board = cloneBoard(player.board);
  for (const [dr, dc] of ori.cells) board[row + dr][col + dc] = { id: patch.id };
  return board;
}

/** 与已有布块共享的边数：贴得越紧，越不容易留下缝 */
function sharedEdges(board) {
  let n = 0;
  for (let r = 0; r < BOARD_SIZE; r += 1) {
    for (let c = 0; c < BOARD_SIZE; c += 1) {
      if (board[r][c] === null) continue;
      if (r + 1 < BOARD_SIZE && board[r + 1][c] !== null) n += 1;
      if (c + 1 < BOARD_SIZE && board[r][c + 1] !== null) n += 1;
    }
  }
  return n;
}

/** 空洞块统计：把空格连通块分成面积，返回 { little, big } 的加权碎片代价 */
function holeFragmentation(board) {
  const seen = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(false));
  let cost = 0;
  for (let r = 0; r < BOARD_SIZE; r += 1) {
    for (let c = 0; c < BOARD_SIZE; c += 1) {
      if (board[r][c] !== null || seen[r][c]) continue;
      // 洪水填充这个空洞
      const stack = [[r, c]];
      seen[r][c] = true;
      let size = 0;
      while (stack.length) {
        const [cr, cc] = stack.pop();
        size += 1;
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const rr = cr + dr;
          const cc2 = cc + dc;
          if (rr < 0 || cc2 < 0 || rr >= BOARD_SIZE || cc2 >= BOARD_SIZE) continue;
          if (seen[rr][cc2] || board[rr][cc2] !== null) continue;
          seen[rr][cc2] = true;
          stack.push([rr, cc2]);
        }
      }
      // 面积 1~2 的小洞最阴：基本注定填不满，最后每格罚 2 分
      if (size <= 2) cost += size;
      else if (size <= 4) cost += 1;
    }
  }
  return cost;
}

/** 被覆盖区域的行跨度 + 列跨度：越小说明拼得越紧凑（越不容易留缝） */
function spanOf(board) {
  let minR = BOARD_SIZE;
  let maxR = -1;
  let minC = BOARD_SIZE;
  let maxC = -1;
  for (let r = 0; r < BOARD_SIZE; r += 1) {
    for (let c = 0; c < BOARD_SIZE; c += 1) {
      if (board[r][c] === null) continue;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
    }
  }
  if (maxR < 0) return 0;
  return (maxR - minR) + (maxC - minC);
}

/** 终局还差几步时，空格罚分要打折 —— 未来收益有时间价值 */
function horizonFactor(state, player) {
  const left = LAST_SPACE - player.time;
  return Math.max(0.25, Math.min(1, left / 18));
}

/**
 * normal 的基础评估（供 easy/normal 用）。
 * 顺序保持和历史一致，别动它 —— 现有测试盯着 normal 的表现。
 */
function scoreBuyNormal(state, player, action, level) {
  const patch = engine.PATCH_BY_ID.get(action.patchId);
  const ori = patch.orientations[action.oriIndex];

  const board = boardWith(player, patch, ori, action.row, action.col);
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

/**
 * hard 的评估：在 normal 基础上再叠形状 / 结构 / 时间价值。
 * **不带随机**，所以同一局面可复现。
 *
 * `base` 是当前局面的「基线量」，由 boardStats() 预先算好传进来 ——
 * 一次决策里所有候选动作共用同一份基线，省掉成千上万次重复计算。
 */
function scoreBuyHard(state, player, action, base) {
  const patch = engine.PATCH_BY_ID.get(action.patchId);
  if (!patch) return -Infinity;
  const ori = patch.orientations[action.oriIndex];
  if (!ori) return -Infinity;
  const board = boardWith(player, patch, ori, action.row, action.col);

  const st = boardStats(board);
  const deadDelta = st.dead - base.dead;
  const grantsSeven = state.bonusTileOwner === null && st.has7;
  const hz = horizonFactor(state, player);

  let s = 0;
  s += patch.income * W.income;
  s += ori.cells.length * W.cell;
  s -= patch.cost * W.cost;
  s -= patch.time * W.time;
  s -= deadDelta * W.dead;
  if (grantsSeven) s += W.seven;

  // ① 形状贴合：鼓励贴着已有布块放，减少缝
  s += (st.edges - base.edges) * HW.fit;

  // ② 补空洞：新增碎洞要罚；「本来会死、现在被救活」的格子给点奖励
  s -= (st.frag - base.frag) * HW.fragment;
  if (deadDelta < 0) s += (-deadDelta) * HW.pocket;

  // ③ 方正度：跨度收得越紧越好（按棋盘比例缩放，避免压过主要项）
  s -= (st.span - base.span) * HW.span * (0.5 + 0.5 * hz);

  return s;
}

/** 一次算齐一块板子的全部结构指标（dead / frag / edges / span / has7） */
function boardStats(board) {
  return {
    dead: deadCells(board),
    frag: holeFragmentation(board),
    edges: sharedEdges(board),
    span: spanOf(board),
    has7: engine.hasFilledSquare(board, 7),
  };
}

/**
 * hard 的「局面价值」—— 直接朝真实计分靠，并尽量把「未来潜力」算准。
 *
 * 把当前局面当成终局算出净分（我 − 对手最高分），再叠未来潜力：
 *   · 剩余圈数里**真正还能填掉的空格**（扣掉彻底填不满的孤立小洞）
 *   · 已积累 income 按剩余圈数折算
 *   · 7×7 奖励的「临门一脚」
 *
 * ⚠️ 关键是把潜力算「准」而不是算「多」：如果给对手也灌一堆乐观潜力，
 * 净差会被抹平，hard 就变得不敢进攻。这里对**对手**的填格潜力打了折
 * （对手未必能吃到他要的补丁 —— 圈是共享的），所以 hard 更愿意抢。
 */
function positionValue(state, mySeat) {
  const rules = state.rules || {};
  const pen = rules.emptyPenalty || 2;
  const o = state.players[mySeat];
  const oScore = engine.score(state, mySeat).total;

  const mine = oScore + potentialOf(o);

  let bestOpp = -Infinity;
  for (const p of state.players) {
    if (p.index === mySeat) continue;
    const v = engine.score(state, p.index).total + potentialOf(p) * OPP_POTENTIAL;
    if (v > bestOpp) bestOpp = v;
  }
  if (bestOpp === -Infinity) bestOpp = 0;

  return mine - bestOpp;
}

/** 一块板子的「未来潜力」估值（绝对值，单位：分） */
function potentialOf(p) {
  const pen = 2;
  // 剩余轮数：每前进约 3.2 格算一轮（经验值）
  const roundsLeft = Math.max(0, LAST_SPACE - p.time) / 3.2;

  // 能被填掉的空格：扣掉「孤立小洞」——面积 ≤1 的死洞永远填不了，
  // 面积 2 的洞要靠一块恰好 2 格的补丁或皮革，成功率低，折半计。
  const empty = engine.emptySpaces(p.board);
  const useless = countUselessHoles(p.board);
  const useful = Math.max(0, empty - useless);
  const fillable = Math.min(useful, Math.round(roundsLeft * 2.6));
  const futureCover = fillable * pen;

  const futureIncome = p.incomeIcons * roundsLeft * 0.9;

  // 7×7 临门一脚：已经盖上大片、只差一点点时，这个奖励值得抢
  let sevenRush = 0;
  if (!p.hasBonusTile) {
    const deficit = sevenDeficit(p.board);
    if (deficit > 0 && deficit <= 6) sevenRush = (7 - deficit) * 4.5;
  }

  return futureCover + futureIncome + sevenRush;
}

/** 面积 ≤1 的孤立洞数量（这些格子几乎注定填不上，别把它算进潜力） */
function countUselessHoles(board) {
  const seen = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(false));
  let n = 0;
  for (let r = 0; r < BOARD_SIZE; r += 1) {
    for (let c = 0; c < BOARD_SIZE; c += 1) {
      if (board[r][c] !== null || seen[r][c]) continue;
      const stack = [[r, c]];
      seen[r][c] = true;
      let size = 0;
      while (stack.length) {
        const [cr, cc] = stack.pop();
        size += 1;
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const rr = cr + dr; const cc2 = cc + dc;
          if (rr < 0 || cc2 < 0 || rr >= BOARD_SIZE || cc2 >= BOARD_SIZE) continue;
          if (seen[rr][cc2] || board[rr][cc2] !== null) continue;
          seen[rr][cc2] = true;
          stack.push([rr, cc2]);
        }
      }
      if (size <= 1) n += size;
      else if (size === 2) n += 1;   // 面积 2 的小洞只算半格「没救」
    }
  }
  return n;
}

/** 还差多少格才能凑出 7×7（返回 0 表示已经够或没戏；用于「临门一脚」判断） */
function sevenDeficit(board) {
  let best = 49;   // 最多需要 49 格
  for (let r0 = 0; r0 + 7 <= BOARD_SIZE; r0 += 1) {
    for (let c0 = 0; c0 + 7 <= BOARD_SIZE; c0 += 1) {
      let miss = 0;
      for (let r = r0; r < r0 + 7 && miss < best; r += 1) {
        for (let c = c0; c < c0 + 7; c += 1) {
          if (board[r][c] === null) miss += 1;
        }
      }
      if (miss < best) best = miss;
    }
  }
  return best;
}

/** 局面的「己方基线」——用于把增量算成绝对值的差值 */
function baseStats(player) {
  return boardStats(player.board);
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

/** hard 版「跳过」：把「领纽扣后每轮还收多少」算进去 */
function scoreAdvanceHard(state, player) {
  let frontier = null;
  for (const p of state.players) {
    if (p.index === player.index) continue;
    if (p.time < player.time) continue;
    if (frontier === null || p.time < frontier) frontier = p.time;
  }
  if (frontier === null) return -999;
  const target = Math.min(frontier + 1, LAST_SPACE);
  const gained = Math.max(0, target - player.time);

  let s = gained * 1.0;
  // 领纽扣的直接收益：这一趟会经过多少纽扣格 × 每格收入（折扣算，别为贪它不买牌）
  const income = player.incomeIcons;
  s += gained * income * 0.18;
  // 手头紧时才值得跳过；宽裕时跳过基本是浪费一次落子机会
  if (player.buttons <= 3) s += 8;
  else if (player.buttons <= 5) s += 3;
  if (player.buttons >= 10) s -= 5;
  if (player.buttons >= 14) s -= 4;
  // 领先太多还空跑，只会给对手让时间
  const maxOther = Math.max(...state.players.filter((p) => p.index !== player.index).map((p) => p.time));
  if (player.time > maxOther + 3) s -= 4;
  if (target >= LAST_SPACE - 6) s -= 5;
  return s;
}

/**
 * 局面「终局分估计」：把当前局面当成现在就结束，
 * 直接调 engine.score()。这样纽扣、空格罚分、7×7 奖励的
 * 相对权重完全跟真实计分一致 —— 比手调权重可靠得多。
 *
 * 但直接用它当唯一判据会变成「绝不买牌」（买牌立刻扣钱、盖的格子
 * 要到最后才值钱），所以最终打分是：
 *    评估分 = 静态增量分（保证会买牌） + 一个"结构分"（保证拼得好）
 * 见 scoreBuyHard / chooseAction。
 */
function estimateTotal(state, player) {
  try {
    return engine.score(state, player.index).total;
  } catch (e) {
    return 0;
  }
}

/** 单动作（无前瞻）打分，hard 用。base 可省略，省了就地现算（慢一点但正确） */
function evalActionHard(state, player, a, base) {
  if (a.type === 'advance') return scoreAdvanceHard(state, player);
  if (a.type === 'leather') {
    // 待放置的皮革补丁：只在 pendingLeather 时出现，粗略算「盖住一格」
    return W.cell;
  }
  const patch = engine.PATCH_BY_ID.get(a.patchId);
  if (!patch) return -Infinity;   // 补丁不在册（理论上不会）——判死，别让整轮崩掉
  if (!patch.orientations[a.oriIndex]) return -Infinity;
  return scoreBuyHard(state, player, a, base || baseStats(player));
}

/**
 * hard 的搜索（v1.6.7 加强版）—— 交替极大极小的递归 + Alpha-Beta 剪枝。
 *
 * 语义：
 *   · 轮到我  → 取「让我净分最大」的一手（max）
 *   · 轮到对手 → 取「让我净分最小」的一手（min，真对抗）
 *   · 到达层数上限 → 用 positionValue 给局面定价（叶节点）
 *
 * 与 v1.6.6 的差别：
 *   · 对手的回应**按「压低我的净分」选**（真 min），不再拿对手静态分当代理；
 *   · 递归多轮（我 → 对手 → 我 → …），并用 **Alpha-Beta 剪枝**把深层搜索压到
 *     可接受的开销内 —— 这让「加深一层」真的能落地，而不是被预算砍回浅层。
 *
 * 返回「走这步之后我能拿到的净分」，越大越好。
 */
function searchValue(state, mySeat, action, depth) {
  const d = depth === undefined ? SEARCH_DEPTH : depth;
  const sim = simulate(state, action);
  if (!sim) return -Infinity;
  return evalPosition(sim, mySeat, d, -Infinity, Infinity);
}

/**
 * Alpha-Beta：给局面估价。alpha = 我方能保证的下界，beta = 对手能保证的上界。
 * 剪枝后深层搜索的开销大幅下降，depth 4~5 才跑得动。
 *
 * 叶节点统一用 positionValue（绝对净分）—— 搜索内部比较必须同尺度，
 * 与静态分的混合只在**根节点**做（见 chooseAction），这样 alpha-beta 才成立。
 */
function evalPosition(state, mySeat, remaining, alpha, beta) {
  if (engine.isGameOver(state)) return positionValue(state, mySeat);

  const seat = engine.currentPlayerIndex(state);
  const actions = engine.legalActions(state);
  if (!actions.length) return positionValue(state, mySeat);
  if (remaining <= 0) return positionValue(state, mySeat);

  const iAmToMove = seat === mySeat;
  const mover = state.players[seat];
  const base = baseStats(mover);
  const width = iAmToMove ? SELF_REPLY_TOP : OPP_REPLY_TOP;
  const coarse = actions
    .map((a) => ({ a, s: evalActionHard(state, mover, a, base) }))
    .sort((x, y) => y.s - x.s)
    .slice(0, width);

  if (iAmToMove) {
    let best = -Infinity;
    for (const { a } of coarse) {
      if (Date.now() > searchDeadline) break;
      const sim = simulate(state, a);
      if (!sim) continue;
      const v = evalPosition(sim, mySeat, remaining - 1, alpha, beta);
      if (v > best) best = v;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;            // 剪枝：对手不会让我走到这里
    }
    return best === -Infinity ? positionValue(state, mySeat) : best;
  }

  // 轮到对手：取最小
  let worst = Infinity;
  for (const { a } of coarse) {
    if (Date.now() > searchDeadline) break;
    const sim = simulate(state, a);
    if (!sim) continue;
    const v = evalPosition(sim, mySeat, remaining - 1, alpha, beta);
    if (v < worst) worst = v;
    if (worst < beta) beta = worst;
    if (alpha >= beta) break;              // 剪枝：我不会走让我更差的那条
  }
  return worst === Infinity ? positionValue(state, mySeat) : worst;
}

/**
 * 读环境变量里的数字参数（调参用）。
 * ⚠️ 浏览器（web/ 静态版）里没有 process —— v1.6.7 发布时这里直接写
 * `Number(process.env.XXX)`，pw-core.js 一加载就 ReferenceError，
 * 静态版「人机对战点不开」。必须走这个助手：浏览器里安全落到默认值。
 */
function envNum(name, fallback) {
  if (typeof process === 'undefined' || !process.env) return fallback;
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * 给**对手**未来潜力的折扣（1 = 完全承认，<1 = 打折）。
 * 圈是共享的，对手未必真能吃到他要的补丁，所以打折后 hard 更敢抢、
 * 不会因为「对手理论上也能填」就畏手畏脚。
 */
const OPP_POTENTIAL = envNum('PW_OPP_POT', 0.75);

/** 对手回应的候选上限（对手也要筛，不然多层会炸） */
const OPP_REPLY_TOP = envNum('PW_OPP_TOP', 16);

/** 轮到我时的候选上限（比对手那层更窄，成本更敏感） */
const SELF_REPLY_TOP = envNum('PW_SELF_TOP', 10);

/**
 * 搜索层数（我 → 对手 → 我 → …）。有 Alpha-Beta 剪枝兜着，
 * 6 层也跑得动；层数越多越强，超时由 searchDeadline 兜底。
 * 扫参实测（各 100 局）：6 层对 normal 80.0%，4 层（310 局合计）约 77%。
 */
const SEARCH_DEPTH = envNum('PW_DEPTH', 6);

/**
 * 当前这次决策的截止时刻（毫秒时间戳）。由 chooseAction 在开始搜索前设好，
 * searchValue / evalPosition 靠它「边搜边看表」避免卡顿。
 * 用模块级变量而不是层层传参，是为了少改签名、读写也便宜。
 */
let searchDeadline = Infinity;

/**
 * 在副本上执行一个动作，返回新 state。
 * engine 的 advance/buyPatch 都直接改传入的 state，所以就深拷一份再跑。
 */
function simulate(state, action) {
  let clone;
  try {
    clone = cloneState(state);
  } catch (e) {
    return null;
  }
  try {
    if (action.type === 'advance') engine.advance(clone, action.player);
    else engine.buyPatch(clone, action.player, action.patchId, action.oriIndex, action.row, action.col);
  } catch (e) {
    return null;
  }
  return clone;
}

/** 深拷贝局面（比 structuredClone 兼容性好，也不依赖 Node 版本） */
function cloneState(state) {
  const players = state.players.map((p) => ({
    index: p.index,
    name: p.name,
    bot: p.bot,
    buttons: p.buttons,
    time: p.time,
    board: cloneBoard(p.board),
    placed: p.placed.slice(),
    incomeIcons: p.incomeIcons,
    hasBonusTile: p.hasBonusTile,
    finished: p.finished,
  }));
  return {
    variant: state.variant,
    rules: state.rules,
    circle: state.circle.slice(),
    neutral: state.neutral,
    players,
    leatherClaimed: state.leatherClaimed.slice(),
    pendingLeather: state.pendingLeather.slice(),
    chaosPlan: state.chaosPlan,
    chaosSet: state.chaosSet,
    bonusTileOwner: state.bonusTileOwner,
    finishOrder: state.finishOrder.slice(),
    arrival: state.arrival.slice(),
    moveSeq: state.moveSeq,
    turnCount: state.turnCount,
    log: [],
  };
}

/**
 * 前瞻的候选上限。合法动作动辄数千个（33 块补丁 × 朝向 × 落点），
 * 全做前瞻要十几秒。先按静态分排序，只对前几名做前瞻 ——
 * 静态分已经很差的落点，前瞻也救不回来。
 */
const LOOKAHEAD_TOP = 80;

/**
 * hard 单步搜索的时间预算（毫秒）。
 * 正常局面 ~30ms 就搜完了；钱多、可选补丁多的大局面会膨胀到几百毫秒，
 * 超过这个上限就收缩候选宽度。500ms 是给六层深搜留的口子，落子仍不至卡顿。
 */
const TIME_BUDGET_MS = envNum('PW_BUDGET', 500);

/** 按合法动作规模挑初始候选宽度：动作越多，每个候选越贵，宽度就收小 */
function top0Width(actionCount) {
  if (actionCount > 2500) return 30;
  if (actionCount > 1200) return 50;
  return LOOKAHEAD_TOP;
}

/**
 * 静态分（增量式）与局面净分（绝对式）的混合比例。
 *
 *   value = MIX × 静态增量分 + (1 − MIX) × 局面净分
 *
 * 两者量级差很多（静态分 ±30 上下，净分 ±60 上下），所以先各自
 * 归一化到「本批候选里的相对排名」再混 —— 见 chooseAction 里的 z-score。
 * MIX 由实测扫描确定，越大越偏「该买就买」，越小越偏「算细账」。
 */
const MIX = envNum('PW_MIX', 0.55);

/** 归一化：把一组数变成 z-score（均值 0、标准差 1）；全相等时返回全 0 */
function zscores(arr) {
  const n = arr.length;
  if (!n) return [];
  let mean = 0;
  for (const x of arr) mean += x;
  mean /= n;
  let varSum = 0;
  for (const x of arr) varSum += (x - mean) * (x - mean);
  const sd = Math.sqrt(varSum / n);
  if (sd < 1e-9) return arr.map(() => 0);
  return arr.map((x) => (x - mean) / sd);
}

/** 挑一个动作：买补丁 or 跳过 */
function chooseAction(state, playerIndex, level) {
  const player = state.players[playerIndex];
  const actions = engine.legalActions(state);
  if (!actions.length) return null;

  if (level === 'hard') {
    const base = baseStats(player);
    // 第一轮：静态分排序，只把「看着还行」的挑进搜索（数千个动作不可能全搜）
    const scored = actions.map((a) => ({ a, s: evalActionHard(state, player, a, base) }));
    scored.sort((x, y) => y.s - x.s);

    /*
     * 第二轮：两层搜索 + 静态分混合。
     *
     * 纯两层搜索（叶节点用 positionValue）实测「求稳」过头 ——
     * 它会把空格留多、指望对手也留空，结果对 normal 只有 69% 胜率。
     * 所以这里把两者**加权混合**：
     *   · 静态分（增量式）保证「该买的牌一定买、该盖的格一定盖」；
     *   · positionValue 净差（绝对式）保证「买哪块、盖哪里」更贴近终局胜负。
     * 两个量量级不同，先各自 z-score 归一化再按 MIX 混。
     *
     * ⚠️ 时间预算：钱多的时候合法动作能到几千个，固定宽度最慢近 1 秒，
     * 玩家会明显感觉卡。所以边搜边看表，超时就**收缩候选宽度**
     * （已搜过的分数照样保留，只是不再往里加），保证单步 ≤ ~350ms。
     */
    const deadline = Date.now() + TIME_BUDGET_MS;
    searchDeadline = deadline;   // 供 searchValue / evalPosition 内部看表
    const width = Math.max(6, Math.min(LOOKAHEAD_TOP, top0Width(actions.length)));
    const top = scored.slice(0, width);

    const rawS = top.map((t) => t.s);
    const rawA = [];
    for (const { a } of top) {
      rawA.push(searchValue(state, playerIndex, a));
      if (Date.now() > deadline) break;   // 超时就停，剩下的不再搜
    }
    searchDeadline = Infinity;
    // 没搜完的候选按「静态分」兜底，避免它们被当成 -Infinity 直接淘汰
    while (rawA.length < top.length) rawA.push(null);
    const zS = zscores(rawS);
    const filledA = rawA.map((x) => (x === null ? NaN : x));
    const zA = zscores(filledA.filter((x) => !Number.isNaN(x)));
    let zi = 0;
    const zAfull = filledA.map((x) => (Number.isNaN(x) ? 0 : zA[zi++]));

    let best = top[0].a;
    let bestScore = -Infinity;
    for (let i = 0; i < top.length; i += 1) {
      // 没搜到深度的候选（zAfull 记 0）只吃静态分那一半，不会凭空占优
      const v = MIX * zS[i] + (1 - MIX) * zAfull[i];
      if (v > bestScore) { bestScore = v; best = top[i].a; }
    }
    return best;
  }

  let best = null;
  let bestScore = -Infinity;
  actions.forEach((a) => {
    const s = a.type === 'advance'
      ? scoreAdvance(state, player, level)
      : scoreBuyNormal(state, player, a, level);
    if (s > bestScore) { bestScore = s; best = a; }
  });
  return best;
}

/**
 * 皮革补丁落点：优先填「会被彻底围死」的格子，
 * 其次挑周围已有补丁最多的位置，让拼布板尽量方正。
 *
 * hard 额外看：填完之后剩下的小空洞会不会变少 / 跨度会不会收窄。
 */
function chooseLeatherCell(state, playerIndex, level) {
  const player = state.players[playerIndex];
  const board = player.board;
  let best = null;
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

      if (level === 'hard') {
        // 在副本上放下这枚皮革，看结构变化
        const board2 = cloneBoard(board);
        board2[r][c] = { id: 'h' };
        const fragDelta = holeFragmentation(board2) - holeFragmentation(board);
        const spanDelta = spanOf(board2) - spanOf(board);
        s -= fragDelta * 6;
        s -= spanDelta * 1.2;
        s -= Math.random() * 0.001;   // 只做零头打破并列，不吃掉主判据
      } else {
        s += Math.random() * 0.4;
      }
      if (s > bestScore) { bestScore = s; best = { row: r, col: c }; }
    }
  }
  // 整块板子已经填满：没有合法落点。返回 null，让调用方跳过这一步，
  // 否则会拿初值 (0,0) 去放 —— 那里必然已被占用，引擎会抛「该格已被占用」。
  return best;
}

/** 合法难度值；`normalizeLevel` 把任何输入收敛到这三档之一（默认 normal） */
const LEVELS = ['easy', 'normal', 'hard'];

/** 把外部传来的难度字符串收成合法值；认不出来的一律当 normal */
function normalizeLevel(level) {
  return LEVELS.includes(level) ? level : 'normal';
}

/**
 * 电脑对手在界面上显示的名字。
 * v1.6.7 起名字回归纯「wzzzhhhhh」—— 难度不再塞进名字里，
 * 改由界面在旁边挂一枚难度徽章（见 levelLabel），这样更好认、也不重复。
 */
function botName() {
  return 'wzzzhhhhh';
}

/** 难度的中文标签（给界面显示徽章用） */
function levelLabel(level) {
  const lv = normalizeLevel(level);
  if (lv === 'hard') return '困难';
  if (lv === 'easy') return '轻松';
  return '普通';
}

module.exports = {
  chooseAction,
  chooseLeatherCell,
  /* —— 进化/调参专用（正常对局用不到），实现见下方 getWeights/setWeights —— */
  getWeights,
  setWeights,
  scoreBuy: scoreBuyNormal,
  scoreBuyHard,
  scoreAdvance,
  scoreAdvanceHard,
  deadCells,
  holeFragmentation,
  sharedEdges,
  normalizeLevel,
  botName,
  levelLabel,
  LEVELS,
};
