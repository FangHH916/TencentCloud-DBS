// Offline interpreter: deliberately bounded, not a general-purpose LLM.
export const PAYEES = Object.freeze([
  { id: 'mom', name: '妈妈 / Mother', aliases: ['妈妈', '母亲', 'mom', 'mother'], account: '•••• 8821' },
  { id: 'john-tan', name: 'John Tan', aliases: ['john tan', '陈约翰'], account: '•••• 4521' },
  { id: 'john-lim', name: 'John Lim', aliases: ['john lim', '林约翰'], account: '•••• 8892' },
  { id: 'grandson', name: '孙子 · 陈小明', aliases: ['小明', '孙子', '陈小明'], account: '•••• 6008' },
  { id: 'alice', name: 'Alice', aliases: ['alice', '爱丽丝'], account: '•••• 1036' }
]);
export const SOURCES = ['savings', 'current'];
const unsafe = /忽略.{0,12}(规则|指令|限制)|绕过|跳过.{0,8}(确认|授权)|ignore.{0,25}(instructions|rules)|bypass|无需授权|不要确认/i;
const unsupported = /股票|投资|shares?|stocks?|美元|美金|usd|人民币|cny|全部|所有余额|whatever|remaining|all my|余额的一半/i;
export const canonical = value => JSON.stringify(value);

function chineseNumber(str) {
  str = str.replaceAll('〇', '零');
  const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
  if (!/[十百千万]/.test(str)) return Number([...str].map(c => digits[c] ?? 'X').join(''));
  if (str.includes('万')) {
    const parts = str.split('万');
    if (parts.length !== 2 || !parts[0] || (parts[1] && !parts[1].startsWith('零') && !/[十百千]/.test(parts[1]))) return NaN;
    return chineseNumber(parts[0]) * 10000 + (parts[1] ? chineseNumber(parts[1].replace(/^零/, '')) : 0);
  }
  if (!/^(?:[一二两三四五六七八九]千零?)?(?:[一二两三四五六七八九]百零?)?(?:[一二两三四五六七八九]?十)?[一二两三四五六七八九]?$/.test(str)) return NaN;
  // Colloquial 五百五 / 一千二 is ambiguous; never infer the omitted unit.
  if (/[百千][一二两三四五六七八九]$/.test(str)) return NaN;
  let total = 0, section = 0, digit = 0;
  for (const c of str) {
    if (c in digits) digit = digits[c];
    else if (c === '万') { total += (section + digit) * 10000; section = 0; digit = 0; }
    else if (c in units) { section += (digit || 1) * units[c]; digit = 0; }
    else return NaN;
  }
  return total + section + digit;
}

export function extractAmounts(text) {
  text = text.normalize('NFKC');
  if (/(?:^|[^\d])\.\d|\d点\d/.test(text)) return [{ raw: text, cents: null, valid: false }];
  const matches = [...text.matchAll(/\d[\d,]*(?:\.\d+)?(?:[百千万亿kKmM])?|[零〇一二两三四五六七八九十百千万亿]+(?:点[零〇一二两三四五六七八九]+)?/g)];
  return matches.map(m => {
    const raw = m[0].replace(/,$/, '');
    let value = NaN;
    if (/^\d/.test(raw)) {
      const numeric = /^(\d+|\d{1,3}(?:,\d{3})+)(\.\d{1,2})?([百千万kKmM])?$/.exec(raw);
      if (numeric) value = Number(numeric[1].replaceAll(',', '') + (numeric[2] ?? '')) * ({ 百: 100, 千: 1000, 万: 10000, k: 1000, m: 1000000 }[numeric[3]?.toLowerCase()] ?? 1);
    } else {
      const [integer, fraction] = raw.split('点');
      value = chineseNumber(integer);
      if (fraction !== undefined) value += fraction.length <= 2 ? chineseNumber(fraction) / 10 ** fraction.length : NaN;
    }
    const cents = Math.round(value * 100);
    return { raw, cents, valid: Number.isSafeInteger(cents) && cents > 0 && Math.abs(value * 100 - cents) < 1e-7 && cents <= 100000000 };
  });
}

export function recipientCandidates(text) {
  const normalized = text.toLowerCase();
  const matched = PAYEES.filter(p => p.aliases.some(alias => /^[a-z ]+$/.test(alias)
    ? new RegExp(`(?<![a-z])${alias}(?![a-z])`, 'i').test(normalized)
    : normalized.includes(alias)));
  return matched.length ? matched : /(?<![a-z])john(?![a-z])/i.test(text) ? PAYEES.filter(p => p.id.startsWith('john-')) : [];
}

function splitTransfers(text) {
  return text.split(/(?:，|,|；|;|\band\b|然后|再)(?=\s*(?:再)?(?:给|向|转|汇|send|transfer|pay))/i).map(x => x.trim()).filter(Boolean);
}

export function parseTransfer(text) {
  if (typeof text !== 'string' || text.length > 1200 || !text.trim()) return { blocked: true, reason: '请输入 1–1200 字的转账指令。' };
  text = text.normalize('NFKC');
  if (unsafe.test(text)) return { blocked: true, reason: '检测到绕过授权或更改规则的指令。此请求已拦截，账户未发生变化。' };
  if (/不要|别给|别向|不转|取消|如果|除非|don['’]t|do not|cancel|\bif\b|unless/i.test(text)) return { blocked: true, reason: '检测到否定、取消或条件表达。本版不推断条件交易，本次不会生成转账草稿。' };
  if (/[-−]\s*\d|负[零一二两三四五六七八九十百千万\d]/.test(text)) return { blocked: true, reason: '转账金额必须为正数，负数金额已拒绝。' };
  if (/(?:^|[^\d])\.\d|\d点\d/.test(text)) return { blocked: true, reason: '请使用完整数字金额，例如 0.50 或 200.50，避免混合小数格式。' };
  if (unsupported.test(text)) return { blocked: true, reason: '离线原型仅支持明确金额的 SGD 转账；投资、其他币种和相对金额需要进一步处理，本次不会执行。' };
  if (!/转|汇|send|transfer|pay/i.test(text)) return { blocked: true, reason: '请明确提出转账需求，例如：从储蓄账户给妈妈转 200 新元。' };
  const segments = splitTransfers(text);
  if (segments.length > 3) return { blocked: true, reason: '本原型每次最多支持三笔转账。请分批提出。' };
  const sources = [];
  if (/储蓄|savings/i.test(text)) sources.push('savings');
  if (/往来|活期|current/i.test(text)) sources.push('current');
  if (sources.length > 1) return { blocked: true, reason: '本版不支持一句话混用多个来源账户，请拆成独立请求。' };
  const currency = /新加坡元|新元|新币|sgd|s\$/i.test(text) ? 'SGD' : null;
  const items = [];
  for (const segment of segments) {
    const amounts = extractAmounts(segment);
    if (amounts.length > 1 || amounts.some(x => !x.valid)) return { blocked: true, reason: '金额无法可靠解析。请每笔只输入一个正数金额，最多保留两位小数。' };
    const candidates = recipientCandidates(segment);
    if (candidates.length > 1 && /和|与|及|各|分别|\band\b|\beach\b|&/i.test(segment)) return { blocked: true, reason: '同一句中有多位收款人。请按“给妈妈转 200 新元，再给 Alice 转 200 新元”的格式分别说明。' };
    if (candidates.length > 2) return { blocked: true, reason: '收款人表达不明确，请分别提出每笔转账。' };
    items.push({ recipient: candidates.length === 1 ? candidates[0].id : null, candidates: candidates.map(p => p.id), amountCents: amounts[0]?.cents ?? null, currency, source: sources[0] ?? null, evidence: segment });
  }
  return { blocked: false, items };
}

export function missingFields(items) {
  return items.flatMap((t, i) => ['recipient', 'amountCents', 'currency', 'source'].filter(k => !t[k]).map(field => ({ index: i, field, candidates: t.candidates })));
}

export function clarificationText(items) {
  const first = missingFields(items)[0];
  if (!first) return '信息已齐全，请核对付款详情。';
  const questions = { recipient: first.candidates.length > 1 ? '有同名收款人，您想转给哪一位？' : '您想转给哪一位已登记的收款人？', amountCents: '您想转多少钱？请说出准确金额。', currency: '这笔金额是新加坡元吗？请确认。', source: '您想从储蓄账户还是往来账户付款？' };
  return (items.length > 1 ? '第 ' + (first.index + 1) + ' 笔：' : '') + questions[first.field] + ' 在信息卡片中逐步补充，或用文字回复。确认授权前不会扣款。';
}

// Independent, read-only semantic checks against the raw transcript.
// This is a rule-based validator, not an independent LLM; it rejects discrepancies.
export function validateSemantics(raw, items, amendments = []) {
  const original = parseTransfer(raw);
  if (original.blocked || original.items.length !== items.length) return { ok: false, reason: '原始指令与草稿结构不一致。' };
  for (const amendment of amendments) {
    const item = original.items[amendment.index];
    if (!item || !['recipient', 'amountCents', 'currency', 'source'].includes(amendment.field)) return { ok: false, reason: '修改记录无效。' };
    item[amendment.field] = amendment.value;
    if (amendment.field === 'recipient') item.candidates = [amendment.value];
  }
  for (let i = 0; i < items.length; i++) {
    const expected = original.items[i], actual = items[i];
    for (const key of ['recipient', 'amountCents', 'currency', 'source']) {
      if (expected[key] !== null && expected[key] !== actual[key]) return { ok: false, reason: `第 ${i + 1} 笔的 ${key} 与原始指令不一致。` };
    }
    if (expected.candidates.length && !expected.candidates.includes(actual.recipient)) return { ok: false, reason: '收款人不属于原指令的候选范围。' };
  }
  return { ok: true, reason: '已核对原始指令及明确修改记录；补充字段保留在澄清记录中。' };
}
