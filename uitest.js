'use strict';

/*
 * 真实浏览器联调（交互深度测试）：用 CDP 驱动本机 Edge 开两个窗口
 * （模拟你和朋友两台机器），走完「主菜单建房 → 加入 → 买补丁 → 落下 →
 * 右键解除固定 → 领纽扣 → 皮革补丁 → 打完整局 → 结算」的全流程，
 * 同时收集页面 JS 报错并截图。
 *
 * 用法：先启动服务端（node server/index.js），再运行 node uitest.js
 *
 * 页面状态通过 app.js 暴露的只读桥 window.__pw 读取（顶层 const 挂不到 window 上）。
 */

const {
  launchEdge, evaluate, waitFor, screenshot, collectErrors, sleep, PORT,
} = require('./browserkit');

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

/** 点当前行动方板上第一个空格（放 1x1 皮革补丁用） */
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

/** 尽量买一块补丁并放下，放不下就跳过领纽扣 */
const TRY_BUY = `
  (function(){
    var cards = document.querySelectorAll('#ringFront .patch-card:not(.disabled)');
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

/** 从左上往右下扫，停在一个「放得下」的位置，这样能看到绿色预览 */
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

(async () => {
  console.log('\n=== Patchwork 浏览器联调（两个 Edge 实例模拟两台电脑） ===\n');
  const errors = [];

  console.log('[1] 打开两个浏览器窗口');
  const A = await launchEdge(9222, `http://127.0.0.1:${PORT}/`, 'a');
  const B = await launchEdge(9223, `http://127.0.0.1:${PORT}/`, 'b');
  collectErrors(A.ws, errors, '窗口甲');
  collectErrors(B.ws, errors, '窗口乙');
  check('两个浏览器窗口均已打开', true);

  await waitFor(A.ws, '!!window.__pw && window.__pw.meta !== null', 12000, '甲端加载原版数据');
  await waitFor(B.ws, '!!window.__pw && window.__pw.meta !== null', 12000, '乙端加载原版数据');
  await waitFor(A.ws, "!!document.getElementById('btnCreate')", 8000, '甲端主菜单就绪');
  await waitFor(B.ws, "!!document.getElementById('btnCreate')", 8000, '乙端主菜单就绪');
  check('两端都拉到了 /api/info 数据', true);
  check('两端都停在主菜单', await evaluate(A.ws, "document.getElementById('menu').classList.contains('active')")
    && await evaluate(B.ws, "document.getElementById('menu').classList.contains('active')"));

  console.log('\n[2] 甲从主菜单建房（联机双人）');
  await evaluate(A.ws, "document.getElementById('playerName').value='甲'; document.getElementById('btnCreate').click(); 'ok'");
  const room = await waitFor(A.ws, 'window.__pw.room', 8000, '甲拿到房间码');
  check('房间码为 4 位', /^[A-Z0-9]{4}$/.test(room), room);
  check('甲进入对局界面', await evaluate(A.ws, "document.getElementById('game').classList.contains('active')"));
  check('没坐满时甲停在等待房', await evaluate(A.ws, "document.getElementById('waitModal').classList.contains('show')"));

  console.log('\n[3] 乙用房间码加入');
  await evaluate(B.ws, `document.getElementById('playerName').value='乙'; document.getElementById('roomCode').value='${room}'; document.getElementById('btnJoin').click(); 'ok'`);
  await waitFor(B.ws, 'window.__pw.room !== null', 8000, '乙加入房间');
  check('乙进入对局界面', await evaluate(B.ws, "document.getElementById('game').classList.contains('active')"));

  await waitFor(A.ws, '__pw.state && __pw.state.started === true', 8000, '甲端看到开局');
  const st0 = JSON.parse(await evaluate(A.ws,
    'JSON.stringify({p0:__pw.state.players[0].name,p1:__pw.state.players[1].name,v:__pw.state.visible.length})'));
  check('双方姓名正确显示', st0.p0 === '甲' && st0.p1 === '乙', JSON.stringify(st0));
  check('市场可见 3 块补丁', st0.v === 3);
  check('乙端也自动开局了', await evaluate(B.ws, '__pw.state && __pw.state.started === true'));

  // 时间板渲染出来的特殊格数量，必须和规则 / 引擎数据一致
  const tb = JSON.parse(await evaluate(A.ws, `JSON.stringify({
    all: document.querySelectorAll('#timeboard .tb-cell').length,
    income: document.querySelectorAll('#timeboard .tb-cell.income').length,
    leather: document.querySelectorAll('#timeboard .tb-cell.leather').length,
    end: document.querySelectorAll('#timeboard .tb-cell.end').length
  })`));
  check('时间板渲染 54 格（0..53）', tb.all === 54, String(tb.all));
  check('时间板渲染 9 个纽扣格', tb.income === 9, String(tb.income));
  check('时间板渲染 5 个皮革格', tb.leather === 5, String(tb.leather));
  check('时间板有且只有 1 个终点格', tb.end === 1, String(tb.end));

  console.log('\n[4] 甲买一块补丁并放到自己板上');
  await waitFor(A.ws, '__pw.state.active === __pw.seat', 8000, '轮到甲行动');
  const beforeBoard = await evaluate(A.ws, '__pw.state.players[__pw.seat].board.flat().filter(Boolean).length');
  await evaluate(A.ws,
    "(function(){var c=document.querySelector('#ringFront .patch-card:not(.disabled)'); if(c) c.click(); return 'ok';})()");
  check('甲选中了一块补丁', await evaluate(A.ws, '!!__pw.selected'));

  // 新交互：选中补丁后鼠标一进板面就该有落点预览，不需要先点一下
  await evaluate(A.ws,
    "(function(){var q=window.__pw.myQuilt(); q.children[0].dispatchEvent(new MouseEvent('mouseenter',{bubbles:true})); return 'ok';})()");
  check('选中即出现落点预览（不用先点击）', await evaluate(A.ws,
    "window.__pw.myQuilt().querySelectorAll('.qcell.valid, .qcell.invalid').length > 0"));
  // 预览必须压住鼠标所在那一格，不能因为形状外接框有空角就被推到旁边
  check('预览盖住鼠标停的那一格', await evaluate(A.ws,
    "(function(){ if(!__pw.hover) return false; var i=__pw.hover.row*9+__pw.hover.col;" +
    " var c=window.__pw.myQuilt().children[i];" +
    " return c.classList.contains('valid')||c.classList.contains('invalid'); })()"));

  // 左键点击 = 固定落点（预览不再跟手）
  await evaluate(A.ws,
    "(function(){var c=window.__pw.myQuilt().children; for(var i=0;i<c.length;i++){ c[i].click(); if(window.__pw.locked) return 'locked'; } return 'none';})()");
  check('左键点击固定落点', await evaluate(A.ws, '!!__pw.locked'));
  check('固定后鼠标那格就是落点高亮', await evaluate(A.ws,
    "(function(){ if(!__pw.hover||!__pw.locked) return false; var i=__pw.hover.row*9+__pw.hover.col;" +
    " var c=window.__pw.myQuilt().children[i];" +
    " return c.classList.contains('locked'); })()"));
  check('固定后「确认放置」变为可用', await evaluate(A.ws,
    "document.getElementById('btnConfirm').disabled === false"));

  // 右键解除固定，预览重新跟手
  await evaluate(A.ws,
    "(function(){var q=window.__pw.myQuilt(); q.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})); return 'ok';})()");
  check('右键可解除固定', await evaluate(A.ws, '__pw.locked === null'));
  // 再固定回去，继续后面的流程
  await evaluate(A.ws,
    "(function(){var c=window.__pw.myQuilt().children; for(var i=0;i<c.length;i++){ c[i].click(); if(window.__pw.locked) return 'locked'; } return 'none';})()");
  check('可以重新固定落点', await evaluate(A.ws, '!!__pw.locked'));
  await evaluate(A.ws, "document.getElementById('btnConfirm').click(); 'ok'");
  await waitFor(A.ws, `__pw.state.players[__pw.seat].board.flat().filter(Boolean).length > ${beforeBoard}`, 8000, '甲的板上出现新补丁');
  const afterBoard = await evaluate(A.ws, '__pw.state.players[__pw.seat].board.flat().filter(Boolean).length');
  check('补丁已落到甲的拼布板上', afterBoard > beforeBoard, beforeBoard + ' -> ' + afterBoard);
  check('落子后日志里记了一笔', await evaluate(A.ws, "document.querySelectorAll('#log div').length > 0"));

  await waitFor(B.ws, '__pw.state.players[1-__pw.seat].board.flat().filter(Boolean).length > 0', 8000, '乙端同步看到对手落子');
  check('乙的界面同步了对手的落子', true);

  console.log('\n[5b] 对手能看到我正在放哪（v1.3 实时预览）');
  // 这段放在「乙跳过」之后才跑：它需要轮到某一方，而且不能打断上面的回合归属
  const runGhostTest = async () => {
  // 先把可能挂着的皮革补丁放掉，否则行动方会被卡住
  for (let i = 0; i < 5; i += 1) {
    const pend = await evaluate(A.ws, '__pw.state.pendingLeather.length ? __pw.state.pendingLeather[0].player : -1');
    if (pend < 0) break;
    await evaluate((pend === 0 ? A : B).ws, CLICK_EMPTY);
    await waitFor(A.ws, '__pw.state.pendingLeather.length === 0', 6000, '皮革补丁已放置');
  }
  await waitFor(A.ws, '__pw.state.phase === "playing" && __pw.state.active !== null', 8000, '有一方能行动');
  const actorIsA = await evaluate(A.ws, '__pw.state.active === __pw.seat');
  const ACT = actorIsA ? A : B;    // 正在行动的那个窗口
  const WATCH = actorIsA ? B : A;  // 旁观的那个窗口
  const actorSeat = await evaluate(ACT.ws, '__pw.seat');
  check('找到了行动方与旁观方', actorSeat === 0 || actorSeat === 1, 'seat=' + actorSeat);

  // 行动方：临时把纽扣拉满（免得三块都买不起），选中一块并挪到一个放得下的位置
  const picked = await evaluate(ACT.ws, `(function(){
    var st = window.__pw.state;
    var me = st.players[window.__pw.seat];
    window.__btnBackup = me.buttons;
    me.buttons = 99;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    var cards = document.querySelectorAll('#ringFront .patch-card:not(.disabled)');
    if (!cards.length) return 'no-card';
    cards[0].click();
    var q = window.__pw.myQuilt(); var c = q.children;
    for (var i = 0; i < c.length; i++) {
      c[i].dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      if (q.querySelectorAll('.qcell.valid').length) { c[i].click(); return 'ok'; }
    }
    return 'no-spot';
  })()`);
  check('行动方选好了补丁和落点', picked === 'ok', picked);
  await sleep(700);

  const ghost = await evaluate(WATCH.ws, `(function(){
    var card = document.querySelector('.player-card[data-seat="${actorSeat}"]');
    return {
      n: card ? card.querySelectorAll('.qcell.ghost').length : 0,
      turn: document.getElementById('turnTag').textContent,
      myOwn: document.querySelectorAll('.player-card[data-seat="' + __pw.seat + '"] .qcell.ghost').length,
    };
  })()`);
  check('对手那块拼布板上出现了半透明预览', ghost.n > 0, JSON.stringify(ghost));
  check('预览只画在对手自己板上，不串到我这块', ghost.myOwn === 0, '我板上 ' + ghost.myOwn + ' 格');
  check('顶栏写着对手正在放哪一块', /正在放/.test(ghost.turn), ghost.turn);
  await screenshot(WATCH.ws, 'v14-3-ghost.png');

  // Esc 一次解除固定、再一次取消选择，预览应当消失
  await evaluate(ACT.ws, `(function(){
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    window.__pw.state.players[__pw.seat].buttons = window.__btnBackup;
    return 'ok';
  })()`);
  await sleep(700);
  const ghostGone = await evaluate(WATCH.ws, "document.querySelectorAll('.qcell.ghost').length");
  check('取消选择后对手那边的预览跟着消失', ghostGone === 0, '还剩 ' + ghostGone);
  };

  console.log('\n[5] 轮到乙时点「跳过」领纽扣');
  await waitFor(B.ws, '__pw.state.active === __pw.seat && __pw.state.pendingLeather.length === 0', 10000, '轮到乙行动');
  const bTime = await evaluate(B.ws, '__pw.state.players[__pw.seat].time');
  const bBtn = await evaluate(B.ws, '__pw.state.players[__pw.seat].buttons');
  await evaluate(B.ws, "document.getElementById('btnAdvance').click(); 'ok'");
  await waitFor(B.ws, `__pw.state.players[__pw.seat].time > ${bTime}`, 8000, '乙时间前进');
  const bTime2 = await evaluate(B.ws, '__pw.state.players[__pw.seat].time');
  const bBtn2 = await evaluate(B.ws, '__pw.state.players[__pw.seat].buttons');
  check('时间令牌前进', bTime2 > bTime, bTime + ' -> ' + bTime2);
  check('前进领到了纽扣', bBtn2 > bBtn, bBtn + ' -> ' + bBtn2);
  check('甲的界面同步了乙的状态', await evaluate(A.ws, `__pw.state.players[1-__pw.seat].time === ${bTime2}`));

  await runGhostTest();

  console.log('\n[6] 皮革补丁放置交互');
  let leatherSeen = false;
  for (let i = 0; i < 150 && !leatherSeen; i += 1) {
    const which = await evaluate(A.ws, '__pw.state.pendingLeather.length ? __pw.state.pendingLeather[0].player : -1');
    if (which >= 0) {
      const w = which === 0 ? A : B;
      const emptyBefore = await evaluate(w.ws, '__pw.state.players[__pw.seat].empty');
      await evaluate(w.ws, CLICK_EMPTY);
      await waitFor(w.ws, '__pw.state.pendingLeather.length === 0', 6000, '皮革补丁已放置');
      const emptyAfter = await evaluate(w.ws, '__pw.state.players[__pw.seat].empty');
      check('点击空格后皮革补丁放下', emptyAfter === emptyBefore - 1, emptyBefore + ' -> ' + emptyAfter);
      leatherSeen = true;
      break;
    }
    const who = await evaluate(A.ws, '__pw.state.active');
    if (who === null || who === undefined) break;
    const w = who === 0 ? A : B;
    await evaluate(w.ws, "document.getElementById('btnAdvance').click(); 'ok'");
    await sleep(60);
  }
  check('皮革补丁界面流程走通', leatherSeen);

  console.log('\n[7] 打完整局并检查结算弹层');
  for (let i = 0; i < 400; i += 1) {
    if (await evaluate(A.ws, "__pw.state.phase === 'over'")) break;
    const o = JSON.parse(await evaluate(A.ws,
      'JSON.stringify({a:__pw.state.active,p:__pw.state.pendingLeather.length?__pw.state.pendingLeather[0].player:-1})'));
    const seat = o.p >= 0 ? o.p : o.a;
    if (seat === null || seat === undefined) break;
    const w = seat === 0 ? A : B;
    await evaluate(w.ws, o.p >= 0 ? CLICK_EMPTY : TRY_BUY);
    await sleep(40);
  }

  const over = await evaluate(A.ws, "__pw.state.phase === 'over'");
  check('界面上打到了终局', over === true);
  if (over) {
    check('结算弹层已弹出', await evaluate(A.ws, "document.getElementById('overlay').classList.contains('show')"));
    check('结算用排名表展示', await evaluate(A.ws, "document.querySelectorAll('#ovBody .score-table tbody tr').length === 2"));
    const ovText = await evaluate(A.ws, "document.getElementById('ovBody').innerText");
    check('结算含纽扣/奖励/空格/总分',
      /纽扣/.test(ovText) && /7×7/.test(ovText) && /空格/.test(ovText) && /总分/.test(ovText), ovText.replace(/\n/g, ' '));
    check('对手端也弹出结算', await evaluate(B.ws, "document.getElementById('overlay').classList.contains('show')"));

    // 用户反馈的「再来一局失效」：两边都点一下，应该真的开出新一局
    const t0Before = await evaluate(A.ws, '__pw.state.players[0].time');
    await evaluate(A.ws, "document.getElementById('btnRematch').click(); 'ok'");
    await evaluate(B.ws, "document.getElementById('btnRematch').click(); 'ok'");
    await waitFor(A.ws, "__pw.state.phase === 'playing'", 8000, '双方同意后开出新一局');
    check('「再来一局」真的开了新局', await evaluate(A.ws, "__pw.state.phase === 'playing'"));
    check('新局时间归零', await evaluate(A.ws, '__pw.state.players[0].time') === 0,
      String(t0Before) + ' -> ' + await evaluate(A.ws, '__pw.state.players[0].time'));
    check('新局板子清空', await evaluate(A.ws, '__pw.state.players[0].board.flat().filter(Boolean).length') === 0);
    check('新局结算弹层已收起', await evaluate(A.ws, "document.getElementById('overlay').classList.contains('show') === false"));
    check('新局日志已清空重开', await evaluate(A.ws, "document.getElementById('log').innerText.indexOf('对局开始') >= 0"));
  }

  console.log('\n[8] 截图');
  console.log('      甲端 ' + await screenshot(A.ws, 'game-a.png'));
  console.log('      乙端 ' + await screenshot(B.ws, 'game-b.png'));

  console.log('\n[9] 页面 JS 报错');
  check('全程无 JS 报错', errors.length === 0, errors.slice(0, 5).join(' | '));

  A.ws.close(); B.ws.close();
  A.proc.kill(); B.proc.kill();

  console.log('\n----------------------------------------');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.error('联调异常：', e.message || e); process.exit(1); });
