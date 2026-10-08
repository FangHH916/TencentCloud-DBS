import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { server } from '../server.mjs';

test('HTTP API validates input, authorization, session isolation and cancellation', async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await fetch(`${base}/api/state`), cookie = first.headers.get('set-cookie').split(';')[0], state = await first.json();
    const post = (path, value, extra = {}) => fetch(`${base}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': state.csrf, ...extra }, body: JSON.stringify(value) });
    for (const value of [null, [], true, 'text']) assert.equal((await post('interpret', value)).status, 400);
    assert.equal((await post('interpret', { text: '从储蓄账户给妈妈转200新元' }, { Origin: 'https://untrusted.test' })).status, 403);
    assert.equal((await post('interpret', { text: '从储蓄账户给妈妈转200新元' }, { 'X-CSRF-Token': '' })).status, 403);
    const draft = (await (await post('interpret', { text: '给 John 转500' })).json()).draft;
    assert.equal((await post('clarify', { draftId: draft.id, fields: [null] })).status, 400);
    const ready = (await (await post('interpret', { text: 'John Tan，储蓄账户，SGD' })).json()).draft;
    assert.equal(ready.status, 'ready');
    const envelope = await (await post('authorize', { draftId: ready.id, digest: ready.digest, confirmation: 'CONFIRM' })).json();
    assert.equal((await post('cancel', { draftId: ready.id })).status, 200);
    assert.equal((await post('execute', envelope)).status, 403);
    const other = await fetch(`${base}/api/state`); const otherState = await other.json(); assert.equal(otherState.draft, null); assert.equal(otherState.balances.savings, 1250000);
    const current = await (await fetch(`${base}/api/state`, { headers: { Cookie: cookie } })).json(); assert.equal(current.draft.status, 'cancelled'); assert.equal(current.balances.savings, 1250000);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
