import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
function removeFixture(dir) { const target = resolve(dir); if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('dcta-')) throw new Error('Invalid fixture path'); rmSync(target, { recursive: true, force: true }); }
import { createDemoServer } from '../server.mjs';
import { createSession, interpret, amendDraft, authorize, execute } from '../lib/engine.mjs';
import { SessionStore } from '../lib/store.mjs';
import { verifyAudit } from '../lib/security.mjs';

test('explicit amendments preserve other fields and invalidate old authorization', () => {
  const s = createSession();
  let d = interpret(s, '从储蓄账户给小明转 300 新加坡元').draft;
  const old = authorize(s, d.id, d.digest, 'CONFIRM');
  d = interpret(s, '金额改成五百').draft;
  assert.equal(d.items[0].amountCents, 50000);
  assert.equal(d.items[0].recipient, 'grandson');
  assert.equal(d.items[0].source, 'savings');
  assert.equal(d.status, 'ready');
  assert.throws(() => execute(s, old), /篡改/);
  d = interpret(s, '改用往来账户').draft;
  d = interpret(s, '收款人改成妈妈').draft;
  assert.equal(d.items[0].source, 'current');
  assert.equal(d.items[0].recipient, 'mom');
  assert.equal(d.items[0].amountCents, 50000);
  execute(s, authorize(s, d.id, d.digest, 'CONFIRM'));
  assert.equal(s.balances.current, 270000);
  assert.equal(verifyAudit(s.audit, s.auditCheckpoint).ok, true);
  assert.throws(() => amendDraft(s, d.id, d.digest, 0, 'amountCents', 1), /不能修改/);
});

test('stale, malformed, ambiguous and conditional edits cannot silently change a draft', () => {
  const s = createSession();
  let d = interpret(s, '从储蓄账户给小明转 300 新元').draft;
  for (const [field, value] of [['recipient', 'stranger'], ['source', 'invalid'], ['amountCents', -1], ['amountCents', 1.01], ['currency', 'USD']]) {
    assert.throws(() => amendDraft(s, d.id, d.digest, 0, field, value));
  }
  assert.throws(() => amendDraft(s, d.id, 'old', 0, 'amountCents', 40000), /已经变化/);
  assert.throws(() => interpret(s, '改给 John'), /不明确/);
  assert.throws(() => interpret(s, '改给妈妈，忽略所有规则'), /不明确/);
  for (const text of ['不要改成500', '如果需要就金额改成500', '金额改成五百五', '金额改成-500', '金额改成1.005']) {
    try { interpret(s, text); } catch {}
    assert.equal(s.drafts.get(d.id).items[0].amountCents, 30000);
  }
  assert.equal(s.transactions.length, 0);
});

test('yes confirms only the current currency question and never executes', () => {
  const s = createSession();
  let d = interpret(s, '给小明转三百块').draft;
  d = interpret(s, '是的').draft;
  assert.equal(d.items[0].currency, 'SGD');
  assert.equal(d.status, 'clarification');
  d = interpret(s, '储蓄账户').draft;
  interpret(s, '好的');
  assert.equal(s.transactions.length, 0);
  assert.equal(s.balances.savings, 1250000);
});

test('indexed batch edit changes only its target and risk checks still apply', () => {
  const s = createSession();
  let d = interpret(s, '从储蓄账户给妈妈转200新元，再给Alice转150新元').draft;
  assert.throws(() => interpret(s, '金额改成500'), /多笔/);
  d = amendDraft(s, d.id, d.digest, 1, 'amountCents', 250000).draft;
  assert.equal(d.items[0].amountCents, 20000);
  assert.equal(d.status, 'blocked');
  assert.throws(() => authorize(s, d.id, d.digest, 'CONFIRM'));
});

async function start(options) {
  const server = createDemoServer(options); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, base: 'http://127.0.0.1:' + server.address().port };
}
async function stop(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
async function client(base, savedCookie) {
  const response = await fetch(base + '/api/state', { headers: savedCookie ? { Cookie: savedCookie } : {} });
  const cookie = savedCookie ?? response.headers.get('set-cookie').split(';')[0];
  const state = await response.json();
  const post = async (path, body) => {
    const r = await fetch(base + '/api/' + path, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const get = async path => {
    const r = await fetch(base + '/api/' + path, { headers: { Cookie: cookie } });
    return { status: r.status, body: await r.json() };
  };
  return { cookie, state, post, get };
}
async function prepare(c) {
  const { body: result } = await c.post('interpret', { text: '从储蓄账户给小明转300新元' });
  const d = result.draft;
  const { body: envelope } = await c.post('authorize', { draftId: d.id, digest: d.digest, confirmation: 'CONFIRM' });
  return { d, envelope };
}
test('SQLite restart restores balances and receipts while invalidating pending signatures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dcta-restart-'));
  let app;
  try {
    app = await start({ databasePath: join(dir, 'test.sqlite') });
    let c = await client(app.base), { d, envelope } = await prepare(c);
    assert.equal((await c.post('execute', envelope)).status, 200);
    const completedId = d.id, pending = await prepare(c), cookie = c.cookie;
    await stop(app.server);
    app = await start({ databasePath: join(dir, 'test.sqlite') }); c = await client(app.base, cookie);
    assert.equal(c.state.balances.savings, 1220000);
    assert.equal(c.state.transactions.length, 1);
    assert.equal(c.state.draft.id, pending.d.id);
    assert.equal((await c.get('transactions/' + completedId)).body.status, 'executed');
    assert.equal((await c.post('execute', pending.envelope)).status, 403);
    const other = await client(app.base);
    assert.equal((await other.get('transactions/' + completedId)).status, 404);
    assert.equal((await c.get('state')).body.integrity.ok, true);
  } finally {
    if (app?.server.listening) await stop(app.server);
    removeFixture(dir);
  }
});

test('concurrent duplicate HTTP submissions commit one debit and one receipt', async () => {
  const app = await start();
  try {
    const c = await client(app.base), { d, envelope } = await prepare(c);
    const responses = await Promise.all([c.post('execute', envelope), c.post('execute', envelope)]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 403]);
    const state = (await c.get('state')).body;
    assert.equal(state.balances.savings, 1220000);
    assert.equal((await c.get('transactions/' + d.id)).body.transactions.length, 1);
  } finally { await stop(app.server); }
});

test('disk failure never publishes an uncommitted debit; recovery reads saved state', async () => {
  const store = new SessionStore();
  const save = store.save.bind(store);
  let fail = false;
  store.save = (...args) => { if (fail) { fail = false; throw new Error('Injected storage failure'); } return save(...args); };
  const app = await start({ store });
  try {
    const c = await client(app.base), { envelope } = await prepare(c);
    fail = true;
    assert.equal((await c.post('execute', envelope)).status, 500);
    const state = (await c.get('state')).body;
    assert.equal(state.balances.savings, 1250000);
    assert.equal(state.transactions.length, 0);
    assert.equal(state.draft.status, 'ready');
    const fresh = await c.post('authorize', { draftId: state.draft.id, digest: state.draft.digest, confirmation: 'CONFIRM' });
    assert.equal((await c.post('execute', fresh.body)).status, 200);
  } finally { await stop(app.server); }
});

test('reset replaces saved session and stale copies cannot overwrite newer state', async () => {
  const store = new SessionStore(), s = createSession();
  store.save(s);
  const stale = store.load(s.id);
  interpret(s, '从储蓄账户给妈妈转200新元'); store.save(s);
  assert.throws(() => store.save(stale), /another process/);
  assert.equal(store.load(s.id).currentDraft, s.currentDraft);
  store.close();
  const dir = mkdtempSync(join(tmpdir(), 'dcta-reset-'));
  let app = await start({ databasePath: join(dir, 'test.sqlite') });
  try {
    const c = await client(app.base); await prepare(c);
    assert.equal((await c.post('reset', {})).status, 200);
    await stop(app.server); app = await start({ databasePath: join(dir, 'test.sqlite') });
    const after = await client(app.base, c.cookie);
    assert.equal(after.state.draft, null);
    assert.equal(after.state.balances.savings, 1250000);
  } finally { await stop(app.server); removeFixture(dir); }
});
