'use strict';

/*
 * Patchwork 原版数据（Uwe Rosenberg, Lookout Games 2014）
 *
 * 补丁形状用 ASCII 行表示，'#' 为占格，'.' 为空。
 * 数值含义：
 *   cost   买下这块补丁要付的纽扣数
 *   time   买下后时间令牌前进的格数
 *   income 每次经过纽扣格时，这块补丁提供的纽扣收益
 *
 * 形状与数值取自公开的开源实现所整理的原始游戏数据，
 * 并与官方规则书逐条比对过：33 块补丁覆盖 2~8 格、按钮成本 0~10、
 * 时间成本 1~6、按钮收益 0~3。
 */
const PATCH_DEFS = [
  { id: 'A', cost: 2, time: 1, income: 0, rows: ['#', '#'] },
  { id: 'B', cost: 1, time: 3, income: 0, rows: ['.#', '##'] },
  { id: 'C', cost: 3, time: 1, income: 0, rows: ['.#', '##'] },
  { id: 'D', cost: 2, time: 2, income: 0, rows: ['#', '#', '#'] },
  { id: 'E', cost: 3, time: 2, income: 1, rows: ['.#', '##', '#.'] },
  { id: 'F', cost: 2, time: 2, income: 0, rows: ['#.', '##', '##'] },
  { id: 'G', cost: 1, time: 4, income: 1, rows: ['..#..', '#####', '..#..'] },
  { id: 'H', cost: 0, time: 3, income: 1, rows: ['.#.', '###', '.#.', '.#.'] },
  { id: 'I', cost: 6, time: 5, income: 2, rows: ['##', '##'] },
  { id: 'J', cost: 4, time: 2, income: 0, rows: ['#.', '##', '##', '.#'] },
  { id: 'K', cost: 2, time: 2, income: 0, rows: ['.#', '##', '.#'] },
  { id: 'L', cost: 1, time: 5, income: 1, rows: ['##', '.#', '.#', '##'] },
  { id: 'M', cost: 3, time: 3, income: 1, rows: ['#', '#', '#', '#'] },
  { id: 'N', cost: 7, time: 1, income: 1, rows: ['#####'] },
  { id: 'O', cost: 3, time: 4, income: 1, rows: ['#.', '#.', '##', '#.'] },
  { id: 'P', cost: 7, time: 4, income: 2, rows: ['#.', '##', '##', '#.'] },
  { id: 'Q', cost: 3, time: 6, income: 2, rows: ['.#.', '###', '#.#'] },
  { id: 'R', cost: 2, time: 1, income: 0, rows: ['.#.', '.##', '##.', '.#.'] },
  { id: 'S', cost: 4, time: 6, income: 2, rows: ['.#', '.#', '##'] },
  { id: 'T', cost: 5, time: 4, income: 2, rows: ['.#.', '###', '.#.'] },
  { id: 'U', cost: 2, time: 3, income: 0, rows: ['#.#', '###', '#.#'] },
  { id: 'V', cost: 5, time: 3, income: 1, rows: ['.#.', '###', '###', '.#.'] },
  { id: 'W', cost: 10, time: 3, income: 2, rows: ['.#', '.#', '.#', '##'] },
  { id: 'X', cost: 5, time: 5, income: 2, rows: ['.#.', '.#.', '###'] },
  { id: 'Y', cost: 10, time: 5, income: 3, rows: ['##', '##', '.#', '.#'] },
  { id: 'Z', cost: 1, time: 2, income: 0, rows: ['##.', '.#.', '.#.', '.##'] },
  { id: 'a', cost: 4, time: 2, income: 1, rows: ['#.', '#.', '##'] },
  { id: 'b', cost: 7, time: 2, income: 2, rows: ['.#.', '.#.', '.#.', '###'] },
  { id: 'c', cost: 10, time: 4, income: 3, rows: ['#..', '##.', '.##'] },
  { id: 'd', cost: 1, time: 2, income: 0, rows: ['#.#', '###'] },
  { id: 'e', cost: 2, time: 3, income: 1, rows: ['.#', '.#', '##', '#.'] },
  { id: 'f', cost: 7, time: 6, income: 3, rows: ['.##', '##.'] },
  { id: 'g', cost: 8, time: 6, income: 3, rows: ['.##', '.##', '##.'] },
];

/** 1x1 皮革补丁（不参与购买，只能通过时间板获得） */
const LEATHER_DEF = { id: 'h', cost: 0, time: 1, income: 0, rows: ['#'] };

/** 拼布板边长 */
const BOARD_SIZE = 9;

/** 时间板总格数（0 为起点，53 为终点） */
const LAST_SPACE = 53;

/** 皮革补丁格：踏上或经过的第一名玩家获得 1x1 补丁 */
const LEATHER_SPACES = [4, 11, 18, 25, 32, 39, 46];

/** 纽扣收益格：踏上或经过时，按自己板上纽扣图标数收钱 */
const INCOME_SPACES = [6, 17, 24, 34, 41, 50];

/** 7x7 奖励分 */
const SEVEN_BY_SEVEN_BONUS = 7;

/** 起始纽扣 */
const START_BUTTONS = 5;

/** 每格未覆盖的扣分 */
const EMPTY_PENALTY = 2;

/** 补丁市场：中立指示物前方可见的补丁数 */
const MARKET_VISIBLE = 3;

const PATCHES = PATCH_DEFS.map((def) => {
  const cells = [];
  let rows = def.rows.length;
  let cols = 0;
  def.rows.forEach((row, r) => {
    cols = Math.max(cols, row.length);
    row.split('').forEach((ch, c) => {
      if (ch === '#') cells.push([r, c]);
    });
  });
  return {
    id: def.id,
    cost: def.cost,
    time: def.time,
    income: def.income,
    size: cells.length,
    rows,
    cols,
    cells,
    /** 该补丁的形态集合（含旋转与镜像，去重后的相对坐标列表） */
    orientations: buildOrientations(cells),
  };
});

const LEATHER = (() => {
  const cells = [[0, 0]];
  return {
    id: LEATHER_DEF.id,
    cost: 0,
    time: 1,
    income: 0,
    size: 1,
    rows: 1,
    cols: 1,
    cells,
    orientations: buildOrientations(cells),
  };
})();

/**
 * 生成全部 8 种朝向（4 次旋转 × 2 次镜像），并归一化到左上角原点，去重。
 * 返回 [{ cells: [[r,c],...], rows, cols, key }]
 */
function buildOrientations(cells) {
  const seen = new Map();
  // 四种旋转（顺时针 0/90/180/270）× 两种镜像（原样 / 水平翻转）
  // 旋转用标准二维旋转，镜像后再做旋转，覆盖全部 8 种朝向
  const transforms = [
    (r, c) => [r, c],
    (r, c) => [c, -r],
    (r, c) => [-r, -c],
    (r, c) => [-c, r],
    (r, c) => [r, -c],
    (r, c) => [-c, -r],
    (r, c) => [-r, c],
    (r, c) => [c, r],
  ];
  transforms.forEach((fn, index) => {
    const raw = cells.map(([r, c]) => fn(r, c));
    const minR = Math.min(...raw.map((p) => p[0]));
    const minC = Math.min(...raw.map((p) => p[1]));
    const norm = raw
      .map(([r, c]) => [r - minR, c - minC])
      .sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    const key = norm.map((p) => p.join(',')).join(';');
    if (!seen.has(key)) {
      const rows = Math.max(...norm.map((p) => p[0])) + 1;
      const cols = Math.max(...norm.map((p) => p[1])) + 1;
      seen.set(key, { key, cells: norm, rows, cols, transform: index });
    }
  });
  return Array.from(seen.values());
}

/** 时间板上每个格子的事件类型 */
const TIME_BOARD = Array.from({ length: LAST_SPACE + 1 }, (_, n) => {
  if (LEATHER_SPACES.includes(n)) return 'leather';
  if (INCOME_SPACES.includes(n)) return 'income';
  return 'normal';
});

module.exports = {
  PATCHES,
  LEATHER,
  TIME_BOARD,
  LEATHER_SPACES,
  INCOME_SPACES,
  BOARD_SIZE,
  LAST_SPACE,
  SEVEN_BY_SEVEN_BONUS,
  START_BUTTONS,
  EMPTY_PENALTY,
  MARKET_VISIBLE,
};
