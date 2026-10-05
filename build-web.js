'use strict';

/*
 * 把 server/ 下的 data.js / engine.js / ai.js 转成浏览器能直接 <script> 加载的版本。
 *
 * 为什么这么做，而不是手抄一份：
 *   这三个文件是**纯 CommonJS、纯函数、零外部依赖**，改造成本极低；
 *   而游戏规则一旦出现「本地版一套、联机版另一套」就是维护灾难。
 *   所以这里做的是**机械转换**（require → 全局引用，module.exports → 全局挂载），
 *   逻辑一行不改。改完跑 `node build-web.js` 即可重新生成，源文件永远是唯一真相。
 *
 * 输出：web/pw-core.js（三个模块合并 + 一个微型 CommonJS 垫片）
 */

const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, 'server');
const OUT = path.join(__dirname, 'web', 'pw-core.js');

/** 模块加载顺序：被依赖的在前 */
const MODULES = [
  { file: 'data.js', global: '__PW_DATA' },
  { file: 'engine.js', global: '__PW_ENGINE' },
  { file: 'ai.js', global: '__PW_AI' },
];

function transform(src, { file, global }) {
  let out = src;

  // 1) 去掉 'use strict'（垫片里统一开了）
  out = out.replace(/^'use strict';\s*\n/m, '');

  // 2) require(...) → 对应的全局名
  //    require('./data') / require('./engine') / require('./ai')
  out = out.replace(/require\(['"]\.\/(data|engine|ai)['"]\)/g, (m, name) => {
    const map = { data: '__PW_DATA', engine: '__PW_ENGINE', ai: '__PW_AI' };
    return map[name];
  });

  // 3) module.exports = {...} → global 挂载
  //    形如：module.exports = {\n  a,\n  b,\n};
  out = out.replace(/module\.exports\s*=\s*\{([\s\S]*?)\};\s*$/m, (m, body) => {
    // 把 { a, b, c } 展开成 obj.a = a; obj.b = b;
    const names = body
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const assigns = names.map((n) => `  ${n},`).join('\n');
    return `Object.assign(${global}, {\n${assigns}\n});`;
  });

  // 4) 整份包进 IIFE —— 这是**必须的**：
  //    三个源文件各自 declare 了顶层 const（PATCHES / BOARD_SIZE …），
  //    合并进同一作用域会直接 SyntaxError: Identifier 'X' has already been declared。
  //    包一层函数正好复刻 CommonJS 的模块作用域，互不污染。
  return `/* ==== ${file}（由 build-web.js 从 server/${file} 机械转换，勿手改）==== */\n(function () {\n${out.trim()}\n})();\n`;
}

function main() {
  const parts = [];

  parts.push(`/*
 * 拼布 Patchwork · 浏览器版核心（自动生成，请勿直接编辑）
 *
 * 由 build-web.js 从 server/{data,engine,ai}.js 机械转换而来：
 *   · require('./x')      → 同名全局对象
 *   · module.exports = {} → Object.assign 到同名全局对象
 * 游戏逻辑与联机版**完全同源**，改规则请改 server/ 下的源文件，然后重跑 build-web.js。
 *
 * 加载顺序由 <script> 标签决定：data → engine → ai → local.js → app.js
 */
'use strict';

/* 微型模块垫片：让三个源文件里对全局的引用读起来仍像模块 */
var __PW_DATA = {};
var __PW_ENGINE = {};
var __PW_AI = {};
`);

  for (const mod of MODULES) {
    const full = path.join(SERVER, mod.file);
    if (!fs.existsSync(full)) {
      console.error('缺少源文件：' + full);
      process.exitCode = 1;
      return;
    }
    parts.push(transform(fs.readFileSync(full, 'utf8'), mod));
  }

  // 兼容 shim：让 `require('./data')` 转换后的变量在函数作用域里也能解析
  parts.push(`
/* 模块垫片结束。下面把三个对象暴露给本地服务端使用。 */
var PW_CORE = { data: __PW_DATA, engine: __PW_ENGINE, ai: __PW_AI };
`);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, parts.join('\n'), 'utf8');

  const size = fs.statSync(OUT).size;
  const msg = `${path.relative(__dirname, OUT)}（${(size / 1024).toFixed(1)} KB）`;
  console.log(msg);
  return msg;
}

// 既能 `node build-web.js` 单独跑，也能被 build-static.js require 进来直接调用
if (require.main === module) main();
module.exports = main;
