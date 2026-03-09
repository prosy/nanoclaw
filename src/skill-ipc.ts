/**
 * Skill IPC — host-side watcher for skill invocation requests (DD-33, REQ-6.3).
 *
 * Agent containers write JSON requests to skill-requests/ and poll skill-results/.
 * This module processes those requests by calling SkillRunner and writing results.
 *
 * A21 limits are enforced at the host level:
 *   CHAIN-01: max 5 skills per turn
 *   CHAIN-02: max 15 skills per session
 *   CHAIN-03: max 3 concurrent skill executions (global)
 *   TIME-01:  max 30s per skill execution
 */

import fs from 'fs';
import path from 'path';

import { SKILLS_DIR } from './config.js';
import { logger } from './logger.js';
import type {
  SkillCounters,
  SkillErrorCode,
  SkillRequest,
  SkillResult,
} from './types.js';

// A21 limits
const CHAIN_01_MAX_PER_TURN = 5;
const CHAIN_02_MAX_PER_SESSION = 15;
const CHAIN_03_MAX_CONCURRENT = 3;
const TIME_01_TIMEOUT_SECONDS = 30;

// Global concurrent execution counter
let concurrentExecutions = 0;

// Per-group counters: groupFolder -> SkillCounters
const groupCounters = new Map<string, SkillCounters>();

/**
 * Get or create counters for a group.
 */
export function getCounters(groupFolder: string): SkillCounters {
  let counters = groupCounters.get(groupFolder);
  if (!counters) {
    counters = { turnCount: 0, sessionCount: 0 };
    groupCounters.set(groupFolder, counters);
  }
  return counters;
}

/**
 * Reset turn counter for a group (called when container exits or new turn begins).
 */
export function resetTurnCounter(groupFolder: string): void {
  const counters = groupCounters.get(groupFolder);
  if (counters) {
    counters.turnCount = 0;
  }
}

/**
 * Reset all counters for a group (called on session end).
 */
export function resetSessionCounters(groupFolder: string): void {
  groupCounters.delete(groupFolder);
}

/**
 * Reset all counters (called on host restart).
 */
export function resetAllCounters(): void {
  if (groupCounters.size > 0) {
    logger.info('[A21] Skill counters reset due to host restart');
  }
  groupCounters.clear();
  concurrentExecutions = 0;
}

/**
 * Validate a skill request has all required fields.
 */
export function validateRequest(
  data: unknown,
): { valid: true; request: SkillRequest } | { valid: false; error: string } {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Request is not a valid JSON object' };
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj.requestId !== 'string' || !obj.requestId) {
    return { valid: false, error: 'Missing or invalid requestId' };
  }

  if (typeof obj.skillName !== 'string' || !obj.skillName) {
    return { valid: false, error: 'Missing or invalid skillName' };
  }

  if (!obj.input || typeof obj.input !== 'object') {
    return { valid: false, error: 'Missing or invalid input' };
  }

  const input = obj.input as Record<string, unknown>;
  if (typeof input.skillDir !== 'string') {
    return { valid: false, error: 'Missing or invalid input.skillDir' };
  }

  if (!input.data || typeof input.data !== 'object') {
    return { valid: false, error: 'Missing or invalid input.data' };
  }

  if (typeof obj.timestamp !== 'string') {
    return { valid: false, error: 'Missing or invalid timestamp' };
  }

  return {
    valid: true,
    request: {
      requestId: obj.requestId as string,
      skillName: obj.skillName as string,
      input: {
        skillDir: input.skillDir as string,
        data: input.data as Record<string, unknown>,
      },
      timestamp: obj.timestamp as string,
    },
  };
}

/**
 * Check A21 chain limits before executing a skill.
 * Returns null if within limits, or an error code and message if exceeded.
 */
export function checkChainLimits(
  groupFolder: string,
): { code: SkillErrorCode; message: string } | null {
  const counters = getCounters(groupFolder);

  if (counters.turnCount >= CHAIN_01_MAX_PER_TURN) {
    return {
      code: 'CHAIN_LIMIT_EXCEEDED',
      message: `Reached skill limit for this turn (CHAIN-01: max ${CHAIN_01_MAX_PER_TURN} per turn)`,
    };
  }

  if (counters.sessionCount >= CHAIN_02_MAX_PER_SESSION) {
    return {
      code: 'CHAIN_LIMIT_EXCEEDED',
      message: `Reached skill limit for this session (CHAIN-02: max ${CHAIN_02_MAX_PER_SESSION} per session)`,
    };
  }

  if (concurrentExecutions >= CHAIN_03_MAX_CONCURRENT) {
    return {
      code: 'CONCURRENT_LIMIT',
      message: `Too many concurrent skill executions (CHAIN-03: max ${CHAIN_03_MAX_CONCURRENT})`,
    };
  }

  return null;
}

/**
 * Resolve skill directory path from skill name.
 * Returns null if the skill does not exist or SKILLS_DIR is not configured.
 */
export function resolveSkillDir(skillName: string): string | null {
  if (!SKILLS_DIR) {
    return null;
  }

  // Prevent path traversal
  if (
    skillName.includes('/') ||
    skillName.includes('\\') ||
    skillName.includes('..')
  ) {
    return null;
  }

  const skillDir = path.join(SKILLS_DIR, skillName);
  try {
    const stat = fs.statSync(skillDir);
    if (!stat.isDirectory()) return null;
    return skillDir;
  } catch {
    return null;
  }
}

/**
 * Build an error result object.
 */
export function buildErrorResult(
  requestId: string,
  code: SkillErrorCode,
  message: string,
  durationMs: number,
): SkillResult {
  return {
    requestId,
    status: 'error',
    error: { code, message },
    durationMs,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Build a success result object.
 */
export function buildSuccessResult(
  requestId: string,
  output: SkillResult['output'],
  durationMs: number,
): SkillResult {
  return {
    requestId,
    status: 'success',
    output,
    durationMs,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Execute a skill via the SkillRunner adapter.
 * This is the integration point -- the actual SkillRunner import is lazy-loaded
 * so the module works even when @travel/skill-runner is not available.
 */
export type SkillExecutor = (
  input: { skillDir: string; data: Record<string, unknown> },
  config: { timeoutSeconds: number },
) => Promise<{
  success: boolean;
  data: Record<string, unknown>;
  metadata: {
    skillName: string;
    skillVersion: string;
    containerId: string;
    durationMs: number;
    exitCode: number;
  };
}>;

let skillExecutor: SkillExecutor | null = null;
let skillRunnerAvailable: boolean | null = null;

/**
 * Set a custom skill executor (for testing or custom integrations).
 */
export function setSkillExecutor(executor: SkillExecutor | null): void {
  skillExecutor = executor;
  skillRunnerAvailable = executor !== null;
}

/**
 * Try to load the SkillRunner. Returns null if not available.
 */
function getSkillExecutor(): SkillExecutor | null {
  if (skillRunnerAvailable === false) return null;
  if (skillExecutor) return skillExecutor;

  // SkillRunner is not bundled with NanoClaw -- it comes from the travel_web
  // monorepo. When unavailable, all skill requests get SKILL_NOT_FOUND errors.
  logger.warn(
    '[SKILL-IPC] SkillRunner not available — set a skill executor via setSkillExecutor()',
  );
  skillRunnerAvailable = false;
  return null;
}

/**
 * Process a single skill request file.
 */
export async function processSkillRequest(
  filePath: string,
  groupFolder: string,
  resultsDir: string,
  errorsDir: string,
): Promise<void> {
  const startTime = Date.now();
  const fileName = path.basename(filePath);
  let requestId = 'unknown';

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.error(
        { file: fileName, groupFolder },
        'Malformed JSON in skill request',
      );
      fs.mkdirSync(errorsDir, { recursive: true });
      fs.renameSync(
        filePath,
        path.join(errorsDir, `${groupFolder}-${fileName}`),
      );
      return;
    }

    const validation = validateRequest(parsed);
    if (!validation.valid) {
      logger.warn(
        { file: fileName, groupFolder, error: validation.error },
        'Invalid skill request',
      );
      // Try to extract requestId for the error result
      if (parsed && typeof parsed === 'object' && 'requestId' in parsed) {
        requestId = String((parsed as Record<string, unknown>).requestId);
      }
      const result = buildErrorResult(
        requestId,
        'INVALID_INPUT',
        validation.error,
        Date.now() - startTime,
      );
      fs.writeFileSync(
        path.join(resultsDir, `${requestId}.json`),
        JSON.stringify(result, null, 2),
      );
      fs.unlinkSync(filePath);
      return;
    }

    const request = validation.request;
    requestId = request.requestId;

    // Check A21 chain limits
    const limitError = checkChainLimits(groupFolder);
    if (limitError) {
      logger.warn(
        { requestId, groupFolder, code: limitError.code },
        'Skill request rejected by A21 limits',
      );
      const result = buildErrorResult(
        requestId,
        limitError.code,
        limitError.message,
        Date.now() - startTime,
      );
      fs.writeFileSync(
        path.join(resultsDir, `${requestId}.json`),
        JSON.stringify(result, null, 2),
      );
      fs.unlinkSync(filePath);
      return;
    }

    // Resolve skill directory
    const skillDir = resolveSkillDir(request.skillName);
    if (!skillDir) {
      logger.warn(
        { requestId, skillName: request.skillName, groupFolder },
        'Skill not found',
      );
      const result = buildErrorResult(
        requestId,
        'SKILL_NOT_FOUND',
        `Skill "${request.skillName}" not found in SKILLS_DIR`,
        Date.now() - startTime,
      );
      fs.writeFileSync(
        path.join(resultsDir, `${requestId}.json`),
        JSON.stringify(result, null, 2),
      );
      fs.unlinkSync(filePath);
      return;
    }

    // Get executor
    const executor = getSkillExecutor();
    if (!executor) {
      const result = buildErrorResult(
        requestId,
        'SKILL_NOT_FOUND',
        'SkillRunner not available',
        Date.now() - startTime,
      );
      fs.writeFileSync(
        path.join(resultsDir, `${requestId}.json`),
        JSON.stringify(result, null, 2),
      );
      fs.unlinkSync(filePath);
      return;
    }

    // Increment counters before execution
    const counters = getCounters(groupFolder);
    counters.turnCount++;
    counters.sessionCount++;
    concurrentExecutions++;

    try {
      const output = await executor(
        { skillDir, data: request.input.data },
        { timeoutSeconds: TIME_01_TIMEOUT_SECONDS },
      );

      const result = buildSuccessResult(
        requestId,
        output,
        Date.now() - startTime,
      );
      fs.writeFileSync(
        path.join(resultsDir, `${requestId}.json`),
        JSON.stringify(result, null, 2),
      );

      logger.info(
        {
          requestId,
          skillName: request.skillName,
          groupFolder,
          durationMs: result.durationMs,
        },
        'Skill executed successfully',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = message.toLowerCase().includes('timeout');
      const code: SkillErrorCode = isTimeout
        ? 'SKILL_TIMEOUT'
        : 'SKILL_EXECUTION_ERROR';
      const errorMessage = isTimeout
        ? `Skill execution exceeded ${TIME_01_TIMEOUT_SECONDS}s limit (TIME-01)`
        : `Skill execution failed: ${message}`;

      const result = buildErrorResult(
        requestId,
        code,
        errorMessage,
        Date.now() - startTime,
      );
      fs.writeFileSync(
        path.join(resultsDir, `${requestId}.json`),
        JSON.stringify(result, null, 2),
      );

      logger.error(
        {
          requestId,
          skillName: request.skillName,
          groupFolder,
          error: message,
        },
        'Skill execution failed',
      );
    } finally {
      concurrentExecutions = Math.max(0, concurrentExecutions - 1);
    }

    // Delete the processed request file
    fs.unlinkSync(filePath);
  } catch (err) {
    logger.error(
      { file: fileName, groupFolder, err },
      'Error processing skill request',
    );
    try {
      fs.mkdirSync(errorsDir, { recursive: true });
      if (fs.existsSync(filePath)) {
        fs.renameSync(
          filePath,
          path.join(errorsDir, `${groupFolder}-${fileName}`),
        );
      }
    } catch (moveErr) {
      logger.error(
        { file: fileName, moveErr },
        'Failed to move skill request to errors',
      );
    }
  }
}

/**
 * Process all pending skill requests for a group.
 * Called from the IPC watcher alongside message and task processing.
 */
export async function processSkillRequests(
  ipcBaseDir: string,
  groupFolder: string,
): Promise<void> {
  const requestsDir = path.join(ipcBaseDir, groupFolder, 'skill-requests');
  const resultsDir = path.join(ipcBaseDir, groupFolder, 'skill-results');
  const errorsDir = path.join(ipcBaseDir, 'errors');

  try {
    if (!fs.existsSync(requestsDir)) return;

    const files = fs
      .readdirSync(requestsDir)
      .filter((f) => f.endsWith('.json'));
    if (files.length === 0) return;

    // Ensure results directory exists
    fs.mkdirSync(resultsDir, { recursive: true });

    // Process sequentially within a group (REQ-6.3.4)
    for (const file of files) {
      await processSkillRequest(
        path.join(requestsDir, file),
        groupFolder,
        resultsDir,
        errorsDir,
      );
    }
  } catch (err) {
    logger.error(
      { err, groupFolder },
      'Error reading skill-requests directory',
    );
  }
}

// Export for testing
export function _getConcurrentExecutions(): number {
  return concurrentExecutions;
}

export function _setConcurrentExecutions(n: number): void {
  concurrentExecutions = n;
}
