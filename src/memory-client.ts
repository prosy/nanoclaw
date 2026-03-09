/**
 * Memory Client for NanoClaw
 * Redis-backed session storage with graceful degradation to flat-file.
 * Implements REQ-6.8.1 through REQ-6.8.9 from memory-mvp-redis.md.
 */
import { Redis } from 'ioredis';
type RedisClient = Redis;

import { REDIS_URL, SESSION_TTL_SECONDS } from './config.js';
import { logger } from './logger.js';

// --- Types (REQ-6.8.2) ---

export interface SkillRecord {
  requestId: string;
  skillName: string;
  timestamp: string;
  status: 'success' | 'error';
  resultSummary: string;
}

export interface SessionPayload {
  sessionId: string;
  groupFolder: string;
  conversationHistory: string;
  skillInvocations: SkillRecord[];
  agentNotes: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
}

// --- Singleton client (REQ-6.8.1) ---

let redis: RedisClient | null = null;
let redisAvailable = false;

/**
 * Redact password from Redis URL for logging.
 */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Build the Redis key for a group+session pair (REQ-6.8.2, REQ-6.8.6).
 * All operations require groupFolder -- no cross-group access is possible.
 */
function sessionKey(groupFolder: string, sessionId: string): string {
  return `session:${groupFolder}:${sessionId}`;
}

/**
 * Build the scan pattern for all sessions in a group (REQ-6.8.6).
 * Only group-scoped patterns are permitted -- never `session:*`.
 */
function groupKeyPattern(groupFolder: string): string {
  return `session:${groupFolder}:*`;
}

/**
 * Initialize the Redis connection singleton (REQ-6.8.1).
 * Call once at startup. Non-blocking -- startup continues if Redis is down.
 */
export function initRedis(): void {
  const url = REDIS_URL;

  try {
    redis = new Redis(url, {
      maxRetriesPerRequest: null, // ioredis default for reconnection
      retryStrategy(times: number) {
        // Exponential backoff: 500ms, 1s, 2s, ... capped at 30s (REQ-6.8.1)
        const delay = Math.min(500 * Math.pow(2, times - 1), 30000);
        return delay;
      },
      lazyConnect: true, // Connect explicitly so we can catch errors
    });

    redis.on('connect', () => {
      redisAvailable = true;
      logger.info(`[MEMORY] Redis connected: ${redactUrl(url)}`);
    });

    redis.on('error', (err: Error) => {
      if (redisAvailable) {
        logger.warn({ err }, '[MEMORY-WARN] Redis connection lost, reconnecting');
      }
      redisAvailable = false;
    });

    redis.on('reconnecting', () => {
      logger.debug('[MEMORY] Redis reconnecting...');
    });

    redis.on('ready', () => {
      if (!redisAvailable) {
        logger.info('[MEMORY] Redis reconnected, resuming Redis-backed sessions');
      }
      redisAvailable = true;
    });

    // Attempt initial connection (REQ-6.8.1)
    redis.connect().catch((err: Error) => {
      redisAvailable = false;
      logger.warn(
        { err },
        `[MEMORY] Redis connection failed: ${err.message}, falling back to flat-file sessions`,
      );
    });
  } catch (err) {
    redisAvailable = false;
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[MEMORY-ERROR] Invalid REDIS_URL: ${url}, ${message}`);
  }
}

/**
 * Check if Redis is currently available (REQ-6.8.7).
 */
export function isRedisAvailable(): boolean {
  return redisAvailable && redis !== null && redis.status === 'ready';
}

/**
 * Read the active session for a group (REQ-6.8.3).
 *
 * If multiple session keys exist, selects the most recent by updatedAt
 * and deletes stale ones. Returns null if no session exists or Redis
 * is unavailable.
 */
export async function readSession(
  groupFolder: string,
): Promise<SessionPayload | null> {
  if (!isRedisAvailable() || !redis) {
    return null;
  }

  const startMs = Date.now();

  try {
    // Find all session keys for this group (REQ-6.8.3, REQ-6.8.6)
    const keys = await redis.keys(groupKeyPattern(groupFolder));

    if (keys.length === 0) {
      return null;
    }

    if (keys.length === 1) {
      const raw = await redis.get(keys[0]);
      const elapsed = Date.now() - startMs;
      if (elapsed > 50) {
        logger.warn(`[MEMORY-WARN] Session read latency ${elapsed}ms for group ${groupFolder}`);
      }
      if (!raw) return null;
      try {
        return JSON.parse(raw) as SessionPayload;
      } catch {
        // Corrupt payload (REQ-6.8.3 failure mode)
        logger.error(`[MEMORY-ERROR] Corrupt session payload for group ${groupFolder}, starting fresh`);
        await redis.del(keys[0]);
        return null;
      }
    }

    // Multiple keys: select most recent, delete stale (REQ-6.8.3)
    const payloads: Array<{ key: string; payload: SessionPayload }> = [];
    for (const key of keys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      try {
        payloads.push({ key, payload: JSON.parse(raw) as SessionPayload });
      } catch {
        await redis.del(key);
      }
    }

    if (payloads.length === 0) return null;

    payloads.sort((a, b) =>
      b.payload.updatedAt.localeCompare(a.payload.updatedAt),
    );

    const best = payloads[0];
    const staleKeys = payloads.slice(1).map((p) => p.key);
    if (staleKeys.length > 0) {
      await redis.del(...staleKeys);
      logger.info(`[MEMORY] Cleaned ${staleKeys.length} stale session keys for group ${groupFolder}`);
    }

    const elapsed = Date.now() - startMs;
    if (elapsed > 50) {
      logger.warn(`[MEMORY-WARN] Session read latency ${elapsed}ms for group ${groupFolder}`);
    }

    return best.payload;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[MEMORY-WARN] Session read failed for group ${groupFolder}: ${message}`);
    return null;
  }
}

/**
 * Summarize text if it exceeds a character limit.
 */
function truncateHistory(history: string, maxTurns: number): string {
  // Split by turn markers and keep only the most recent
  const turns = history.split('\n---\n');
  if (turns.length <= maxTurns) return history;

  const kept = turns.slice(-maxTurns);
  return `[Prior context: ${turns.length - maxTurns} earlier turns summarized]\n---\n${kept.join('\n---\n')}`;
}

/**
 * Write session data to Redis (REQ-6.8.4).
 * Non-blocking: returns a Promise that callers should NOT await on the
 * response path (NFR-MEM-2).
 */
export async function writeSession(
  groupFolder: string,
  sessionId: string,
  payload: SessionPayload,
): Promise<void> {
  if (!isRedisAvailable() || !redis) {
    return;
  }

  try {
    // Enforce 1MB cap with turn truncation (NFR-MEM-3)
    const serialized = JSON.stringify(payload);
    if (serialized.length > 1_000_000) {
      payload.conversationHistory = truncateHistory(
        payload.conversationHistory,
        10,
      );
      logger.warn(`[MEMORY-WARN] Session payload truncated for ${sessionId}, keeping last 10 turns`);
    }

    const key = sessionKey(groupFolder, sessionId);
    const data = JSON.stringify(payload);
    await redis.set(key, data, 'EX', SESSION_TTL_SECONDS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[MEMORY-WARN] Session write failed for ${sessionId}: ${message}`);
  }
}

/**
 * Delete all session keys for a group (REQ-6.8.9).
 */
export async function clearSession(groupFolder: string): Promise<void> {
  if (!isRedisAvailable() || !redis) {
    logger.warn(`[MEMORY-WARN] Session clear requested for group ${groupFolder} but Redis unavailable`);
    return;
  }

  try {
    const keys = await redis.keys(groupKeyPattern(groupFolder));
    if (keys.length === 0) {
      logger.info(`[MEMORY] Session clear requested for group ${groupFolder}, no active session found`);
      return;
    }
    await redis.del(...keys);
    logger.info(`[MEMORY] Session cleared for group ${groupFolder} via IPC`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[MEMORY-WARN] Session clear failed for group ${groupFolder}: ${message}`);
  }
}

/**
 * Disconnect the Redis client. Call on process shutdown.
 */
export async function disconnectRedis(): Promise<void> {
  if (redis) {
    await redis.quit().catch(() => {});
    redis = null;
    redisAvailable = false;
  }
}

// --- Test helpers ---

/** @internal - for tests only. Override the redis instance and availability flag. */
export function _setRedisForTest(client: RedisClient | null, available: boolean): void {
  redis = client;
  redisAvailable = available;
}
