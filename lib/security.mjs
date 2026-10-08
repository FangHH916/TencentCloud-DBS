import { createHash, generateKeyPairSync, sign, verify, randomUUID } from 'node:crypto';
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Demo authenticator boundary. Replace with WebAuthn or a device authenticator.
// The private key is not available to the interpreter, but this is one local process.
export function createMockAuthenticator() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    publicKey,
    authorize(payload, confirmation) {
      if (confirmation !== 'CONFIRM') throw new Error('需要明确的模拟认证确认。');
      return sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64url');
    }
  };
}

export function verifyAuthorization(publicKey, payload, signature) {
  try { return verify(null, Buffer.from(JSON.stringify(payload)), publicKey, Buffer.from(signature, 'base64url')); }
  catch { return false; }
}

export function appendAudit(session, action, details = {}) {
  const entry = { sequence: session.audit.length + 1, id: randomUUID(), timestamp: new Date().toISOString(), action, details: structuredClone(details), previousHash: session.audit.at(-1)?.hash ?? 'GENESIS' };
  entry.hash = digest(entry);
  session.audit.push(entry);
  // Trusted in-memory checkpoint detects suffix deletion in this demo.
  session.auditCheckpoint = { count: session.audit.length, head: entry.hash };
  return entry;
}

export function verifyAudit(entries, checkpoint) {
  let previous = 'GENESIS';
  for (let i = 0; i < entries.length; i++) {
    const { hash, ...entry } = entries[i];
    if (entry.sequence !== i + 1 || entry.previousHash !== previous || digest(entry) !== hash) return { ok: false, reason: `第 ${i + 1} 条日志链校验失败。` };
    previous = hash;
  }
  if (checkpoint && (checkpoint.count !== entries.length || checkpoint.head !== previous)) return { ok: false, reason: '日志长度或尾部与受信检查点不一致。' };
  return { ok: true, reason: `已验证 ${entries.length} 条日志及检查点。` };
}
