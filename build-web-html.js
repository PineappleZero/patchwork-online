'use strict';

/*
 * 生成静态托管版（单机版）页面：site/index.html
 *
 * 做法：以 public/index.html 为模板，只做两件事：
 *   1) 在 app.js 之前插入两个脚本：pw-core.js（引擎）与 local-server.js（同页服务端）；
 *   2) 打上 pw-static 类，让 CSS 把「联机」那一栏和局域网地址藏掉。
 *
 * HTML 里其余每一个字都不动 —— 这样单机版和联机版的界面**天然一致**，
 * 以后改 UI 只改 public/index.html，重跑本脚本即可。
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'public', 'index.html');
const OUT = path.join(__dirname, 'site', 'index.html');

function main() {
  let html = fs.readFileSync(SRC, 'utf8');

  // 1) 文档根上打标记，CSS 靠它隐藏联机栏
  html = html.replace(/<html([^>]*)>/, (m, attrs) => {
    const cleaned = attrs.replace(/\s*class="[^"]*"/, '');
    return `<html${cleaned} class="pw-static">`;
  });

  // 2) 在 app.js 前插入核心与本地服务端
  const INSERT_BEFORE = '<script src="app.js"></script>';
  if (!html.includes(INSERT_BEFORE)) {
    console.error('模板里找不到 <script src="app.js"></script>，无法注入');
    process.exitCode = 1;
    return '失败';
  }
  html = html.replace(INSERT_BEFORE, [
    '<!-- 静态单机版：把服务端搬进页面。引擎由 build-web.js 从 server/ 生成，逻辑与联机版同源。 -->',
    '<script src="pw-core.js"></script>',
    '<script src="local-server.js"></script>',
    '<!-- 访问量 / 开局数统计（云服务，尽力而为，失败静默） -->',
    '<script src="pw-stats.js"></script>',
    INSERT_BEFORE,
  ].join('\n'));

  // 3) 静态版专属的收尾样式：隐藏联机栏、把单机栏铺满、补一句说明
  const STATIC_CSS = `
<style>
  /* 连不上局域网 —— 这一栏在静态版里没有意义，直接藏掉 */
  .pw-static .menu-grid .menu-sec:last-child { display: none; }
  /* 只剩单机一栏时，让它占满整行并居中，别留一条空荡荡的右栏 */
  .pw-static .menu-grid { grid-template-columns: minmax(0, 1fr); max-width: 520px; margin: 0 auto; }
  .pw-static .menu-sec { border-right: none !important; }

  /* 底部补一句：这是单机版，说明为什么没有联机 */
  .pw-static .menu-foot::after {
    content: "单机版：人机对战与同机双人随时可玩。2~6 人联机需要运行本地/服务器版本 —— 见 GitHub 仓库。";
    display: block;
    margin-top: 10px;
    font-size: 12px;
    line-height: 1.6;
    opacity: .6;
    text-align: center;
  }

  /* 访问量 / 开局数面板：只在单机版出现，嵌在底部按钮上方 */
  .pw-stats {
    display: flex;
    align-items: baseline;
    justify-content: center;
    gap: 8px;
    margin: 16px 0 2px;
    padding: 8px 14px;
    border-radius: 999px;
    background: rgba(127, 127, 127, .1);
    font-size: 13px;
    letter-spacing: .02em;
    opacity: .85;
    user-select: none;
  }
  .pw-stats .pws-item { display: inline-flex; align-items: baseline; gap: 4px; }
  .pw-stats .pws-item b { font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .pw-stats .pws-item i { font-style: normal; opacity: .7; }
  .pw-stats .pws-sep { opacity: .4; }
  /* 联机版（非静态）不显示这块统计 */
  html:not(.pw-static) .pw-stats { display: none !important; }
</style>
`;

  html = html.replace('</head>', STATIC_CSS + '</head>');

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, html, 'utf8');
  const msg = `${path.relative(__dirname, OUT)}（${(fs.statSync(OUT).size / 1024).toFixed(1)} KB）`;
  console.log(msg);
  return msg;
}

if (require.main === module) main();
module.exports = main;
