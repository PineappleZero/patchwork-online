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

/** 问一下服务端当前有几个房间（用来验证房间回收） */
function roomCount() {
  return new Promise((resolve) => {
    http.get({ port: PORT, host: '127.0.0.1', path: '/api/info' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body).rooms); } catch (e) { resolve(-1); }
      });
    }).on('error', () => resolve(-1));
  });
}

(async () => {
  console.log('\n=== 房间生命周期测试 ===\n');

  console.log('[1] 建房、加入与自动开局');
  const host = await wsClient();
  await sleep(200);
  host.send({ type: 'create', name: '房主', mode: 'online', capacity: 2 });
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

  console.log('\n[7] 多人房里有人掉线，其他人继续，掉线者能凭 token 回来');
  const m1 = await wsClient();
  const m2 = await wsClient();
  const m3 = await wsClient();
  await sleep(200);
  m1.send({ type: 'create', name: '甲', mode: 'online', capacity: 3 });
  await sleep(300);
  const room3 = m1.latest('joined').room;
  m2.send({ type: 'join', name: '乙', room: room3 });
  await sleep(200);
  m3.send({ type: 'join', name: '丙', room: room3 });
  await sleep(400);
  const token3 = m3.latest('joined').token;
  check('三人局已开局', m1.latest('state').started === true);
  check('三人房座位数为 3', (m1.latest('state').seats || []).length === 3);

  m3.close();
  await sleep(1400);
  const st3 = m1.latest('state');
  check('掉线的第三位被标记离线', st3.seats[2] && st3.seats[2].connected === false);
  check('另外两人不受影响', st3.players.length === 3 && st3.phase === 'playing');

  const back3 = await wsClient();
  await sleep(150);
  back3.send({ type: 'join', name: '丙', room: room3, token: token3 });
  await sleep(500);
  const bj = back3.latest('joined');
  check('掉线者凭 token 回到原座位', !!bj && bj.seat === 2, bj ? 'seat=' + bj.seat : 'no joined');
  check('回来后座位恢复在线', m1.latest('state').seats[2].connected === true);
  check('对局没有被重置', m1.latest('state').players.length === 3 &&
    m1.latest('state').phase === 'playing');

  console.log('\n[8] 单机房间不会被别人抢走，没人了就回收');
  const solo = await wsClient();
  await sleep(150);
  solo.send({ type: 'create', name: '独狼', mode: 'solo' });
  await sleep(400);
  check('单机房不需要等待对手，直接开局', solo.latest('state').started === true);
  check('单机房只有一个连接座位', (solo.latest('state').seats || []).length === 1);
  const soloRoom = solo.latest('joined').room;
  const soloToken = solo.latest('joined').token;

  const grabber = await wsClient();
  await sleep(150);
  grabber.send({ type: 'join', name: '想蹭的', room: soloRoom });
  await sleep(400);
  check('没有 token 的人加不进单机房', /单机/.test((grabber.latest('error') || {}).message || ''),
    JSON.stringify(grabber.latest('error')));

  // 刷新页面 = 带 token 重连，必须放行，否则单机局一刷新就没了
  solo.close();
  await sleep(900);
  const backSolo = await wsClient();
  await sleep(150);
  backSolo.send({ type: 'join', name: '独狼', room: soloRoom, token: soloToken });
  await sleep(500);
  check('单机局刷新后能接着打（凭 token 回到座位）',
    !!backSolo.latest('joined'), JSON.stringify(backSolo.latest('error')));
  check('回来之后还是那局，进度没丢',
    backSolo.latest('state').started === true && backSolo.latest('state').players.length === 2);

  backSolo.close();
  grabber.close();
  await sleep(2200);
  const roomsFinal = await roomCount();
  // 同一个服务进程里反复跑本文件时，房间数会因为「开过局的联机房保留 20 分钟等重连」
  // 而一路累加，所以这里只能做个「没有失控」的粗上限；
  // 真正验证回收能力的是 [9] 那两条增量断言（peak > 0 且 after < peak）。
  check('房间总数没有失控', roomsFinal >= 0 && roomsFinal < 80, String(roomsFinal));

  host.close(); rejoin.close(); intruder.close(); stray.close();
  m1.close(); m2.close(); back3.close();

  console.log('\n[9] 没人进过的空房间会被回收（防内存泄漏）');
  const ghost = await wsClient();
  await sleep(150);
  ghost.send({ type: 'create', name: '幽灵', mode: 'online', capacity: 4 });
  await sleep(450);
  const peak = await roomCount();
  check('创建的房间确实登记在册', peak > 0, String(peak));
  ghost.close();
  await sleep(3000);
  const after = await roomCount();
  check('断开后空房间被回收', after < peak, peak + ' -> ' + after);

  console.log('\n[10] 规则的第二种变体：魔改版（v1.5）');
  const classicSolo = await wsClient();
  await sleep(150);
  classicSolo.send({ type: 'create', name: '老张', mode: 'solo', level: 'normal' });
  await sleep(450);
  const cs = classicSolo.latest('state');
  check('不指定变体时开的是经典版', cs.variant === 'classic', String(cs.variant));
  check('经典版广播了规则数值', cs.rules && cs.rules.startButtons === 5,
    JSON.stringify(cs.rules));
  check('经典版环上 33 块补丁', cs.circle.length === 33, String(cs.circle.length));
  check('经典版没有混沌格', cs.rules.chaosSpaces.length === 0);
  classicSolo.close();

  const chaosSolo = await wsClient();
  await sleep(150);
  chaosSolo.send({ type: 'create', name: '老王', mode: 'solo', level: 'normal', variant: 'chaos' });
  await sleep(450);
  const ks = chaosSolo.latest('state');
  check('魔改版单机房认出了 variant', ks.variant === 'chaos', String(ks.variant));
  check('魔改版开局 0 纽扣', ks.players.every((p) => p.buttons === 0),
    JSON.stringify(ks.players.map((p) => p.buttons)));
  check('魔改版环上只剩 26 块', ks.circle.length === 26, String(ks.circle.length));
  check('魔改版前方可见 4 块', ks.visible.length === 4, String(ks.visible.length));
  check('魔改版广播了 3 个混沌格',
    ks.rules.chaosSpaces.join(',') === '12,30,48', ks.rules.chaosSpaces.join(','));
  chaosSolo.close();

  // 联机房里房主选了魔改，1 号位加入后拿到的仍然得是同一套规则
  const cHost = await wsClient();
  await sleep(150);
  cHost.send({ type: 'create', name: '魔改房主', mode: 'online', capacity: 2, variant: 'chaos' });
  await sleep(350);
  const cRoom = cHost.latest('joined').room;
  check('房主侧 joined 就带上了变体', cHost.latest('joined').variant === 'chaos');
  const cGuest = await wsClient();
  await sleep(150);
  cGuest.send({ type: 'join', name: '魔改客人', room: cRoom });
  await sleep(450);
  const cst = cHost.latest('state');
  check('魔改联机房开局后仍是魔改', cst.variant === 'chaos' && cst.started === true);
  check('客人也看到同一套魔改规则', cGuest.latest('state').rules.bonusBonus === 14);
  check('魔改联机房也认得那 4 块可选', cst.visible.length === 4);

  // 重开一局不能把变体丢掉
  cHost.send({ type: 'rematch' });
  await sleep(120);
  cGuest.send({ type: 'rematch' });
  await sleep(600);
  const rr = cHost.latest('state');
  check('重开一局后变体不丢', rr.variant === 'chaos' && rr.phase === 'playing');
  check('重开后依旧是魔改的数值', rr.rules.emptyPenalty === 3 && rr.circle.length === 26);
  cHost.close();
  cGuest.close();

  console.log('\n----------------------------------------');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
