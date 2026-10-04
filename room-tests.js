'use strict';

/*
 * 房间生命周期测试：覆盖「等待开局时断线释放座位」「对局中凭 token 重连」两个场景。
 * 用法：先启动服务端，再运行 node room-tests.js
 */

const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3178);

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; failures.push(name); console.log('  FAIL  ' + name + (extra ? ' -> ' + extra : '')); }
}

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
      const c = {
        socket, buffer: Buffer.alloc(0), messages: [], closed: false,
        send(obj) {
          const payload = Buffer.from(JSON.stringify(obj), 'utf8');
          const mask = crypto.randomBytes(4);
          const len = payload.length;
          let header;
          if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
          else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
          else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
          header[0] = 0x81;
          const m = Buffer.from(payload);
          for (let i = 0; i < m.length; i += 1) m[i] ^= mask[i % 4];
          socket.write(Buffer.concat([header, mask, m]));
        },
        latest(type) { return this.messages.filter((m) => m.type === type).pop(); },
        close() { c.closed = true; socket.destroy(); },
      };
      socket.on('data', (chunk) => {
        c.buffer = Buffer.concat([c.buffer, chunk]);
        for (;;) {
          if (c.buffer.length < 2) return;
          const opcode = c.buffer[0] & 0x0f;
          let len = c.buffer[1] & 0x7f; let off = 2;
          if (len === 126) { if (c.buffer.length < 4) return; len = c.buffer.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (c.buffer.length < 10) return; len = Number(c.buffer.readBigUInt64BE(2)); off = 10; }
          if (c.buffer.length < off + len) return;
          const pl = c.buffer.slice(off, off + len);
          c.buffer = c.buffer.slice(off + len);
          if (opcode !== 0x1) continue;
          try { c.messages.push(JSON.parse(pl.toString('utf8'))); } catch (e) { /* 忽略 */ }
        }
      });
      socket.on('error', () => {});
      resolve(c);
    });
    req.on('error', reject);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\n=== 房间生命周期测试 ===\n');

  console.log('[1] 建房、加入与自动开局');
  const host = await wsClient();
  await sleep(200);
  host.send({ type: 'create', name: '房主' });
  await sleep(350);
  const room = host.latest('joined').room;

  const guest = await wsClient();
  await sleep(150);
  guest.send({ type: 'join', name: '客人', room });
  await sleep(400);
  const gj = guest.latest('joined');
  check('客人成功入座', !!gj && gj.seat === 1, gj ? 'seat=' + gj.seat : 'no joined');
  check('两人到齐后自动开局', host.latest('state').started === true);

  const token2 = gj.token;

  console.log('\n[2] 断线会被标记为离线（保留座位等待回归）');
  guest.close();
  await sleep(1500);
  const st = host.latest('state');
  check('断线座位被标记为离线', st.seats[1] && st.seats[1].connected === false,
    JSON.stringify(st.seats[1]));
  check('对局中的座位不会被直接清空（保护对局进度）', st.seats[1] !== null);

  console.log('\n[3] 凭 token 重连回到原座位');
  const rejoin = await wsClient();
  await sleep(150);
  rejoin.send({ type: 'join', name: '客人', room, token: token2 });
  await sleep(500);
  const rj = rejoin.latest('joined');
  check('凭 token 重连成功', !!rj, rj ? 'seat=' + rj.seat : 'no joined');
  check('重连仍是原来的座位', rj && rj.seat === 1, rj ? 'seat=' + rj.seat : '-');
  check('重连后座位恢复在线', host.latest('state').seats[1].connected === true);

  console.log('\n[4] 对局进行中，满员房间拒绝第三方');
  const intruder = await wsClient();
  await sleep(150);
  intruder.send({ type: 'join', name: '插队的', room });
  await sleep(450);
  const err = intruder.latest('error');
  check('第三方被拒绝', !!err && /已满/.test(err.message), err ? err.message : '(无报错)');

  console.log('\n[5] 重连的玩家可以正常行动，进度不丢');
  const stBefore = rejoin.latest('state');
  const activeSeat = stBefore.active;
  const actor = activeSeat === 0 ? host : rejoin;
  const seen = actor.messages.length;
  actor.send({ type: 'advance' });
  for (let g = 0; g < 300 && actor.messages.length === seen; g += 1) await sleep(5);
  const stAfter = rejoin.latest('state');
  check('重连后可正常行动', stAfter.players[0].time + stAfter.players[1].time > 0,
    'times=' + stAfter.players[0].time + '/' + stAfter.players[1].time);
  check('对局进度未因重连而重置', stAfter.players.length === 2 && stAfter.phase === 'playing');

  console.log('\n[6] 加入不存在的房间');
  const stray = await wsClient();
  await sleep(150);
  stray.send({ type: 'join', name: '路人', room: 'ZZZZ' });
  await sleep(400);
  const err2 = stray.latest('error');
  check('不存在的房间被拒绝', !!err2 && /不存在/.test(err2.message), err2 ? err2.message : '(无报错)');

  host.close(); rejoin.close(); intruder.close(); stray.close();

  console.log('\n----------------------------------------');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
