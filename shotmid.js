'use strict';

/*
 * 中局视觉检查：开两个 Edge，推进到中局（双方时间 > 26、各放下 4 块以上），
 * 然后截图。用来肉眼确认拼布板、时间板、市场、按钮状态、落点预览都正常。
 *
 * 用法：先启动服务端（node server/index.js），再运行 node shotmid.js
 * 页面状态走 app.js 暴露的只读桥 window.__pw。
 */

const { launchEdge, evaluate, waitFor, screenshot, sleep, PORT } = require('./browserkit');

const CLICK_EMPTY = `
  (function(){
    var q = window.__pw.myQuilt();
    if (!q) return 'no-quilt';
    var c = q.children;
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
      var q = window.__pw.myQuilt();
      var c = q.children;
      for (var i = 0; i < c.length; i++) {
        c[i].click();
        if (window.__pw.locked) { document.getElementById('btnConfirm').click(); return 'patch'; }
      }
    }
    document.getElementById('btnAdvance').click();
    return 'advance';
  })()
`;

/** 从左上往右下扫，停在一个「放得下」的位置，这样截出来是绿色预览 */
const HOVER_VALID = `
  (function(){
    var q = window.__pw.myQuilt();
    if (!q) return 'no-quilt';
    var c = q.children;
    for (var i = 0; i < c.length; i++) {
      c[i].dispatchEvent(new MouseEvent('mouseenter', {bubbles:true}));
      if (q.querySelectorAll('.qcell.valid').length) return 'valid@' + i;
    }
    return 'none';
  })()
`;

const SELECT_MARKET = "(function(){var c=document.querySelectorAll('#marketRow .patch-card:not(.disabled)'); if(c.length) c[0].click(); return c.length ? 'ok' : 'none';})()";

(async () => {
  console.log('\n=== 中局视觉检查 ===\n');

  const A = await launchEdge(9224, `http://127.0.0.1:${PORT}/`, 'ma');
  const B = await launchEdge(9225, `http://127.0.0.1:${PORT}/`, 'mb');
  await waitFor(A.ws, '!!window.__pw && window.__pw.meta !== null', 12000, '甲加载');
  await waitFor(B.ws, '!!window.__pw && window.__pw.meta !== null', 12000, '乙加载');
  await waitFor(A.ws, "!!document.getElementById('btnCreate')", 8000, '甲主菜单就绪');
  await waitFor(B.ws, "!!document.getElementById('btnCreate')", 8000, '乙主菜单就绪');

  await evaluate(A.ws, "document.getElementById('playerName').value='阿杭'; document.getElementById('btnCreate').click(); 'ok'");
  const room = await waitFor(A.ws, 'window.__pw.room', 8000, '房间码');
  await evaluate(B.ws, `document.getElementById('playerName').value='老王'; document.getElementById('roomCode').value='${room}'; document.getElementById('btnJoin').click(); 'ok'`);
  await waitFor(A.ws, '__pw.state && __pw.state.started', 8000, '开局');
  console.log('  房间 ' + room + ' 已开局');

  // 推进到中局
  for (let i = 0; i < 240; i += 1) {
    const s = JSON.parse(await evaluate(A.ws, `JSON.stringify({
      t0: __pw.state.players[0].time, t1: __pw.state.players[1].time,
      n0: __pw.state.players[0].placed.length, n1: __pw.state.players[1].placed.length,
      over: __pw.state.phase === 'over',
      act: __pw.state.active,
      pend: __pw.state.pendingLeather.length ? __pw.state.pendingLeather[0].player : -1
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
    t0: __pw.state.players[0].time, t1: __pw.state.players[1].time,
    n0: __pw.state.players[0].placed.length, n1: __pw.state.players[1].placed.length,
    empty0: __pw.state.players[0].empty, empty1: __pw.state.players[1].empty,
    income0: __pw.state.players[0].incomeIcons, income1: __pw.state.players[1].incomeIcons,
    leatherUsed: __pw.meta.timeBoard.filter((k, i) => k === 'leather' && __pw.state.leatherClaimed[i]).length,
    over: __pw.state.phase === 'over'
  })`);
  console.log('  中局状态 ' + snap);

  // 让甲选中一块补丁并悬停，进入「预览态」再截图，检查落点预览
  const enterPreview = async (w) => {
    await evaluate(w.ws, SELECT_MARKET);
    await sleep(150);
    console.log('  甲端已进入补丁预览态（' + await evaluate(w.ws, HOVER_VALID) + '）');
    await sleep(150);
  };

  if (await evaluate(A.ws, "__pw.state.active === __pw.seat && __pw.state.phase === 'playing'")) {
    await enterPreview(A);
  } else {
    console.log('  当前不是甲回合，先推进到甲行动');
    for (let i = 0; i < 60; i += 1) {
      const o = JSON.parse(await evaluate(A.ws, 'JSON.stringify({a:__pw.state.active,p:__pw.state.pendingLeather.length?__pw.state.pendingLeather[0].player:-1})'));
      if (o.a === 0 && o.p < 0) break;
      if (o.a === null || o.a === undefined) break;
      const w = (o.p >= 0 ? o.p : o.a) === 0 ? A : B;
      await evaluate(w.ws, o.p >= 0 ? CLICK_EMPTY : TRY_BUY);
      await sleep(40);
    }
    await enterPreview(A);
  }

  console.log('  截图：' + await screenshot(A.ws, 'mid-a.png'));
  console.log('  截图：' + await screenshot(B.ws, 'mid-b.png'));

  // 左键固定落点后的样子（预览不再跟手）
  await evaluate(A.ws,
    "(function(){var c=window.__pw.myQuilt().children; for(var i=0;i<c.length;i++){ c[i].click(); if(window.__pw.locked) return 'locked'; } return 'none';})()");
  await sleep(200);
  console.log('  截图：' + await screenshot(A.ws, 'locked-a.png'));

  // 规则与图例弹层
  await evaluate(A.ws, "document.getElementById('btnRules').click(); 'ok'");
  await sleep(300);
  console.log('  截图：' + await screenshot(A.ws, 'rules.png'));
  await evaluate(A.ws,
    "(function(){var c=document.querySelector('#rulesModal .overlay-card'); c.scrollTop=c.scrollHeight; return 'ok';})()");
  await sleep(250);
  console.log('  截图：' + await screenshot(A.ws, 'rules-legend.png'));
  await evaluate(A.ws, "document.getElementById('btnRulesClose').click(); 'ok'");

  A.ws.close(); B.ws.close();
  A.proc.kill(); B.proc.kill();
  process.exit(0);
})().catch((e) => { console.error('异常：', e.message || e); process.exit(1); });
