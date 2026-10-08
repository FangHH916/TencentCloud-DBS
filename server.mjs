import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createSession, viewSession, interpret, clarify, cancelDraft, authorize, execute, runLab, DemoError } from './lib/engine.mjs';
const sessions = new Map();
const port = Number(process.env.PORT ?? 8787);
const files = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']]]);
const headers = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
async function body(req) {
  let text = '';
  for await (const chunk of req) { text += chunk; if (text.length > 20000) throw new DemoError('请求过大。', 413); }
  let value;
  try { value = text ? JSON.parse(text) : {}; } catch { throw new DemoError('JSON 格式错误。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DemoError('请求内容必须是 JSON 对象。');
  return value;
}
function reply(res, status, data, extra = {}) { res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra }); res.end(JSON.stringify(data)); }
export const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host;
    const listeningPort = server.address()?.port ?? port;
    if (![`127.0.0.1:${listeningPort}`, `localhost:${listeningPort}`].includes(host)) throw new DemoError('仅允许本机访问。', 403);
    const pathname = new URL(req.url, `http://${host}`).pathname;
    if (req.method === 'GET' && files.has(pathname)) {
      const [name, type] = files.get(pathname);
      res.writeHead(200, { ...headers, 'Content-Type': type }); res.end(await readFile(new URL(`./public/${name}`, import.meta.url))); return;
    }
    if (!pathname.startsWith('/api/')) return reply(res, 404, { error: 'Not found' });
    let sid = /(?:^|;\s*)dcta_session=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1];
    let s = sessions.get(sid);
    if (!s) {
      if (req.method !== 'GET' || pathname !== '/api/state') throw new DemoError('请先加载页面建立会话。', 401);
      if (sessions.size >= 500) sessions.delete(sessions.keys().next().value);
      s = createSession(); sid = s.id; sessions.set(sid, s);
      res.setHeader('Set-Cookie', `dcta_session=${sid}; HttpOnly; SameSite=Strict; Path=/`);
    }
    if (req.method === 'GET' && pathname === '/api/state') return reply(res, 200, viewSession(s));
    if (req.method !== 'POST') throw new DemoError('请求方法不支持。', 405);
    if (req.headers.origin && req.headers.origin !== `http://${host}`) throw new DemoError('来源不匹配。', 403);
    if (req.headers['x-csrf-token'] !== s.csrf) throw new DemoError('会话校验失败，请刷新页面。', 403);
    const input = await body(req);
    let result;
    if (pathname === '/api/interpret') result = interpret(s, input.text);
    else if (pathname === '/api/clarify') result = clarify(s, input.draftId, input.fields);
    else if (pathname === '/api/cancel') result = cancelDraft(s, input.draftId);
    else if (pathname === '/api/authorize') result = authorize(s, input.draftId, input.digest, input.confirmation);
    else if (pathname === '/api/execute') result = execute(s, input);
    else if (pathname === '/api/lab') result = runLab(s, input.scenario);
    else if (pathname === '/api/reset') {
      const next = createSession(); sessions.delete(sid); sessions.set(next.id, next);
      res.setHeader('Set-Cookie', `dcta_session=${next.id}; HttpOnly; SameSite=Strict; Path=/`); result = viewSession(next);
    } else throw new DemoError('接口不存在。', 404);
    reply(res, 200, result);
  } catch (e) { reply(res, e instanceof DemoError ? e.status : 500, { error: e instanceof DemoError ? e.message : '服务异常，请重试。' }); if (!(e instanceof DemoError)) console.error(e); }
});
if (process.argv[1] === fileURLToPath(import.meta.url)) server.listen(port, '127.0.0.1', () => console.log(`DCTA demo: http://127.0.0.1:${port}\nOffline interpreter · simulated accounts / authentication\nPress Ctrl+C to stop.`));
