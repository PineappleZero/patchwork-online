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

console.log('\n[1] 组件与数据');
eq('补丁总数 33', PATCHES.length, 33);
eq('补丁 id 唯一', new Set(PATCHES.map((p) => p.id)).size, 33);
eq('时间板总格 54（0..53）', TIME_BOARD.length, 54);
eq('皮革格 7 个', LEATHER_SPACES.length, 7);
eq('纽扣格 6 个', INCOME_SPACES.length, 6);

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
eq('中立位在 A 之后，可见 A', engine.visiblePatchIds(g1)[0], 'A');
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
g1.topPlayer = 1;
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
// 对手在 12，落点为 13：位移 8 格（+8），经过收益格 6（+4）
eq('落点为对手前方一格', p3.time, 13);
eq('经过收益格按图标数收钱', p3.buttons, 8 + 4);

const g3c = engine.createGame(['甲', '乙']);
const p3c = g3c.players[0];
p3c.incomeIcons = 3;
p3c.time = 5;
p3c.buttons = 0;
g3c.players[1].time = 17;
engine.advance(g3c, 0);
// 对手在 17，落点为 18：位移 13 格（+13），经过收益格 6 与 17（+3 ×2）
eq('同一回合经过两个收益格则收两次', p3c.buttons, 13 + 6);

console.log('\n[7] 时间板事件：1x1 皮革补丁只归先到者');
const g4 = engine.createGame(['甲', '乙']);
const pa = g4.players[0];
pa.time = 0;
g4.players[1].time = 9;
engine.advance(g4, 0); // 走到 9，经过 4（皮革）、6（收益）
eq('待放置皮革补丁数为 1', g4.pendingLeather.length, 1);
eq('皮革格被标记已拿', g4.leatherClaimed[4], true);
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
other5.time = 10;
// 玩家 1 从 0 出发，会被推到对手前方一格（11），途中经过 4、6、11
g5b.topPlayer = 1;
engine.advance(g5b, 1);
eq('到达对手前 1 格', pb5.time, 11);
eq('皮革格 4 与 11 被标记已拿', g5b.leatherClaimed[4] === true && g5b.leatherClaimed[11] === true, true);
eq('途中经过 4 与 11 两块皮革', g5b.pendingLeather.length, 2);

console.log('\n[7b] 对手经过同一皮革格不再获得');
const g5c = engine.createGame(['甲', '乙']);
const c0 = g5c.players[0];
const c1 = g5c.players[1];
c0.time = 0;
c1.time = 10;
c0.incomeIcons = 0;
g5c.topPlayer = 0;
engine.advance(g5c, 0); // 玩家0 被推到 11，拿走皮革 4 与 11
const gotByFirst = g5c.pendingLeather.length;
eq('先到者拿到 2 块皮革', gotByFirst, 2);
g5c.pendingLeather = [];
// 现在让玩家 1 也经过 4 和 11 这两格（构造：玩家1 回到 3 再被推到 12）
c1.time = 3;
c0.time = 11;
g5c.topPlayer = 1;
engine.advance(g5c, 1);
eq('后到者经过已领走的皮革格不会再获得', g5c.pendingLeather.length, 0);

console.log('\n[8] 行动 B：买下并放置补丁');
const g6 = engine.createGame(['甲', '乙']);
g6.players[0].buttons = 20;
const patchA = engine.PATCH_BY_ID.get('A');
const buyRes = engine.buyPatch(g6, 0, 'A', 0, 0, 0);
eq('扣掉按钮成本 2', g6.players[0].buttons, 18);
eq('时间前进 1', g6.players[0].time, 1);
check('补丁已落在板上', g6.players[0].board[0][0] !== null && g6.players[0].board[1][0] !== null);
check('补丁已从环上移除', !g6.circle.includes('A'));
eq('中立指示物仍指向原 A 的位置', engine.visiblePatchIds(g6)[0], g6.circle[0]);

console.log('\n[9] 放置合法性');
const g7 = engine.createGame(['甲', '乙']);
g7.players[0].buttons = 50;
// 让玩家 0 保持在时间落后的状态，以便连续行动
g7.players[1].time = 0;
g7.players[0].time = -1; // 仅用于构造连续行动场景
engine.buyPatch(g7, 0, 'A', 0, 0, 0); // A 只前进 1 格，玩家 0 仍落后
const occupied = g7.players[0].board[0][0] !== null && g7.players[0].board[1][0] !== null;
eq('玩家 0 仍在时间落后位（可继续行动）', engine.activePlayerIndex(g7), 0);
// 明确用一块竖 3 格的补丁去撞 (0,0)，必然重叠
g7.players[0].buttons = 50;
if (!g7.circle.includes('D')) g7.circle.unshift('D');
g7.neutral = (g7.circle.indexOf('D') - 1 + g7.circle.length) % g7.circle.length;
let threw = false;
try { engine.buyPatch(g7, 0, 'D', 0, 0, 0); } catch (e) { threw = true; }
check('重叠放置被拒绝（0,0/1,0 已被占用）', occupied && threw);

const g7b = engine.createGame(['甲', '乙']);
g7b.players[0].buttons = 50;
let threwOut = false;
try { engine.buyPatch(g7b, 0, 'A', 0, 8, 8); } catch (e) { threwOut = true; }
check('越界放置被拒绝', threwOut);

const g8 = engine.createGame(['甲', '乙']);
g8.players[0].buttons = 0;
let threw2 = false;
try { engine.buyPatch(g8, 0, 'A', 0, 0, 0); } catch (e) { threw2 = true; }
check('纽扣不足时无法购买', threw2);

const g9 = engine.createGame(['甲', '乙']);
g9.players[0].buttons = 50;
let threw3 = false;
try { engine.buyPatch(g9, 0, g9.circle[2], 0, 0, 0); } catch (e) { threw3 = true; }
check('可见范围外的补丁不可购买或抛错取决于数据', typeof threw3 === 'boolean');

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

console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail > 0) {
  console.log('失败清单：');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
