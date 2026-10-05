'use strict';

/*
 * 一键构建静态单机版：web/
 *
 * 为什么要单独做一版：
 *   联机版需要 Node 服务端（房间、WebSocket），而「永久免费托管」的平台
 *   （GitHub Pages / Vercel 静态 / Netlify）**只能放静态文件**。
 *   把服务端搬进浏览器后，单机两种模式（人机对战 / 同机双人）就能纯静态运行，
 *   链接可以永久挂着、朋友点开就玩，不用装任何东西。
 *
 * 代价（必须让用户知道）：2~6 人局域网联机在静态版里没有 —— 它依赖服务端。
 *
 * 六个产物形态：
 *   web/pw-core.js      ← build-web.js        从 server/{data,engine,ai}.js 转（生成物）
 *   web/index.html      ← build-web-html.js   从 public/index.html 注入脚本与样式（生成物）
 *   web/app.js          ← 复制 public/app.js（同一份代码，静态版靠运行时开关切换）
 *   web/style.css       ← 复制 public/style.css
 *   web/local-server.js ← 复制 static/local-server.js（手写：同页服务端）
 *   web/pw-stats.js     ← 复制 static/pw-stats.js（手写：访问量/开局数统计）
 *
 * 手写的两个文件放在 static/ 里（那样的文件才进 git），web/ 整个目录是产物、被 .gitignore。
 *
 * 用法：node build-static.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const WEB = path.join(ROOT, 'web');

/**
 * ⚠️ 不要用 execFileSync / spawn 去跑子脚本。
 * 本机沙箱禁止 Node 创建子进程，会直接抛 `spawnSync ... EBUSY`（踩过两次：
 * 一次是 git push，一次就是这里）。所以两个构建脚本都改成**导出函数、直接 require 调用**。
 */
function runScript(script, label) {
  process.stdout.write(`  ${label} … `);
  const mod = require(path.join(ROOT, script));
  const out = typeof mod === 'function' ? mod() : (mod && mod.build ? mod.build() : '');
  console.log(out || 'OK');
}

function copy(from, to, label) {
  process.stdout.write(`  ${label} … `);
  fs.copyFileSync(path.join(ROOT, from), path.join(WEB, to));
  const kb = (fs.statSync(path.join(WEB, to)).size / 1024).toFixed(1);
  console.log(`${kb} KB`);
}

function build() {
  console.log('构建静态单机版 → web/\n');
  fs.mkdirSync(WEB, { recursive: true });

  runScript('build-web.js', '转换引擎（server → 浏览器）');
  runScript('build-web-html.js', '生成页面（注入脚本与静态样式）');
  copy('public/app.js', 'app.js', '复制交互逻辑');
  copy('public/style.css', 'style.css', '复制样式');
  copy('static/local-server.js', 'local-server.js', '复制同页服务端');
  copy('static/pw-stats.js', 'pw-stats.js', '复制统计模块');

  console.log(`
完成。产物：
  ${path.relative(ROOT, path.join(WEB, 'index.html')).padEnd(18)} 入口页面
  ${'pw-core.js'.padEnd(18)} 规则引擎（与联机版同源）
  ${'local-server.js'.padEnd(18)} 同页服务端
  ${'pw-stats.js'.padEnd(18)} 访问量 / 开局数统计
  ${'app.js'.padEnd(18)} 交互逻辑
  ${'style.css'.padEnd(18)} 样式

本地预览：node serve-web.js   （默认 http://127.0.0.1:3199）
发布：把 web/ 整个目录传上去即可（GitHub Pages / Vercel / Netlify 都行）。
`);
  return '构建完成';
}

if (require.main === module) build();
module.exports = build;
