import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock config before importing skill-ipc
vi.mock('./config.js', () => ({
  SKILLS_DIR: '/tmp/test-skills',
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IPC_POLL_INTERVAL: 1000,
  MAIN_GROUP_FOLDER: 'main',
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  validateRequest,
  checkChainLimits,
  resolveSkillDir,
  buildErrorResult,
  buildSuccessResult,
  processSkillRequest,
  processSkillRequests,
  getCounters,
  resetTurnCounter,
  resetSessionCounters,
  resetAllCounters,
  setSkillExecutor,
  _getConcurrentExecutions,
  _setConcurrentExecutions,
} from './skill-ipc.js';

describe('skill-ipc', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-ipc-test-'));
    resetAllCounters();
    setSkillExecutor(null);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('validateRequest', () => {
    it('accepts a valid request', () => {
      const result = validateRequest({
        requestId: 'sr-1709913600-a1b2c3',
        skillName: 'flight-search',
        input: {
          skillDir: '/skills/flight-search',
          data: { origin: 'LAX', destination: 'NRT' },
        },
        timestamp: '2026-03-08T12:00:00Z',
      });
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.request.requestId).toBe('sr-1709913600-a1b2c3');
        expect(result.request.skillName).toBe('flight-search');
      }
    });

    it('rejects null input', () => {
      const result = validateRequest(null);
      expect(result.valid).toBe(false);
    });

    it('rejects missing requestId', () => {
      const result = validateRequest({
        skillName: 'flight-search',
        input: { skillDir: '/skills/flight-search', data: {} },
        timestamp: '2026-03-08T12:00:00Z',
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('requestId');
      }
    });

    it('rejects missing skillName', () => {
      const result = validateRequest({
        requestId: 'sr-123-abc',
        input: { skillDir: '/skills/flight-search', data: {} },
        timestamp: '2026-03-08T12:00:00Z',
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('skillName');
      }
    });

    it('rejects missing input', () => {
      const result = validateRequest({
        requestId: 'sr-123-abc',
        skillName: 'flight-search',
        timestamp: '2026-03-08T12:00:00Z',
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('input');
      }
    });

    it('rejects missing input.data', () => {
      const result = validateRequest({
        requestId: 'sr-123-abc',
        skillName: 'flight-search',
        input: { skillDir: '/skills/flight-search' },
        timestamp: '2026-03-08T12:00:00Z',
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('input.data');
      }
    });

    it('rejects missing timestamp', () => {
      const result = validateRequest({
        requestId: 'sr-123-abc',
        skillName: 'flight-search',
        input: { skillDir: '/skills/flight-search', data: {} },
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain('timestamp');
      }
    });
  });

  describe('checkChainLimits', () => {
    it('allows first skill invocation', () => {
      const result = checkChainLimits('test-group');
      expect(result).toBeNull();
    });

    it('allows up to 5 skills per turn (CHAIN-01)', () => {
      const counters = getCounters('test-group');
      counters.turnCount = 4;
      counters.sessionCount = 4;
      expect(checkChainLimits('test-group')).toBeNull();
    });

    it('rejects 6th skill in turn (CHAIN-01)', () => {
      const counters = getCounters('test-group');
      counters.turnCount = 5;
      counters.sessionCount = 5;
      const result = checkChainLimits('test-group');
      expect(result).not.toBeNull();
      expect(result!.code).toBe('CHAIN_LIMIT_EXCEEDED');
      expect(result!.message).toContain('CHAIN-01');
    });

    it('rejects 16th skill in session (CHAIN-02)', () => {
      const counters = getCounters('test-group');
      counters.turnCount = 0; // new turn
      counters.sessionCount = 15;
      const result = checkChainLimits('test-group');
      expect(result).not.toBeNull();
      expect(result!.code).toBe('CHAIN_LIMIT_EXCEEDED');
      expect(result!.message).toContain('CHAIN-02');
    });

    it('rejects when concurrent limit reached (CHAIN-03)', () => {
      _setConcurrentExecutions(3);
      const result = checkChainLimits('test-group');
      expect(result).not.toBeNull();
      expect(result!.code).toBe('CONCURRENT_LIMIT');
      expect(result!.message).toContain('CHAIN-03');
    });

    it('allows at 2 concurrent (under CHAIN-03 limit)', () => {
      _setConcurrentExecutions(2);
      expect(checkChainLimits('test-group')).toBeNull();
    });
  });

  describe('counter management', () => {
    it('resets turn counter', () => {
      const counters = getCounters('test-group');
      counters.turnCount = 4;
      counters.sessionCount = 8;
      resetTurnCounter('test-group');
      expect(getCounters('test-group').turnCount).toBe(0);
      expect(getCounters('test-group').sessionCount).toBe(8);
    });

    it('resets session counters', () => {
      const counters = getCounters('test-group');
      counters.turnCount = 4;
      counters.sessionCount = 12;
      resetSessionCounters('test-group');
      // After reset, getCounters creates fresh counters
      expect(getCounters('test-group').turnCount).toBe(0);
      expect(getCounters('test-group').sessionCount).toBe(0);
    });

    it('resets all counters', () => {
      getCounters('group-a').turnCount = 3;
      getCounters('group-b').sessionCount = 10;
      _setConcurrentExecutions(2);
      resetAllCounters();
      expect(getCounters('group-a').turnCount).toBe(0);
      expect(getCounters('group-b').sessionCount).toBe(0);
      expect(_getConcurrentExecutions()).toBe(0);
    });
  });

  describe('resolveSkillDir', () => {
    it('returns null for path traversal attempts', () => {
      expect(resolveSkillDir('../etc/passwd')).toBeNull();
      expect(resolveSkillDir('skill/../../etc')).toBeNull();
      expect(resolveSkillDir('skill\\..\\etc')).toBeNull();
    });

    it('returns null when skill directory does not exist', () => {
      expect(resolveSkillDir('nonexistent-skill')).toBeNull();
    });

    it('returns the path when skill directory exists', () => {
      const skillDir = path.join(tmpDir, 'test-skill');
      fs.mkdirSync(skillDir);

      // We need to temporarily override the module's SKILLS_DIR check
      // Since SKILLS_DIR is mocked to /tmp/test-skills, create the dir there
      const testSkillsDir = '/tmp/test-skills';
      const testSkill = path.join(testSkillsDir, 'flight-search');
      fs.mkdirSync(testSkill, { recursive: true });

      try {
        const result = resolveSkillDir('flight-search');
        expect(result).toBe(testSkill);
      } finally {
        fs.rmSync(testSkillsDir, { recursive: true, force: true });
      }
    });
  });

  describe('buildErrorResult', () => {
    it('builds an error result with correct structure', () => {
      const result = buildErrorResult('sr-123-abc', 'SKILL_TIMEOUT', 'Timed out', 5000);
      expect(result.requestId).toBe('sr-123-abc');
      expect(result.status).toBe('error');
      expect(result.error!.code).toBe('SKILL_TIMEOUT');
      expect(result.error!.message).toBe('Timed out');
      expect(result.durationMs).toBe(5000);
      expect(result.timestamp).toBeTruthy();
    });
  });

  describe('buildSuccessResult', () => {
    it('builds a success result with correct structure', () => {
      const output = {
        success: true,
        data: { flights: [] },
        metadata: {
          skillName: 'flight-search',
          skillVersion: '1.0.0',
          containerId: 'abc123',
          durationMs: 2340,
          exitCode: 0,
        },
      };
      const result = buildSuccessResult('sr-123-abc', output, 2355);
      expect(result.requestId).toBe('sr-123-abc');
      expect(result.status).toBe('success');
      expect(result.output).toEqual(output);
      expect(result.durationMs).toBe(2355);
    });
  });

  describe('processSkillRequest', () => {
    let requestsDir: string;
    let resultsDir: string;
    let errorsDir: string;

    beforeEach(() => {
      requestsDir = path.join(tmpDir, 'skill-requests');
      resultsDir = path.join(tmpDir, 'skill-results');
      errorsDir = path.join(tmpDir, 'errors');
      fs.mkdirSync(requestsDir, { recursive: true });
      fs.mkdirSync(resultsDir, { recursive: true });
    });

    it('moves malformed JSON to errors directory', async () => {
      const filePath = path.join(requestsDir, 'bad-request.json');
      fs.writeFileSync(filePath, 'not valid json {{{');

      await processSkillRequest(filePath, 'test-group', resultsDir, errorsDir);

      expect(fs.existsSync(filePath)).toBe(false);
      expect(fs.existsSync(path.join(errorsDir, 'test-group-bad-request.json'))).toBe(true);
    });

    it('writes INVALID_INPUT error for missing fields', async () => {
      const filePath = path.join(requestsDir, 'sr-123-abc.json');
      fs.writeFileSync(filePath, JSON.stringify({
        requestId: 'sr-123-abc',
        // missing skillName, input, timestamp
      }));

      await processSkillRequest(filePath, 'test-group', resultsDir, errorsDir);

      expect(fs.existsSync(filePath)).toBe(false);
      const resultFile = path.join(resultsDir, 'sr-123-abc.json');
      expect(fs.existsSync(resultFile)).toBe(true);
      const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
      expect(result.status).toBe('error');
      expect(result.error.code).toBe('INVALID_INPUT');
    });

    it('enforces CHAIN-01 limit', async () => {
      const counters = getCounters('test-group');
      counters.turnCount = 5;
      counters.sessionCount = 5;

      const filePath = path.join(requestsDir, 'sr-123-abc.json');
      fs.writeFileSync(filePath, JSON.stringify({
        requestId: 'sr-123-abc',
        skillName: 'flight-search',
        input: { skillDir: '/skills/flight-search', data: {} },
        timestamp: '2026-03-08T12:00:00Z',
      }));

      await processSkillRequest(filePath, 'test-group', resultsDir, errorsDir);

      const resultFile = path.join(resultsDir, 'sr-123-abc.json');
      const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
      expect(result.status).toBe('error');
      expect(result.error.code).toBe('CHAIN_LIMIT_EXCEEDED');
      expect(result.error.message).toContain('CHAIN-01');
    });

    it('writes SKILL_NOT_FOUND for unknown skills', async () => {
      const filePath = path.join(requestsDir, 'sr-123-abc.json');
      fs.writeFileSync(filePath, JSON.stringify({
        requestId: 'sr-123-abc',
        skillName: 'nonexistent-skill',
        input: { skillDir: '/skills/nonexistent', data: {} },
        timestamp: '2026-03-08T12:00:00Z',
      }));

      await processSkillRequest(filePath, 'test-group', resultsDir, errorsDir);

      const resultFile = path.join(resultsDir, 'sr-123-abc.json');
      const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
      expect(result.status).toBe('error');
      expect(result.error.code).toBe('SKILL_NOT_FOUND');
    });

    it('executes skill and writes success result', async () => {
      // Create a mock skill directory
      const skillDir = '/tmp/test-skills/flight-search';
      fs.mkdirSync(skillDir, { recursive: true });

      const mockOutput = {
        success: true,
        data: { flights: [{ price: 500 }] },
        metadata: {
          skillName: 'flight-search',
          skillVersion: '1.0.0',
          containerId: 'abc123',
          durationMs: 2340,
          exitCode: 0,
        },
      };

      setSkillExecutor(async () => mockOutput);

      const filePath = path.join(requestsDir, 'sr-123-abc.json');
      fs.writeFileSync(filePath, JSON.stringify({
        requestId: 'sr-123-abc',
        skillName: 'flight-search',
        input: { skillDir: '/skills/flight-search', data: { origin: 'LAX' } },
        timestamp: '2026-03-08T12:00:00Z',
      }));

      await processSkillRequest(filePath, 'test-group', resultsDir, errorsDir);

      // Request file should be deleted
      expect(fs.existsSync(filePath)).toBe(false);

      // Result file should exist
      const resultFile = path.join(resultsDir, 'sr-123-abc.json');
      expect(fs.existsSync(resultFile)).toBe(true);
      const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
      expect(result.status).toBe('success');
      expect(result.output.data.flights).toHaveLength(1);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      // Counters should be incremented
      const counters = getCounters('test-group');
      expect(counters.turnCount).toBe(1);
      expect(counters.sessionCount).toBe(1);

      fs.rmSync('/tmp/test-skills', { recursive: true, force: true });
    });

    it('handles skill execution error', async () => {
      const skillDir = '/tmp/test-skills/flight-search';
      fs.mkdirSync(skillDir, { recursive: true });

      setSkillExecutor(async () => {
        throw new Error('Docker container failed');
      });

      const filePath = path.join(requestsDir, 'sr-123-abc.json');
      fs.writeFileSync(filePath, JSON.stringify({
        requestId: 'sr-123-abc',
        skillName: 'flight-search',
        input: { skillDir: '/skills/flight-search', data: {} },
        timestamp: '2026-03-08T12:00:00Z',
      }));

      await processSkillRequest(filePath, 'test-group', resultsDir, errorsDir);

      const resultFile = path.join(resultsDir, 'sr-123-abc.json');
      const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
      expect(result.status).toBe('error');
      expect(result.error.code).toBe('SKILL_EXECUTION_ERROR');

      fs.rmSync('/tmp/test-skills', { recursive: true, force: true });
    });

    it('handles skill timeout error', async () => {
      const skillDir = '/tmp/test-skills/flight-search';
      fs.mkdirSync(skillDir, { recursive: true });

      setSkillExecutor(async () => {
        throw new Error('Container timeout after 30000ms');
      });

      const filePath = path.join(requestsDir, 'sr-123-abc.json');
      fs.writeFileSync(filePath, JSON.stringify({
        requestId: 'sr-123-abc',
        skillName: 'flight-search',
        input: { skillDir: '/skills/flight-search', data: {} },
        timestamp: '2026-03-08T12:00:00Z',
      }));

      await processSkillRequest(filePath, 'test-group', resultsDir, errorsDir);

      const resultFile = path.join(resultsDir, 'sr-123-abc.json');
      const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
      expect(result.status).toBe('error');
      expect(result.error.code).toBe('SKILL_TIMEOUT');
      expect(result.error.message).toContain('TIME-01');

      fs.rmSync('/tmp/test-skills', { recursive: true, force: true });
    });

    it('decrements concurrent counter even on error', async () => {
      const skillDir = '/tmp/test-skills/flight-search';
      fs.mkdirSync(skillDir, { recursive: true });

      setSkillExecutor(async () => {
        throw new Error('fail');
      });

      const before = _getConcurrentExecutions();

      const filePath = path.join(requestsDir, 'sr-123-abc.json');
      fs.writeFileSync(filePath, JSON.stringify({
        requestId: 'sr-123-abc',
        skillName: 'flight-search',
        input: { skillDir: '/skills/flight-search', data: {} },
        timestamp: '2026-03-08T12:00:00Z',
      }));

      await processSkillRequest(filePath, 'test-group', resultsDir, errorsDir);

      expect(_getConcurrentExecutions()).toBe(before);

      fs.rmSync('/tmp/test-skills', { recursive: true, force: true });
    });
  });

  describe('processSkillRequests', () => {
    it('skips when skill-requests directory does not exist', async () => {
      // Should not throw
      await processSkillRequests(tmpDir, 'nonexistent-group');
    });

    it('processes multiple request files sequentially', async () => {
      const groupDir = path.join(tmpDir, 'test-group');
      const requestsDir = path.join(groupDir, 'skill-requests');
      const resultsDir = path.join(groupDir, 'skill-results');
      fs.mkdirSync(requestsDir, { recursive: true });
      fs.mkdirSync(resultsDir, { recursive: true });

      const skillDir = '/tmp/test-skills/flight-search';
      fs.mkdirSync(skillDir, { recursive: true });

      const callOrder: string[] = [];
      setSkillExecutor(async (input) => {
        callOrder.push(input.skillDir);
        return {
          success: true,
          data: {},
          metadata: {
            skillName: 'flight-search',
            skillVersion: '1.0.0',
            containerId: 'abc',
            durationMs: 100,
            exitCode: 0,
          },
        };
      });

      fs.writeFileSync(
        path.join(requestsDir, 'sr-001-aaa.json'),
        JSON.stringify({
          requestId: 'sr-001-aaa',
          skillName: 'flight-search',
          input: { skillDir: '/skills/flight-search', data: { seq: 1 } },
          timestamp: '2026-03-08T12:00:00Z',
        }),
      );

      fs.writeFileSync(
        path.join(requestsDir, 'sr-002-bbb.json'),
        JSON.stringify({
          requestId: 'sr-002-bbb',
          skillName: 'flight-search',
          input: { skillDir: '/skills/flight-search', data: { seq: 2 } },
          timestamp: '2026-03-08T12:00:01Z',
        }),
      );

      await processSkillRequests(tmpDir, 'test-group');

      // Both results should exist
      expect(fs.existsSync(path.join(resultsDir, 'sr-001-aaa.json'))).toBe(true);
      expect(fs.existsSync(path.join(resultsDir, 'sr-002-bbb.json'))).toBe(true);

      // Request files should be deleted
      expect(fs.readdirSync(requestsDir)).toHaveLength(0);

      // Executor was called twice
      expect(callOrder).toHaveLength(2);

      // Counters should reflect both executions
      const counters = getCounters('test-group');
      expect(counters.turnCount).toBe(2);
      expect(counters.sessionCount).toBe(2);

      fs.rmSync('/tmp/test-skills', { recursive: true, force: true });
    });
  });
});
