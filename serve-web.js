// site/ 静态服务 + 服务端权威锦标赛 API（部署入口：sites 沙箱跑这个）
// v1.7.3 起不再「与发布产物无关」—— 锦标赛的服务端部分就挂在这台服务上。
const http = require('http'), fs = require('fs'), path = require('path');
const tourney = require('./server/tourney');
const ROOT = path.join(__dirname, 'site');
const PORT = Number(process.env.PORT || 3199);
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
                '.css':'text/css; charset=utf-8', '.png':'image/png', '.ico':'image/x-icon' };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.startsWith('/api/tw/')) {
    tourney.handle(req, res, p).catch(() => {
      try { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"服务器内部错误"}'); } catch (e) { /* 已响应 */ }
    });
    return;
  }
  if (p === '/') p = '/index.html';
  const f = path.resolve(ROOT, '.' + p);
  if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end('403'); }
  fs.readFile(f, (e, b) => {
    if (e) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
    res.end(b);
  });
}).listen(PORT, '0.0.0.0', () => console.log('site 预览服务：http://127.0.0.1:' + PORT));
