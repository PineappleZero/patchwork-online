'use strict';

/*
 * 用无头浏览器 + 真实 WS 客户端配合，把对局界面玩到中局后截图。
 * 做法：脚本作为「玩家二」连上服务端，再用 Edge 打开页面作为「玩家一」，
 * 通过注入脚本让玩家一自动建房、自动落子，最后由 playwright 不可用，
 * 改用纯 CDP 太复杂 —— 这里简化为：服务端注入一个演示房间，
 * 直接构造中局状态并渲染。
 *
 * 更简单可靠的方式：用真实客户端连服务端建好房间并走几步，
 * 然后把房间码写进一个 demo 页面，用 Edge 打开并自动加入。
 */

const http = require('http');
const crypto = require('crypto');
const { PATCHES } = require('./server/data');

const PORT = Number(process.env.PORT || 3178);

/* 复用 e2e.js 的 WS 客户端实现（精简版） */
function wsClient() {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      port: PORT, host: '127.0.0.1', path: '/',
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': 13,
      },
    });
    req.on('upgrade', (res, socket) => {
      socket.setNoDelay(true);
      const client = {
        socket, buffer: Buffer.alloc(0), messages: [],
        send(obj) {
          const payload = Buffer.from(JSON.stringify(obj), 'utf8');
          const mask = crypto.randomBytes(4);
          const len = payload.length;
          let header;
          if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
          else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
          else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
          header[0] = 0x81;
          const masked = Buffer.from(payload);
          for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
          socket.write(Buffer.concat([header, mask, masked]));
        },
      };
      socket.on('data', (chunk) => {
        client.buffer = Buffer.concat([client.buffer, chunk]);
        for (;;) {
          if (client.buffer.length < 2) return;
          const opcode = client.buffer[0] & 0x0f;
          let len = client.buffer[1] & 0x7f; let off = 2;
          if (len === 126) { if (client.buffer.length < 4) return; len = client.buffer.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (client.buffer.length < 10) return; len = Number(client.buffer.readBigUInt64BE(2)); off = 10; }
          if (client.buffer.length < off + len) return;
          const pl = client.buffer.slice(off, off + len);
          client.buffer = client.buffer.slice(off + len);
          if (opcode !== 0x1) continue;
          try { client.messages.push(JSON.parse(pl.toString('utf8'))); } catch (e) { /* ignore */ }
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

(async () => {
  const c2 = await wsClient();
  await sleep(300);
  c2.send({ type: 'create', name: '小杭' });
  await sleep(400);
  const joined = c2.messages.find((m) => m.type === 'joined');
  console.log('ROOM=' + joined.room);
  const c1 = await wsClient();
  await sleep(200);
  c1.send({ type: 'join', name: '阿岚', room: joined.room });
  await sleep(600);

  const latest = () => c1.messages.filter((m) => m.type === 'state').pop();
  let st = latest();
  console.log('started, active=' + st.active);

  // 走 14 步让局面丰富起来（两位玩家都由本脚本代打）
  for (let step = 0; step < 14 && st && st.phase !== 'over'; step += 1) {
    const seat = st.active;
    const cl = seat === 0 ? c1 : c2;
    const player = st.players[seat];
    const seen = c1.messages.length;

    if (st.pendingLeather.some((x) => x.player === seat)) {
      let spot = null;
      for (let r = 0; r < 9 && !spot; r += 1) {
        for (let c = 0; c < 9; c += 1) { if (!player.board[r][c]) { spot = { r, c }; break; } }
      }
      cl.send({ type: 'leather', row: spot.r, col: spot.c });
    } else {
      // 挑一块买得起、能放下的补丁
      let action = null;
      for (const pid of st.visible) {
        const p = PATCHES.find((x) => x.id === pid);
        if (!p || p.cost > player.buttons) continue;
        for (let oi = 0; oi < p.orientations.length && !action; oi += 1) {
          const ori = p.orientations[oi];
          for (let r = 0; r + ori.rows <= 9 && !action; r += 1) {
            for (let c = 0; c + ori.cols <= 9; c += 1) {
              let ok = true;
              for (const [dr, dc] of ori.cells) { if (player.board[r + dr][c + dc]) { ok = false; break; } }
              if (ok) { action = { type: 'patch', patchId: pid, oriIndex: oi, row: r, col: c }; break; }
            }
          }
        }
        if (action) break;
      }
      cl.send(action || { type: 'advance' });
    }

    for (let g = 0; g < 200 && c1.messages.length === seen; g += 1) await sleep(5);
    st = latest();
  }
  console.log('steps done, phase=' + st.phase + ' active=' + st.active);
  console.log('ROOM=' + joined.room + ' ACTIVE=' + st.active);

  // 让玩家二主动让座：通知服务端释放该座位，浏览器即可接替查看这个中局
  c2.send({ type: 'release' });
  await sleep(600);
  c2.socket.destroy();
  console.log('演示房间已就绪：' + joined.room + '（玩家二座位留给你）');
  await sleep(180000);
})().catch((e) => { console.error(e); process.exit(1); });
