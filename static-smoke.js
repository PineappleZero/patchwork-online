'use strict';

/*
 * v1.6.7 静态版（web/）端到端冒烟：
 * 线上「人机对战点不开」事故的回归测试 —— ai.js 里的 process.env 被打进
 * pw-core.js，浏览器一加载就 ReferenceError，点人机对战无声失败。
 * 服务端路径（server/index.js + public/）的测试全绿也测不到这条路径，
 * 所以这个脚本直接对着 serve-web.js（web/）跑真浏览器。
 *
 * 用法：先 PORT=3199 node serve-web.js，再 node _smoke-static.js
 */

const { launchEdge, evaluate, waitFor, screenshot, collectErrors, sleep } = require('./browserkit');

const URL_BASE = 'http://127.0.0.1:3199/';

(async () => {
  const errors = [];
  let fail = 0;
  const check = (name, cond, extra) => {
    console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? ' -> ' + extra : ''));
    if (!cond) fail += 1;
  };

  const edge = await launchEdge(9335, URL_BASE, 'smoke167');
  const ws = edge.ws;
  collectErrors(ws, errors, '静态单机');

  try {
    await waitFor(ws, `document.getElementById('menu').classList.contains('active')`, 12000, '主菜单出现');

    // 核心探针：ai 桥是否活着（事故里它没活着）
    const bridge = await evaluate(ws, `({ ai: typeof __PW_AI, engine: typeof __PW_ENGINE })`);
    check('__PW_AI 加载成功（事故根因探针）', bridge.ai === 'object', '实际 ' + bridge.ai);
    check('__PW_ENGINE 加载成功', bridge.engine === 'object', '实际 ' + bridge.engine);

    // 开一局困难人机
    await evaluate(ws, `document.getElementById('botLevel').value = 'hard'`);
    await evaluate(ws, `document.getElementById('btnSolo').click()`);
    await waitFor(ws, `document.getElementById('game').classList.contains('active')`, 8000, '进入对局');
    await waitFor(ws, `document.querySelectorAll('#playersWrap .player-card').length === 2`, 8000, '两张玩家卡');

    const solo = await evaluate(ws, `(function(){
      const botTag = document.querySelector('#playersWrap .player-card .pc-tag.bot');
      const botCard = botTag ? botTag.closest('.player-card') : null;
      const lvEl = botCard ? botCard.querySelector('.pc-level') : null;
      return {
        bot: !!botTag,
        botName: botCard ? botCard.querySelector('.pc-name').textContent : '',
        levelKey: lvEl ? lvEl.dataset.level : '',
        levelText: lvEl ? lvEl.textContent : '',
        logs: document.querySelectorAll('#log div').length,
      };
    })()`);
    check('人机对手是 wzzzhhhhh', solo.botName === 'wzzzhhhhh', solo.botName);
    check('难度徽章显示困难', solo.levelKey === 'hard' && solo.levelText === '困难',
      solo.levelKey + '/' + solo.levelText);

    // 人类走一步（跳过领纽扣永远合法），等电脑（六层深搜，浏览器主线程同步算）回一步
    const logsBefore = solo.logs;
    await evaluate(ws, `document.getElementById('btnAdvance').click()`);
    await sleep(3500); // depth6 单步 ~0.3s，留足余量
    const after = await evaluate(ws, `({
      logs: document.querySelectorAll('#log div').length,
      btnDisabled: document.getElementById('btnAdvance').disabled,
    })`);
    check('人类落子后电脑有回应（事件纪要在增长）', after.logs > logsBefore,
      `纪要 ${logsBefore} -> ${after.logs}`);
    await screenshot(ws, 'smoke167-solo.png');
  } catch (e) {
    fail += 1;
    console.log('  FAIL  流程中断 -> ' + e.message);
  }

  await sleep(300);
  check('全程无 JS 报错', errors.length === 0, errors.join(' | '));
  console.log(fail === 0 ? '\n冒烟通过' : `\n冒烟失败 ${fail} 项`);
  process.exitCode = fail === 0 ? 0 : 1;
  edge.close && edge.close();
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 500);
})();
