'use strict';

/*
 * pw-stats.js —— 单机版的「访问量 / 开局数」统计（手写，非生成）
 *
 * 静态托管没有后端，两个数字只能靠云服务（WorkBuddy Cloud Service）里的
 * 一张表 play_stats（全局单行：id=1, visits, games）+ 一个 SECURITY DEFINER
 * 函数 bump_stat(kind text) 原子 +1。
 *
 * 设计要点：
 *  - 只有 CDN IIFE 形式可用（本项目是纯 HTML，无打包步骤）。
 *  - endpoint / publishableKey 来自云服务返回的 publicConfig；**不硬编码、
 *    不读 location**。写死在文件顶部常量里，因为它们本来就会出现在浏览器里。
 *  - 全部是「尽力而为」：任何一步失败都静默降级 —— 数字面板不显示，
 *    绝不影响玩。私服/断网/额度用尽都不该让游戏坏掉。
 *  - 页面加载记 1 次访问，但同一标签页刷新不重复记（sessionStorage 去重，
 *    避免 F5 刷数字）；开局每局记 1 次。
 *  - 数字面板挂在主菜单里（.menu-foot 上方），由 CSS 控制只在单机版显示。
 */

(function () {
  const ENDPOINT = 'https://patchwork-online.app.workbuddy.host';
  const PUBLISHABLE_KEY = 'wbpk_UY01JVqxYKljhxdEMCrcWt_Q1CcTbFcW9DE9cXDLCVKdVqRDf0kNM1C';

  const VISIT_FLAG = 'pw.stats.visitLogged';
  const CACHE_KEY = 'pw.stats.last';

  const S = {
    cloud: null,
    ready: false,
    visits: null,
    games: null,
    panel: null,
  };

  /* ---------------------------------------------------------------- 面板 */

  function ensurePanel() {
    if (S.panel && document.body.contains(S.panel)) return S.panel;
    const foot = document.querySelector('.menu-foot');
    if (!foot) return null;
    const p = document.createElement('div');
    p.className = 'pw-stats';
    p.id = 'pwStats';
    p.setAttribute('aria-live', 'polite');
    foot.parentNode.insertBefore(p, foot);
    S.panel = p;
    return p;
  }

  function render() {
    const p = ensurePanel();
    if (!p) return;
    if (S.visits == null && S.games == null) { p.style.display = 'none'; return; }
    const v = S.visits == null ? '—' : String(S.visits);
    const g = S.games == null ? '—' : String(S.games);
    p.style.display = '';
    p.innerHTML =
      '<span class="pws-item"><b>' + v + '</b><i>次访问</i></span>' +
      '<span class="pws-sep" aria-hidden="true">·</span>' +
      '<span class="pws-item"><b>' + g + '</b><i>局已开</i></span>';
  }

  function readCache() {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return;
      const o = JSON.parse(raw);
      if (typeof o.visits === 'number') S.visits = o.visits;
      if (typeof o.games === 'number') S.games = o.games;
      render();
    } catch (e) { /* 忽略 */ }
  }

  function writeCache() {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ visits: S.visits, games: S.games }));
    } catch (e) { /* 忽略 */ }
  }

  function applyRow(row) {
    if (!row) return;
    if (typeof row.visits === 'number') S.visits = row.visits;
    if (typeof row.games === 'number') S.games = row.games;
    render();
    writeCache();
  }

  /* ------------------------------------------------------------ 初始化 */

  // CDN IIFE 脚本按需加载，避免拖慢首屏；失败就彻底放弃统计
  function loadSdk() {
    return new Promise(function (resolve) {
      if (window.WorkBuddyCloud && window.WorkBuddyCloud.createWorkBuddyCloud) return resolve(true);
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js';
      script.async = true;
      script.onload = function () {
        resolve(!!(window.WorkBuddyCloud && window.WorkBuddyCloud.createWorkBuddyCloud));
      };
      script.onerror = function () { resolve(false); };
      document.head.appendChild(script);
    });
  }

  function initCloud() {
    if (S.cloud) return S.cloud;
    try {
      S.cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: ENDPOINT,
        publishableKey: PUBLISHABLE_KEY,
      });
    } catch (e) { S.cloud = null; }
    return S.cloud;
  }

  // 建表 / RPC 都走云服务，调用失败一律吞掉
  async function callRpc(kind) {
    if (!S.cloud) return null;
    try {
      const res = await S.cloud.database.rpc('bump_stat', { kind: kind });
      if (res && res.error) return null;
      const rows = res && res.data;
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row && (typeof row.visits === 'number' || typeof row.games === 'number')) {
        applyRow(row);
        return row;
      }
      return null;
    } catch (e) { return null; }
  }

  async function readCurrent() {
    if (!S.cloud) return null;
    try {
      const res = await S.cloud.database.from('play_stats').select('visits, games').eq('id', 1).maybeSingle();
      if (res && res.error) return null;
      applyRow(res && res.data);
      return res && res.data;
    } catch (e) { return null; }
  }

  function alreadyLoggedVisit() {
    try { return sessionStorage.getItem(VISIT_FLAG) === '1'; } catch (e) { return false; }
  }
  function markVisitLogged() {
    try { sessionStorage.setItem(VISIT_FLAG, '1'); } catch (e) { /* 忽略 */ }
  }

  /* 对外：开局时调用一次，局数 +1 */
  async function countGame() {
    if (!S.ready) return;
    await callRpc('game');
  }

  async function boot() {
    // 先把上次的数字画上，避免面板空一下
    readCache();
    render();

    const ok = await loadSdk();
    if (!ok) return;
    if (!initCloud()) return;
    S.ready = true;

    if (alreadyLoggedVisit()) {
      await readCurrent();
    } else {
      markVisitLogged();
      await callRpc('visit');
    }
  }

  window.PW_STATS = {
    boot: boot,
    countGame: countGame,
    _s: S,
  };
})();
