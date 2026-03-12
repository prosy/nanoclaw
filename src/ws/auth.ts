/**
 * WebSocket Authentication (M2-P3 T1.2, REQ-10.2)
 *
 * Validates JWT tokens on WebSocket handshake and per-message.
 * Tokens are issued by the Vercel backend (POST /api/ws-token),
 * signed with a shared secret (WS_AUTH_SECRET / AUTH_SECRET).
 *
 * Close codes:
 * - 4001: Authentication required (missing token)
 * - 4003: Invalid or expired token
 */

import { createHmac } from 'crypto';

import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WSTokenPayload {
  sub: string;      // Auth0 user ID
  exp: number;      // Expiration (Unix timestamp)
  iss: string;      // Issuer ("travel-aw-vercel")
  iat: number;      // Issued at
  userId?: string;  // Internal user ID
}

export interface AuthResult {
  valid: boolean;
  payload?: WSTokenPayload;
  error?: string;
  closeCode?: number;
}

// ---------------------------------------------------------------------------
// Token validation
// ---------------------------------------------------------------------------

function base64urlDecode(str: string): Buffer {
  // Restore standard base64
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64');
}

/**
 * Verify a JWT token signed with HMAC-SHA256.
 * Returns the decoded payload or an error.
 */
export function verifyToken(token: string, secret: string): AuthResult {
  if (!token) {
    return { valid: false, error: 'Authentication required', closeCode: 4001 };
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return { valid: false, error: 'Invalid token format', closeCode: 4003 };
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // Verify signature
  const signingInput = `${headerB64}.${payloadB64}`;
  const expectedSig = createHmac('sha256', secret)
    .update(signingInput)
    .digest();
  const actualSig = base64urlDecode(signatureB64);

  if (!expectedSig.equals(actualSig)) {
    logger.warn('[WS-AUTH] Token signature mismatch');
    return { valid: false, error: 'Invalid or expired token', closeCode: 4003 };
  }

  // Decode payload
  let payload: WSTokenPayload;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString('utf-8'));
  } catch {
    return { valid: false, error: 'Invalid token payload', closeCode: 4003 };
  }

  // Check expiration
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) {
    return { valid: false, error: 'Invalid or expired token', closeCode: 4003 };
  }

  // Verify issuer
  if (payload.iss !== 'travel-aw-vercel') {
    return { valid: false, error: 'Invalid token issuer', closeCode: 4003 };
  }

  return { valid: true, payload };
}

/**
 * Extract token from WebSocket upgrade request.
 * Checks query string parameter 'token'.
 */
export function extractToken(url: string | undefined): string | null {
  if (!url) return null;
  try {
    // URL may be relative (e.g., "/?token=..."), need a base
    const parsed = new URL(url, 'http://localhost');
    return parsed.searchParams.get('token');
  } catch {
    return null;
  }
}
