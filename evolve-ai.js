'use strict';

/*
 * hard AI 权重进化脚本（路线①：权重爬山，不碰神经网络）。
 *
 * 原理：hard 的评估函数 = W(6 项) + HW(5 项) 共 11 个权重。
 * 让候选权重和现任冠军自对弈（种子不同 → 补丁圈洗牌不同 → 对局不同），
 * 胜率高者留任。每轮对每个权重试 ×1.3 / ÷1.3，逐坐标爬山。
 *
 * 关键实现：ai.js 的 W/HW 是模块级变量，同一局里两边要用不同权重，
 * 靠「轮到谁就临时换成谁的权重」实现 —— chooseAction 只在决策瞬间读权重。
 *
 * 用法：
 *   node evolve-ai.js bench            # 测一局 hard vs hard 多慢，定进化预算
 *   node evolve-ai.js evolve [轮数]    # 开始爬山
 */

/* 进化保持出厂深度 6（实测降深度不提速，瓶颈在候选动作评估不在搜索层）。
   注意必须在 require ai.js 之前设置（PW_DEPTH 在模块加载时读取）。 */
if (process.argv[2] === 'evolve') process.env.PW_DEPTH = process.env.PW_EVO_DEPTH || '6';

const engine = require('./server/engine');
const ai = require('./server/ai');

/* ------------------------- 种子随机数 ------------------------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------- 打一局 ------------------------- */
/** 出厂权重快照（对局会反复 setWeights，污染模块状态，必须在开局前抓） */
const FACTORY = ai.getWeights();

/** 返回 {winner, margin, moves}。seat0 用 wA，seat1 用 wB。 */
function playGame(seed, wA, wB) {
  const state = engine.createGame(
    [{ name: 'A', bot: true }, { name: 'B', bot: true }],
    mulberry32(seed),
  );
  let moves = 0;
  while (!engine.isGameOver(state) && moves < 2000) {
    moves += 1;
    const seat = engine.currentPlayerIndex(state);
    ai.setWeights(seat === 0 ? wA : wB); // 轮到谁就换上谁的权重
    if (state.pendingLeather.length) {
      const cell = ai.chooseLeatherCell(state, seat, 'hard');
      engine.placeLeather(state, seat, cell.row, cell.col);
    } else {
      const a = ai.chooseAction(state, seat, 'hard');
      if (!a) break;
      if (a.type === 'advance') engine.advance(state, seat);
      else engine.buyPatch(state, seat, a.patchId, a.oriIndex, a.row, a.col);
    }
  }
  const res = engine.finalResult(state);
  const s = res.scores.map((x) => x.total);
  return {
    winner: res.winner, // 0/1/null(平)
    margin: s[0] - s[1],
    moves,
  };
}

/**
 * 评估：候选 vs 冠军。每个种子打两局（候选先手/后手各一），
 * 消掉先手优势。返回 {pts, margin, games}，pts 每局胜 1 平 0.5 负 0。
 */
function evalWeights(cand, champ, seeds) {
  let pts = 0;
  let margin = 0;
  for (const seed of seeds) {
    const r0 = playGame(seed, cand, champ); // 候选执 0 号位
    const r1 = playGame(seed + 100000, champ, cand); // 候选执 1 号位
    if (r0.winner === 0) pts += 1; else if (r0.winner === null) pts += 0.5;
    if (r1.winner === 1) pts += 1; else if (r1.winner === null) pts += 0.5;
    margin += r0.margin - r1.margin; // 候选视角的分差
  }
  return { pts, margin, games: seeds.length * 2 };
}

/* ------------------------- 基准测速 ------------------------- */
function bench() {
  const w = ai.getWeights();
  const t0 = Date.now();
  const games = [];
  for (let i = 0; i < 3; i += 1) {
    games.push(playGame(1000 + i, w, w));
  }
  const dt = Date.now() - t0;
  console.log('hard vs hard 每局耗时 ≈', Math.round(dt / games.length), 'ms');
  console.log('对局样本:', JSON.stringify(games));
  console.log('按此速度，12 局评估 ≈', Math.round(dt / games.length * 12 / 1000), 's，22 个候选一轮 ≈', Math.round(dt / games.length * 12 * 22 / 1000 / 60), '分钟');
}

/* ------------------------- 爬山 ------------------------- */
function evolve(maxSweeps) {
  // 种子可通过 PW_SEEDS 换血（防对固定种子集过拟合），如 "11,22,33,44,55,66"
  const seeds = process.env.PW_SEEDS
    ? process.env.PW_SEEDS.split(',').map((x) => Number(x.trim())).filter(Number.isFinite)
    : [11, 22, 33, 44, 55, 66];
  // 时间保险丝：最多跑这么多分钟，防止后台任务无限挂
  const deadline = Date.now() + (Number(process.env.PW_MAX_MIN) || 110) * 60000;
  let champ = { W: { ...FACTORY.W }, HW: { ...FACTORY.HW } };
  // PW_START=checkpoint：从 evolved-weights.json 续训（通宵多轮用）
  if (process.env.PW_START === 'checkpoint') {
    try {
      const saved = JSON.parse(require('fs').readFileSync('evolved-weights.json', 'utf8'));
      champ = { W: { ...FACTORY.W, ...saved.W }, HW: { ...FACTORY.HW, ...saved.HW } };
      console.log('从存档续训：', JSON.stringify(champ));
    } catch (e) { console.log('无存档，从出厂权重开始'); }
  }
  const keys = [...Object.keys(champ.W), ...Object.keys(champ.HW)];
  const clamp = (v) => Math.max(0.05, Math.min(200, v));

  const base = evalWeights(champ, champ, seeds); // 恒为 50%，当自检
  console.log(`自检（自己打自己应≈50%）：${(base.pts / base.games * 100).toFixed(1)}%`);

  for (let sweep = 1; sweep <= maxSweeps; sweep += 1) {
    if (Date.now() > deadline) { console.log('\n时间到，提前收工。'); break; }
    console.log(`\n===== 第 ${sweep} 轮扫描（${new Date().toLocaleTimeString()}）=====`);
    let improved = false;
    for (const key of keys) {
      if (Date.now() > deadline) { console.log('时间到，提前收工。'); sweep = maxSweeps + 1; break; }
      for (const f of [1.3, 1 / 1.3]) {
        const cand = { W: { ...champ.W }, HW: { ...champ.HW } };
        const pool = key in cand.W ? cand.W : cand.HW;
        const v = clamp(pool[key] * f);
        if (Math.abs(v - pool[key]) < 1e-6) continue;
        pool[key] = v;
        const r = evalWeights(cand, champ, seeds);
        const rate = r.pts / r.games;
        // 接受门槛：12 局赢 ≥8（二项分布 p≈0.14，噪声可控）且分差为正；
        // 或压倒性 ≥9.5 分直接上位
        const accept = (r.pts >= 8 && r.margin > 0) || r.pts >= 9.5;
        const tag = `${key} ${f > 1 ? '×' : '÷'}1.3 → ${v.toFixed(2)}`;
        console.log(`  ${tag.padEnd(28)} 胜 ${(r.pts).toFixed(1)}/${r.games}  分差 ${r.margin}${accept ? '  ↑ 上位' : ''}`);
        if (accept) {
          champ = { W: cand.W, HW: cand.HW };
          improved = true;
          // 每次上位立即落盘，防中途崩掉全丢
          require('fs').writeFileSync('evolved-weights.json', JSON.stringify(champ, null, 2));
          console.log('  （已存档 evolved-weights.json）');
          break; // 这个权重已被接受，另一方向不用再试
        }
      }
    }
    if (!improved) {
      console.log('本轮无改进，收敛。');
      break;
    }
  }

  console.log('\n===== 最终权重 =====');
  console.log(JSON.stringify(champ, null, 2));
  require('fs').writeFileSync('evolved-weights.json', JSON.stringify(champ, null, 2));
  console.log('已写入 evolved-weights.json');

  // 深度 4 下的快速终验；真实线上配置（深度 6）用 verify 模式单独跑
  const bigSeeds = [];
  for (let i = 0; i < 10; i += 1) bigSeeds.push(7000 + i * 13);
  const fin = evalWeights(champ, FACTORY, bigSeeds);
  console.log(`快速终验（深度 4）vs 出厂权重：${fin.pts}/${fin.games}（${(fin.pts / fin.games * 100).toFixed(0)}%）分差 ${fin.margin}`);
}

/* ------------------------- 终验（出厂 6 深度） ------------------------- */
function verify() {
  const champ = JSON.parse(require('fs').readFileSync('evolved-weights.json', 'utf8'));
  const bigSeeds = [];
  for (let i = 0; i < 20; i += 1) bigSeeds.push(7000 + i * 13);
  const fin = evalWeights(champ, FACTORY, bigSeeds);
  console.log(`终验（深度 ${process.env.PW_DEPTH || 6}）vs 出厂权重：${fin.pts}/${fin.games}（${(fin.pts / fin.games * 100).toFixed(0)}%）分差 ${fin.margin}`);
}

/* ------------------------- 入口 ------------------------- */
if (process.argv[2] === 'bench') bench();
else if (process.argv[2] === 'evolve') evolve(Number(process.argv[3]) || 5);
else if (process.argv[2] === 'verify') verify();
else console.log('用法：node evolve-ai.js bench | evolve [轮数] | verify');
