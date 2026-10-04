'use strict';

/*
 * 临时探针：量「绕拼布板」布局在真实浏览器里的几何。
 * 按几种典型窗口尺寸各量一遍，确认圆角矩形真的框住了两块拼布板、
 * 补丁既不越界也不压到棋盘。用法：先起服务端，再 node probe-frame.js
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
  await sleep(500);
  await screenshot(A.ws, 'v141-ring-1440x900.png');
  await evaluate(A.ws, "document.querySelector('#layoutSwitch button[data-layout=\"frame\"]').click(); 'ok'");
  await sleep(600);

  const sizes = [[1440, 900], [1280, 800], [1100, 720], [960, 640], [880, 600]];
  for (const [w, h] of sizes) {
    await cdp(A.ws, 'Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(500);
    const m = await evaluate(A.ws, MEASURE);
    console.log(`\n--- 窗口 ${w}x${h} ---`);
    if (m.err) { console.log('  ', m.err); continue; }
    console.log('  ', JSON.stringify(m));
    await screenshot(A.ws, `v141-frame-${w}x${h}.png`);
  }

  await cdp(A.ws, 'Emulation.clearDeviceMetricsOverride', {});
  console.log('\n页面报错：', errors.length ? errors : '无');
  A.proc.kill();
  process.exitCode = errors.length ? 1 : 0;
})();
