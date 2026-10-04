'use strict';
/*
 * 诊断：事件纪要（日志）到底有没有自动跟随滚动 + 再来一局为什么失效。
 * 用法：先启动服务端（node server/index.js），再运行 node diag-log.js
 */
const { launchEdge, evaluate, waitFor, sleep, PORT } = require('./browserkit');

const LOGSTAT = `JSON.stringify((function(){
  var el = document.getElementById('log');
  return {
    n: el.children.length,
    scrollTop: Math.round(el.scrollTop),
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    maxScroll: el.scrollHeight - el.clientHeight,
    atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 40,
    jumpHidden: document.getElementById('btnLogJump').hidden,
    lastText: el.lastElementChild ? el.lastElementChild.textContent.slice(0, 40) : ''
  };
})())`;

(async () => {
  const A = await launchEdge(9230, `http://127.0.0.1:${PORT}/`, 'la');
  const B = await launchEdge(9231, `http://127.0.0.1:${PORT}/`, 'lb');
  await waitFor(A.ws, "typeof S !== 'undefined' && S.meta !== null", 10000, '甲加载');
  await waitFor(B.ws, "typeof S !== 'undefined' && S.meta !== null", 10000, '乙加载');
  await evaluate(A.ws, "document.getElementById('playerName').value='阿杭'; document.getElementById('btnCreate').click(); 'ok'");
  const room = await waitFor(A.ws, 'S.room', 8000, '房间码');
  await evaluate(B.ws, `document.getElementById('playerName').value='老王'; document.getElementById('roomCode').value='${room}'; document.getElementById('btnJoin').click(); 'ok'`);
  await waitFor(A.ws, 'S.state && S.state.started', 8000, '开局');
  await sleep(300);

  console.log('\n--- 1) 纯 pushLog 压力测试（50 条）---');
  await evaluate(A.ws, "document.getElementById('log').innerHTML=''; for(var i=0;i<50;i++) pushLog('测试条目 '+i); 'ok'");
  console.log('   ' + await evaluate(A.ws, LOGSTAT));

  console.log('\n--- 2) 真实对局：每步后的日志滚动状态 ---');
  for (let step = 0; step < 14; step += 1) {
    const info = JSON.parse(await evaluate(A.ws, `JSON.stringify({
      over: S.state.phase === 'over', act: S.state.active,
      pend: S.state.pendingLeather.length ? S.state.pendingLeather[0].player : -1
    })`));
    if (info.over) break;
    const seat = info.pend >= 0 ? info.pend : info.act;
    const w = seat === 0 ? A : B;
    if (info.pend >= 0) {
      await evaluate(w.ws, "(function(){var c=document.getElementById('meQuilt').children; for(var i=0;i<c.length;i++){ if(!c[i].classList.contains('filled')){ c[i].click(); return 'ok'; } } return 'no';})()");
    } else {
      await evaluate(w.ws, "document.getElementById('btnAdvance').click(); 'ok'");
    }
    await sleep(90);
    if (step % 4 === 3) console.log('   step' + step + ' ' + await evaluate(A.ws, LOGSTAT));
  }
  console.log('   最终 ' + await evaluate(A.ws, LOGSTAT));

  console.log('\n--- 3) 往上翻看历史后，新条目还会不会抢滚动 ---');
  await evaluate(A.ws, "document.getElementById('log').scrollTop = 0; 'ok'");
  await evaluate(A.ws, "pushLog('翻历史时插入的一条'); 'ok'");
  await sleep(120);
  console.log('   ' + await evaluate(A.ws, LOGSTAT));
  await evaluate(A.ws, "document.getElementById('btnLogJump').click(); 'ok'");
  await sleep(120);
  console.log('   点回最新后 ' + await evaluate(A.ws, LOGSTAT));

  console.log('\n--- 4) 打到终局，测「再来一局」---');
  for (let i = 0; i < 500; i += 1) {
    const info = JSON.parse(await evaluate(A.ws, `JSON.stringify({
      over: S.state.phase === 'over', act: S.state.active,
      pend: S.state.pendingLeather.length ? S.state.pendingLeather[0].player : -1,
      acts: (function(){ var a = engineActionsForTest ? [] : null; return null; })()
    })`));
    if (info.over) break;
    const seat = info.pend >= 0 ? info.pend : info.act;
    const w = seat === 0 ? A : B;
    const r = await evaluate(w.ws, `(function(){
      var cards = document.querySelectorAll('#marketRow .patch-card:not(.disabled)');
      if (cards.length) {
        cards[0].click();
        var c = document.getElementById('meQuilt').children;
        for (var i = 0; i < c.length; i++) { c[i].click(); if (S.locked) { document.getElementById('btnConfirm').click(); return 'patch'; } }
      }
      if (S.leatherMode) {
        var q = document.getElementById('meQuilt').children;
        for (var j = 0; j < q.length; j++) { if (!q[j].classList.contains('filled')) { q[j].click(); return 'leather'; } }
      }
      document.getElementById('btnAdvance').click();
      return 'advance';
    })()`);
    await sleep(35);
  }
  console.log('   phase=' + await evaluate(A.ws, 'S.state.phase'));
  console.log('   结算弹层可见=' + await evaluate(A.ws, "document.getElementById('overlay').classList.contains('show')"));

  const beforeState = await evaluate(A.ws, "JSON.stringify({room:S.room, phase:S.state.phase, t:S.state.players.map(function(p){return p.time;})})");
  console.log('   点「再来一局」前：' + beforeState);
  await evaluate(A.ws, "document.getElementById('btnRematch').click(); 'ok'");
  await evaluate(B.ws, "document.getElementById('btnRematch').click(); 'ok'");
  await sleep(900);
  console.log('   双方都点之后：' + await evaluate(A.ws,
    "JSON.stringify({phase:S.state.phase, t:S.state.players.map(function(p){return p.time;}), placed:S.state.players.map(function(p){return p.placed.length;})})"));
  console.log('   A 端 phase=' + await evaluate(A.ws, 'S.state.phase') + '  B 端 phase=' + await evaluate(B.ws, 'S.state.phase'));
  console.log('   服务端房间票数（若有）=' + await evaluate(A.ws, "document.getElementById('overlay').classList.contains('show')"));

  A.ws.close(); B.ws.close();
  A.proc.kill(); B.proc.kill();
  process.exit(0);
})().catch((e) => { console.error('诊断异常：', e.message || e); process.exit(1); });
