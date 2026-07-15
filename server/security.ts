import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

interface AuthPayload {
  sub: string;
  merchantId: string;
  role: 'OWNER' | 'ADMIN' | 'QUOTER';
  canViewCost: boolean;
  exp: number;
  iat: number;
}

function base64Url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function createAccessToken(
  payload: Omit<AuthPayload, 'exp' | 'iat'>,
  secret: string,
  lifetimeSeconds = 12 * 60 * 60,
): string {
  const now = Math.floor(Date.now() / 1000);
  const body = base64Url(JSON.stringify({ ...payload, iat: now, exp: now + lifetimeSeconds }));
  return `${body}.${sign(body, secret)}`;
}

export function verifyAccessToken(token: string, secret: string): AuthPayload | null {
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra || !safeEqual(sign(body, secret), signature)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AuthPayload;
    if (!parsed.sub || !parsed.merchantId || parsed.exp <= Math.floor(Date.now() / 1000))
      return null;
    return parsed;
  } catch {
    return null;
  }
}

export function createQuoteToken(versionId: string, nonce: string, secret: string): string {
  const body = base64Url(JSON.stringify({ versionId, nonce }));
  return `${body}.${sign(`quote:${body}`, secret)}`;
}

export function verifyQuoteToken(
  token: string,
  secret: string,
): { versionId: string; nonce: string } | null {
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra || !safeEqual(sign(`quote:${body}`, secret), signature))
    return null;
  try {
    const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      versionId?: unknown;
      nonce?: unknown;
    };
    if (typeof value.versionId !== 'string' || typeof value.nonce !== 'string') return null;
    return { versionId: value.versionId, nonce: value.nonce };
  } catch {
    return null;
  }
}

export function randomNonce(): string {
  return randomBytes(32).toString('base64url');
}

export function hashText(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

function encryptionKey(secret: string): Buffer {
  return createHash('sha256').update(`diangao-field-encryption:${secret}`).digest();
}

export function encryptText(plainText: string, secret: string): string {
  if (!plainText) return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptText(encryptedText: string, secret: string): string {
  if (!encryptedText) return '';
  const [version, ivText, tagText, bodyText, extra] = encryptedText.split('.');
  if (version !== 'v1' || !ivText || !tagText || !bodyText || extra) {
    throw new Error('无法解密字段：格式无效');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(secret),
    Buffer.from(ivText, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(bodyText, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
