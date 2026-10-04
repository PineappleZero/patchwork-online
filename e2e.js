'use strict';

/*
 * 联机端到端测试：模拟两个真实 WebSocket 客户端创建/加入房间并打完整局。
 * 用法：先启动服务端，再运行 node e2e.js
 */

const http = require('http');
const crypto = require('crypto');
const { PATCHES: ALL_PATCHES, LEATHER_SPACES } = require('./server/data');

const PORT = Number(process.env.PORT || 3178);
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; failures.push(name + (extra ? ' -> ' + extra : '')); console.log('  FAIL  ' + name + (extra ? ' -> ' + extra : '')); }
}

/** 极简 WS 客户端 */
function wsClient(name) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      port: PORT,
      host: '127.0.0.1',
      path: '/',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': 13,
      },
    });
    req.on('upgrade', (res, socket) => {
      socket.setNoDelay(true);
      const client = {
        name,
        socket,
        buffer: Buffer.alloc(0),
        messages: [],
        waiters: [],
        send(obj) {
          const payload = Buffer.from(JSON.stringify(obj), 'utf8');
          const mask = crypto.randomBytes(4);
          let header;
          const len = payload.length;
          if (len < 126) {
            header = Buffer.alloc(2);
            header[1] = 0x80 | len;
          } else if (len < 65536) {
            header = Buffer.alloc(4);
            header[1] = 0x80 | 126;
            header.writeUInt16BE(len, 2);
          } else {
            header = Buffer.alloc(10);
            header[1] = 0x80 | 127;
            header.writeBigUInt64BE(BigInt(len), 2);
          }
          header[0] = 0x81;
          const masked = Buffer.from(payload);
          for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
          socket.write(Buffer.concat([header, mask, masked]));
        },
        /** 等待满足条件的一条消息 */
        wait(pred, timeout = 4000) {
          const found = client.messages.find(pred);
          if (found) return Promise.resolve(found);
          return new Promise((res2, rej2) => {
            const t = setTimeout(() => rej2(new Error(name + ' 等待消息超时')), timeout);
            client.waiters.push({ pred, res: res2, t });
          });
        },
        close() { socket.destroy(); },
      };
      socket.on('data', (chunk) => {
        client.buffer = Buffer.concat([client.buffer, chunk]);
        for (;;) {
          if (client.buffer.length < 2) return;
          const opcode = client.buffer[0] & 0x0f;
          let len = client.buffer[1] & 0x7f;
          let offset = 2;
          if (len === 126) { if (client.buffer.length < 4) return; len = client.buffer.readUInt16BE(2); offset = 4; }
          else if (len === 127) { if (client.buffer.length < 10) return; len = Number(client.buffer.readBigUInt64BE(2)); offset = 10; }
          if (client.buffer.length < offset + len) return;
          const payload = client.buffer.slice(offset, offset + len);
          client.buffer = client.buffer.slice(offset + len);
          if (opcode !== 0x1) continue;
          let msg;
          try { msg = JSON.parse(payload.toString('utf8')); } catch (e) { continue; }
          client.messages.push(msg);
          for (let i = client.waiters.length - 1; i >= 0; i -= 1) {
            const w = client.waiters[i];
            if (w.pred(msg)) { clearTimeout(w.t); w.res(msg); client.waiters.splice(i, 1); }
          }
        }
      });
      socket.on('error', () => {});
      resolve(client);
    });
    req.on('error', reject);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 测试用机器人：粗略估值，尽量像真人那样紧凑摆放 ---------------- */
const N = 9;
const NB = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** 落点紧凑度：贴边或贴着已放的补丁更好，孤立摆放更差 */
function neighborScore(board, ori, row, col) {
  let s = 0;
  for (const [dr, dc] of ori.cells) {
    const r = row + dr;
    const c = col + dc;
    for (const [nr, nc] of NB) {
      const rr = r + nr;
      const cc = c + nc;
      if (rr < 0 || cc < 0 || rr >= N || cc >= N) s += 1;
      else if (board[rr][cc]) s += 1.2;
    }
  }
  return s;
}

/** 挑一步动作：买估值最高的补丁（含最佳朝向与落点），或者前进领纽扣 */
function chooseAction(state, seat) {
  const me = state.players[seat];
  let best = null;

  for (const pid of state.visible) {
    const p = ALL_PATCHES.find((x) => x.id === pid);
    if (!p || p.cost > me.buttons) continue;
    for (let oi = 0; oi < p.orientations.length; oi += 1) {
      const ori = p.orientations[oi];
      for (let r = 0; r + ori.rows <= N; r += 1) {
        for (let c = 0; c + ori.cols <= N; c += 1) {
          let ok = true;
          for (const [dr, dc] of ori.cells) { if (me.board[r + dr][c + dc]) { ok = false; break; } }
          if (!ok) continue;
          const v = p.income * 3 - p.cost + p.size * 0.4 + neighborScore(me.board, ori, r, c) * 0.9;
          if (!best || v > best.v) best = { v, msg: { type: 'patch', patchId: pid, oriIndex: oi, row: r, col: c } };
        }
      }
    }
  }

  // 与服务端同一条规则：前面最近那位玩家的前 1 格；前面没人就别空跑
  let frontier = null;
  state.players.forEach((p) => {
    if (p.index === seat || p.time < me.time) return;
    if (frontier === null || p.time < frontier) frontier = p.time;
  });
  if (frontier === null) return best ? best.msg : { type: 'advance' };
  const gained = Math.max(0, Math.min(frontier + 1, 53) - me.time);
  const advValue = gained * 1.1 + (me.buttons < 3 ? 2 : 0);
  if (!best || advValue > best.v) return { type: 'advance' };
  return best.msg;
}

/** 取某客户端收到的最后一份状态 */
function lastState(client) {
  const list = client.messages.filter((m) => m.type === 'state');
  return list[list.length - 1];
}

/** 皮革补丁：填进邻边最多的空格，尽量补洞 */
function chooseLeatherSpot(board) {
  let bestCell = { row: 0, col: 0 };
  let bestScore = -1;
  for (let r = 0; r < N; r += 1) {
    for (let c = 0; c < N; c += 1) {
      if (board[r][c]) continue;
      let s = 0;
      for (const [nr, nc] of NB) {
        const rr = r + nr;
        const cc = c + nc;
        if (rr < 0 || cc < 0 || rr >= N || cc >= N) s += 1;
        else if (board[rr][cc]) s += 1.5;
      }
      if (s > bestScore) { bestScore = s; bestCell = { row: r, col: c }; }
    }
  }
  return bestCell;
}

(async () => {
  console.log('\n=== Patchwork 联机端到端测试 ===\n');

  console.log('[1] 建房与加入');
  const c1 = await wsClient('甲');
  const c2 = await wsClient('乙');
  c1.send({ type: 'create', name: '甲', mode: 'online', capacity: 2 });
  const joined1 = await c1.wait((m) => m.type === 'joined');
  check('创建返回房间码', /^[A-Z0-9]{4}$/.test(joined1.room), joined1.room);
  check('创建者座位为 0', joined1.seat === 0);

  c2.send({ type: 'join', name: '乙', room: joined1.room });
  const joined2 = await c2.wait((m) => m.type === 'joined');
  check('加入者座位为 1', joined2.seat === 1);

  const started = await c1.wait((m) => m.type === 'state' && m.started);
  check('两人到齐自动开局', started.started === true);
  check('双方各 5 纽扣', started.players[0].buttons === 5 && started.players[1].buttons === 5);
  check('开局可见 3 块补丁', started.visible.length === 3);
  check('开局时间板双方都在 0', started.players[0].time === 0 && started.players[1].time === 0);

  console.log('\n[2] 非当前回合方不能行动');
  const activeSeat = started.active;
  const wrongSeat = 1 - activeSeat;
  const wrongClient = wrongSeat === 0 ? c1 : c2;
  wrongClient.send({ type: 'advance' });
  const err = await wrongClient.wait((m) => m.type === 'error');
  check('轮不到的玩家操作被拒绝', /轮到/.test(err.message), err.message);

  console.log('\n[3] 打完整局并校验一致性');
  let state = started;
  let turns = 0;
  const clients = [c1, c2];

  while (state.phase !== 'over' && turns < 500) {
    const seat = state.active;
    if (seat === null || seat === undefined) break;
    const cl = clients[seat];
    const player = state.players[seat];

    const leatherForMe = state.pendingLeather.some((x) => x.player === seat);
    if (leatherForMe) {
      const spot = chooseLeatherSpot(player.board);
      cl.send({ type: 'leather', row: spot.row, col: spot.col });
    } else {
      cl.send(chooseAction(state, seat));
    }

    // 等待收到一条更新的 state（服务端会把同一份状态广播给双方）
    const seen = c1.messages.length;
    for (let guard = 0; guard < 300; guard += 1) {
      if (c1.messages.length > seen) break;
      await sleep(5);
    }
    const states = c1.messages.filter((m) => m.type === 'state');
    const next = states[states.length - 1];
    if (next === state) { // 没有新状态，避免死循环
      const errs = c1.messages.filter((m) => m.type === 'error');
      throw new Error('第 ' + turns + ' 步未收到新状态' +
        (errs.length ? '，最后错误：' + errs[errs.length - 1].message : ''));
    }
    state = next;
    turns += 1;
  }
  check('对局在合理步数内结束', state.phase === 'over', 'turns=' + turns);
  check('双方时间都到 53', state.players[0].time === 53 && state.players[1].time === 53,
    state.players[0].time + '/' + state.players[1].time);
  check('产生了结算结果', !!state.result);
  check('结算包含双方得分', state.result && state.result.scores.length === 2);
  check('胜者已判定或为平局', state.result && (state.result.winner !== null || state.result.scores[0].total === state.result.scores[1].total));
  check('没有遗留未放置的皮革补丁', state.pendingLeather.length === 0);

  const leatherGot = LEATHER_SPACES.filter((s) => state.leatherClaimed[s]).length;
  check('皮革格被先到者领走', leatherGot >= 5, '领走 ' + leatherGot + '/5');

  const boardOk = state.players.every((p) => {
    const filled = p.board.reduce((n, row) => n + row.filter(Boolean).length, 0);
    return filled + p.empty === 81;
  });
  check('拼布板占用格与空格数守恒', boardOk);

  const timeOk = state.players.every((p) => p.time >= 0 && p.time <= 53);
  check('时间令牌未越界', timeOk);

  console.log('\n[4] 结束后的状态快照');
  [0, 1].forEach((i) => {
    const s = state.result.scores[i];
    const p = state.players[i];
    console.log(`      玩家${i} ${p.name}：纽扣 ${s.buttons} + 奖励 ${s.bonus} - 空格 ${s.empty}×2 = ${s.total}（放下方块 ${81 - s.empty} 格）`);
  });
  console.log('      总步数 ' + turns + '，胜者 ' + (state.result.winner === null ? '平局' : '玩家' + state.result.winner));

  console.log('\n[5] 房间不存在时的错误处理');
  const c3 = await wsClient('丙');
  c3.send({ type: 'join', name: '丙', room: 'ZZZZ' });
  const err3 = await c3.wait((m) => m.type === 'error');
  check('加入不存在的房间被拒绝', /不存在/.test(err3.message), err3.message);

  console.log('\n[6] 再来一局');
  check('终局后状态为 over', state.phase === 'over', state.phase);
  c1.send({ type: 'rematch' });
  await sleep(260);
  let rs = lastState(c1);
  check('只有一方投票时不开新局',
    rs.phase === 'over' && rs.rematchVotes === 1, 'phase=' + rs.phase + ' votes=' + rs.rematchVotes);
  c2.send({ type: 'rematch' });
  await sleep(420);
  rs = lastState(c1);
  check('双方都投票后开出新的一局', rs.phase === 'playing', 'phase=' + rs.phase);
  check('新局双方回到起点 0', rs.players.every((p) => p.time === 0),
    JSON.stringify(rs.players.map((p) => p.time)));
  check('新局拼布板全部清空', rs.players.every((p) => p.empty === 81));
  check('新局补丁环恢复满额', rs.circle.length === ALL_PATCHES.length, String(rs.circle.length));
  check('新局重新开始于同一房间', rs.room === joined1.room);

  console.log('\n[7] 单机：人机对战');
  const s1 = await wsClient('单人');
  s1.send({ type: 'create', name: '我', mode: 'solo' });
  const j1 = await s1.wait((m) => m.type === 'joined');
  check('人机模式标记正确', j1.mode === 'solo' && j1.local === false, j1.mode);
  const soloStart = await s1.wait((m) => m.type === 'state' && m.started);
  check('人机对战建房即开局，不用等人', soloStart.started === true);
  check('第二位玩家是电脑', soloStart.players[1].bot === true && /电脑/.test(soloStart.players[1].name),
    soloStart.players[1].name);
  check('只有 2 位玩家', soloStart.players.length === 2);

  // 让人类只做最省事的动作，看电脑会不会自己接上
  let solo = soloStart;
  for (let i = 0; i < 26 && solo.phase !== 'over'; i += 1) {
    if (solo.active === 0 && !solo.players[0].finished) {
      const me = solo.players[0];
      const leather = solo.pendingLeather.some((x) => x.player === 0);
      if (leather) {
        const spot = chooseLeatherSpot(me.board);
        s1.send({ type: 'leather', row: spot.row, col: spot.col });
      } else {
        s1.send(chooseAction(solo, 0));
      }
    }
    await sleep(140);
    solo = lastState(s1);
  }
  // 电脑思考有 750ms 延迟，上面那个循环可能正好停在它思考的中途。
  // 等一下让回合交回人类，否则「轮次归属」这条会随机翻车。
  for (let i = 0; i < 20 && solo.phase !== 'over' && solo.active !== 0; i += 1) {
    await sleep(220);
    solo = lastState(s1);
  }
  check('电脑在没有人类干预时也会自己行动', solo.players[1].placed.length + solo.players[1].time > 0,
    'time=' + solo.players[1].time + ' placed=' + solo.players[1].placed.length);
  check('对面电脑确实在买补丁', solo.players[1].placed.length >= 1,
    '放了 ' + solo.players[1].placed.length + ' 块');
  check('人机局人类回合归人类', solo.active === 0 || solo.phase === 'over' || solo.players[0].finished);

  console.log('\n[8] 多人联机：3 人局');
  const t1 = await wsClient('一');
  const t2 = await wsClient('二');
  const t3 = await wsClient('三');
  t1.send({ type: 'create', name: '一', mode: 'online', capacity: 3 });
  const jt = await t1.wait((m) => m.type === 'joined');
  // joined 与紧跟的 state 是两条独立消息，可能落在不同的 TCP 分段里，
  // 等一拍再读，否则 lastState 还是 undefined
  await sleep(200);
  check('三人房容量为 3', lastState(t1).capacity === 3, String(lastState(t1).capacity));
  check('三人房一共 3 个座位', lastState(t1).seats.length === 3, String(lastState(t1).seats.length));
  t2.send({ type: 'join', name: '二', room: jt.room });
  await t2.wait((m) => m.type === 'joined');
  await sleep(200);
  let mid3 = lastState(t1);
  check('没坐满时不自动开局', mid3.started === false && mid3.phase === 'waiting', mid3.phase);
  check('房主此时可以开始', mid3.canStart === true);
  t3.send({ type: 'join', name: '三', room: jt.room });
  await t3.wait((m) => m.type === 'joined');
  await sleep(250);
  let g3 = lastState(t1);
  check('坐满 3 人自动开局', g3.started === true && g3.players.length === 3, String(g3.players.length));
  check('三人的名字都对上',
    g3.players.map((p) => p.name).join(',') === '一,二,三', g3.players.map((p) => p.name).join(','));
  // 前端拿 players 数组下标当座位号，index 必须与下标一致，否则多人布局会错位
  check('每位玩家的 index 与数组下标一致',
    g3.players.every((p, i) => p.index === i),
    g3.players.map((p) => p.index).join(','));

  const trio = [t1, t2, t3];
  const actedSeats = new Set();
  for (let i = 0; i < 30 && g3.phase !== 'over'; i += 1) {
    const seat = g3.active;
    if (seat === null || seat === undefined) break;
    actedSeats.add(seat);
    const me = g3.players[seat];
    const cl = trio[seat];
    if (g3.pendingLeather.some((x) => x.player === seat)) {
      const spot = chooseLeatherSpot(me.board);
      cl.send({ type: 'leather', row: spot.row, col: spot.col });
    } else {
      cl.send(chooseAction(g3, seat));
    }
    await sleep(60);
    g3 = lastState(t1);
  }
  check('三个座位都轮到过', actedSeats.size === 3, [...actedSeats].join(','));
  check('三人局时间令牌都不越界', g3.players.every((p) => p.time >= 0 && p.time <= 53));
  check('三人局没有皮革积压', g3.phase === 'over' || g3.pendingLeather.length === 0);

  console.log('\n[9] 多人联机：房主可以提前开局');
  const u1 = await wsClient('主');
  const u2 = await wsClient('客');
  u1.send({ type: 'create', name: '主', mode: 'online', capacity: 4 });
  const ju = await u1.wait((m) => m.type === 'joined');
  u2.send({ type: 'join', name: '客', room: ju.room });
  await u2.wait((m) => m.type === 'joined');
  await sleep(200);
  u2.send({ type: 'start' });
  await sleep(200);
  check('非房主开局被拒绝', lastState(u1).started === false);
  u1.send({ type: 'start' });
  await sleep(300);
  const started4 = lastState(u1);
  check('房主可以用 2 人开局（不满 4 人）', started4.started === true, started4.phase);
  check('开局人数按实际到场人数收窄', started4.players.length === 2, String(started4.players.length));

  console.log('\n[10] 单机：同机双人（热座）');
  const l1 = await wsClient('本地');
  l1.send({ type: 'create', name: '小明', name2: '小红', mode: 'local' });
  const jl = await l1.wait((m) => m.type === 'joined');
  check('同机模式标记为 local', jl.local === true && jl.mode === 'local');
  const loc = await l1.wait((m) => m.type === 'state' && m.started);
  check('同机双人建房即开局', loc.started === true);
  check('两位玩家名字都对上',
    loc.players[0].name === '小明' && loc.players[1].name === '小红',
    loc.players.map((p) => p.name).join(','));
  const firstSeat = loc.active;
  l1.send({ type: 'advance' });
  await sleep(180);
  let ls = lastState(l1);
  check('同一台设备可以替当前行动方操作',
    ls.players[firstSeat].time > 0, 'time=' + ls.players[firstSeat].time);
  check('行动方自动换人', ls.active !== firstSeat || ls.players[firstSeat].finished);
  l1.send({ type: 'advance' });
  await sleep(180);
  ls = lastState(l1);
  check('换人之后照样能操作（热座核心）', ls.players.every((p) => p.time > 0),
    JSON.stringify(ls.players.map((p) => p.time)));
  check('同机房间不能被别人加入', true); // 见下方单独断言

  const outsider = await wsClient('路人');
  outsider.send({ type: 'join', name: '路人', room: jl.room });
  const outsiderErr = await outsider.wait((m) => m.type === 'error');
  check('单机房间拒绝他人加入', /单机/.test(outsiderErr.message), outsiderErr.message);

  console.log('\n[11] 联机实时预览：对手能看见我在放哪（v1.3）');
  const d1 = await wsClient('预览甲');
  const d2 = await wsClient('预览乙');
  d1.send({ type: 'create', name: '甲', mode: 'online', capacity: 2 });
  const dj = await d1.wait((m) => m.type === 'joined');
  d2.send({ type: 'join', name: '乙', room: dj.room });
  await d2.wait((m) => m.type === 'joined');
  const dst = await d1.wait((m) => m.type === 'state' && m.started);
  const actor = dst.active === 0 ? d1 : d2;
  const watcher = dst.active === 0 ? d2 : d1;
  const pick = dst.visible[0];

  actor.send({ type: 'cursor', patchId: pick, oriIndex: 0, row: 3, col: 4 });
  const cur = await watcher.wait((m) => m.type === 'cursor');
  check('对手收到了实时预览',
    cur.seat === dst.active && cur.patchId === pick, JSON.stringify(cur));
  check('预览带着朝向与落点（对手能画在同一格）',
    cur.oriIndex === 0 && cur.row === 3 && cur.col === 4, JSON.stringify(cur));

  await sleep(250);
  check('预览只点对点转发，发起方自己收不到',
    actor.messages.filter((m) => m.type === 'cursor').length === 0,
    '收到 ' + actor.messages.filter((m) => m.type === 'cursor').length + ' 条');
  // 关键：预览绝不能混进 state 广播里（否则每 70ms 就会让所有人整屏重绘）
  const stMsgs = watcher.messages.filter((m) => m.type === 'state');
  check('预览没有搭上 state 广播（不触发整屏重绘）',
    stMsgs.every((m) => m.cursors === undefined), 'state 条数 ' + stMsgs.length);

  actor.send({ type: 'cursor', patchId: null });
  const clr = await watcher.wait((m) => m.type === 'cursor' && m.patchId === null);
  check('取消选择会通知对手擦掉预览', clr.patchId === null);

  // 落子之后服务端必须主动擦掉，否则对手屏幕上会僵着一块假的
  actor.send({ type: 'cursor', patchId: pick, oriIndex: 0, row: 5, col: 5 });
  await watcher.wait((m) => m.type === 'cursor' && m.patchId === pick);
  watcher.messages.length = 0;
  actor.send(chooseAction(dst, dst.active));
  let afterAct = null;
  try {
    afterAct = await watcher.wait((m) => m.type === 'cursor' && m.patchId === null, 5000);
  } catch (e) { afterAct = null; }
  check('动作落定后服务端主动擦掉预览', Boolean(afterAct));

  c1.close(); c2.close(); c3.close();
  s1.close(); t1.close(); t2.close(); t3.close();
  u1.close(); u2.close(); l1.close(); outsider.close();
  d1.close(); d2.close();

  console.log('\n----------------------------------------');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
