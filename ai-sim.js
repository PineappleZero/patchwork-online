'use strict';
/* 电脑对手自检：让 AI 自己跟自己打整局，看看会不会卡死、会不会把板子拼烂。 */
const engine = require('./server/engine');
const ai = require('./server/ai');

function play(n, level) {
  const state = engine.createGame(Array.from({ length: n }, (_, i) => ({ name: 'AI' + i, bot: true })));
  let moves = 0;
  while (!engine.isGameOver(state) && moves < 4000) {
    moves += 1;
    const seat = engine.currentPlayerIndex(state);
    if (state.pendingLeather.length) {
      const cell = ai.chooseLeatherCell(state, seat);
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
    totals: res.scores.map((s) => s.total).join('/'),
    empty: state.players.map((p) => engine.emptySpaces(p.board)).join('/'),
    placed: state.players.map((p) => p.placed.length).join('/'),
    winner: res.winner,
    circleLeft: state.circle.length,
  };
}

[2, 3, 4].forEach((n) => {
  console.log('--- ' + n + ' 人局 ---');
  for (let i = 0; i < 5; i += 1) console.log('  #' + i + ' ' + JSON.stringify(play(n, 'normal')));
});
