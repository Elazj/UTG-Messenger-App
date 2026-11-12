const identityKey = (userId: string) => `utg-identity-v1-${userId}`;
const conversationKey = (userId: string, id: string) => `utg-conversation-key-${userId}-${id}`;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

export async function ensureIdentity(
  userId: string,
  request: (path: string, method?: string, body?: any) => Promise<any>,
) {
  let saved: any;
  try { saved = JSON.parse(localStorage.getItem(identityKey(userId)) || 'null'); } catch { saved = null; }
  if (!saved) {
    const pair = await crypto.subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['encrypt', 'decrypt'],
    );
    saved = {
      publicKey: await crypto.subtle.exportKey('jwk', pair.publicKey),
      privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey),
    };
    localStorage.setItem(identityKey(userId), JSON.stringify(saved));
  }
  await request('/api/users/me/public-key', 'PUT', { publicKey: saved.publicKey });
  return crypto.subtle.importKey('jwk', saved.privateKey, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
}

export async function getConversationKey(
  id: string,
  createdBy: string,
  me: string,
  privateKey: CryptoKey,
  request: (path: string, method?: string, body?: any) => Promise<any>,
) {
  const cached = localStorage.getItem(conversationKey(me, id));
  if (cached) return crypto.subtle.importKey('raw', fromBase64(cached), 'AES-GCM', false, ['encrypt', 'decrypt']);

  const own = await request(`/api/conversations/${id}/keys`);
  if (own.wrappedKey) {
    const raw = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, fromBase64(own.wrappedKey));
    localStorage.setItem(conversationKey(me, id), toBase64(new Uint8Array(raw)));
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  if (createdBy !== me) throw new Error('The conversation creator has not set up encryption yet.');

  const { members } = await request(`/api/conversations/${id}/keys/public`);
  if (members.some((member: any) => !member.publicKey))
    throw new Error('Each participant must sign in once on this device before encrypted chat can start.');
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const wrappedKeys = await Promise.all(members.map(async (member: any) => {
    const key = await crypto.subtle.importKey('jwk', member.publicKey, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    const wrapped = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, raw);
    return { userId: member.userId, wrappedKey: toBase64(new Uint8Array(wrapped)) };
  }));
  await request(`/api/conversations/${id}/keys`, 'POST', { wrappedKeys });
  localStorage.setItem(conversationKey(me, id), toBase64(raw));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptText(key: CryptoKey, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(value));
  return `enc1:${toBase64(iv)}:${toBase64(new Uint8Array(cipher))}`;
}

export async function decryptText(key: CryptoKey, value: string) {
  if (!value.startsWith('enc1:')) return value;
  const [, iv, cipher] = value.split(':');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) }, key, fromBase64(cipher));
  return decoder.decode(plain);
}

export async function encryptFile(key: CryptoKey, file: File) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, await file.arrayBuffer());
  return new File([iv, cipher], 'encrypted.bin', { type: 'application/octet-stream' });
}

export async function decryptFile(key: CryptoKey, file: Blob) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
  return new Blob([plain]);
}
