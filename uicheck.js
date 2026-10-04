'use strict';

/*
 * v1.2 界面联调：用 CDP 驱动本机 Edge，逐屏截图并断言关键布局。
 * 覆盖：主菜单 / 人机对战 / 事件纪要滚动 / 更新日志 / 六人联机等待房与对局。
 *
 * 用两个 Edge 实例：A 跑单机部分，B 跑联机部分。
 * 因为「返回主菜单」会整页重载，而 localStorage 里还存着上一局的座位，
 * 在同一实例里继续测会被自动拉回旧房间，分开最省事。
 */

const http = require('http');
const crypto = require('crypto');
const { launchEdge, evaluate, waitFor, screenshot, collectErrors, sleep } = require('./browserkit');

const HOST = '127.0.0.1';
const PORT = 3178;
const URL_BASE = `http://${HOST}:${PORT}/`;

/* ---------------- 极简 WebSocket 客户端（走游戏协议，不是 CDP） ---------------- */
function gameConnect() {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      port: PORT, host: HOST, path: '/',
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': 13,
      },
    });
    req.on('upgrade', (res, socket) => {
      const c = {
        socket, buf: Buffer.alloc(0), seen: [], waiters: [],
        send(obj) {
          const p = Buffer.from(JSON.stringify(obj), 'utf8');
          const mask = crypto.randomBytes(4);
          let head;
          if (p.length < 126) { head = Buffer.alloc(2); head[1] = 0x80 | p.length; }
          else { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(p.length, 2); }
          head[0] = 0x81;
          const m = Buffer.from(p);
          for (let i = 0; i < m.length; i += 1) m[i] ^= mask[i % 4];
          socket.write(Buffer.concat([head, mask, m]));
        },
        wait(pred, timeout = 6000) {
          const hit = c.seen.find(pred);
          if (hit) return Promise.resolve(hit);
          return new Promise((res2, rej2) => {
            const t = setTimeout(() => rej2(new Error('游戏消息等待超时')), timeout);
            c.waiters.push({ pred, res: res2, t });
          });
        },
        close() { try { socket.destroy(); } catch (e) { /* noop */ } },
      };
      socket.on('data', (chunk) => {
        c.buf = Buffer.concat([c.buf, chunk]);
        for (;;) {
          if (c.buf.length < 2) return;
          const op = c.buf[0] & 0x0f;
          let len = c.buf[1] & 0x7f;
          let off = 2;
          if (len === 126) { if (c.buf.length < 4) return; len = c.buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (c.buf.length < 10) return; len = Number(c.buf.readBigUInt64BE(2)); off = 10; }
          if (c.buf.length < off + len) return;
          const payload = c.buf.slice(off, off + len);
          c.buf = c.buf.slice(off + len);
          if (op !== 0x1) continue;
          let msg;
          try { msg = JSON.parse(payload.toString('utf8')); } catch (e) { continue; }
          c.seen.push(msg);
          for (let i = c.waiters.length - 1; i >= 0; i -= 1) {
            const w = c.waiters[i];
            if (w.pred(msg)) { clearTimeout(w.t); w.res(msg); c.waiters.splice(i, 1); }
          }
        }
      });
      socket.on('error', () => {});
      resolve(c);
    });
    req.on('error', reject);
    req.end();
  });
}

/* ---------------- 断言 ---------------- */
let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + label); }
  else { fail += 1; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + extra : '')); }
}

(async () => {
  const errA = [];
  const errB = [];
  const edgeA = await launchEdge(9333, URL_BASE, 'v13a');
  const edgeB = await launchEdge(9334, URL_BASE, 'v13b');

  try {
    /* ================= A：单机部分 ================= */
    const ws = edgeA.ws;
    collectErrors(ws, errA, '单机页');

    console.log('\n[1] 主菜单');
    await waitFor(ws, `document.getElementById('menu').classList.contains('active')`, 12000, '主菜单出现');
    await sleep(400);
    await screenshot(ws, 'v13-1-menu.png');

    const menu = await evaluate(ws, `(function(){
      const q = (s) => document.querySelector(s);
      const ids = ['playerName','btnSolo','btnLocal','botLevel','playerCount','btnCreate','roomCode','btnJoin','btnRulesMenu','btnChangelog'];
      const missing = ids.filter((id) => !q('#' + id));
      const rect = q('.menu-card').getBoundingClientRect();
      return {
        missing,
        cards: document.querySelectorAll('.mode-card').length,
        counts: Array.from(document.querySelectorAll('#playerCount option')).map((o) => o.value),
        visible: rect.top >= -2 && rect.bottom <= window.innerHeight + 2,
        h: Math.round(rect.height), vh: window.innerHeight,
      };
    })()`);
    ok(menu.missing.length === 0, '菜单控件齐全', '缺 ' + JSON.stringify(menu.missing));
    ok(menu.cards === 2, '单机有两个模式入口', '实际 ' + menu.cards);
    ok(menu.counts.join(',') === '2,3,4,5,6', '人数可选 2~6', menu.counts.join(','));
    ok(menu.visible, '菜单整卡在视口内', `高 ${menu.h} / 视口 ${menu.vh}`);

    console.log('\n[2] 人机对战');
    await evaluate(ws, `document.getElementById('btnSolo').click()`);
    await waitFor(ws, `document.getElementById('game').classList.contains('active')`, 8000, '进入对局');
    await waitFor(ws, `document.querySelectorAll('#playersWrap .player-card').length === 2`, 8000, '两张玩家卡');
    await waitFor(ws, `document.getElementById('modeTag').textContent.indexOf('人机') >= 0`, 5000, '模式标签');
    await sleep(1500); // 让电脑走两步，日志里就有内容了
    await screenshot(ws, 'v13-2-solo.png');

    const solo = await evaluate(ws, `(function(){
      const cards = document.querySelectorAll('#playersWrap .player-card');
      const botTag = document.querySelector('#playersWrap .player-card .pc-tag.bot');
      return {
        n: cards.length,
        gridCols: getComputedStyle(document.getElementById('playersWrap')).gridTemplateColumns.split(' ').length,
        bot: !!botTag,
        botText: botTag ? botTag.textContent : '',
        mode: document.getElementById('modeTag').textContent,
        copyHidden: getComputedStyle(document.getElementById('btnCopy')).display === 'none',
        logs: document.querySelectorAll('#log div').length,
      };
    })()`);
    ok(solo.n === 2, '渲染 2 张玩家卡');
    ok(solo.bot, '电脑席位带「电脑」标签', solo.botText);
    ok(solo.gridCols === 2, '双人两列并排', '实际 ' + solo.gridCols + ' 列');
    ok(solo.mode === '人机对战', '模式标签正确', solo.mode);
    ok(solo.copyHidden, '单机模式隐藏「复制邀请」');

    console.log('\n[3] 事件纪要（用户第二次反馈的那个）');
    const logBox = await evaluate(ws, `(function(){
      const e = document.getElementById('log');
      e.innerHTML = '';
      for (let i = 1; i <= 80; i += 1) {
        const d = document.createElement('div');
        d.textContent = '第 ' + i + ' 条测试纪要，用来撑高内容看滚动条会不会出来';
        e.appendChild(d);
      }
      e.scrollTop = e.scrollHeight;
      const r = {
        clientHeight: e.clientHeight,
        scrollHeight: e.scrollHeight,
        maxScroll: e.scrollHeight - e.clientHeight,
        atBottom: Math.abs(e.scrollTop - (e.scrollHeight - e.clientHeight)) <= 2,
        overflowY: getComputedStyle(e).overflowY,
      };
      return r;
    })()`);
    ok(logBox.clientHeight > 0 && logBox.clientHeight <= 420,
      '日志框高度被锁死（不再被内容撑开）', `clientHeight=${logBox.clientHeight}`);
    ok(logBox.scrollHeight > logBox.clientHeight,
      '内容超出后出现可滚动区域', `scroll ${logBox.scrollHeight} vs ${logBox.clientHeight}`);
    ok(logBox.maxScroll > 0, '存在真实可滚动距离', 'maxScroll=' + logBox.maxScroll);

    const jumped = await evaluate(ws, `(function(){
      const e = document.getElementById('log');
      e.scrollTop = 0;                 // 手动往上翻
      window.pushLog('一条新动态，用来触发提示按钮');  // pushLog 是顶层函数声明，挂在 window 上
      return { hidden: document.getElementById('btnLogJump').hidden };
    })()`);
    await sleep(200);
    ok(!jumped.hidden, '往上翻时提示按钮亮起', JSON.stringify(jumped));

    const backBottom = await evaluate(ws, `(function(){
      document.getElementById('btnLogJump').click();
      const e = document.getElementById('log');
      return { atBottom: Math.abs(e.scrollTop - (e.scrollHeight - e.clientHeight)) <= 2,
               hidden: document.getElementById('btnLogJump').hidden };
    })()`);
    ok(backBottom.atBottom && backBottom.hidden, '点提示按钮能回到最新', JSON.stringify(backBottom));
    await screenshot(ws, 'v13-3-log.png');

    console.log('\n[4] 更新日志');
    await evaluate(ws, `document.getElementById('btnChangelog').click()`);
    await sleep(300);
    const cl = await evaluate(ws, `(function(){
      const m = document.getElementById('changelogModal');
      return {
        show: m.classList.contains('show'),
        vers: m.querySelectorAll('.ver').length,
        first: (m.querySelector('.ver h3') || {}).textContent || '',
        items: m.querySelectorAll('.ver:first-child li').length,
      };
    })()`);
    ok(cl.show, '更新日志弹层能打开');
    ok(cl.vers >= 3, '包含 3 个及以上版本', '实际 ' + cl.vers);
    ok(cl.first.indexOf('v1.2') === 0, '首条是 v1.2', cl.first);
    ok(cl.items >= 5, 'v1.2 条目不少于 5 条', '实际 ' + cl.items);
    await screenshot(ws, 'v13-4-changelog.png');

    /* ================= B：联机部分 ================= */
    const wsb = edgeB.ws;
    collectErrors(wsb, errB, '联机页');

    console.log('\n[5] 六人联机');
    await waitFor(wsb, `document.getElementById('menu').classList.contains('active')`, 12000, '联机页主菜单出现');
    await evaluate(wsb, `(function(){
      document.getElementById('playerCount').value = '6';
      document.getElementById('playerName').value = '房主';
      document.getElementById('btnCreate').click();
    })()`);
    await waitFor(wsb, `document.getElementById('waitModal').classList.contains('show')`, 8000, '等待房出现');
    const room = await evaluate(wsb, `document.getElementById('waitCode').textContent.trim()`);
    ok(/^[A-Z0-9]{4}$/.test(room), '拿到 4 位房间码', room);

    const joiners = [];
    for (let i = 2; i <= 5; i += 1) {
      const c = await gameConnect();
      c.send({ type: 'join', name: '玩家' + i, room });
      await c.wait((m) => m.type === 'joined');
      joiners.push(c);
    }
    await waitFor(wsb, `document.querySelectorAll('#waitList .wait-row:not(.empty)').length === 5`, 8000, '五人已就座');
    await sleep(250);
    await screenshot(wsb, 'v13-5-wait.png');

    const waitInfo = await evaluate(wsb, `(function(){
      const btn = document.getElementById('btnStart');
      return {
        rows: document.querySelectorAll('#waitList .wait-row:not(.empty)').length,
        empty: document.querySelectorAll('#waitList .wait-row.empty').length,
        startEnabled: !btn.disabled,
        btnText: btn.textContent,
        open: document.getElementById('waitModal').classList.contains('show'),
      };
    })()`);
    ok(waitInfo.rows === 5 && waitInfo.empty === 1, '等待房 5 人就座 + 1 个空位', JSON.stringify(waitInfo));
    ok(waitInfo.open && waitInfo.startEnabled, '还没坐满，房主可提前开局', waitInfo.btnText);

    // 第 6 个人进来，坐满应当自动开局（不需要再点「开始」）
    const last = await gameConnect();
    last.send({ type: 'join', name: '玩家6', room });
    await last.wait((m) => m.type === 'joined');
    joiners.push(last);

    await waitFor(wsb, `document.getElementById('waitModal').classList.contains('show') === false`, 6000, '坐满自动开局');
    await waitFor(wsb, `document.querySelectorAll('#playersWrap .player-card').length === 6`, 6000, '六张玩家卡');
    await sleep(700);
    await screenshot(wsb, 'v13-6-six.png');

    const six = await evaluate(wsb, `(function(){
      const wrap = document.getElementById('playersWrap');
      const cards = wrap.querySelectorAll('.player-card');
      const tops = [];
      cards.forEach((c) => tops.push(Math.round(c.getBoundingClientRect().top / 10)));
      return {
        n: cards.length,
        dataN: document.getElementById('boardWrap').dataset.n,
        cols: getComputedStyle(wrap).gridTemplateColumns.split(' ').length,
        mode: document.getElementById('modeTag').textContent,
        distinctRows: new Set(tops).size,
        cardsOverflow: wrap.scrollHeight > wrap.clientHeight + 2,
        wrapScroll: wrap.scrollHeight,
        wrapClient: wrap.clientHeight,
        pageScrolls: document.documentElement.scrollHeight > window.innerHeight,
      };
    })()`);
    ok(six.n === 6, '六张玩家卡都渲染');
    ok(six.cols === 3, '六人三列布局', '实际 ' + six.cols);
    ok(six.distinctRows >= 2, '六人分两行以上', '实际 ' + six.distinctRows);
    ok(six.mode.indexOf('6') >= 0, '模式标签显示 6 人联机', six.mode);
    ok(!six.cardsOverflow, '六块拼布板一屏看得全，不用滚动',
      `scrollHeight ${six.wrapScroll} vs clientHeight ${six.wrapClient}`);
    ok(!six.pageScrolls, '整页没有出现滚动条（布局没撑破）');

    const tok = await evaluate(wsb, `(function(){
      const t = document.querySelectorAll('#timeboard .tb-cell .tok');
      const lefts = new Set();
      t.forEach((x) => lefts.add(x.style.left));
      return { count: t.length, distinctLefts: lefts.size };
    })()`);
    ok(tok.count >= 1, '时间板上画出了令牌', JSON.stringify(tok));

    await sleep(300);
    ok(errA.length === 0, '单机页没有未捕获异常', errA.join(' | '));
    ok(errB.length === 0, '联机页没有未捕获异常', errB.join(' | '));

    joiners.forEach((c) => c.close());

  } catch (e) {
    fail += 1;
    console.log('\n!! 脚本中断：' + e.message);
    if (errA.length) console.log('   单机页异常：' + errA.join(' | '));
    if (errB.length) console.log('   联机页异常：' + errB.join(' | '));
    try {
      const dump = await evaluate(edgeB.ws, `(function(){
        return {
          screen: document.getElementById('menu').classList.contains('active') ? 'menu' : 'game',
          waitShow: document.getElementById('waitModal').classList.contains('show'),
          cards: document.querySelectorAll('#playersWrap .player-card').length,
          turn: document.getElementById('turnTag').textContent,
          sel: document.getElementById('selInfo').textContent,
        };
      })()`);
      console.log('   联机页现场：' + JSON.stringify(dump));
    } catch (e2) { /* noop */ }
  } finally {
    try { edgeA.proc.kill(); } catch (e) { /* noop */ }
    try { edgeB.proc.kill(); } catch (e) { /* noop */ }
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
