'use strict';
/*
 * 诊断：事件纪要（日志）到底有没有自动跟随滚动 + 「再来一局」真的能开新局吗。
 * 用法：先启动服务端（node server/index.js），再运行 node diag-log.js
 *
 * 注意：页面里读局面一律走 window.__pw 这个只读桥 ——
 * 顶层的 const S 虽然能从别处求值里看见，但它依赖脚本执行顺序，不牢靠。
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

/** 读当前局面：谁该动、有没有待放皮革 */
const SNAP = `JSON.stringify((function(){
  var s = window.__pw.state;
  return {
    over: s.phase === 'over',
    act: s.active,
    pend: s.pendingLeather.length ? s.pendingLeather[0].player : -1
  };
})())`;

/** 一步：能买就买（随便找个放得下的位置），否则跳过 */
const STEP = `(function(){
  if (window.__pw.state.pendingLeather.length) {
    var q = window.__pw.myQuilt().children;
    for (var j = 0; j < q.length; j++) { if (!q[j].classList.contains('filled')) { q[j].click(); return 'leather'; } }
  }
  var cards = document.querySelectorAll('#ringFront .patch-card:not(.disabled)');
  if (cards.length) {
    cards[Math.floor(Math.random() * cards.length)].click();
    var c = window.__pw.myQuilt().children;
    for (var i = 0; i < c.length; i++) {
      c[i].click();
      if (window.__pw.locked) { document.getElementById('btnConfirm').click(); return 'patch'; }
    }
  }
  document.getElementById('btnAdvance').click();
  return 'advance';
})()`;

(async () => {
  const A = await launchEdge(9230, `http://127.0.0.1:${PORT}/`, 'la');
  const B = await launchEdge(9231, `http://127.0.0.1:${PORT}/`, 'lb');
  await waitFor(A.ws, '!!(window.__pw && window.__pw.meta)', 10000, '甲加载');
  await waitFor(B.ws, '!!(window.__pw && window.__pw.meta)', 10000, '乙加载');
  await evaluate(A.ws, "document.getElementById('playerName').value='阿杭'; document.getElementById('btnCreate').click(); 'ok'");
  const room = await waitFor(A.ws, 'window.__pw.room', 8000, '房间码');
  await evaluate(B.ws, `document.getElementById('playerName').value='老王'; document.getElementById('roomCode').value='${room}'; document.getElementById('btnJoin').click(); 'ok'`);
  await waitFor(A.ws, "window.__pw.state && window.__pw.state.phase === 'playing'", 8000, '开局');
  await sleep(300);

  console.log('\n--- 1) 纯 pushLog 压力测试（50 条）---');
  await evaluate(A.ws, "document.getElementById('log').innerHTML=''; for(var i=0;i<50;i++) pushLog('测试条目 '+i); 'ok'");
  console.log('   ' + await evaluate(A.ws, LOGSTAT));

  console.log('\n--- 2) 真实对局：每步后的日志滚动状态 ---');
  for (let step = 0; step < 14; step += 1) {
    const info = JSON.parse(await evaluate(A.ws, SNAP));
    if (info.over) break;
    const seat = info.pend >= 0 ? info.pend : info.act;
    const w = seat === 0 ? A : B;
    await evaluate(w.ws, STEP);
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
    const info = JSON.parse(await evaluate(A.ws, SNAP));
    if (info.over) break;
    const seat = info.pend >= 0 ? info.pend : info.act;
    await evaluate((seat === 0 ? A : B).ws, STEP);
    await sleep(35);
  }
  console.log('   phase=' + await evaluate(A.ws, 'window.__pw.state.phase'));
  console.log('   结算弹层可见=' + await evaluate(A.ws, "document.getElementById('overlay').classList.contains('show')"));

  const beforeState = await evaluate(A.ws,
    "JSON.stringify({room:window.__pw.room, phase:window.__pw.state.phase, t:window.__pw.state.players.map(function(p){return p.time;})})");
  console.log('   点「再来一局」前：' + beforeState);
  await evaluate(A.ws, "document.getElementById('btnRematch').click(); 'ok'");
  await evaluate(B.ws, "document.getElementById('btnRematch').click(); 'ok'");
  await sleep(900);
  console.log('   双方都点之后：' + await evaluate(A.ws,
    "JSON.stringify({phase:window.__pw.state.phase, t:window.__pw.state.players.map(function(p){return p.time;}), placed:window.__pw.state.players.map(function(p){return p.placed.length;})})"));
  console.log('   A 端 phase=' + await evaluate(A.ws, 'window.__pw.state.phase') +
    '  B 端 phase=' + await evaluate(B.ws, 'window.__pw.state.phase'));
  console.log('   结算弹层还开着吗=' + await evaluate(A.ws, "document.getElementById('overlay').classList.contains('show')"));

  A.ws.close(); B.ws.close();
  A.proc.kill(); B.proc.kill();
  process.exit(0);
})().catch((e) => { console.error('诊断异常：', e.message || e); process.exit(1); });
