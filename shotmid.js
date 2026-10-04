'use strict';

/*
 * 中局视觉检查：开两个 Edge，推进到中局（双方时间 > 26、各放下 4 块以上），
 * 然后截图。用来肉眼确认拼布板、时间板、市场、按钮状态、落点预览都正常。
 *
 * 用法：先启动服务端（node server/index.js），再运行 node shotmid.js
 */

const { launchEdge, evaluate, waitFor, screenshot, sleep, PORT } = require('./browserkit');

const CLICK_EMPTY = `
  (function(){
    var c = document.getElementById('meQuilt').children;
    for (var i = 0; i < c.length; i++) {
      if (!c[i].classList.contains('filled')) { c[i].click(); return 'clicked'; }
    }
    return 'full';
  })()
`;

const TRY_BUY = `
  (function(){
    var cards = document.querySelectorAll('#marketRow .patch-card:not(.disabled)');
    if (cards.length) {
      cards[0].click();
      var c = document.getElementById('meQuilt').children;
      for (var i = 0; i < c.length; i++) {
        c[i].click();
        if (S.anchored) { document.getElementById('btnConfirm').click(); return 'patch'; }
      }
    }
    document.getElementById('btnAdvance').click();
    return 'advance';
  })()
`;

(async () => {
  console.log('\n=== 中局视觉检查 ===\n');

  const A = await launchEdge(9224, `http://127.0.0.1:${PORT}/`, 'ma');
  const B = await launchEdge(9225, `http://127.0.0.1:${PORT}/`, 'mb');
  await waitFor(A.ws, "typeof S !== 'undefined' && S.meta !== null", 10000, '甲加载');
  await waitFor(B.ws, "typeof S !== 'undefined' && S.meta !== null", 10000, '乙加载');
  await waitFor(A.ws, "!!document.getElementById('btnCreate')", 8000, '甲大厅就绪');
  await waitFor(B.ws, "!!document.getElementById('btnCreate')", 8000, '乙大厅就绪');

  await evaluate(A.ws, "document.getElementById('playerName').value='阿杭'; document.getElementById('btnCreate').click(); 'ok'");
  const room = await waitFor(A.ws, 'S.room', 8000, '房间码');
  await evaluate(B.ws, `document.getElementById('playerName').value='老王'; document.getElementById('roomCode').value='${room}'; document.getElementById('btnJoin').click(); 'ok'`);
  await waitFor(A.ws, 'S.state && S.state.started', 8000, '开局');
  console.log('  房间 ' + room + ' 已开局');

  // 推进到中局
  for (let i = 0; i < 240; i += 1) {
    const s = JSON.parse(await evaluate(A.ws, `JSON.stringify({
      t0: S.state.players[0].time, t1: S.state.players[1].time,
      n0: S.state.players[0].placed.length, n1: S.state.players[1].placed.length,
      over: S.state.phase === 'over',
      act: S.state.active,
      pend: S.state.pendingLeather.length ? S.state.pendingLeather[0].player : -1
    })`));
    if (s.over) break;
    if (s.t0 > 26 && s.t1 > 26 && s.n0 >= 4 && s.n1 >= 4) break;

    const seat = s.pend >= 0 ? s.pend : s.act;
    if (seat === null || seat === undefined) break;
    const w = seat === 0 ? A : B;
    await evaluate(w.ws, s.pend >= 0 ? CLICK_EMPTY : TRY_BUY);
    await sleep(30);
  }

  const snap = await evaluate(A.ws, `JSON.stringify({
    t0: S.state.players[0].time, t1: S.state.players[1].time,
    n0: S.state.players[0].placed.length, n1: S.state.players[1].placed.length,
    empty0: S.state.players[0].empty, empty1: S.state.players[1].empty,
    income0: S.state.players[0].incomeIcons, income1: S.state.players[1].incomeIcons,
    leatherClaimed: S.state.leatherClaimed.filter(Boolean).length,
    over: S.state.phase === 'over'
  })`);
  console.log('  中局状态 ' + snap);

  // 让甲选中一块补丁并悬停，进入"预览态"再截图，检查落点预览
  const canSelect = await evaluate(A.ws, "S.state.active === S.seat && S.state.phase === 'playing'");
  if (canSelect) {
    await evaluate(A.ws, "(function(){var c=document.querySelectorAll('#marketRow .patch-card:not(.disabled)'); if(c.length) c[0].click(); return 'ok';})()");
    await sleep(150);
    await evaluate(A.ws, "(function(){var c=document.getElementById('meQuilt').children; c[40].dispatchEvent(new MouseEvent('mouseenter',{bubbles:true})); return 'ok';})()");
    await sleep(150);
    console.log('  甲端已进入补丁预览态');
  } else {
    console.log('  当前不是甲回合，跳过预览态');
    // 等一轮让甲成为行动方
    for (let i = 0; i < 60; i += 1) {
      const o = JSON.parse(await evaluate(A.ws, 'JSON.stringify({a:S.state.active,p:S.state.pendingLeather.length?S.state.pendingLeather[0].player:-1})'));
      if (o.a === 0 && o.p < 0) break;
      if (o.a === null || o.a === undefined) break;
      const w = (o.p >= 0 ? o.p : o.a) === 0 ? A : B;
      await evaluate(w.ws, o.p >= 0 ? CLICK_EMPTY : TRY_BUY);
      await sleep(40);
    }
    await evaluate(A.ws, "(function(){var c=document.querySelectorAll('#marketRow .patch-card:not(.disabled)'); if(c.length) c[0].click(); return 'ok';})()");
    await sleep(150);
    await evaluate(A.ws, "(function(){var c=document.getElementById('meQuilt').children; c[40].dispatchEvent(new MouseEvent('mouseenter',{bubbles:true})); return 'ok';})()");
    await sleep(150);
  }

  console.log('  截图：' + await screenshot(A.ws, 'mid-a.png'));
  console.log('  截图：' + await screenshot(B.ws, 'mid-b.png'));

  A.ws.close(); B.ws.close();
  A.proc.kill(); B.proc.kill();
})().catch((e) => { console.error('异常：', e.message || e); process.exit(1); });
