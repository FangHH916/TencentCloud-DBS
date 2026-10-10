import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createSession, viewSession, interpret, clarify, amendDraft, cancelDraft, authorize, execute, runLab, DemoError } from './lib/engine.mjs';
import { SessionStore, copySession } from './lib/store.mjs';

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
function reply(res, status, data, extra = {}) {
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra });
  res.end(JSON.stringify(data));
}
const cookie = id => 'dcta_session=' + id + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800';

export function createDemoServer({ databasePath = ':memory:', store = new SessionStore(databasePath) } = {}) {
  const sessions = new Map();
  function remember(s) {
    if (!sessions.has(s.id) && sessions.size >= 500) sessions.delete(sessions.keys().next().value);
    sessions.set(s.id, s);
  }
  function getSession(id) {
    if (!id) return null;
    let session = sessions.get(id);
    if (!session) {
      session = store.load(id);
      if (session) { store.save(session); remember(session); }
    }
    return session;
  }
  const app = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host, port = app.address()?.port;
      if (!['127.0.0.1:' + port, 'localhost:' + port].includes(host)) throw new DemoError('仅允许本机访问。', 403);
      const pathname = new URL(req.url, 'http://' + host).pathname;
      if (req.method === 'GET' && files.has(pathname)) {
        const [name, type] = files.get(pathname);
        const content = await readFile(new URL('./public/' + name, import.meta.url));
        res.writeHead(200, { ...headers, 'Content-Type': type }); res.end(content); return;
      }
      if (!pathname.startsWith('/api/')) return reply(res, 404, { error: 'Not found' });
      let sid = /(?:^|;\s*)dcta_session=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1];
      let s = getSession(sid);
      if (!s) {
        if (req.method !== 'GET' || pathname !== '/api/state') throw new DemoError('请先加载页面建立会话。', 401);
        s = createSession(); store.save(s); sid = s.id; remember(s);
        res.setHeader('Set-Cookie', cookie(sid));
      }
      if (req.method === 'GET' && pathname === '/api/state') return reply(res, 200, viewSession(s));
      if (req.method === 'GET' && pathname.startsWith('/api/transactions/')) {
        const id = pathname.slice('/api/transactions/'.length), d = s.drafts.get(id);
        if (!d) throw new DemoError('本会话没有这笔交易。', 404);
        return reply(res, 200, { draftId: id, status: d.status, transactions: s.transactions.filter(t => t.draftId === id) });
      }
      if (req.method !== 'POST') throw new DemoError('请求方法不支持。', 405);
      if (req.headers.origin && req.headers.origin !== 'http://' + host) throw new DemoError('来源不匹配。', 403);
      if (req.headers['x-csrf-token'] !== s.csrf) throw new DemoError('会话校验失败，请刷新页面。', 403);
      const input = await body(req);
      // Re-read after the await: concurrent requests must use the latest state.
      s = getSession(sid);
      if (!s || req.headers['x-csrf-token'] !== s.csrf) throw new DemoError('会话已变化，请刷新页面。', 409);
      const next = copySession(s);
      let result, domainError;
      try {
        if (pathname === '/api/interpret') result = interpret(next, input.text);
        else if (pathname === '/api/clarify') result = clarify(next, input.draftId, input.fields);
        else if (pathname === '/api/amend') result = amendDraft(next, input.draftId, input.digest, input.index, input.field, input.value);
        else if (pathname === '/api/cancel') result = cancelDraft(next, input.draftId);
        else if (pathname === '/api/authorize') result = authorize(next, input.draftId, input.digest, input.confirmation);
        else if (pathname === '/api/execute') result = execute(next, input);
        else if (pathname === '/api/lab') result = runLab(next, input.scenario);
        else if (pathname === '/api/reset') {
          const replacement = createSession(); store.save(replacement, s);
          sessions.delete(sid); remember(replacement);
          res.setHeader('Set-Cookie', cookie(replacement.id));
          return reply(res, 200, viewSession(replacement));
        } else throw new DemoError('接口不存在。', 404);
      } catch (error) {
        if (!(error instanceof DemoError)) throw error;
        domainError = error;
      }
      try { store.save(next); } catch (error) { sessions.delete(sid); throw error; }
      remember(next);
      if (domainError) throw domainError;
      reply(res, 200, result);
    } catch (error) {
      reply(res, error instanceof DemoError ? error.status : 500, { error: error instanceof DemoError ? error.message : '服务或保存记录异常。请查询交易结果后再操作。' });
      if (!(error instanceof DemoError)) console.error(error.message);
    }
  });
  app.once('close', () => store.close());
  return app;
}
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
export const server = createDemoServer({ databasePath: isMain ? process.env.DCTA_DB_PATH ?? fileURLToPath(new URL('./data/demo.sqlite', import.meta.url)) : ':memory:' });
if (isMain) server.listen(Number(process.env.PORT ?? 8787), '127.0.0.1', () => console.log('DCTA demo: http://127.0.0.1:' + server.address().port + '\nOffline interpreter · simulated accounts / authentication · SQLite storage\nPress Ctrl+C to stop.'));
