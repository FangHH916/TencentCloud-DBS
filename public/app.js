const $ = selector => document.querySelector(selector);
let state, busy = false, toastTimer, recognition, confirmingDraft;
let lastAnnouncement = '', speechToken = 0, connected = false, editingDraft, speechUtterance;
let uncertainDraftId = '';
try { uncertainDraftId = sessionStorage.getItem('dcta-pending') ?? ''; } catch {}
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
  const blocked = value || !connected || Boolean(uncertainDraftId);
  $('#send').disabled = blocked; $('#reset').disabled = blocked;
  $('#voice').disabled = blocked;
  $('#cancel-confirm').disabled = value;
  $('#send').setAttribute('aria-busy', String(value));
  document.querySelectorAll('[data-lab], [data-example], .draft-cta').forEach(b => { b.disabled = blocked; });
  $('#save-edit').disabled = blocked; $('#cancel-edit').disabled = value; $('#confirm-reset').disabled = blocked;
  $('#check-result').disabled = value; $('#stop-pending').disabled = value;
  $('#approve').disabled = blocked || !$('#confirm-check').checked;
  $('#help').disabled = value;
  $('#voice').setAttribute('aria-busy', String(Boolean(recognition)));
  if (value && recognition) recognition.stop();
}
async function action(fn) {
  if (busy) return;
  lock(true);
  try { await fn(); } catch (e) {
    toast(e.message); $('#confirm-dialog').close(); $('#edit-dialog').close(); confirmingDraft = null;
    try { await refreshState(); $('#reconnect').hidden = true; }
    catch { connected = false; $('#reconnect').hidden = false; }
    showRecovery();
  }
  finally { lock(false); }
}
function renderMessages() {
  const container = $('#messages'); container.replaceChildren();
  const intro = element('div', 'message welcome');
  intro.append(element('div', 'msg-avatar', 'D'));
  const bubble = element('div', 'bubble'); bubble.append(element('h3', '', '您好，我们一起练习转账。'), element('p', '', '您可以说“给小明转三百块”。我会一次问一个问题。核对并授权前不会扣款。')); intro.append(bubble); container.append(intro);
  for (const m of state.messages) {
    const row = element('div', `message ${m.role}`);
    if (m.role !== 'user') row.append(element('div', 'msg-avatar', 'D'));
    row.append(element('div', 'bubble', m.text)); container.append(row);
  }
  container.scrollTop = container.scrollHeight;
}
function itemCard(item, index) {
  const card = element('div', 'transfer-item');
  const header = element('div', 'item-heading');
  const recipient = payee(item.recipient);
  header.append(element('strong', '', recipient?.name ?? '收款人待确认'), element('span', 'item-number', `第 ${index + 1} 笔`));
  card.append(header, element('div', 'item-amount', item.amountCents === null ? '金额待确认' : `${item.currency ?? '?'} ${money(item.amountCents)}`));
  const details = element('div', 'item-detail'); details.append(element('span', '', '付款账户'), element('b', '', sourceName(item.source))); card.append(details);
  if (recipient) { const account = element('div', 'item-detail'); account.append(element('span', '', '收款账户'), element('b', '', recipient.account)); card.append(account); }

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
  d.items.forEach((item, i) => {
    const card = itemCard(item, i);
    if (['ready', 'clarification', 'blocked'].includes(d.status)) {
      const edit = element('button', 'button subtle draft-cta edit-item', '修改这笔');
      edit.type = 'button'; edit.dataset.editIndex = i; edit.onclick = () => openEdit(d, i); card.append(edit);
    }
    form.append(card);
  });
  if (d.status === 'clarification') renderGuidedQuestion(form, d);
  body.append(form);
  if (d.items.every(item => item.amountCents !== null && item.currency === 'SGD')) {
    const total = element('div', 'batch-total'); total.append(element('span', '', `${d.items.length} 笔交易合计`), element('strong', '', `SGD ${money(d.items.reduce((sum, item) => sum + item.amountCents, 0))}`)); body.append(total);
  }
  const read = element('button', 'button subtle draft-cta', '再听一遍付款详情'); read.id = 'read-draft'; read.type = 'button'; read.onclick = () => speak(draftReadback(d)); body.append(read);
  if (d.validation) body.append(element('p', `validation-note ${d.validation.ok ? '' : 'bad'}`, `${d.validation.ok ? '✓' : '×'} ${d.validation.reason}`));
  if (d.risk) body.append(element('p', `validation-note ${d.risk.ok ? '' : 'bad'}`, `${d.risk.ok ? '✓' : '×'} ${d.risk.reason}`));
  if (d.status === 'ready') {
    const review = element('button', 'button main-button draft-cta', '下一步：核对并授权'); review.id = 'review'; review.onclick = () => openConfirmation(d); body.append(review);
  }
  if (d.status === 'executed') {
    const receipt = element('div', 'payment-receipt');
    receipt.append(element('strong', '', '✓ 模拟付款已完成'), element('p', '', '无需再次付款。已完成的付款不能通过取消草稿撤销。'), element('small', '', '交易编号：' + d.id));
    body.append(receipt);
  }
  if (d.status === 'cancelled') body.append(element('p', 'validation-note', '草稿已取消，原授权已失效。可修改指令后重新生成。'));
  if (!['executed', 'cancelled'].includes(d.status)) {
    const tools = element('div', 'draft-tools');
    const edit = element('button', 'button subtle draft-cta', '修改指令'); edit.type = 'button';
    edit.onclick = () => { $('#prompt').value = d.raw; $('#prompt').focus(); $('#prompt').scrollIntoView({ behavior: 'smooth', block: 'center' }); toast('修改输入框中的指令并发送；新草稿生成后，旧草稿自动失效。'); };
    const cancel = element('button', 'button subtle draft-cta', '取消草稿'); cancel.type = 'button'; cancel.id = 'cancel-draft';
    cancel.onclick = () => action(async () => { state = await api('cancel', { draftId: d.id }); render(); toast('草稿已取消，余额未改变。'); });
    tools.append(edit, cancel); body.append(tools);
  }
  const technical = element('details', 'technical-details'); technical.append(element('summary', '', '查看校验信息'), element('div', 'digest', 'DRAFT ' + d.id + ' · REV ' + d.revision + '\nSHA-256 ' + d.digest)); body.append(technical); container.append(body);
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
  renderMessages(); renderDraft(); renderTransactions(); renderAudit(); showRecovery();
  $('#send').textContent = state.draft?.status === 'clarification' ? '发送补充信息' : '发送需求';
  announceState();
  $('#prompt').placeholder = state.draft?.status === 'clarification' ? state.messages.at(-1)?.text ?? '请补充信息' : '例如：给小明转三百块';
}
function openConfirmation(draft) {
  confirmingDraft = { id: draft.id, digest: draft.digest };
  $('#confirm-items').replaceChildren(...draft.items.map((item, i) => itemCard(item, i)));
  const total = element('div', 'batch-total'); total.append(element('span', '', `${draft.items.length} 笔交易合计`), element('strong', '', `SGD ${money(draft.items.reduce((sum, item) => sum + item.amountCents, 0))}`)); $('#confirm-items').append(total);
  $('#confirm-check').checked = false; $('#approve').disabled = true; $('#confirm-dialog').showModal(); stopSpeech(); if ($('#auto-read').checked) speak(draftReadback(draft) + '核对无误后，请勾选并点击确认。');
}
$('#confirm-check').addEventListener('change', () => { $('#approve').disabled = busy || !$('#confirm-check').checked; });
$('#cancel-confirm').onclick = () => { stopSpeech(); $('#confirm-dialog').close(); };
$('#confirm-dialog').addEventListener('close', stopSpeech);
$('#confirm-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
$('#approve').onclick = () => action(async () => {
  if (!$('#confirm-check').checked || !confirmingDraft) return;
  const envelope = await api('authorize', { draftId: confirmingDraft.id, digest: confirmingDraft.digest, confirmation: 'CONFIRM' });
  setPending(confirmingDraft.id);
  state = await api('execute', envelope); setPending(''); $('#confirm-dialog').close(); render(); focusDraft(); toast('模拟转账完成，余额与操作记录已更新。');
});
$('#chat-form').addEventListener('submit', event => {
  event.preventDefault(); const text = $('#prompt').value.trim(); if (!text) { toast('请先输入转账指令。'); return; }
  action(async () => { state = await api('interpret', { text }); $('#prompt').value = ''; render(); focusDraft(); });
});
$('#prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#chat-form').requestSubmit(); } });
document.querySelectorAll('[data-example]').forEach(button => button.onclick = () => { $('#prompt').value = button.dataset.example; $('#prompt').focus(); });
document.querySelectorAll('[data-tab]').forEach(button => button.onclick = () => {
  const tab = button.dataset.tab;
  document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b === button));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active-view', v.id === `${tab}-view`));
  $('#page-title').textContent = { transfer: '说出需求，安心转账', lab: '把安全，验证出来。', audit: '让每一步，都可追溯。' }[tab];
});
$('#reset').onclick = () => { stopSpeech(); $('#reset-dialog').showModal(); };
$('#cancel-reset').onclick = () => $('#reset-dialog').close();
$('#confirm-reset').onclick = () => action(async () => { state = await api('reset', {}); setPending(''); $('#reset-dialog').close(); render(); $('#lab-result').replaceChildren(element('h3', '', '演示已重置。选择一个场景开始验证。')); toast('已恢复初始账户余额。'); });
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
  stopSpeech();
  if (!SpeechRecognition) { toast('此浏览器不支持语音识别。请使用文字输入，或在 Chrome / Edge 中重试。'); return; }
  if (recognition) { recognition.stop(); return; }
  recognition = new SpeechRecognition(); recognition.lang = 'zh-CN'; recognition.interimResults = false;
  recognition.onstart = () => { $('#voice').classList.add('listening'); $('#voice').setAttribute('aria-pressed', 'true'); $('#voice span').textContent = '停止收音'; $('#voice-note').textContent = '正在听，请说出收款人和金额。不会自动发送或付款。'; };
  recognition.onresult = event => { $('#prompt').value = event.results[0][0].transcript; toast('请检查识别文字，确认正确后点击发送需求。'); $('#prompt').focus(); };
  recognition.onerror = event => toast(`语音识别不可用（${event.error}），请使用文字输入。`);
  recognition.onend = () => { recognition = null; $('#voice').classList.remove('listening'); $('#voice').setAttribute('aria-pressed', 'false'); $('#voice span').textContent = '点击说话'; $('#voice-note').textContent = '识别结果需要检查后发送，语音识别可能需要联网。'; };
  try { recognition.start(); } catch { recognition = null; toast('语音识别无法启动，请使用文字输入。'); }
};
async function connect() {
  lock(true); $('#reconnect').disabled = true;
  try { await refreshState(); $('#reconnect').hidden = true; lock(false); }
  catch (error) { $('#messages').replaceChildren(element('p', 'input-note', '连接失败，请确认本地服务已启动，再点击“重新连接”。')); $('#reconnect').hidden = false; toast(error.message); }
  finally { $('#reconnect').disabled = false; }
}
$('#reconnect').onclick = connect;
initializeSeniorTools();
initializeUpgradeTools();
connect();

function renderGuidedQuestion(form, draft) {
  const missing = draft.missing[0];
  if (!missing) return;
  const { index, field, candidates } = missing;
  const questions = { recipient: '您想转给哪一位？', amountCents: '您想转多少钱？', currency: '金额是新加坡元吗？', source: '从哪个账户付款？' };
  const group = element('fieldset', 'guided-question');
  group.append(element('legend', '', `${draft.items.length > 1 ? '第 ' + (index + 1) + ' 笔：' : ''}${questions[field]}`));
  group.append(element('p', '', `还需补充 ${draft.missing.length} 个信息，我们一次确认一个。`));
  const submitField = value => action(async () => {
    const fields = draft.items.map(() => ({})); fields[index][field] = value;
    state = await api('clarify', { draftId: draft.id, fields }); render();
    const target = $('#draft-content .guided-question button, #draft-content .guided-question input, #review');
    if (target) { target.focus({ preventScroll: true }); target.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  });
  if (field === 'amountCents') {
    const label = element('label', 'field', '请输入准确金额');
    const input = element('input'); input.id = `clarify-${index}-amountCents`; input.inputMode = 'decimal'; input.placeholder = '例如 300 或 300.50'; input.required = true; input.maxLength = 14; label.append(input); group.append(label);
    const button = element('button', 'button main-button draft-cta', '确认这个金额'); button.type = 'submit'; group.append(button);
    form.addEventListener('submit', e => { e.preventDefault(); const raw = input.value.trim(); const amount = Number(raw); if (!/^\d+(?:\.\d{1,2})?$/.test(raw) || amount <= 0 || !Number.isSafeInteger(Math.round(amount * 100))) { toast('请输入大于零、最多两位小数的金额，例如 300.50。'); input.focus(); return; } submitField(Math.round(amount * 100)); });
  } else {
    const choices = field === 'recipient' ? state.payees.filter(p => !candidates.length || candidates.includes(p.id)).map(p => [p.id, `${p.name}，尾号 ${p.account}`]) : field === 'currency' ? [['SGD', '确认：新加坡元（SGD）']] : [['savings', sourceName('savings')], ['current', sourceName('current')]];
    for (const [value, name] of choices) {
      const button = element('button', 'button choice-button draft-cta', name); button.type = 'button'; button.dataset.choice = value; button.onclick = () => submitField(value); group.append(button);
    }
    form.addEventListener('submit', e => e.preventDefault());
  }
  group.append(element('p', 'input-note', field === 'currency' ? '这里只支持新加坡元，其他币种请取消后修改。' : '也可以回到对话框，输入或说出补充信息。'));
  form.append(group);
}
function draftReadback(draft) {
  if (!draft) return '请先告诉我收款人和金额，我们一步一步核对。';
  const intro = draft.status === 'executed' ? '模拟付款已完成。' : draft.status === 'cancelled' ? '草稿已取消。' : '请听取当前模拟付款详情。';
  return intro + draft.items.map((item, i) => '第' + (i + 1) + '笔，收款人：' + (payee(item.recipient)?.name ?? '待确认') + '，收款账户尾号：' + (payee(item.recipient)?.account.replace(/[^0-9]/g, '').split('').join(' ') ?? '待确认') + '，金额：' + (item.amountCents === null ? '待确认' : String(item.amountCents / 100)) + (item.currency === 'SGD' ? '新加坡元' : '，币种待确认') + '，付款账户：' + (item.source === 'savings' ? '储蓄账户，尾号二零三八' : item.source === 'current' ? '往来账户，尾号七七一六' : '待确认') + '。').join('') + (draft.missing.length ? '请继续补充信息。' : ['executed', 'cancelled'].includes(draft.status) ? '' : '请核对后再授权付款。');
}
function stopSpeech() { speechToken++; if ('speechSynthesis' in window) window.speechSynthesis.cancel(); speechUtterance = null; $('#speech-status').textContent = ''; }
function speak(text) {
  stopSpeech();
  if (recognition) { toast('正在收音，请结束说话后再朗读。'); return; }
  if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) { $('#speech-status').textContent = '此浏览器无法朗读，请查看文字。'; return; }
  const token = speechToken;
  const utterance = new SpeechSynthesisUtterance(text); utterance.lang = 'zh-CN'; utterance.rate = Number($('#speech-rate').value); speechUtterance = utterance;
  const voice = window.speechSynthesis.getVoices().find(v => /^zh[-_]CN$/i.test(v.lang)) ?? window.speechSynthesis.getVoices().find(v => /^zh/i.test(v.lang));
  if (voice) utterance.voice = voice;
  utterance.onstart = () => { if (token === speechToken) $('#speech-status').textContent = '正在朗读，可点击停止朗读。'; };
  utterance.onend = () => { if (token === speechToken) $('#speech-status').textContent = '朗读结束。'; };
  utterance.onerror = () => { if (token === speechToken) $('#speech-status').textContent = '朗读不可用，请查看文字并核对。'; };
  try { window.speechSynthesis.speak(utterance); } catch { $('#speech-status').textContent = '朗读不可用，请查看文字并核对。'; }
}
function announceState() {
  const message = state.messages.filter(m => m.role === 'assistant').at(-1)?.text ?? '您好，我们一起练习转账，请告诉我想转给谁和金额。';
  const key = `${state.draft?.id ?? 'welcome'}:${state.draft?.revision ?? 0}:${message}`;
  if (key !== lastAnnouncement) { lastAnnouncement = key; if ($('#auto-read').checked && !$('#confirm-dialog').open) speak(message); }
}
function initializeSeniorTools() {
  const status = element('span', 'speech-status'); status.id = 'speech-status'; status.setAttribute('role', 'status'); $('.access-tools').append(status);
  $('#font-size').onclick = () => { const large = document.body.classList.toggle('extra-large'); $('#font-size').setAttribute('aria-pressed', String(large)); $('#font-size').textContent = large ? '恢复标准大字' : '加大文字'; };
  $('#stop-reading').onclick = stopSpeech;
  $('#auto-read').onchange = () => { if (!$('#auto-read').checked) stopSpeech(); else if (state) speak(state.draft ? draftReadback(state.draft) : '请告诉我想转给谁和金额。'); };
  $('#read-confirm').onclick = () => { if (state?.draft && confirmingDraft?.id === state.draft.id) speak(draftReadback(state.draft)); };
  $('#help').onclick = () => { stopSpeech(); $('#help-dialog').showModal(); };
  $('#close-help').onclick = () => $('#help-dialog').close();
  window.addEventListener('pagehide', () => { stopSpeech(); if (recognition) recognition.stop(); });
}

function setPending(id) {
  uncertainDraftId = id;
  try { if (id) sessionStorage.setItem('dcta-pending', id); else sessionStorage.removeItem('dcta-pending'); } catch {}
  showRecovery();
}
function showRecovery() {
  $('#recovery-banner').hidden = !uncertainDraftId;
  $('#recovery-title').textContent = busy ? '正在处理或核对付款' : '这笔付款的结果需要核对';
  $('#recovery-text').textContent = '请先查询结果。若仍未确认，可以停止这笔待确认付款；系统确认后才能继续操作。';
}
async function refreshState() {
  if (uncertainDraftId) {
    const result = await api('transactions/' + encodeURIComponent(uncertainDraftId));
    if (['executed', 'cancelled'].includes(result.status)) setPending('');
  }
  state = await api('state'); connected = true; render();
}
function focusDraft() {
  const target = $('#draft-content .guided-question input, #draft-content .guided-question button, #review') ?? $('#draft-content');
  target.focus({ preventScroll: true });
  if (window.innerWidth <= 1200) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function openEdit(draft, index) {
  stopSpeech(); if (recognition) recognition.stop();
  editingDraft = { id: draft.id, digest: draft.digest, index, item: draft.items[index] };
  $('#edit-title').textContent = '修改第 ' + (index + 1) + ' 笔交易';
  $('#edit-field').value = 'amountCents'; renderEditControl(); $('#edit-dialog').showModal();
}
function renderEditControl() {
  const field = $('#edit-field').value, label = element('label', 'field');
  $('#edit-error').textContent = '';
  let input;
  if (field === 'amountCents') {
    label.textContent = '新金额（最多两位小数）'; input = element('input'); input.inputMode = 'decimal'; input.maxLength = 14;
    input.value = editingDraft.item.amountCents === null ? '' : (editingDraft.item.amountCents / 100).toFixed(2);
  } else {
    label.textContent = field === 'recipient' ? '选择已登记收款人' : '选择付款账户';
    input = element('select');
    const choices = field === 'recipient' ? state.payees.map(p => [p.id, p.name + ' ' + p.account]) : ['savings', 'current'].map(id => [id, sourceName(id)]);
    input.append(new Option('请选择', ''));
    for (const [value, text] of choices) input.append(new Option(text, value));
    input.value = editingDraft.item[field] ?? '';
  }
  input.id = 'edit-value'; input.required = true; label.htmlFor = input.id; label.append(input); $('#edit-control').replaceChildren(label);
}
function initializeUpgradeTools() {
  const preferenceKey = 'dcta-accessibility-v1';
  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem(preferenceKey) ?? '{}') ?? {}; } catch {}
  if (prefs.large === true) $('#font-size').click();
  if (typeof prefs.autoRead === 'boolean') $('#auto-read').checked = prefs.autoRead;
  if (['0.7', '0.85', '1'].includes(prefs.rate)) $('#speech-rate').value = prefs.rate;
  const savePrefs = () => { try { localStorage.setItem(preferenceKey, JSON.stringify({ large: document.body.classList.contains('extra-large'), autoRead: $('#auto-read').checked, rate: $('#speech-rate').value })); } catch {} };
  $('#font-size').addEventListener('click', savePrefs); $('#auto-read').addEventListener('change', savePrefs);
  $('#speech-rate').addEventListener('change', () => { stopSpeech(); savePrefs(); });
  $('#edit-field').onchange = renderEditControl;
  $('#cancel-edit').onclick = () => $('#edit-dialog').close();
  for (const id of ['edit-dialog', 'reset-dialog']) $('#' + id).addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  $('#edit-form').onsubmit = event => {
    event.preventDefault();
    const field = $('#edit-field').value, raw = $('#edit-value').value.trim();
    let value = raw;
    if (field === 'amountCents') {
      if (!/^\d+(?:\.\d{1,2})?$/.test(raw) || Number(raw) <= 0) { $('#edit-error').textContent = '请输入大于零、最多两位小数的金额。'; $('#edit-value').focus(); return; }
      value = Math.round(Number(raw) * 100);
    }
    action(async () => {
      state = await api('amend', { draftId: editingDraft.id, digest: editingDraft.digest, index: editingDraft.index, field, value });
      $('#edit-dialog').close(); render(); focusDraft(); toast('修改已保存，请重新核对全部信息。');
    });
  };
  $('#check-result').onclick = () => action(async () => {
    await refreshState();
    toast(uncertainDraftId ? '尚未确认完成。可停止待确认付款后重新操作。' : '已查询到交易状态，请查看交易详情和记录。');
  });
  $('#stop-pending').onclick = () => action(async () => {
    const id = uncertainDraftId;
    const result = await api('transactions/' + encodeURIComponent(id));
    if (!['executed', 'cancelled'].includes(result.status)) await api('cancel', { draftId: id });
    await refreshState();
    toast(state.transactions.some(t => t.draftId === id) ? '这笔付款已经完成，不能取消，请查看记录。' : '已停止待确认付款，没有继续执行。');
  });
}
