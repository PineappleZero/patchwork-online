'use strict';

/*
 * 真实浏览器联调：用 CDP 驱动本机 Edge 开两个窗口（模拟你和朋友两台机器），
 * 走完「建房 → 加入 → 买补丁 → 放置 → 领纽扣 → 结算」的完整界面流程，
 * 同时收集页面 JS 报错并截图。
 *
 * 用法：先启动服务端（node server/index.js），再运行 node uitest.js
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

/** 点自己板上第一个空格（用于放 1x1 皮革补丁） */
const CLICK_EMPTY = `
  (function(){
    var c = document.getElementById('meQuilt').children;
    for (var i = 0; i < c.length; i++) {
      if (!c[i].classList.contains('filled')) { c[i].click(); return 'clicked'; }
    }
    return 'full';
  })()
`;

/** 尽量买一块补丁并放下，放不下就跳过领纽扣 */
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
  console.log('\n=== Patchwork 浏览器联调（两个 Edge 实例模拟两台电脑） ===\n');
  const errors = [];

  console.log('[1] 打开两个浏览器窗口');
  const A = await launchEdge(9222, `http://127.0.0.1:${PORT}/`, 'a');
  const B = await launchEdge(9223, `http://127.0.0.1:${PORT}/`, 'b');
  collectErrors(A.ws, errors, '窗口甲');
  collectErrors(B.ws, errors, '窗口乙');
  check('两个浏览器窗口均已打开', true);

  await waitFor(A.ws, "typeof S !== 'undefined' && S.meta !== null", 10000, '甲端加载原版数据');
  await waitFor(B.ws, "typeof S !== 'undefined' && S.meta !== null", 10000, '乙端加载原版数据');
  await waitFor(A.ws, "!!document.getElementById('btnCreate')", 8000, '大厅界面就绪');
  await waitFor(B.ws, "!!document.getElementById('btnCreate')", 8000, '大厅界面就绪');
  check('两端都拉到了 /api/info 数据', true);

  console.log('\n[2] 甲创建房间');
  await evaluate(A.ws, "document.getElementById('playerName').value='甲'; document.getElementById('btnCreate').click(); 'ok'");
  const room = await waitFor(A.ws, 'S.room', 8000, '甲拿到房间码');
  check('房间码为 4 位', /^[A-Z0-9]{4}$/.test(room), room);
  check('甲进入对局界面', await evaluate(A.ws, "document.getElementById('game').classList.contains('active')"));

  console.log('\n[3] 乙用房间码加入');
  await evaluate(B.ws, `document.getElementById('playerName').value='乙'; document.getElementById('roomCode').value='${room}'; document.getElementById('btnJoin').click(); 'ok'`);
  await waitFor(B.ws, 'S.room !== null', 8000, '乙加入房间');
  check('乙进入对局界面', await evaluate(B.ws, "document.getElementById('game').classList.contains('active')"));

  await waitFor(A.ws, 'S.state && S.state.started === true', 8000, '甲端看到开局');
  const st0 = JSON.parse(await evaluate(A.ws,
    'JSON.stringify({p0:S.state.players[0].name,p1:S.state.players[1].name,v:S.state.visible.length})'));
  check('双方姓名正确显示', st0.p0 === '甲' && st0.p1 === '乙', JSON.stringify(st0));
  check('市场可见 3 块补丁', st0.v === 3);

  console.log('\n[4] 甲买一块补丁并放到自己板上');
  await waitFor(A.ws, 'S.state.active === S.seat', 8000, '轮到甲行动');
  const beforeBoard = await evaluate(A.ws, 'S.state.players[S.seat].board.flat().filter(Boolean).length');
  await evaluate(A.ws,
    "(function(){var c=document.querySelector('#marketRow .patch-card:not(.disabled)'); if(c) c.click(); return 'ok';})()");
  check('甲选中了一块补丁', await evaluate(A.ws, '!!S.selected'));

  await evaluate(A.ws, "document.getElementById('meQuilt').children[0].click(); 'ok'");
  check('落点已锚定', await evaluate(A.ws, 'S.anchored === true'));
  await evaluate(A.ws, "document.getElementById('btnConfirm').click(); 'ok'");
  await waitFor(A.ws, `S.state.players[S.seat].board.flat().filter(Boolean).length > ${beforeBoard}`, 8000, '甲的板上出现新补丁');
  const afterBoard = await evaluate(A.ws, 'S.state.players[S.seat].board.flat().filter(Boolean).length');
  check('补丁已落到甲的拼布板上', afterBoard > beforeBoard, beforeBoard + ' -> ' + afterBoard);

  await waitFor(B.ws, 'S.state.players[1-S.seat].board.flat().filter(Boolean).length > 0', 8000, '乙端同步看到对手落子');
  check('乙的界面同步了对手的落子', true);

  console.log('\n[5] 轮到乙时点「跳过」领纽扣');
  await waitFor(B.ws, 'S.state.active === S.seat && S.state.pendingLeather.length === 0', 10000, '轮到乙行动');
  const bTime = await evaluate(B.ws, 'S.state.players[S.seat].time');
  const bBtn = await evaluate(B.ws, 'S.state.players[S.seat].buttons');
  await evaluate(B.ws, "document.getElementById('btnAdvance').click(); 'ok'");
  await waitFor(B.ws, `S.state.players[S.seat].time > ${bTime}`, 8000, '乙时间前进');
  const bTime2 = await evaluate(B.ws, 'S.state.players[S.seat].time');
  const bBtn2 = await evaluate(B.ws, 'S.state.players[S.seat].buttons');
  check('时间令牌前进', bTime2 > bTime, bTime + ' -> ' + bTime2);
  check('前进领到了纽扣', bBtn2 > bBtn, bBtn + ' -> ' + bBtn2);
  check('甲的界面同步了乙的状态', await evaluate(A.ws, `S.state.players[1-S.seat].time === ${bTime2}`));

  console.log('\n[6] 皮革补丁放置交互');
  let leatherSeen = false;
  for (let i = 0; i < 150 && !leatherSeen; i += 1) {
    const which = await evaluate(A.ws, 'S.state.pendingLeather.length ? S.state.pendingLeather[0].player : -1');
    if (which >= 0) {
      const w = which === 0 ? A : B;
      const emptyBefore = await evaluate(w.ws, 'S.state.players[S.seat].empty');
      await evaluate(w.ws, CLICK_EMPTY);
      await waitFor(w.ws, 'S.state.pendingLeather.length === 0', 6000, '皮革补丁已放置');
      const emptyAfter = await evaluate(w.ws, 'S.state.players[S.seat].empty');
      check('点击空格后皮革补丁放下', emptyAfter === emptyBefore - 1, emptyBefore + ' -> ' + emptyAfter);
      leatherSeen = true;
      break;
    }
    const who = await evaluate(A.ws, 'S.state.active');
    if (who === null || who === undefined) break;
    const w = who === 0 ? A : B;
    await evaluate(w.ws, "document.getElementById('btnAdvance').click(); 'ok'");
    await sleep(60);
  }
  check('皮革补丁界面流程走通', leatherSeen);

  console.log('\n[7] 打完整局并检查结算弹层');
  for (let i = 0; i < 400; i += 1) {
    if (await evaluate(A.ws, "S.state.phase === 'over'")) break;
    const o = JSON.parse(await evaluate(A.ws,
      'JSON.stringify({a:S.state.active,p:S.state.pendingLeather.length?S.state.pendingLeather[0].player:-1})'));
    const seat = o.p >= 0 ? o.p : o.a;
    if (seat === null || seat === undefined) break;
    const w = seat === 0 ? A : B;
    await evaluate(w.ws, o.p >= 0 ? CLICK_EMPTY : TRY_BUY);
    await sleep(40);
  }

  const over = await evaluate(A.ws, "S.state.phase === 'over'");
  check('界面上打到了终局', over === true);
  if (over) {
    check('结算弹层已弹出', await evaluate(A.ws, "document.getElementById('overlay').classList.contains('show')"));
    const ovText = await evaluate(A.ws, "document.getElementById('ovBody').innerText");
    check('结算含纽扣/奖励/空格/总分',
      /剩余纽扣/.test(ovText) && /7×7 奖励/.test(ovText) && /空格扣分/.test(ovText) && /最终得分/.test(ovText));
    check('对手端也弹出结算', await evaluate(B.ws, "document.getElementById('overlay').classList.contains('show')"));
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
