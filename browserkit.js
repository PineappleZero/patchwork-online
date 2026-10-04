'use strict';

/*
 * 浏览器联调脚手架：用 CDP 驱动本机 Edge。
 * uitest.js / shotmid.js 共用，避免重复代码。
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 3178);
const EDGE = process.env.EDGE_PATH || 'C:////////Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SHOT_DIR = path.join(__dirname, 'shots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* ---------------- 通用 WebSocket 客户端（RFC 6455，带掩码） ---------------- */
function wsConnect(url) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      port: u.port, host: u.hostname, path: u.pathname,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': 13,
      },
    });
    req.on('upgrade', (res, socket) => {
      socket.setNoDelay(true);
      const client = {
        socket, buffer: Buffer.alloc(0), messages: [], waiters: [],
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
        wait(pred, timeout = 8000) {
          const found = client.messages.find(pred);
          if (found) return Promise.resolve(found);
          return new Promise((res2, rej2) => {
            const t = setTimeout(() => rej2(new Error('等待 CDP 消息超时')), timeout);
            client.waiters.push({ pred, res: res2, t });
          });
        },
        close() { try { socket.destroy(); } catch (e) { /* noop */ } },
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

/* ---------------- CDP 封装 ---------------- */
let cdpId = 0;
async function cdp(ws, method, params = {}) {
  cdpId += 1;
  const id = cdpId;
  ws.send({ id, method, params });
  const res = await ws.wait((m) => m.id === id);
  if (res.error) throw new Error(method + ' 失败：' + JSON.stringify(res.error));
  return res.result;
}

async function evaluate(ws, expression) {
  const r = await cdp(ws, 'Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error('页面异常：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

/** 轮询页面表达式直到为真 */
async function waitFor(ws, expression, timeout = 8000, label = expression) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await evaluate(ws, expression);
    if (v) return v;
    if (Date.now() > deadline) throw new Error('等待超时：' + label);
    await sleep(120);
  }
}

/* ---------------- 启动 Edge 实例 ---------------- */
async function launchEdge(port, url, tag) {
  const dir = path.join(require('os').tmpdir(), 'pw-edge-' + tag + '-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  const proc = spawn(EDGE, [
    '--headless=new',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + dir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=1440,900',
    url,
  ], { stdio: 'ignore', detached: false });

  // 等待调试端口就绪并拿到页面目标的 WS 地址
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const list = await httpGet('http://127.0.0.1:' + port + '/json/list');
      const page = JSON.parse(list).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) {
        const ws = await wsConnect(page.webSocketDebuggerUrl);
        await cdp(ws, 'Runtime.enable');
        await cdp(ws, 'Log.enable');
        await cdp(ws, 'Page.enable');
        // 关键：CDP 端口通了不代表 DOM 已就绪，等页面真正加载完再交出去，
        // 否则接着就去点按钮会拿到 null。
        await waitForDomReady(ws);
        return { proc, ws, dir };
      }
    } catch (e) { /* 还没起来，继续等 */ }
    if (Date.now() > deadline) { proc.kill(); throw new Error('Edge 调试端口 ' + port + ' 未就绪'); }
    await sleep(400);
  }
}

/** 等到文档加载完成，并且页面脚本已执行到能响应点击的程度 */
async function waitForDomReady(ws, timeout = 15000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const r = await cdp(ws, 'Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true,
      });
      if (r.result && r.result.value === 'complete') return;
    } catch (e) { /* 页面还在导航 */ }
    if (Date.now() > deadline) return; // 超时就交给调用方的 waitFor 兜底
    await sleep(150);
  }
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

/** 收集页面报错 */
function collectErrors(ws, sink, tag) {
  ws.messages.forEach(() => {});
  const origPush = ws.messages.push.bind(ws.messages);
  ws.messages.push = (m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      sink.push(tag + ' 未捕获异常：' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      sink.push(tag + ' console.error：' + m.params.args.map((a) => a.value || a.description).join(' '));
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      sink.push(tag + ' 日志错误：' + m.params.entry.text);
    }
    return origPush(m);
  };
}

async function screenshot(ws, file) {
  const r = await cdp(ws, 'Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.writeFileSync(path.join(SHOT_DIR, file), Buffer.from(r.data, 'base64'));
  return path.join(SHOT_DIR, file);
}


module.exports = {
  launchEdge, evaluate, waitFor, screenshot, collectErrors, sleep, PORT, SHOT_DIR, cdp,
};
