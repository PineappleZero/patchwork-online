'use strict';

/*
 * 几何探针：量「绕拼布板」布局在真实浏览器里的几何。
 * 按几种典型窗口尺寸各量一遍，确认圆角矩形真的框住了两块拼布板、
 * 补丁既不越界也不压到棋盘、中立棋子稳稳待在上半部分。
 * v1.5 起这一套是双人局的默认布局，所以进来直接量，不用先切。
 * 用法：先起服务端，再 node probe-frame.js
 * 尺寸：1440/1280/1100/960/880 五档，容差 ±1px。
 * 带随机性（补丁池每局重洗），所以值得连跑几轮再下结论。
 */

const {
  launchEdge, evaluate, waitFor, screenshot, collectErrors, sleep, PORT, cdp,
} = require('./browserkit');

const MEASURE = `
  (function(){
    const g = window.__pw.frameGeom();
    if (!g) return { err: 'no-frame' };
    const stage = document.getElementById('frameStage');
    const sr = stage.getBoundingClientRect();
    const players = document.getElementById('playersWrap').getBoundingClientRect();
    const cards = Array.from(document.querySelectorAll('#playersWrap .player-card'))
      .map((c) => c.getBoundingClientRect());
    const chips = g.chips;
    const inside = chips.filter((c) => c.cx - c.w/2 >= sr.x - 1 && c.cy - c.h/2 >= sr.y - 1 &&
      c.cx + c.w/2 <= sr.x + sr.width + 1 && c.cy + c.h/2 <= sr.y + sr.height + 1).length;
    const overlapped = chips.filter((c) => cards.some((r) => c.cx + c.w/2 > r.left + 1 &&
      c.cx - c.w/2 < r.right - 1 && c.cy + c.h/2 > r.top + 1 && c.cy - c.h/2 < r.bottom - 1)).length;
    const radii = chips.map((c) => Math.hypot(c.cx - (sr.x + sr.width/2), c.cy - (sr.y + sr.height/2)));
    const tok = window.__pw.neutralPos();
    const playersEl = document.getElementById('playersWrap');
    const cs = getComputedStyle(playersEl);
    const tile = parseFloat(getComputedStyle(document.getElementById('ringFar')).getPropertyValue('--rc-tile'));
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const wrapTop = document.getElementById('boardWrap').getBoundingClientRect().top;
    const wrapBot = document.getElementById('boardWrap').getBoundingClientRect().bottom;
    return {
      vp: vw + 'x' + vh,
      frame: Math.round(sr.width) + 'x' + Math.round(sr.height),
      fitsVert: sr.top >= wrapTop - 1 && sr.bottom <= wrapBot + 1,
      cards: cards.map((c) => Math.round(c.width) + 'x' + Math.round(c.height)).join(' '),
      chips: chips.length,
      inside: inside,
      overlapped: overlapped,
      maxChipW: Math.round(Math.max.apply(null, chips.map((c) => c.w))),
      arcGap: Math.round(Math.min.apply(null, radii.map((r, i) => {
        if (i === 0) return 9999;
        const prev = radii[i - 1];
        return 9999;
      }))),
      rRange: Math.round(Math.min.apply(null, radii)) + '~' + Math.round(Math.max.apply(null, radii)),
      marked: chips.filter((c) => /option|selectable/.test(c.cls)).length,
      tile: tile,
      band: Math.round(parseFloat(cs.paddingTop)),
      // 中立棋子：宽度得像一枚棋子（圆片），且纵坐标必须在上半部分
      tokW: tok ? Math.round(tok.w) : 0,
      tokDy: tok ? Math.round(tok.dy) : 0,
      tokAbove: tok ? tok.cy < sr.top + sr.height / 2 : false,
      tokInside: tok ? (tok.cy - tok.h / 2 >= sr.top - 1 && tok.cy + tok.h / 2 <= sr.bottom + 1) : false,
      centerOverflow: document.getElementById('centerCol').scrollHeight -
        document.getElementById('centerCol').clientHeight,
      bodyOverflowY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    };
  })()
`;

(async () => {
  const errors = [];
  const A = await launchEdge(9224, `http://127.0.0.1:${PORT}/`, 'probe');
  collectErrors(A.ws, errors, 'probe');

  await waitFor(A.ws, '!!window.__pw && window.__pw.meta !== null', 15000, 'meta');
  await waitFor(A.ws, "!!document.getElementById('btnLocal')", 8000, 'menu');
  await evaluate(A.ws, "window.prompt = function(){ return '玩家二'; }; 'ok'");
  await evaluate(A.ws, "document.getElementById('btnLocal').click(); 'ok'");
  await waitFor(A.ws, "window.__pw.state && window.__pw.state.phase === 'playing'", 12000, 'playing');
  await sleep(700);
  // v1.5：双人局进来就是「绕拼布板」，直接量默认态
  console.log('默认布局：', await evaluate(A.ws, 'window.__pw.layout'));
  await screenshot(A.ws, 'v15-frame-1440x900.png');

  const sizes = [[1440, 900], [1280, 800], [1100, 720], [960, 640], [880, 600]];
  let violations = 0;
  const complain = (label, cond, detail) => {
    if (cond) return;
    violations += 1;
    console.log('   ✗ ' + label + (detail ? ' -> ' + detail : ''));
  };

  for (const [w, h] of sizes) {
    await cdp(A.ws, 'Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(500);
    const m = await evaluate(A.ws, MEASURE);
    console.log(`\n--- 窗口 ${w}x${h} ---`);
    if (m.err) { console.log('   ', m.err); violations += 1; continue; }
    console.log('   ' + JSON.stringify(m));
    // 逐条验收：越界、压板、棋子位置各看一遍。容差 ±1px。
    complain('补丁全部落在环绕舞台里', m.inside === m.chips, `出界 ${m.chips - m.inside} 个`);
    complain('补丁没压到拼布板', m.overlapped === 0, `压住 ${m.overlapped} 个`);
    complain('环绕舞台没顶出可视区', m.fitsVert);
    complain('路径确实是圆角矩形（不是圆）', /^\d+~\d+$/.test(m.rRange) &&
      Number(m.rRange.split('~')[1]) - Number(m.rRange.split('~')[0]) > 40, m.rRange);
    complain('补丁格子保持放大档 10px', m.tile >= 10, m.tile + 'px');
    complain('环绕轨道够宽', m.band >= 60, m.band + 'px');
    complain('中立棋子是一枚棋子（圆片）', m.tokW >= 14 && m.tokW <= 24, m.tokW + 'px');
    complain('中立棋子在上半部分', m.tokAbove, 'dy=' + m.tokDy);
    complain('中立棋子没被裁掉', m.tokInside);
    complain('中间列没被撑出滚动条', m.centerOverflow <= 0, 'overflow=' + m.centerOverflow);
    complain('整页没有竖向滚动条', m.bodyOverflowY <= 0, 'overflow=' + m.bodyOverflowY);
    await screenshot(A.ws, `v15-frame-${w}x${h}.png`);
  }

  // 再切回圆环量一次，确认「环绕时间板」这一档没被 v1.5 的改动弄坏
  await cdp(A.ws, 'Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await evaluate(A.ws, `document.querySelector('#layoutSwitch button[data-layout="ring"]').click(); 'ok'`);
  await sleep(700);
  const ring = await evaluate(A.ws, `(function(){
    const stage = document.getElementById('ringStage');
    const guide = stage.querySelector('.ring-guide');
    const sr = stage.getBoundingClientRect();
    const gr = guide.getBoundingClientRect();
    const chips = Array.from(document.getElementById('ringFar').children)
      .map((c) => c.getBoundingClientRect());
    const R = gr.width / 2;
    const cx = gr.x + R;
    const cy = gr.y + R;
    const radii = chips.map((b) => Math.hypot(b.x + b.width / 2 - cx, b.y + b.height / 2 - cy));
    const tok = window.__pw.neutralPos();
    return {
      guideD: Math.round(gr.width),
      minR: Math.round(Math.min.apply(null, radii)),
      maxR: Math.round(Math.max.apply(null, radii)),
      tokW: tok ? Math.round(tok.w) : 0,
      tokInside: tok ? (tok.cy - tok.h / 2 >= sr.top - 1 && tok.cy + tok.h / 2 <= sr.bottom + 1) : false,
      overflow: document.getElementById('centerCol').scrollHeight -
        document.getElementById('centerCol').clientHeight,
    };
  })()`);
  console.log('\n--- 切回圆环 1440x900 ---');
  console.log('   ' + JSON.stringify(ring));
  complain('圆环轨道直径照旧在合理区间', ring.guideD >= 300 && ring.guideD <= 380, ring.guideD + 'px');
  complain('环上补丁都贴在圆周上', ring.maxR - ring.minR <= 2, `${ring.minR}~${ring.maxR}`);
  complain('圆环下中立棋子也没被裁掉', ring.tokInside);
  complain('圆环下中间列不出滚动条', ring.overflow <= 0, 'overflow=' + ring.overflow);
  await screenshot(A.ws, 'v15-ring-1440x900.png');

  console.log('\n几何问题：' + violations + ' 处');
  await cdp(A.ws, 'Emulation.clearDeviceMetricsOverride', {});
  console.log('页面报错：', errors.length ? errors : '无');
  A.proc.kill();
  process.exitCode = (errors.length || violations) ? 1 : 0;
})();
