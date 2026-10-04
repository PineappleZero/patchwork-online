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
  const other = state.players[1 - seat];
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

  const gained = Math.max(0, Math.min(other.time + 1, 53) - me.time);
  const advValue = gained * 1.1 + (me.buttons < 3 ? 2 : 0);
  if (!best || advValue > best.v) return { type: 'advance' };
  return best.msg;
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
  c1.send({ type: 'create', name: '甲' });
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
  check('皮革格被先到者领走', leatherGot >= 5, '领走 ' + leatherGot + '/7');

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

  c1.close(); c2.close(); c3.close();

  console.log('\n----------------------------------------');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
