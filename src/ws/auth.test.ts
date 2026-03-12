/**
 * WS Authentication tests (M2-P3 T1.2)
 */
import { createHmac } from 'crypto';
import { describe, it, expect } from 'vitest';
import { verifyToken, extractToken } from './auth.js';

const TEST_SECRET = 'test-secret-key-for-ws-auth';

function base64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function makeToken(
  payload: Record<string, unknown>,
  secret = TEST_SECRET,
): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = base64url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest();
  return `${signingInput}.${base64url(signature)}`;
}

describe('verifyToken', () => {
  it('accepts valid token', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = makeToken({
      sub: 'auth0|user1',
      iss: 'travel-aw-vercel',
      iat: now,
      exp: now + 3600,
    });

    const result = verifyToken(token, TEST_SECRET);
    expect(result.valid).toBe(true);
    expect(result.payload?.sub).toBe('auth0|user1');
    expect(result.payload?.iss).toBe('travel-aw-vercel');
  });

  it('rejects empty token with close code 4001', () => {
    const result = verifyToken('', TEST_SECRET);
    expect(result.valid).toBe(false);
    expect(result.closeCode).toBe(4001);
    expect(result.error).toBe('Authentication required');
  });

  it('rejects expired token with close code 4003', () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const token = makeToken({
      sub: 'auth0|user1',
      iss: 'travel-aw-vercel',
      iat: past - 3600,
      exp: past,
    });

    const result = verifyToken(token, TEST_SECRET);
    expect(result.valid).toBe(false);
    expect(result.closeCode).toBe(4003);
  });

  it('rejects token with wrong secret', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = makeToken(
      {
        sub: 'auth0|user1',
        iss: 'travel-aw-vercel',
        iat: now,
        exp: now + 3600,
      },
      'wrong-secret',
    );

    const result = verifyToken(token, TEST_SECRET);
    expect(result.valid).toBe(false);
    expect(result.closeCode).toBe(4003);
  });

  it('rejects token with wrong issuer', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = makeToken({
      sub: 'auth0|user1',
      iss: 'not-travel-aw',
      iat: now,
      exp: now + 3600,
    });

    const result = verifyToken(token, TEST_SECRET);
    expect(result.valid).toBe(false);
    expect(result.closeCode).toBe(4003);
  });

  it('rejects malformed token', () => {
    const result = verifyToken('not.a.valid.jwt', TEST_SECRET);
    expect(result.valid).toBe(false);
  });
});

describe('extractToken', () => {
  it('extracts token from query string', () => {
    const token = extractToken('/?token=abc123');
    expect(token).toBe('abc123');
  });

  it('returns null when no token parameter', () => {
    const token = extractToken('/');
    expect(token).toBeNull();
  });

  it('returns null for undefined URL', () => {
    const token = extractToken(undefined);
    expect(token).toBeNull();
  });
});
