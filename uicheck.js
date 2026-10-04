'use strict';

/*
 * v1.4 界面联调：用 CDP 驱动本机 Edge，逐屏截图并断言关键布局。
 * 覆盖：主菜单（含联机网址）/ 人机对战 / 补丁环包住时间板 / 跳过按钮高亮 / 事件纪要滚动 / 更新日志 / 六人联机。
 *
 * 用两个 Edge 实例：A 跑单机部分，B 跑联机部分。
 * 因为「返回主菜单」会整页重载，而 localStorage 里还存着上一局的座位，
 * 在同一实例里继续测会被自动拉回旧房间，分开最省事。
 */

const http = require('http');
const crypto = require('crypto');
const { launchEdge, evaluate, waitFor, screenshot, collectErrors, sleep } = require('./browserkit');

const HOST = '127.0.0.1';
// 端口跟着环境变量走：开发时可以在别的端口起一份服务，
// 不要去打扰正在被朋友连着的那一份（以前这里写死 3178，结果测的是旧服务端）。
const PORT = Number(process.env.PORT || 3178);
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
    await waitFor(ws, `!document.getElementById('netHint').hidden`, 8000, '联机网址渲染出来');
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

    const net = await evaluate(ws, `(function(){
      const box = document.getElementById('netHint');
      const code = document.getElementById('netUrl');
      const btn = document.getElementById('btnCopyUrl');
      const r = code.getBoundingClientRect();
      return {
        shown: !box.hidden,
        text: code.textContent,
        hasBtn: !!btn,
        fits: r.width > 40 && r.right <= window.innerWidth,
      };
    })()`);
    ok(net.shown && /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/.test(net.text),
      '主菜单显示联机网址（不用再去 PowerShell 里找）', net.text);
    ok(net.hasBtn && net.fits, '网址后面有复制按钮，且没被挤出视口');

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

    console.log('\n[2b] 补丁环包住时间板（v1.4 的主角）');
    const ring = await evaluate(ws, `(function(){
      const st = window.__pw.state;
      const stage = document.getElementById('ringStage');
      const guide = stage.querySelector('.ring-guide');
      const core = stage.querySelector('.ring-core');
      const tb = document.getElementById('timeboard');
      const chips = Array.from(document.getElementById('ringFar').children);
      const sr = stage.getBoundingClientRect();
      const gr = guide.getBoundingClientRect();
      const cr = core.getBoundingClientRect();
      const tr = tb.getBoundingClientRect();
      const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
      const chipsBox = chips.map(box);
      const outside = chipsBox.filter((b) => b.x < sr.x - 1 || b.y < sr.y - 1 ||
        b.x + b.w > sr.x + sr.width + 1 || b.y + b.h > sr.y + sr.height + 1).length;
      const radii = chipsBox.map((b) => {
        const dx = (b.x + b.w / 2) - (gr.x + gr.width / 2);
        const dy = (b.y + b.h / 2) - (gr.y + gr.height / 2);
        return Math.round(Math.hypot(dx, dy));
      });
      const R = gr.width / 2;
      const cx = gr.x + R;
      const cy = gr.y + R;
      // 环心里那块棋盘的四角离圆心多远：必须明显小于轨道半径，圆才算真「包住」它
      const corner = Math.hypot(cr.width / 2, cr.height / 2);
      const rows = new Set(Array.from(tb.children).map((c) => Math.round(c.getBoundingClientRect().y)));
      const front = Array.from(document.getElementById('ringFront').children);
      return {
        N: st.circle.length,
        visible: st.visible,
        chips: chips.length,
        chipIds: chips.map((c) => c.dataset.patchId),
        frontIds: front.map((c) => c.dataset.patchId),
        frontHasGrid: front.every((c) => c.querySelector('.patch-grid') && c.querySelector('.patch-meta')),
        guideD: Math.round(gr.width),
        stage: { w: Math.round(sr.width), h: Math.round(sr.height) },
        outside,
        minR: Math.min(...radii), maxR: Math.max(...radii),
        corner: Math.round(corner),
        gapRingToCorner: Math.round(R - corner),
        tbCells: tb.children.length,
        tbCols: getComputedStyle(tb).gridTemplateColumns.split(' ').length,
        tbRows: rows.size,
        tbInsideCore: tr.x >= cr.x - 1 && tr.y >= cr.y - 1 &&
          tr.x + tr.width <= cr.x + cr.width + 1 && tr.y + tr.height <= cr.y + cr.height + 1,
        // 时间板的四个角都得落在轨道圆里面，否则圆会从棋盘角上切过去
        tbCornersInsideRing: [[tr.x, tr.y], [tr.x + tr.width, tr.y],
          [tr.x, tr.y + tr.height], [tr.x + tr.width, tr.y + tr.height]]
          .every((p) => Math.hypot(p[0] - cx, p[1] - cy) < R),
        label: document.getElementById('ringLabel').textContent,
        neutralShown: !document.getElementById('ringNeutral').hidden,
        neutralInStage: (function(){
          const n = document.getElementById('ringNeutral').getBoundingClientRect();
          return n.y + n.height <= sr.y + sr.height + 1 && n.x >= sr.x - 1 && n.x + n.width <= sr.x + sr.width + 1;
        })(),
        overflow: document.getElementById('centerCol').scrollHeight - document.getElementById('centerCol').clientHeight,
      };
    })()`);
    ok(ring.chips === ring.N - 3, '环上画出了「剩下的块数 − 正面前三块」个小补丁',
      `chips=${ring.chips} N=${ring.N}`);
    ok(ring.frontIds.length === 3 && ring.frontIds.join(',') === ring.visible.join(','),
      '正面三张卡片就是中立指示物前方那三块', ring.frontIds.join(',') + ' vs ' + ring.visible.join(','));
    ok(new Set(ring.chipIds.concat(ring.frontIds)).size === ring.N,
      '环上 + 正面合起来正好是全部剩余补丁，不重不漏');
    ok(!ring.chipIds.includes('A') || ring.N > 3, '2×1 那块不再霸占正面（原版规则）');
    ok(ring.frontHasGrid, '正面三张卡片都带着补丁形状和三个数字');
    ok(ring.guideD >= 300 && ring.guideD <= 380, '环的轨道直径在合理区间', ring.guideD + 'px');
    ok(ring.outside === 0, '没有小补丁溢出环的舞台', '溢出 ' + ring.outside + ' 个');
    ok(ring.maxR - ring.minR <= 2 && ring.maxR > 120,
      '每个小补丁都贴在圆周上', `半径 ${ring.minR}~${ring.maxR}`);
    ok(ring.tbCols === 9 && ring.tbRows === 6 && ring.tbCells === 54,
      '时间板改成 9 列 × 6 行，正好 54 格不剩不空',
      `${ring.tbCols} 列 × ${ring.tbRows} 行，${ring.tbCells} 格`);
    ok(ring.tbInsideCore, '时间板落在环心的棋盘底衬里');
    ok(ring.tbCornersInsideRing, '时间板四角都没越过轨道');
    ok(ring.gapRingToCorner >= 6,
      '轨道半径大于棋盘半对角线，环真「包住」了时间板',
      `半径余量 ${ring.gapRingToCorner}px（棋盘角 ${ring.corner}px）`);
    ok(ring.label.indexOf('时间板') >= 0 && ring.label.indexOf(String(ring.N)) >= 0,
      '标题同时写着时间板和环上剩余块数', ring.label);
    ok(ring.neutralShown && ring.neutralInStage, '中立指示物画在环上且没被裁掉');
    ok(ring.overflow <= 0, '中间列没有被撑出滚动条', 'overflow=' + ring.overflow);
    await screenshot(ws, 'v14-1-ring.png');

    console.log('\n[2c] 只剩跳过时，「跳过领纽扣」会跳出来');
    // 分三步：先把纽扣清零并重绘，等放大动画跑完再读样式，最后恢复原状。
    // （一步做完会读到过渡中间态：transform 还是 matrix(1,0,0,1,0,0)）
    const zeroed = await evaluate(ws, `(function(){
      const st = window.__pw.state;
      const me = st.players[window.__pw.actSeat()];
      window.__advBackup = me.buttons;
      const costs = st.visible.map((id) => (window.__pw.meta.patches.find((p) => p.id === id) || {}).cost);
      // 置成「比最便宜那块还少 1 个」：33 块里有唯一一块 0 成本的补丁，
      // 直接清零在它出现时并不能构成「一块都买不起」。
      me.buttons = Math.min.apply(null, costs.concat([0])) - 1;
      // 走一条真实的重绘路径：Esc 会让界面按当前 state 重画一次
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { costs, buttons: me.buttons, phase: st.phase, canAct: window.__pw.canAct(), leather: st.pendingLeather.length };
    })()`);
    await sleep(400);
    const adv = await evaluate(ws, `(function(){
      const el = document.getElementById('btnAdvance');
      const cs = getComputedStyle(el);
      return {
        cls: el.className,
        has: el.classList.contains('only-option'),
        scale: cs.transform,
        tint: cs.backgroundImage.slice(0, 30),
        anim: cs.animationName,
        tip: document.getElementById('selInfo').textContent,
      };
    })()`);
    const restored = await evaluate(ws, `(function(){
      const st = window.__pw.state;
      st.players[window.__pw.actSeat()].buttons = window.__advBackup;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return document.getElementById('btnAdvance').className;
    })()`);
    ok(adv.has, '买不起任何补丁时「跳过领纽扣」被加上高亮',
      JSON.stringify(Object.assign({}, adv, zeroed)));
    ok(/matrix\(1\.1/.test(adv.scale), '按钮被放大到 1.1 倍以上', adv.scale);
    ok(adv.tint.indexOf('gradient') >= 0, '按钮变成金色渐变', adv.tint);
    ok(adv.anim === 'advPulse', '按钮在持续闪动提醒', adv.anim);
    ok(adv.tip.indexOf('买不起') >= 0, '操作条同步说明原因', adv.tip);
    ok(restored.indexOf('only-option') < 0, '买得起之后高亮自动撤掉', restored);

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
    ok(cl.first.indexOf('v1.4') === 0, '首条是 v1.4', cl.first);
    ok(cl.items >= 5, 'v1.4 条目不少于 5 条', '实际 ' + cl.items);
    await screenshot(ws, 'v14-2-changelog.png');

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

    // 六人时中间列最窄，环和时间板也得完整待着
    const sixRing = await evaluate(wsb, `(function(){
      const stage = document.getElementById('ringStage');
      const sr = stage.getBoundingClientRect();
      const guide = stage.querySelector('.ring-guide');
      const gr = guide.getBoundingClientRect();
      const core = stage.querySelector('.ring-core').getBoundingClientRect();
      const tb = document.getElementById('timeboard').getBoundingClientRect();
      const chips = Array.from(document.getElementById('ringFar').children);
      let outside = 0;
      chips.forEach((c) => {
        const b = c.getBoundingClientRect();
        if (b.x < sr.x - 1 || b.y < sr.y - 1 || b.x + b.w > sr.x + sr.width + 1 || b.y + b.h > sr.y + sr.height + 1) outside += 1;
      });
      const col = document.getElementById('centerCol');
      const front = document.getElementById('ringFront').getBoundingClientRect();
      const R = gr.width / 2;
      return {
        chips: chips.length,
        outside,
        overflow: col.scrollHeight - col.clientHeight,
        frontH: Math.round(front.height),
        ringW: Math.round(stage.getBoundingClientRect().width),
        gapRingToCorner: Math.round(R - Math.hypot(core.width / 2, core.height / 2)),
        tbInsideRing: [[tb.x, tb.y], [tb.x + tb.width, tb.y],
          [tb.x, tb.y + tb.height], [tb.x + tb.width, tb.y + tb.height]]
          .every((p) => Math.hypot(p[0] - (gr.x + R), p[1] - (gr.y + R)) < R),
      };
    })()`);
    ok(sixRing.chips > 0 && sixRing.outside === 0,
      '六人布局下补丁环没有被挤爆', `chips=${sixRing.chips} 溢出=${sixRing.outside}`);
    ok(sixRing.tbInsideRing && sixRing.gapRingToCorner >= 6,
      '六人时时间板还稳稳待在环心里', `半径余量 ${sixRing.gapRingToCorner}px`);
    ok(sixRing.overflow <= 0, '六人时中间列也不出滚动条', 'overflow=' + sixRing.overflow);
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
