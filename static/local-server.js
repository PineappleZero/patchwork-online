'use strict';

/*
 * 浏览器版「服务端」。
 *
 * 联机版里，客户端通过 WebSocket 把意图发给 server/index.js，服务端算完再广播 state。
 * 静态托管没有服务端进程，所以这里把那一层**原地搬进浏览器**：
 *
 *   · 房间不再是真的房间，就是一个内存对象；
 *   · WebSocket 换成同页函数调用（send / onmessage 直连）；
 *   · 规则判定仍然全部走 engine —— 与联机版**同一份代码**（web/pw-core.js 生成自 server/）。
 *
 * 结果是 app.js 一行都不用改：它以为自己在跟服务端说话，其实是在跟同页的 LocalServer。
 * 单机两种模式（人机对战 / 同机双人）完整可用；联机入口由 app.js 按 isStatic 隐藏。
 *
 * 唯一真正的功能差异：局域网联机不可用（需要服务端），所以叫「单机版」。
 */
(function () {
  const engine = __PW_ENGINE;
  const ai = __PW_AI;
  const data = __PW_DATA;

  const BOT_DELAY_MS = 750;

  /** 模式定义：与 server/index.js 的 MODES 保持一致，只是去掉 online */
  const MODES = {
    solo: { slots: 1, capacity: 2, local: false, botSeats: [1], label: '人机对战' },
    local: { slots: 1, capacity: 2, local: true, botSeats: [], label: '同机双人' },
  };

  function cleanName(raw, fallback) {
    const s = String(raw == null ? '' : raw).trim().slice(0, 12);
    return s || fallback;
  }

  function randomCode() {
    // 与联机版一样，去掉 I/O/0/1 这些看混的字符
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 4; i += 1) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return s;
  }

  class LocalRoom {
    constructor(mode, opts) {
      const def = MODES[mode] || MODES.solo;
      this.code = randomCode();
      this.mode = mode;
      this.variant = opts.variant === 'chaos' ? 'chaos' : 'classic';
      this.slots = def.slots;
      this.capacity = def.capacity;
      this.local = def.local;
      this.botSeats = new Set(def.botSeats);
      this.botLevel = ai.normalizeLevel(opts.botLevel);
      this.playerNames = [];
      this.state = null;
      this.history = [];
      this.rematchVotes = new Set();
      this.botTimer = null;
      this.seats = [];
      this.localNames = [opts.name1, opts.name2].map((n, i) =>
        cleanName(n, mode === 'local' ? `玩家${i === 0 ? '一' : '二'}` : (i === 0 ? '你' : ai.botName(opts.botLevel)))
      );
      this.connIndex = 0;
      this.start();
    }

    get joinedCount() { return this.slots; }

    /** 与 server/index.js 的 start 保持一致：开局时把名单钉下来 */
    start() {
      const cap = this.capacity;
      const list = [];
      for (let i = 0; i < cap; i += 1) {
        const isBot = this.botSeats.has(i);
        const name = this.local
          ? this.localNames[i]
          : (isBot ? ai.botName(this.botLevel) : this.localNames[0]);
        list.push({ name, bot: isBot });
      }
      this.playerNames = list.map((x) => x.name);
      this.state = engine.createGame(list, Math.random, { variant: this.variant });
      this.history = [];
      this.rematchVotes.clear();

      /*
       * 每开一局自增一次。这是「局数统计」唯一可靠的判据：
       * `started` 这个布尔量在 rematch 后仍然是 true，光看它无法区分
       * 「还在同一局」和「又开了一局」；而每局都会新建 state，所以这里
       * 单调递增的序号就是「第几局」。serialize() 把它带出去给 app.js。
       */
      this.gameSeq = (this.gameSeq || 0) + 1;

      this.maybeRunBot();
    }

    rematch() { this.start(); }

    controlledSeats() {
      if (this.local) return this.state.players.map((p) => p.index);
      return [this.connIndex];
    }

    remember(events, seat) {
      const stamp = Date.now();
      (events || []).forEach((e) => {
        this.history.push(Object.assign({ seat, at: stamp }, e));
      });
      if (this.history.length > 200) this.history = this.history.slice(-200);
    }

    /** 与 server/index.js 的 serialize 逐字段对齐 —— app.js 就是照着这个结构渲染的 */
    serialize() {
      const st = this.state;
      const over = st ? engine.isGameOver(st) : false;
      return {
        type: 'state',
        room: this.code,
        mode: this.mode,
        variant: this.variant,
        local: this.local,
        capacity: this.capacity,
        slots: this.slots,
        started: !!st,
        gameSeq: this.gameSeq || 0,
        phase: st ? (over ? 'over' : 'playing') : 'waiting',
        full: true,
        canStart: false,
        seats: this.seats.map((s, i) => (s
          ? { name: s.name, connected: s.connected, host: i === 0, bot: this.botSeats.has(i) }
          : null)),
        playerNames: this.playerNames,
        botLevel: this.botLevel,
        neutral: st ? st.neutral : 0,
        circle: st ? st.circle : [],
        visible: st ? engine.visiblePatchIds(st) : [],
        active: st && !over ? engine.currentPlayerIndex(st) : null,
        pendingLeather: st ? st.pendingLeather.map((x) => ({ player: x.player })) : [],
        leatherClaimed: st ? st.leatherClaimed : [],
        rematchVotes: this.rematchVotes.size,
        players: st ? st.players.map((p) => ({
          index: p.index,
          name: p.name,
          bot: p.bot,
          buttons: p.buttons,
          time: p.time,
          board: p.board,
          placed: p.placed,
          incomeIcons: p.incomeIcons,
          hasBonusTile: p.hasBonusTile,
          finished: p.finished,
          empty: engine.emptySpaces(p.board),
        })) : [],
        bonusTileOwner: st ? st.bonusTileOwner : null,
        rules: st ? st.rules : null,
        result: st && over ? engine.finalResult(st) : null,
        lastEvents: st ? st.lastEvents || [] : [],
        history: this.history || [],
      };
    }

    /** 把当前局面推回给页面（对应联机版的 broadcast） */
    broadcast() {
      if (this.onmessage) this.onmessage(this.serialize());
    }

    maybeRunBot() {
      if (!this.botSeats.size) return;
      const st = this.state;
      if (!st || engine.isGameOver(st)) return;
      if (this.botTimer) return;
      const seat = engine.currentPlayerIndex(st);
      if (!this.botSeats.has(seat)) return;
      this.botTimer = setTimeout(() => {
        this.botTimer = null;
        this.runBot();
      }, BOT_DELAY_MS);
    }

    runBot() {
      const st = this.state;
      if (!st || engine.isGameOver(st)) return;
      const seat = engine.currentPlayerIndex(st);
      if (!this.botSeats.has(seat)) return;
      try {
        let events = [];
        if (st.pendingLeather.length) {
          const cell = ai.chooseLeatherCell(st, seat, this.botLevel);
          engine.placeLeather(st, seat, cell.row, cell.col);
          events = [{ type: 'leatherPlaced', row: cell.row, col: cell.col, player: seat }];
        } else {
          const action = ai.chooseAction(st, seat, this.botLevel);
          if (!action) return;
          events = action.type === 'advance'
            ? engine.advance(st, seat).events
            : engine.buyPatch(st, seat, action.patchId, action.oriIndex, action.row, action.col).events;
        }
        st.lastEvents = events;
        this.remember(events, seat);
      } catch (err) {
        try { st.lastEvents = engine.advance(st, seat).events; } catch (e) { return; }
      }
      this.broadcast();
      this.maybeRunBot();
    }

    /** 处理一条「客户端消息」——签名与语义都对齐 server/index.js 的 ws 消息处理 */
    handle(msg) {
      const st = this.state;
      if (!st) return;

      if (msg.type === 'rematch') {
        if (!engine.isGameOver(st)) return this.error('这局还没结束');
        this.rematch();
        this.broadcast();
        return;
      }

      if (engine.isGameOver(st)) return this.error('这局已经结束了');

      try {
        const want = engine.currentPlayerIndex(st);
        if (!this.controlledSeats().includes(want)) throw new Error('还没轮到你');

        if (st.pendingLeather.length) {
          if (msg.type !== 'leather') throw new Error('请先放置 1x1 皮革补丁');
          engine.placeLeather(st, want, msg.row, msg.col);
          const ev = [{ type: 'leatherPlaced', row: msg.row, col: msg.col, player: want }];
          st.lastEvents = ev;
          this.remember(ev, want);
          this.broadcast();
          this.maybeRunBot();
          return;
        }

        if (msg.type === 'advance') {
          const res = engine.advance(st, want);
          st.lastEvents = res.events;
          this.remember(res.events, want);
        } else if (msg.type === 'patch') {
          const res = engine.buyPatch(st, want, msg.patchId, msg.oriIndex, msg.row, msg.col);
          st.lastEvents = res.events;
          this.remember(res.events, want);
        } else {
          throw new Error('未知的操作');
        }
        this.broadcast();
        this.maybeRunBot();
      } catch (err) {
        this.error(err.message);
      }
    }

    error(message) {
      if (this.onmessage) this.onmessage({ type: 'error', message });
    }

    /** 回给页面的「初始信息」——对应联机版的 GET /api/info */
    info() {
      return {
        patches: data.PATCHES,
        leather: data.LEATHER,
        timeBoard: data.TIME_BOARD,
        leatherSpaces: data.LEATHER_SPACES,
        incomeSpaces: data.INCOME_SPACES,
        boardSize: data.BOARD_SIZE,
        lastSpace: data.LAST_SPACE,
        variants: data.VARIANTS,
        chaosEvents: data.CHAOS_EVENTS,
        static: true,
      };
    }
  }

  /* ------------------------------------------------------------------ */

  class LocalServer {
    constructor() {
      this.room = null;
      this.ws = null; // app.js 会读 S.ws.readyState / 调用 send，用这个假对象接口够用
    }

    /**
     * 对应联机版的 GET /api/info —— 规则数值（补丁表、时间板、变体参数）。
     * ⚠️ 必须是 LocalServer 上的方法，不能只挂在 LocalRoom 上：
     *     app.js 在**脚本加载时**就 new 一个 LocalServer 取 meta，
     *     挂错地方会让整份 app.js 在初始化阶段就抛错、后面的代码全不执行（踩过）。
     */
    info() {
      return {
        patches: data.PATCHES,
        leather: data.LEATHER,
        timeBoard: data.TIME_BOARD,
        leatherSpaces: data.LEATHER_SPACES,
        incomeSpaces: data.INCOME_SPACES,
        boardSize: data.BOARD_SIZE,
        lastSpace: data.LAST_SPACE,
        variants: data.VARIANTS,
        chaosEvents: data.CHAOS_EVENTS,
        netUrls: [],
        static: true,
      };
    }

    /** 对应联机版 new WebSocket('ws://host') —— 只保留 app.js 用到的接口 */
    connect(handlers) {
      const self = this;
      this.ws = {
        readyState: 1, // WebSocket.OPEN
        send(payload) {
          let msg;
          try { msg = JSON.parse(payload); } catch (e) { return; }
          self.route(msg);
        },
        close() { self.room = null; },
      };
      // 立即用 open 回调告诉 app.js「连上了」（真实 WS 是异步的，这里给个微任务）
      Promise.resolve().then(() => handlers && handlers.onopen && handlers.onopen());
      return this.ws;
    }

    route(msg) {
      const room = this.room;

      if (msg.type === 'create') {
        const mode = msg.mode === 'local' ? 'local' : 'solo';
        if (mode === 'online' || msg.mode === 'online') {
          return this.emit({ type: 'error', message: '在线版不支持局域网联机，请在电脑上运行本地服务。' });
        }
        this.room = new LocalRoom(mode, {
          variant: msg.variant,
          botLevel: msg.botLevel,
          name1: msg.name,
          name2: msg.name2,
        });
        this.room.onmessage = (m) => this.emit(m);
        this.emit({
          type: 'joined',
          room: this.room.code,
          seat: 0,
          token: 'local',
          mode: this.room.mode,
          local: this.room.local,
        });
        this.room.broadcast();
        return;
      }

      if (!room) return this.emit({ type: 'error', message: '请先创建房间' });

      // 联机专属的消息直接忽略（静态版没有第二台设备）
      if (msg.type === 'join' || msg.type === 'start' || msg.type === 'cursor') return;
      if (msg.type === 'chat') {
        return this.emit({ type: 'chat', from: 0, name: room.playerNames[0], text: String(msg.text || '').slice(0, 200) });
      }

      room.handle(msg);
    }

    emit(payload) {
      if (this.onmessage) this.onmessage(payload);
    }
  }

  window.PW_LOCAL = { LocalServer, LocalRoom, engine, ai, data };
})();
