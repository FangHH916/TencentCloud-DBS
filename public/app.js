const $ = selector => document.querySelector(selector);
let state, busy = false, toastTimer, recognition, confirmingDraft;
const money = cents => new Intl.NumberFormat('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
const sourceName = key => ({ savings: '储蓄账户 •••• 2038', current: '往来账户 •••• 7716' })[key] ?? '待确认';
const payee = id => state.payees.find(p => p.id === id);
function element(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; }
function toast(message) { const el = $('#toast'); el.textContent = message; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 5500); }
async function api(path, data) {
  let response;
  try { response = await fetch(`/api/${path}`, { signal: AbortSignal.timeout(12000), ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state?.csrf ?? '' }, body: JSON.stringify(data) }) }); }
  catch (e) { throw new Error(e.name === 'TimeoutError' ? '请求超时，请查看交易记录确认结果，勿重复操作。' : '无法连接本地服务，请确认服务已启动后重新连接。'); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '请求失败');
  return result;
}
function lock(value) {
  busy = value;
  $('#send').disabled = value; $('#reset').disabled = value;
  $('#voice').disabled = value;
  $('#cancel-confirm').disabled = value;
  $('#send').setAttribute('aria-busy', String(value));
  document.querySelectorAll('[data-lab], [data-example], .draft-cta').forEach(b => { b.disabled = value; });
  $('#approve').disabled = value || !$('#confirm-check').checked;
}
async function action(fn) {
  if (busy) return;
  lock(true);
  try { await fn(); } catch (e) {
    toast(e.message); $('#confirm-dialog').close(); confirmingDraft = null;
    try { state = await api('state'); render(); $('#reconnect').hidden = true; }
    catch { $('#reconnect').hidden = false; }
  }
  finally { lock(false); }
}
function renderMessages() {
  const container = $('#messages'); container.replaceChildren();
  const intro = element('div', 'message welcome');
  intro.append(element('div', 'msg-avatar', 'D'));
  const bubble = element('div', 'bubble'); bubble.append(element('h3', '', '你好，Alex。今天想办理什么？'), element('p', '', '告诉我收款人和金额，我会准备交易草稿。信息不明确时会先询问；你授权前，资金不会移动。')); intro.append(bubble); container.append(intro);
  for (const m of state.messages) {
    const row = element('div', `message ${m.role}`);
    if (m.role !== 'user') row.append(element('div', 'msg-avatar', 'D'));
    row.append(element('div', 'bubble', m.text)); container.append(row);
  }
  container.scrollTop = container.scrollHeight;
}
function itemCard(item, index, editable = false) {
  const card = element('div', 'transfer-item');
  const header = element('div', 'item-heading');
  const recipient = payee(item.recipient);
  header.append(element('strong', '', recipient?.name ?? '收款人待确认'), element('span', 'item-number', `TRANSFER ${String(index + 1).padStart(2, '0')}`));
  card.append(header, element('div', 'item-amount', item.amountCents === null ? '金额待确认' : `${item.currency ?? '?'} ${money(item.amountCents)}`));
  const details = element('div', 'item-detail'); details.append(element('span', '', '来源'), element('b', '', sourceName(item.source))); card.append(details);
  if (recipient) { const account = element('div', 'item-detail'); account.append(element('span', '', '收款账户'), element('b', '', recipient.account)); card.append(account); }
  if (editable) {
    const definitions = {
      recipient: ['选择收款人', (item.candidates.length ? state.payees.filter(p => item.candidates.includes(p.id)) : state.payees).map(p => [p.id, `${p.name} ${p.account}`])],
      source: ['选择来源账户', [['savings', sourceName('savings')], ['current', sourceName('current')]]],
      currency: ['确认币种', [['SGD', 'SGD · 新加坡元']]],
      amountCents: ['补充金额（SGD）', null]
    };
    for (const [key, [labelText, options]] of Object.entries(definitions)) {
      if (item[key] !== null) continue;
      const label = element('label', 'field', labelText);
      let control;
      if (options) {
        control = element('select'); control.append(new Option('请选择', ''));
        for (const [value, title] of options) control.append(new Option(title, value));
      } else { control = element('input'); control.type = 'number'; control.min = '0.01'; control.step = '0.01'; control.placeholder = '例如 200.00'; }
      control.dataset.index = index; control.dataset.field = key; control.id = `clarify-${index}-${key}`; control.required = true; label.append(control); card.append(label);
    }
  }
  return card;
}
function renderDraft() {
  const d = state.draft, container = $('#draft-content'), status = $('#draft-status'); container.replaceChildren();
  const labels = { clarification: '需要补充', ready: '等待授权', blocked: '风控拦截', frozen: '校验冻结', executed: '已执行', cancelled: '已取消' };
  status.textContent = d ? labels[d.status] ?? d.status : '待生成';
  status.className = `pill ${!d ? 'muted' : d.status === 'clarification' ? 'warning' : ['blocked', 'frozen'].includes(d.status) ? 'danger' : ''}`;
  if (!d) {
    const empty = element('div', 'draft-empty'); empty.append(element('div', 'empty-symbol', '↗'), element('h3', '', '每一笔交易，从草稿开始'), element('p', '', '输入转账指令后，在这里核对收款人、金额和来源账户。')); container.append(empty); return;
  }
  const body = element('div', 'draft-body');
  const steps = element('div', 'progress-steps');
  const stepIndex = { clarification: 0, frozen: 1, blocked: 1, ready: 2, executed: 3, cancelled: -1 }[d.status];
  ['理解指令', '核对信息', '用户授权', '执行完成'].forEach((title, i) => steps.append(element('span', i <= stepIndex ? 'reached' : '', `${i < stepIndex ? '✓' : i + 1} ${title}`)));
  body.append(steps);
  const form = element('form'); form.id = 'clarify-form';
  d.items.forEach((item, i) => form.append(itemCard(item, i, d.status === 'clarification')));
  if (d.status === 'clarification') {
    form.append(element('p', 'validation-note', '关键字段需要明确确认，系统不会代替你选择。'));
    const submit = element('button', 'button main-button draft-cta', '补齐信息并重新校验'); submit.type = 'submit'; form.append(submit);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const fields = d.items.map(() => ({}));
      try { form.querySelectorAll('[data-field]').forEach(control => {
        const key = control.dataset.field;
        if (key === 'amountCents') {
          const value = Number(control.value); if (!/^\d+(?:\.\d{1,2})?$/.test(control.value) || !Number.isFinite(value) || value <= 0) throw new Error('金额最多两位小数。');
          fields[Number(control.dataset.index)][key] = Math.round(value * 100);
        } else fields[Number(control.dataset.index)][key] = control.value;
      }); } catch (e) { toast(e.message); return; }
      action(async () => { state = await api('clarify', { draftId: d.id, fields }); render(); });
    });
  }
  body.append(form);
  if (d.items.every(item => item.amountCents !== null && item.currency === 'SGD')) {
    const total = element('div', 'batch-total'); total.append(element('span', '', `${d.items.length} 笔交易合计`), element('strong', '', `SGD ${money(d.items.reduce((sum, item) => sum + item.amountCents, 0))}`)); body.append(total);
  }
  if (d.validation) body.append(element('p', `validation-note ${d.validation.ok ? '' : 'bad'}`, `${d.validation.ok ? '✓' : '×'} ${d.validation.reason}`));
  if (d.risk) body.append(element('p', `validation-note ${d.risk.ok ? '' : 'bad'}`, `${d.risk.ok ? '✓' : '×'} ${d.risk.reason}`));
  if (d.status === 'ready') {
    const review = element('button', 'button main-button draft-cta', '核对交易并授权 →'); review.id = 'review'; review.onclick = () => openConfirmation(d); body.append(review);
  }
  if (d.status === 'executed') body.append(element('p', 'validation-note', '✓ 模拟账本已更新。本次授权不能再次使用。'));
  if (d.status === 'cancelled') body.append(element('p', 'validation-note', '草稿已取消，原授权已失效。可修改指令后重新生成。'));
  if (!['executed', 'cancelled'].includes(d.status)) {
    const tools = element('div', 'draft-tools');
    const edit = element('button', 'button subtle draft-cta', '修改指令'); edit.type = 'button';
    edit.onclick = () => { $('#prompt').value = d.raw; $('#prompt').focus(); $('#prompt').scrollIntoView({ behavior: 'smooth', block: 'center' }); toast('修改输入框中的指令并发送；新草稿生成后，旧草稿自动失效。'); };
    const cancel = element('button', 'button subtle draft-cta', '取消草稿'); cancel.type = 'button'; cancel.id = 'cancel-draft';
    cancel.onclick = () => action(async () => { state = await api('cancel', { draftId: d.id }); render(); toast('草稿已取消，余额未改变。'); });
    tools.append(edit, cancel); body.append(tools);
  }
  body.append(element('div', 'digest', `DRAFT ${d.id.slice(0, 8)} · REV ${d.revision}\nSHA-256 ${d.digest}`)); container.append(body);
}
function renderTransactions() {
  const container = $('#transactions'); container.replaceChildren();
  if (!state.transactions.length) { container.append(element('div', 'empty-row', '尚无交易。生成草稿不会扣款。')); return; }
  for (const t of state.transactions.slice(0, 8)) {
    const row = element('div', 'transaction-row'); row.append(element('span', 'transaction-icon', '↗'));
    const info = element('div'); info.append(element('strong', '', payee(t.recipient)?.name ?? t.recipient), element('small', '', `${sourceName(t.source)} · ${new Date(t.timestamp).toLocaleTimeString('zh-CN')}`));
    const amount = element('div', 'amount', `− SGD ${money(t.amountCents)}`); amount.append(element('small', '', '授权执行成功')); row.append(info, amount); container.append(row);
  }
}
function renderAudit() {
  $('#audit-count').textContent = state.audit.length;
  $('#integrity').textContent = `${state.integrity.ok ? '✓' : '×'} ${state.integrity.reason}`;
  $('#integrity').className = `pill ${state.integrity.ok ? '' : 'danger'}`;
  const list = $('#audit-list'); list.replaceChildren();
  for (const entry of [...state.audit].reverse()) {
    const detail = element('details', 'audit-entry'); const summary = element('summary');
    summary.append(element('span', '', `#${String(entry.sequence).padStart(3, '0')}`), element('strong', '', entry.action), element('time', '', new Date(entry.timestamp).toLocaleString('zh-CN')));
    detail.append(summary, element('pre', '', JSON.stringify(entry, null, 2))); list.append(detail);
  }
}
function render() {
  $('#savings').textContent = money(state.balances.savings); $('#current').textContent = money(state.balances.current);
  $('#transaction-count').textContent = state.transactions.length;
  renderMessages(); renderDraft(); renderTransactions(); renderAudit();
  $('#send').textContent = state.draft?.status === 'clarification' ? '发送补充 ↗' : '生成草稿 ↗';
  $('#prompt').placeholder = state.draft?.status === 'clarification' ? '可直接回复：John Tan，储蓄账户，SGD' : '例如：从储蓄账户给妈妈转 200 新元…';
}
function openConfirmation(draft) {
  confirmingDraft = { id: draft.id, digest: draft.digest };
  $('#confirm-items').replaceChildren(...draft.items.map((item, i) => itemCard(item, i)));
  const total = element('div', 'batch-total'); total.append(element('span', '', `${draft.items.length} 笔交易合计`), element('strong', '', `SGD ${money(draft.items.reduce((sum, item) => sum + item.amountCents, 0))}`)); $('#confirm-items').append(total);
  $('#confirm-check').checked = false; $('#approve').disabled = true; $('#confirm-dialog').showModal();
}
$('#confirm-check').addEventListener('change', () => { $('#approve').disabled = busy || !$('#confirm-check').checked; });
$('#cancel-confirm').onclick = () => $('#confirm-dialog').close();
$('#confirm-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
$('#approve').onclick = () => action(async () => {
  if (!$('#confirm-check').checked || !confirmingDraft) return;
  const envelope = await api('authorize', { draftId: confirmingDraft.id, digest: confirmingDraft.digest, confirmation: 'CONFIRM' });
  state = await api('execute', envelope); $('#confirm-dialog').close(); render(); toast('模拟转账完成，余额与审计记录已更新。');
});
$('#chat-form').addEventListener('submit', event => {
  event.preventDefault(); const text = $('#prompt').value.trim(); if (!text) { toast('请先输入转账指令。'); return; }
  action(async () => { state = await api('interpret', { text }); $('#prompt').value = ''; render(); });
});
$('#prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#chat-form').requestSubmit(); } });
document.querySelectorAll('[data-example]').forEach(button => button.onclick = () => { $('#prompt').value = button.dataset.example; $('#prompt').focus(); });
document.querySelectorAll('[data-tab]').forEach(button => button.onclick = () => {
  const tab = button.dataset.tab;
  document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b === button));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active-view', v.id === `${tab}-view`));
  $('#page-title').textContent = { transfer: '把转账，说出来。', lab: '把安全，验证出来。', audit: '让每一步，都可追溯。' }[tab];
});
$('#reset').onclick = () => action(async () => { state = await api('reset', {}); render(); $('#lab-result').replaceChildren(element('h3', '', '演示已重置。选择一个场景开始验证。')); toast('已恢复初始账户余额。'); });
$('#export-audit').onclick = () => {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), integrity: state.integrity, events: state.audit }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), link = element('a'); link.href = url; link.download = 'dcta-audit.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const labCases = [
  ['unsigned', '↗', '绕过用户授权', '尝试直接调用执行网关，没有签名时必须拒绝。'],
  ['tamper', '◇', '授权后篡改金额', '确认 SGD 200 后，把提交金额改成 SGD 2,000。'],
  ['replay', '↻', '重复提交交易', '把同一份授权提交两次，余额只能扣减一次。'],
  ['injection', '⌘', '提示注入', '要求忽略规则并跳过授权，检查是否会创建可执行交易。'],
  ['audit', '≡', '篡改审计记录', '修改一条日志，验证哈希链能否发现变化。']
];
for (const [id, icon, title, description] of labCases) {
  const card = element('article', 'lab-card'); card.append(element('div', 'lab-icon', icon), element('h3', '', title), element('p', '', description));
  const button = element('button', 'button subtle', '运行测试 ↗'); button.dataset.lab = id;
  button.onclick = () => action(async () => {
    const response = await api('lab', { scenario: id }); state = response.state; render();
    const r = response.result, result = $('#lab-result'); result.replaceChildren();
    result.append(element('span', 'result-badge', r.detected && r.invariantPassed ? '✓ 拦截与账本检查通过' : '× 检查未通过'), element('h3', '', r.caseName), element('p', '', r.reason));
    const stats = element('div', 'result-stats');
    for (const [label, value] of [['测试账户实际扣款', `SGD ${money(r.deductedCents)}`], ['预期扣款', `SGD ${money(r.expectedDeductionCents)}`], ['演示账户影响', 'SGD 0.00']]) { const column = element('div', '', label); column.append(element('strong', '', value)); stats.append(column); }
    result.append(stats);
    const details = element('details'); details.append(element('summary', '', '查看测试事件'), element('pre', '', JSON.stringify(r.events, null, 2))); result.append(details);
  });
  card.append(button); $('#lab-cards').append(card);
}
const SpeechRecognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
$('#voice').onclick = () => {
  if (!SpeechRecognition) { toast('此浏览器不支持语音识别。请使用文字输入，或在 Chrome / Edge 中重试。'); return; }
  if (recognition) { recognition.stop(); return; }
  recognition = new SpeechRecognition(); recognition.lang = 'zh-CN'; recognition.interimResults = false;
  recognition.onstart = () => { $('#voice-note').textContent = '正在听取语音…请说出来源账户、收款人、金额和币种。'; };
  recognition.onresult = event => { $('#prompt').value = event.results[0][0].transcript; toast('识别完成，请检查文字后生成草稿。'); };
  recognition.onerror = event => toast(`语音识别不可用（${event.error}），请使用文字输入。`);
  recognition.onend = () => { recognition = null; $('#voice-note').textContent = '文字流程无需联网。语音识别取决于浏览器，可能需要联网。'; };
  try { recognition.start(); } catch { recognition = null; toast('语音识别无法启动，请使用文字输入。'); }
};
async function connect() {
  lock(true); $('#reconnect').disabled = true;
  try { state = await api('state'); render(); $('#reconnect').hidden = true; lock(false); }
  catch (error) { $('#messages').replaceChildren(element('p', 'input-note', '连接失败，请确认本地服务已启动，再点击“重新连接”。')); $('#reconnect').hidden = false; toast(error.message); }
  finally { $('#reconnect').disabled = false; }
}
$('#reconnect').onclick = connect;
connect();
