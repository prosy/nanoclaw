import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  _setRedisForTest,
  clearSession,
  isRedisAvailable,
  readSession,
  SessionPayload,
  writeSession,
} from './memory-client.js';

// --- Mock Redis using ioredis built-in mock ---

/**
 * In-memory Redis-like store for unit testing.
 * Uses a simple Map with TTL tracking.
 */
class MockRedis {
  private store = new Map<
    string,
    { value: string; expiresAt: number | null }
  >();
  status = 'ready';

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(
    key: string,
    value: string,
    ex?: string,
    ttl?: number,
  ): Promise<'OK'> {
    const expiresAt = ex === 'EX' && ttl ? Date.now() + ttl * 1000 : null;
    this.store.set(key, { value, expiresAt });
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if (this.store.delete(key)) count++;
    }
    return count;
  }

  async keys(pattern: string): Promise<string[]> {
    // Simple glob: session:{group}:* -> prefix match
    const prefix = pattern.replace('*', '');
    const result: string[] = [];
    for (const [key, entry] of this.store) {
      if (key.startsWith(prefix)) {
        if (entry.expiresAt && Date.now() > entry.expiresAt) {
          this.store.delete(key);
          continue;
        }
        result.push(key);
      }
    }
    return result;
  }

  async quit(): Promise<'OK'> {
    this.store.clear();
    return 'OK';
  }

  // Simulate expired entries for TTL tests
  _expireKey(key: string): void {
    const entry = this.store.get(key);
    if (entry) {
      entry.expiresAt = Date.now() - 1000;
    }
  }
}

function makePayload(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return {
    sessionId: 'sess_test123',
    groupFolder: 'trip-planning',
    conversationHistory:
      'User: Find flights to Tokyo\nAssistant: Found 3 options.',
    skillInvocations: [],
    agentNotes: '',
    createdAt: '2026-03-08T10:00:00.000Z',
    updatedAt: '2026-03-08T10:05:00.000Z',
    turnCount: 1,
    ...overrides,
  };
}

describe('memory-client', () => {
  let mockRedis: MockRedis;

  beforeEach(() => {
    mockRedis = new MockRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setRedisForTest(mockRedis as any, true);
  });

  afterEach(() => {
    _setRedisForTest(null, false);
  });

  // --- Session lifecycle (AC-3) ---

  describe('write/read/clear lifecycle', () => {
    it('writes a session and reads it back', async () => {
      const payload = makePayload();
      await writeSession('trip-planning', 'sess_test123', payload);

      const result = await readSession('trip-planning');
      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('sess_test123');
      expect(result!.conversationHistory).toContain('flights to Tokyo');
      expect(result!.turnCount).toBe(1);
    });

    it('uses correct key pattern session:{group}:{id}', async () => {
      const payload = makePayload();
      await writeSession('trip-planning', 'sess_abc', payload);

      // Verify key format directly
      const raw = await mockRedis.get('session:trip-planning:sess_abc');
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.sessionId).toBe('sess_test123');
    });

    it('clears a session', async () => {
      const payload = makePayload();
      await writeSession('trip-planning', 'sess_test123', payload);

      await clearSession('trip-planning');

      const result = await readSession('trip-planning');
      expect(result).toBeNull();
    });
  });

  // --- Namespace isolation (AC-7) ---

  describe('group namespace isolation', () => {
    it('group A cannot read group B sessions', async () => {
      const payloadA = makePayload({ groupFolder: 'trip-planning' });
      const payloadB = makePayload({
        groupFolder: 'expense-tracking',
        sessionId: 'sess_xyz',
      });

      await writeSession('trip-planning', 'sess_abc', payloadA);
      await writeSession('expense-tracking', 'sess_xyz', payloadB);

      const resultA = await readSession('trip-planning');
      expect(resultA!.sessionId).toBe('sess_test123');

      const resultB = await readSession('expense-tracking');
      expect(resultB!.sessionId).toBe('sess_xyz');
    });

    it('clearing one group does not affect another', async () => {
      await writeSession('trip-planning', 'sess_1', makePayload());
      await writeSession(
        'expense-tracking',
        'sess_2',
        makePayload({ sessionId: 'sess_2' }),
      );

      await clearSession('trip-planning');

      expect(await readSession('trip-planning')).toBeNull();
      expect(await readSession('expense-tracking')).not.toBeNull();
    });
  });

  // --- TTL enforcement (AC-5) ---

  describe('TTL enforcement', () => {
    it('returns null for expired sessions', async () => {
      await writeSession('trip-planning', 'sess_expired', makePayload());
      mockRedis._expireKey('session:trip-planning:sess_expired');

      const result = await readSession('trip-planning');
      expect(result).toBeNull();
    });
  });

  // --- Session expiry (REQ-6.8.8) ---

  describe('session expiry handling', () => {
    it('treats missing session as fresh conversation', async () => {
      // No session written -- readSession should return null (not error)
      const result = await readSession('nonexistent-group');
      expect(result).toBeNull();
    });
  });

  // --- Multiple sessions cleanup (REQ-6.8.3) ---

  describe('multiple session cleanup', () => {
    it('selects most recent by updatedAt and deletes stale', async () => {
      const older = makePayload({
        sessionId: 'sess_old',
        updatedAt: '2026-03-08T09:00:00.000Z',
      });
      const newer = makePayload({
        sessionId: 'sess_new',
        updatedAt: '2026-03-08T10:30:00.000Z',
      });

      await writeSession('trip-planning', 'sess_old', older);
      await writeSession('trip-planning', 'sess_new', newer);

      const result = await readSession('trip-planning');
      expect(result!.sessionId).toBe('sess_new');
      expect(result!.updatedAt).toBe('2026-03-08T10:30:00.000Z');

      // Stale key should be deleted
      const raw = await mockRedis.get('session:trip-planning:sess_old');
      expect(raw).toBeNull();
    });
  });

  // --- Corrupt payload handling ---

  describe('corrupt payload handling', () => {
    it('deletes corrupt key and returns null', async () => {
      // Write garbage directly
      await mockRedis.set('session:trip-planning:sess_corrupt', 'not-json');

      const result = await readSession('trip-planning');
      expect(result).toBeNull();

      // Key should have been deleted
      const raw = await mockRedis.get('session:trip-planning:sess_corrupt');
      expect(raw).toBeNull();
    });
  });

  // --- Graceful degradation (AC-2) ---

  describe('graceful degradation when Redis unavailable', () => {
    it('readSession returns null when redis unavailable', async () => {
      _setRedisForTest(null, false);

      const result = await readSession('trip-planning');
      expect(result).toBeNull();
    });

    it('writeSession silently succeeds when redis unavailable', async () => {
      _setRedisForTest(null, false);

      // Should not throw
      await writeSession('trip-planning', 'sess_1', makePayload());
    });

    it('clearSession logs warning when redis unavailable', async () => {
      _setRedisForTest(null, false);

      // Should not throw
      await clearSession('trip-planning');
    });

    it('isRedisAvailable returns false when disconnected', () => {
      _setRedisForTest(null, false);
      expect(isRedisAvailable()).toBe(false);
    });
  });

  // --- Payload truncation (NFR-MEM-3, AC-10) ---

  describe('payload size cap', () => {
    it('truncates conversation history when payload exceeds 1MB', async () => {
      // Build a payload with very large conversation history
      const largeTurn = 'x'.repeat(100_000);
      const turns = Array.from(
        { length: 15 },
        (_, i) => `Turn ${i}: ${largeTurn}`,
      ).join('\n---\n');

      const payload = makePayload({ conversationHistory: turns });
      await writeSession('trip-planning', 'sess_large', payload);

      const result = await readSession('trip-planning');
      expect(result).not.toBeNull();
      // After truncation, should have at most 10 turns
      const turnCount = result!.conversationHistory.split('\n---\n').length;
      expect(turnCount).toBeLessThanOrEqual(11); // 10 turns + possible prior context note
    });
  });
});
