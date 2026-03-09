import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'SKILLS_DIR',
  'REDIS_URL',
  'SESSION_TTL_SECONDS',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Path to the travel-aw-skills checkout (required for skill IPC).
// When unset, skill requests return SKILL_NOT_FOUND errors.
export const SKILLS_DIR = process.env.SKILLS_DIR || envConfig.SKILLS_DIR || '';

// --- Memory / Redis config (REQ-6.8.1, REQ-6.8.2) ---

export const REDIS_URL =
  process.env.REDIS_URL || envConfig.REDIS_URL || 'redis://localhost:6379';

/**
 * Session TTL in seconds. Default 7200 (2 hours).
 * Clamped to [3600, 10800] per REQ-6.8.2.
 */
function parseSessionTtl(): number {
  const raw = process.env.SESSION_TTL_SECONDS || envConfig.SESSION_TTL_SECONDS;
  if (!raw) return 7200;

  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    console.warn(
      '[MEMORY-WARN] SESSION_TTL_SECONDS is not a number, using default 7200',
    );
    return 7200;
  }

  if (parsed < 3600) {
    console.warn(
      `[MEMORY-WARN] SESSION_TTL_SECONDS=${parsed} below minimum, clamping to 3600`,
    );
    return 3600;
  }
  if (parsed > 10800) {
    console.warn(
      `[MEMORY-WARN] SESSION_TTL_SECONDS=${parsed} above maximum, clamping to 10800`,
    );
    return 10800;
  }

  return parsed;
}

export const SESSION_TTL_SECONDS = parseSessionTtl();
