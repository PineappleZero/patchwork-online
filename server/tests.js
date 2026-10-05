'use strict';

/*
 * 规则自测：验证引擎与 Patchwork 原版规则一致。
 * 运行：node tests.js
 */
const {
  PATCHES, TIME_BOARD, LEATHER_SPACES, INCOME_SPACES, LAST_SPACE, START_BUTTONS,
} = require('./data');
const engine = require('./engine');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else {
    fail += 1;
    failures.push(name + (extra ? ' -> ' + extra : ''));
    console.log('  FAIL  ' + name + (extra ? ' -> ' + extra : ''));
  }
}

function eq(name, actual, expected) {
  check(name, actual === expected, 'expected ' + expected + ', got ' + actual);
}

/**
 * 把某块补丁挪到中立指示物的正前方（可见的第一块）。
 * 补丁环每局随机，写「买某某补丁」这类针对性用例时得先把目标摆到可选位。
 */
function forceVisible(state, patchId) {
  const idx = state.circle.indexOf(patchId);
  if (idx >= 0) {
    state.circle.splice(idx, 1);
    state.circle.unshift(patchId);
  } else {
    state.circle.unshift(patchId);
  }
  state.neutral = 0;
  return state;
}

console.log('\n[1] 组件与数据');
eq('补丁总数 33', PATCHES.length, 33);
eq('补丁 id 唯一', new Set(PATCHES.map((p) => p.id)).size, 33);
eq('时间板总格 54（0..53）', TIME_BOARD.length, 54);
eq('皮革格 5 个', LEATHER_SPACES.length, 5);
eq('纽扣格 9 个', INCOME_SPACES.length, 9);
// 位置也要逐一对上，光看数量容易被"数量对但位置错"骗过去
eq('皮革格位置', LEATHER_SPACES.join(','), '20,26,32,44,50');
eq('纽扣格位置', INCOME_SPACES.join(','), '5,11,17,23,29,35,41,47,53');
// 终点格本身就是最后一枚纽扣格，所以抵达中央时会收最后一次收益
eq('终点格同时是纽扣格', INCOME_SPACES.includes(LAST_SPACE), true);
// 皮革格永远夹在相邻两枚纽扣格正中间
check('皮革格都落在两枚纽扣格中间', LEATHER_SPACES.every(
  (s) => INCOME_SPACES.includes(s - 3) && INCOME_SPACES.includes(s + 3)
));
check('皮革格与纽扣格不重叠', LEATHER_SPACES.every((s) => !INCOME_SPACES.includes(s)));

const sizes = PATCHES.map((p) => p.size);
check('补丁覆盖格数在 2~8', Math.min(...sizes) >= 2 && Math.max(...sizes) <= 8,
  'min=' + Math.min(...sizes) + ' max=' + Math.max(...sizes));
check('补丁按钮成本 0~10', PATCHES.every((p) => p.cost >= 0 && p.cost <= 10));
check('补丁时间成本 1~6', PATCHES.every((p) => p.time >= 1 && p.time <= 6));
check('补丁收益 0~3', PATCHES.every((p) => p.income >= 0 && p.income <= 3));
eq('最小的补丁是 2 格（A）', PATCHES.find((p) => p.size === 2).id, 'A');
check('所有补丁都生成了至少 1 种朝向', PATCHES.every((p) => p.orientations.length >= 1));

const oneByOne = PATCHES.filter((p) => p.size === 1);
eq('普通补丁中没有 1x1', oneByOne.length, 0);

console.log('\n[2] 朝向生成（旋转 + 镜像 + 去重）');
const A = PATCHES.find((p) => p.id === 'A'); // 1x2 多米诺
eq('1x2 去重后应为 2 种朝向', A.orientations.length, 2);
const I = PATCHES.find((p) => p.id === 'I'); // 2x2 正方形
eq('2x2 正方形去重后应为 1 种朝向', I.orientations.length, 1);
const M = PATCHES.find((p) => p.id === 'M'); // 1x4 长条
eq('1x4 去重后应为 2 种朝向', M.orientations.length, 2);
const T = PATCHES.find((p) => p.id === 'T'); // 四向对称的十字形
eq('十字形去重后应为 1 种朝向', T.orientations.length, 1);
const E = PATCHES.find((p) => p.id === 'E'); // S/Z 形
eq('S 形去重后应为 4 种朝向', E.orientations.length, 4);
const F = PATCHES.find((p) => p.id === 'F'); // 手性 L 形
eq('手性 L 形去重后应为 8 种朝向', F.orientations.length, 8);
check('朝向内格子数守恒', PATCHES.every((p) =>
  p.orientations.every((o) => o.cells.length === p.size)));
check('所有朝向都落在自身包围盒内', PATCHES.every((p) => p.orientations.every((o) =>
  o.cells.every(([r, c]) => r >= 0 && c >= 0 && r < o.rows && c < o.cols))));

console.log('\n[3] 开局状态');
const g1 = engine.createGame(['甲', '乙']);
eq('双方起始纽扣 5', g1.players[0].buttons + g1.players[1].buttons, START_BUTTONS * 2);
eq('双方起始时间 0', g1.players[0].time + g1.players[1].time, 0);
check('补丁环一共 33 块、每块只出现一次',
  new Set(g1.circle).size === g1.circle.length && g1.circle.length === PATCHES.length,
  `length=${g1.circle.length}`);
// 原版：中立指示物夹在 2×1 补丁与它顺时针方向下一块之间，所以 A 在环尾，开局不可选
eq('2×1 补丁排在环的最后一块', g1.circle[g1.circle.length - 1], 'A');
check('开局可见的三块里没有 2×1 补丁', !engine.visiblePatchIds(g1).includes('A'),
  engine.visiblePatchIds(g1).join(','));
eq('可见的三块就是环上前三块', engine.visiblePatchIds(g1).join(','), g1.circle.slice(0, 3).join(','));
eq('初始行动者为玩家 0', engine.activePlayerIndex(g1), 0);
eq('拼布板 9x9 全空', engine.emptySpaces(g1.players[0].board), 81);

console.log('\n[4] 回合顺序：时间落后方行动');
g1.players[0].time = 3;
g1.players[1].time = 7;
eq('时间落后的是玩家 0', engine.activePlayerIndex(g1), 0);
g1.players[0].time = 9;
eq('时间落后的换成玩家 1', engine.activePlayerIndex(g1), 1);
g1.players[0].time = 9;
g1.players[1].time = 9;
g1.arrival[1] = 99; // 玩家1 后到，叠在上面
eq('同格时叠在上方的玩家先动', engine.activePlayerIndex(g1), 1);

console.log('\n[5] 行动 A：前进到对手前方并领纽扣');
const g2 = engine.createGame(['甲', '乙']);
g2.players[1].time = 5;
const before = g2.players[0].buttons;
const r5 = engine.advance(g2, 0);
eq('落点为对手前 1 格（6）', g2.players[0].time, 6);
eq('依格数获得纽扣 6', g2.players[0].buttons - before, 6);
eq('行动类型为 advance', r5.action, 'advance');

console.log('\n[6] 时间板事件：纽扣收益');
const g3 = engine.createGame(['甲', '乙']);
const p = g3.players[0];
p.incomeIcons = 4;
p.time = 0;
p.buttons = 0;
engine.advance(g3, 0);
eq('未经过收益格则不收钱（只领移动格数）', p.buttons, 1);

const g3b = engine.createGame(['甲', '乙']);
const p3 = g3b.players[0];
p3.incomeIcons = 4;
p3.time = 5;
p3.buttons = 0;
g3b.players[1].time = 12;
engine.advance(g3b, 0);
// 对手在 12，落点为 13：位移 8 格（+8），途中经过纽扣格 11（+4）
eq('落点为对手前方一格', p3.time, 13);
eq('经过收益格按图标数收钱', p3.buttons, 8 + 4);

const g3c = engine.createGame(['甲', '乙']);
const p3c = g3c.players[0];
p3c.incomeIcons = 3;
p3c.time = 5;
p3c.buttons = 0;
g3c.players[1].time = 17;
engine.advance(g3c, 0);
// 对手在 17，落点为 18：位移 13 格（+13），途中经过纽扣格 11 与 17（+3 ×2）
eq('同一回合经过两个收益格则收两次', p3c.buttons, 13 + 6);

console.log('\n[7] 时间板事件：1x1 皮革补丁只归先到者');
const g4 = engine.createGame(['甲', '乙']);
const pa = g4.players[0];
pa.time = 0;
g4.players[1].time = 19;
engine.advance(g4, 0); // 走到 20：途中经过纽扣格 5/11/17，并踩到全板第一块皮革格 20
eq('待放置皮革补丁数为 1', g4.pendingLeather.length, 1);
eq('皮革格被标记已拿', g4.leatherClaimed[20], true);
const leatherActions = engine.legalActions(g4);
check('有皮革待放置时，合法动作只剩选落点', leatherActions.every((a) => a.type === 'leather'));
engine.placeLeather(g4, 0, 0, 0);
eq('皮革补丁落到指定格', g4.players[0].board[0][0] !== null, true);
eq('放置后待放置队列清空', g4.pendingLeather.length, 0);

const g5b = engine.createGame(['甲', '乙']);
g5b.players[0].time = 0;
const pb5 = g5b.players[1]; // 玩家 1 落后，由他行动
pb5.time = 0;
pb5.incomeIcons = 0;
const other5 = g5b.players[0];
other5.time = 29;
// 玩家 1 从 0 出发，会被推到对手前方一格（30），途中踩到 20 与 26 两块皮革

engine.advance(g5b, 1);
eq('到达对手前 1 格', pb5.time, 30);
eq('皮革格 20 与 26 被标记已拿', g5b.leatherClaimed[20] === true && g5b.leatherClaimed[26] === true, true);
eq('途中经过 20 与 26 两块皮革', g5b.pendingLeather.length, 2);

console.log('\n[7b] 对手经过同一皮革格不再获得');
const g5c = engine.createGame(['甲', '乙']);
const c0 = g5c.players[0];
const c1 = g5c.players[1];
c0.time = 0;
c1.time = 29;
c0.incomeIcons = 0;

engine.advance(g5c, 0); // 玩家0 被推到 30，一路拿走皮革 20 与 26
const gotByFirst = g5c.pendingLeather.length;
eq('先到者拿到 2 块皮革', gotByFirst, 2);
g5c.pendingLeather = [];
// 现在让玩家 1 也经过 20 和 26 这两格（构造：玩家1 退到 19，再被推到 31）
c1.time = 19;
c0.time = 30;

engine.advance(g5c, 1);
eq('后到者经过已领走的皮革格不会再获得', g5c.pendingLeather.length, 0);

console.log('\n[8] 行动 B：买下并放置补丁');
const g6 = engine.createGame(['甲', '乙']);
g6.players[0].buttons = 20;
forceVisible(g6, 'A'); // 把 2×1 摆到可选位再买
engine.buyPatch(g6, 0, 'A', 0, 0, 0);
eq('扣掉按钮成本 2', g6.players[0].buttons, 18);
eq('时间前进 1', g6.players[0].time, 1);
check('补丁已落在板上', g6.players[0].board[0][0] !== null && g6.players[0].board[1][0] !== null);
check('补丁已从环上移除', !g6.circle.includes('A'));
eq('中立指示物仍指向原 A 的位置', engine.visiblePatchIds(g6)[0], g6.circle[0]);
eq('买走的那块被删掉后环长 32', g6.circle.length, 32);

console.log('\n[9] 放置合法性');
const g7 = engine.createGame(['甲', '乙']);
g7.players[0].buttons = 50;
// 让玩家 0 保持在时间落后的状态，以便连续行动
g7.players[1].time = 0;
g7.players[0].time = -1; // 仅用于构造连续行动场景
forceVisible(g7, 'A');
engine.buyPatch(g7, 0, 'A', 0, 0, 0); // A 只前进 1 格，玩家 0 仍落后
const occupied = g7.players[0].board[0][0] !== null && g7.players[0].board[1][0] !== null;
eq('玩家 0 仍在时间落后位（可继续行动）', engine.activePlayerIndex(g7), 0);
// 明确用一块竖 3 格的补丁去撞 (0,0)，必然重叠
g7.players[0].buttons = 50;
forceVisible(g7, 'D');
let threw = false;
try { engine.buyPatch(g7, 0, 'D', 0, 0, 0); } catch (e) { threw = true; }
check('重叠放置被拒绝（0,0/1,0 已被占用）', occupied && threw);

const g7b = engine.createGame(['甲', '乙']);
g7b.players[0].buttons = 50;
forceVisible(g7b, 'A');
let threwOut = false;
try { engine.buyPatch(g7b, 0, 'A', 0, 8, 8); } catch (e) { threwOut = true; }
check('越界放置被拒绝', threwOut);

const g8 = engine.createGame(['甲', '乙']);
g8.players[0].buttons = 0;
forceVisible(g8, 'A'); // 让它有资格可选，测的才是「纽扣不足」而不是「不在可选范围」
let threw2 = false;
let threw2Msg = '';
try { engine.buyPatch(g8, 0, 'A', 0, 0, 0); } catch (e) { threw2 = true; threw2Msg = e.message; }
check('纽扣不足时无法购买', threw2 && threw2Msg.includes('纽扣'), threw2Msg);

const g9 = engine.createGame(['甲', '乙']);
g9.players[0].buttons = 50;
forceVisible(g9, 'A');
let threw3 = false;
try { engine.buyPatch(g9, 0, 'A', 0, 0, 0); } catch (e) { threw3 = true; }
check('可见范围内的补丁可以购买', threw3 === false);

console.log('\n[10] 买块顺序：中立指示物只前移不后退');
const g10 = engine.createGame(['甲', '乙']);
g10.players[0].buttons = 99;
g10.players[1].buttons = 99;
const firstVisible = engine.visiblePatchIds(g10)[0];
engine.buyPatch(g10, 0, firstVisible, 0, 0, 0);
const after = engine.visiblePatchIds(g10)[0];
check('拿走一块后可见补丁前移一位', after !== firstVisible);

console.log('\n[11] 7x7 奖励');
const g11 = engine.createGame(['甲', '乙']);
const board = g11.players[0].board;
for (let r = 0; r < 7; r += 1) for (let c = 0; c < 7; c += 1) board[r][c] = { id: 'I', oriIndex: 0 };
check('完整 7x7 被识别', engine.hasFilledSquare(board, 7));
board[6][6] = null;
check('有洞的 7x7 不被识别', !engine.hasFilledSquare(board, 7));

console.log('\n[12] 终局计分');
const g12 = engine.createGame(['甲', '乙']);
g12.players[0].buttons = 20;
g12.players[0].hasBonusTile = true;
g12.players[1].buttons = 30;
for (let r = 0; r < 9; r += 1) for (let c = 0; c < 9; c += 1) g12.players[0].board[r][c] = { id: 'I', oriIndex: 0 };
const s0 = engine.score(g12, 0);
const s1 = engine.score(g12, 1);
eq('玩家0 满板：无扣分', s0.empty, 0);
eq('玩家0 总分 = 20 + 7', s0.total, 27);
eq('玩家1 空板扣分 = 81*2', s1.penalty, 162);
eq('玩家1 总分 = 30 - 162', s1.total, -132);
const res = engine.finalResult(g12);
eq('玩家0 获胜', res.winner, 0);

console.log('\n[13] 平局由先抵达终点者获胜');
const g13 = engine.createGame(['甲', '乙']);
g13.players[0].buttons = 10;
g13.players[1].buttons = 10;
for (let r = 0; r < 9; r += 1) for (let c = 0; c < 9; c += 1) {
  g13.players[0].board[r][c] = { id: 'I', oriIndex: 0 };
  g13.players[1].board[r][c] = { id: 'I', oriIndex: 0 };
}
g13.finishOrder = [1, 0];
eq('先到者为玩家1', engine.finalResult(g13).winner, 1);

console.log('\n[14] 终局判定');
const g14 = engine.createGame(['甲', '乙']);
g14.players[0].time = LAST_SPACE;
g14.players[0].finished = true;
check('仅一方到终点时未结束', !engine.isGameOver(g14));
g14.players[1].time = LAST_SPACE;
g14.players[1].finished = true;
check('双方到达终点时结束', engine.isGameOver(g14));

console.log('\n[15] 时间前进不会越过终点');
const g15 = engine.createGame(['甲', '乙']);
g15.players[0].buttons = 99;
g15.players[0].time = 52;
const bigPatch = g15.circle.map((id) => engine.PATCH_BY_ID.get(id))
  .filter((pp) => pp.time >= 2 && pp.cost <= 99);
const visible = engine.visiblePatchIds(g15);
const target = visible.map((id) => engine.PATCH_BY_ID.get(id)).find((pp) => pp.time >= 2);
if (target) {
  const spot = engine.legalPlacements(g15.players[0].board, target)[0];
  engine.buyPatch(g15, 0, target.id, spot.oriIndex, spot.row, spot.col);
  eq('时间停在第 53 格', g15.players[0].time, LAST_SPACE);
} else {
  check('可见补丁中无可测试的时间≥2 的块（跳过）', true);
}

console.log('\n[16] 多人局：回合顺序');
const m1 = engine.createGame(['甲', '乙', '丙']);
eq('三人局人数正确', m1.players.length, 3);
eq('每人起始 5 纽扣', m1.players.every((p) => p.buttons === START_BUTTONS), true);
m1.players[0].time = 10; m1.players[1].time = 20; m1.players[2].time = 30;
eq('时间最靠后的先动', engine.activePlayerIndex(m1), 0);
m1.players[0].time = 30; m1.players[1].time = 30; m1.players[2].time = 30;
m1.arrival[0] = 1; m1.arrival[1] = 7; m1.arrival[2] = 3;
eq('三人同格时，最后到达的先动', engine.activePlayerIndex(m1), 1);
m1.players[2].time = 29;
eq('有人落后时，落后的那位先动', engine.activePlayerIndex(m1), 2);

console.log('\n[17] 多人局：行动 A 的推广');
const m2 = engine.createGame(['甲', '乙', '丙']);
m2.players[0].time = 10; m2.players[1].time = 20; m2.players[2].time = 30;
const m2before = m2.players[0].buttons;
engine.advance(m2, 0);
eq('只前进到前面最近那位玩家的前 1 格', m2.players[0].time, 21);
eq('领到与路程等量的纽扣', m2.players[0].buttons - m2before, 11);
// 把甲变成全场领先，再让他跳过
m2.players[1].time = 15; m2.players[2].time = 15;
const leadTime = m2.players[0].time;
const leadButtons = m2.players[0].buttons;
const passRes = engine.advance(m2, 0);
eq('已领先全场时不会倒着走', m2.players[0].time, leadTime);
eq('领先时空跑不领纽扣', m2.players[0].buttons, leadButtons);
eq('空跑记成 pass 事件', passRes.events[0].type, 'pass');

console.log('\n[18] 7x7 奖励全场只有一块');
function prepSeven(player, patchId, oriIndex) {
  for (let r = 0; r < 7; r += 1) {
    for (let c = 0; c < 7; c += 1) player.board[r][c] = { id: 'I', oriIndex: 0 };
  }
  engine.PATCH_BY_ID.get(patchId).orientations[oriIndex].cells
    .forEach(([r, c]) => { player.board[r][c] = null; });
}
const m3 = engine.createGame(['甲', '乙', '丙']);
m3.players.forEach((p) => { p.buttons = 99; });
prepSeven(m3.players[0], 'A', 0);
forceVisible(m3, 'A');
engine.buyPatch(m3, 0, 'A', 0, 0, 0);
eq('先拼出 7x7 的甲拿到奖励', m3.bonusTileOwner, 0);
eq('甲的 hasBonusTile 为真', m3.players[0].hasBonusTile, true);
// 把 A 放回环上并让乙也拼出 7x7
m3.circle.push('A');
forceVisible(m3, 'A');
prepSeven(m3.players[1], 'A', 0);
engine.buyPatch(m3, 1, 'A', 0, 0, 0);
eq('奖励已被拿走，乙不再获得', m3.players[1].hasBonusTile, false);
eq('归属者不会被覆盖', m3.bonusTileOwner, 0);
eq('乙的分数里没有 +7', engine.score(m3, 1).bonus, 0);

console.log('\n[19] 多人局结算与排名');
const m4 = engine.createGame(['甲', '乙', '丙']);
m4.players.forEach((p) => {
  for (let r = 0; r < 9; r += 1) for (let c = 0; c < 9; c += 1) p.board[r][c] = { id: 'I', oriIndex: 0 };
});
m4.players[0].buttons = 10; m4.players[1].buttons = 30; m4.players[2].buttons = 20;
const r4 = engine.finalResult(m4);
eq('排名按总分降序', r4.ranking.join(','), '1,2,0');
eq('最高分者获胜', r4.winner, 1);
eq('三人的分数都在结果里', r4.scores.length, 3);
// 全员同分且到达顺序一致 → 真并列
const m5 = engine.createGame(['甲', '乙', '丙']);
m5.players.forEach((p) => {
  for (let r = 0; r < 9; r += 1) for (let c = 0; c < 9; c += 1) p.board[r][c] = { id: 'I', oriIndex: 0 };
  p.buttons = 10;
});
// 同分时用「谁先抵达终点」破平（原版规则），所以实战中不会出现并列
m5.finishOrder = [2, 0, 1];
eq('三人同分时先到终点者胜', engine.finalResult(m5).winner, 2);
m5.finishOrder = [];
eq('连到达顺序都没有时才判并列', engine.finalResult(m5).winner, null);

console.log('\n[20] 多人局的皮革补丁队列');
const m6 = engine.createGame(['甲', '乙', '丙']);
m6.players[0].time = 0; m6.players[0].incomeIcons = 0;
m6.players[1].time = 29; m6.players[2].time = 29;
engine.advance(m6, 0);
eq('先到者一次拿到两块皮革', m6.pendingLeather.length, 2);
eq('两块都记在玩家 0 名下', m6.pendingLeather.every((x) => x.player === 0), true);
eq('有待放置皮革时仍由该玩家操作', engine.currentPlayerIndex(m6), 0);
engine.placeLeather(m6, 0, 0, 0);
engine.placeLeather(m6, 0, 0, 1);
eq('逐一放下后队列清空', m6.pendingLeather.length, 0);
check('皮革补丁都记到了板上',
  m6.players[0].board[0][0] !== null && m6.players[0].board[0][1] !== null);

console.log('\n[21] 电脑对手能自己打完一局');
const ai = require('./ai');
function playAiGame(n, level, variant) {
  const state = engine.createGame(
    Array.from({ length: n }, (_, i) => ({ name: 'AI' + i, bot: true })),
    Math.random,
    { variant },
  );
  let moves = 0;
  while (!engine.isGameOver(state) && moves < 2000) {
    moves += 1;
    const seat = engine.currentPlayerIndex(state);
    if (state.pendingLeather.length) {
      const cell = ai.chooseLeatherCell(state, seat, level);
      engine.placeLeather(state, seat, cell.row, cell.col);
    } else {
      const a = ai.chooseAction(state, seat, level);
      if (!a) break;
      if (a.type === 'advance') engine.advance(state, seat);
      else engine.buyPatch(state, seat, a.patchId, a.oriIndex, a.row, a.col);
    }
  }
  const res = engine.finalResult(state);
  return {
    over: engine.isGameOver(state),
    moves,
    placedTotal: state.players.reduce((s, p) => s + p.placed.length, 0),
    maxEmpty: Math.max(...state.players.map((p) => engine.emptySpaces(p.board))),
    scores: res.scores.map((x) => x.total),
    winner: res.winner,
  };
}
[2, 3].forEach((n) => {
  for (let run = 0; run < 2; run += 1) {
    const r = playAiGame(n, 'normal');
    check(`${n} 人局电脑能自己打完（${r.moves} 手）`, r.over && r.moves < 1500);
    check(`${n} 人局电脑确实在买补丁（共 ${r.placedTotal} 块）`, r.placedTotal > n * 3);
    check(`${n} 人局电脑把板子拼得不算烂（最多空 ${r.maxEmpty} 格）`, r.maxEmpty < 60);
  }
});
const easy = playAiGame(2, 'easy');
check('轻松难度也能正常打完', easy.over && easy.moves < 1500);

/* v1.6.6：困难难度 —— 会打完、会买牌，而且**明显强于普通** */
console.log('\n[21b] 困难难度（v1.6.6）');

check('normalizeLevel 认 hard', ai.normalizeLevel('hard') === 'hard');
check('normalizeLevel 把野字符串收敛成 normal', ai.normalizeLevel('xxx') === 'normal');
// v1.6.7：难度不再写进名字，改为对局页面的徽章展示
check('电脑名字统一是 wzzzhhhhh', ai.botName('hard') === 'wzzzhhhhh' && ai.botName('normal') === 'wzzzhhhhh' && ai.botName('easy') === 'wzzzhhhhh');
check('levelLabel 给出中文难度名', ai.levelLabel('hard') === '困难' && ai.levelLabel('normal') === '普通' && ai.levelLabel('easy') === '轻松');
check('levelLabel 野字符串收敛成「普通」', ai.levelLabel('xxx') === '普通');

const hard = playAiGame(2, 'hard');
check(`困难难度能自己打完（${hard.moves} 手）`, hard.over && hard.moves < 1500);
check(`困难难度确实在买补丁（共 ${hard.placedTotal} 块）`, hard.placedTotal > 6);
check(`困难难度把板子拼得不错（最多空 ${hard.maxEmpty} 格）`, hard.maxEmpty < 55);

/** 对拉：seat 交替，统计 A 相对 B 的胜率 */
function duel(levelA, levelB, N) {
  let aw = 0; let bw = 0; let d = 0; let aSum = 0; let bSum = 0;
  for (let i = 0; i < N; i += 1) {
    const aSeat = i % 2 === 0 ? 0 : 1;
    const lv = aSeat === 0 ? [levelA, levelB] : [levelB, levelA];
    const st = engine.createGame(
      [{ name: 'A', bot: true }, { name: 'B', bot: true }], Math.random, { variant: 'classic' },
    );
    let moves = 0;
    while (!engine.isGameOver(st) && moves < 2000) {
      moves += 1;
      const seat = engine.currentPlayerIndex(st);
      if (st.pendingLeather.length) {
        const c = ai.chooseLeatherCell(st, seat, lv[seat]);
        engine.placeLeather(st, seat, c.row, c.col);
      } else {
        const a = ai.chooseAction(st, seat, lv[seat]);
        if (!a) break;
        if (a.type === 'advance') engine.advance(st, seat);
        else engine.buyPatch(st, seat, a.patchId, a.oriIndex, a.row, a.col);
      }
    }
    const res = engine.finalResult(st);
    const aTot = res.scores[aSeat].total;
    const bTot = res.scores[1 - aSeat].total;
    aSum += aTot; bSum += bTot;
    if (res.winner === null) d += 1;
    else if (res.winner === aSeat) aw += 1;
    else bw += 1;
  }
  return { aw, bw, d, aAvg: aSum / N, bAvg: bSum / N, wr: aw / N };
}

// 40 局够看出趋势，又不至于把测试拖太久（hard 单步 ~30ms，一局约 1.4s）
const duelEasy = duel('hard', 'easy', 40);
check(`困难对轻松胜率过半（${duelEasy.aw}/40，均分 ${duelEasy.aAvg.toFixed(1)} : ${duelEasy.bAvg.toFixed(1)}）`,
  duelEasy.aw > duelEasy.bw);

const duelNormal = duel('hard', 'normal', 40);
check(`困难对普通胜率过半（${duelNormal.aw}/40，均分 ${duelNormal.aAvg.toFixed(1)} : ${duelNormal.bAvg.toFixed(1)}）`,
  duelNormal.aw > duelNormal.bw);
check(`困难对普通的平均分更高（${duelNormal.aAvg.toFixed(1)} : ${duelNormal.bAvg.toFixed(1)}）`,
  duelNormal.aAvg > duelNormal.bAvg);

/* ------------------------------------------------------------------ */
/* v1.5 魔改版                                                        */
/* ------------------------------------------------------------------ */
console.log('\n[22] 魔改版：规则变体');

/** 造一个魔改局，并把混沌格收成只剩一格，方便逐一验证四种事件 */
function chaosState(kind, space = 12) {
  const s = engine.createGame(['甲', '乙'], () => 0, { variant: 'chaos' });
  s.chaosPlan = [{ space, kind }];
  s.chaosSet = new Set([space]);
  return s;
}
/** 让某位玩家“刚好走到” space 那一格（把对手摆在同格，行动 A 才走得出一步） */
function walkTo(s, seat, space) {
  s.players[seat].time = space - 1;
  s.players[1 - seat].time = space - 1;
  return engine.advance(s, seat);
}

eq('魔改版起始 0 纽扣', engine.createGame(['甲'], () => 0, { variant: 'chaos' }).players[0].buttons, 0);
eq('经典版起始 5 纽扣', engine.createGame(['甲'], () => 0).players[0].buttons, 5);
eq('魔改版可见 4 块', engine.visiblePatchIds(engine.createGame(['甲'], () => 0, { variant: 'chaos' })).length, 4);
eq('经典版可见 3 块', engine.visiblePatchIds(engine.createGame(['甲'], () => 0)).length, 3);
eq('魔改版补丁池 26 块', engine.createGame(['甲'], () => 0, { variant: 'chaos' }).circle.length, 26);
eq('经典版补丁池 33 块', engine.createGame(['甲'], () => 0).circle.length, 33);
check('魔改版 1×2 那块 A 依旧压在环尾',
  engine.createGame(['甲'], () => 0, { variant: 'chaos' }).circle.slice(-1)[0] === 'A');
// 抽签得是随机的：两次开局不该抽出同一个顺序
const poolA = engine.createGame(['甲'], Math.random, { variant: 'chaos' }).circle.join('');
const poolB = engine.createGame(['甲'], Math.random, { variant: 'chaos' }).circle.join('');
check('魔改版每局抽到的补丁池不一样', poolA !== poolB);
check('未知变体名退回经典', engine.createGame(['甲'], () => 0, { variant: '不存在' }).circle.length === 33);

const chaosBoard = engine.createGame(['甲', '乙'], () => 0, { variant: 'chaos' });
eq('魔改版混沌格 3 个', chaosBoard.rules.chaosSpaces.length, 3);
check('混沌格都避开了纽扣格与皮革格', chaosBoard.rules.chaosSpaces.every(
  (s) => TIME_BOARD[s] === 'normal'));
check('混沌格位置就是 12 / 30 / 48', chaosBoard.rules.chaosSpaces.join(',') === '12,30,48');
check('开局预抽的三个混沌事件互不相同',
  new Set(chaosBoard.chaosPlan.map((x) => x.kind)).size === chaosBoard.chaosPlan.length);
check('混沌事件都是已知花样',
  chaosBoard.chaosPlan.every((x) => engine.CHAOS_KINDS.indexOf(x.kind) >= 0));
eq('经典局没有混沌格', engine.createGame(['甲'], () => 0).rules.chaosSpaces.length, 0);

// --- 天赐 ---
{
  const s = chaosState('bonus');
  s.players[0].buttons = 3;
  const ev = walkTo(s, 0, 12).events;
  const c = ev.find((e) => e.type === 'chaos');
  check('混沌·天赐：写进 lastEvents', Boolean(c) && c.kind === 'bonus' && c.space === 12);
  eq('混沌·天赐：白拿 6 个纽扣', s.players[0].buttons, 3 + 1 + 6); // +1 是行动 A 自己领的那格
}

// --- 苛捐 ---
{
  const s = chaosState('toll');
  s.players[0].buttons = 10;
  const c = walkTo(s, 0, 12).events.find((e) => e.type === 'chaos');
  check('混沌·苛捐：扣 4 个', Boolean(c) && c.paid === 4 && s.players[0].buttons === 7);
}
{
  const s = chaosState('toll');
  s.players[0].buttons = 0; // 一个纽扣都没有
  const c = walkTo(s, 0, 12).events.find((e) => e.type === 'chaos');
  // 行动 A 先给了他 1 个，苛捐要扣 4 个却只够扣 1 个 —— 扣光为止，绝不变负
  check('混沌·苛捐：纽扣不够就扣光，不会变负',
    Boolean(c) && c.paid === 1 && s.players[0].buttons === 0);
}

// --- 命运交换 ---
{
  const s = chaosState('swap');
  s.players[0].buttons = 20;
  s.players[1].buttons = 4;
  const c = walkTo(s, 0, 12).events.find((e) => e.type === 'chaos');
  check('混沌·命运交换：跟纽扣最多的对手对调口袋',
    Boolean(c) && c.with === 1 && s.players[0].buttons === 4 && s.players[1].buttons === 21);
}

// --- 跃迁 ---
{
  const s = chaosState('leap');
  s.players[0].buttons = 5;
  const c = walkTo(s, 0, 12).events.find((e) => e.type === 'chaos');
  check('混沌·跃迁：额外前进 2 格', Boolean(c) && c.advanced === 2 && s.players[0].time === 14);
  eq('混沌·跃迁：途中纽扣格照收', s.players[0].buttons, 6); // 12 走 13（无）、14（纽扣格 11+3）
}
{
  // 跃迁踩在终点前，不能冲出时间板
  const s = chaosState('leap', 51);
  s.players[0].time = 50;
  s.players[1].time = 50;
  engine.advance(s, 0);
  eq('混沌·跃迁：不会越过终点 53', s.players[0].time, 53);
  eq('混沌·跃迁：冲到终点就算完成', s.players[0].finished, true);
}

// --- 经典局完全不碰这套 ---
{
  const s = engine.createGame(['甲', '乙'], () => 0);
  s.players[0].buttons = 5;
  walkTo(s, 0, 12);
  check('经典局走到第 12 格什么也不会发生', s.players[0].buttons === 5 + 1);
}

// --- 魔改局电脑能自己打完 ---
{
  const r = playAiGame(2, 'normal', 'chaos');
  check(`魔改局电脑能自己打完（${r.moves} 手）`, r.over && r.moves < 1500);
  check(`魔改局电脑确实在买补丁（共 ${r.placedTotal} 块）`, r.placedTotal > 6);
  const r3 = playAiGame(3, 'normal', 'chaos');
  check(`魔改版 3 人局也能打完（${r3.moves} 手）`, r3.over);
}
{
  // 魔改版的 7×7 奖励翻倍、空格罚分更贵，用同一块板子对照一下
  const mk = (variant) => {
    const s = engine.createGame(['甲'], () => 0, { variant });
    s.players[0].buttons = 10;
    for (let r = 0; r < 7; r += 1) {
      for (let c = 0; c < 7; c += 1) s.players[0].board[r][c] = { id: 'A', oriIndex: 0 };
    }
    s.players[0].hasBonusTile = true;
    return engine.score(s, 0);
  };
  const a = mk('classic');
  const b = mk('chaos');
  eq('经典版 7×7 奖励 +7', a.bonus, 7);
  eq('魔改版 7×7 奖励 +14', b.bonus, 14);
  eq('经典版空格罚 2 分/格', a.penalty, a.empty * 2);
  eq('魔改版空格罚 3 分/格', b.penalty, b.empty * 3);
  eq('魔改版总分按新规则算', b.total, 10 + 14 - b.empty * 3);
}

console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail > 0) {
  console.log('失败清单：');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
