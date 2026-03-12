/**
 * IPC Translator tests (M2-P3 T1.3)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateTaskSubmit, writeTaskToIpc, readTaskResult } from './translator.js';

describe('validateTaskSubmit', () => {
  it('accepts valid task_submit', () => {
    const result = validateTaskSubmit({
      type: 'task_submit',
      task_id: 'task-123',
      skill: 'flight-search',
      input: { origin: 'SEA', destination: 'NRT' },
    });
    expect(result).toBeNull();
  });

  it('rejects non-object', () => {
    expect(validateTaskSubmit('string')).not.toBeNull();
    expect(validateTaskSubmit(null)).not.toBeNull();
  });

  it('rejects unknown message type', () => {
    const result = validateTaskSubmit({ type: 'unknown', task_id: 'x', skill: 's', input: {} });
    expect(result).toMatch(/Unknown message type/);
  });

  it('rejects missing task_id', () => {
    const result = validateTaskSubmit({ type: 'task_submit', skill: 's', input: {} });
    expect(result).toMatch(/task_id/);
  });

  it('rejects missing skill', () => {
    const result = validateTaskSubmit({ type: 'task_submit', task_id: 'x', input: {} });
    expect(result).toMatch(/skill/);
  });

  it('rejects missing input', () => {
    const result = validateTaskSubmit({ type: 'task_submit', task_id: 'x', skill: 's' });
    expect(result).toMatch(/input/);
  });
});

describe('writeTaskToIpc / readTaskResult', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ws-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes task to IPC directory and creates proper structure', () => {
    writeTaskToIpc(tmpDir, 'user1', {
      type: 'task_submit',
      task_id: 'task-001',
      skill: 'flight-search',
      input: { origin: 'SEA' },
    });

    const filePath = path.join(tmpDir, 'web-user1', 'messages', 'task-001.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(content.type).toBe('agent_request');
    expect(content.requestId).toBe('task-001');
    expect(content.chatJid).toBe('web:user1');
  });

  it('reads task result from IPC response', () => {
    // Simulate NanoClaw writing a response
    const responsesDir = path.join(tmpDir, 'web-user1', 'responses');
    fs.mkdirSync(responsesDir, { recursive: true });
    fs.writeFileSync(
      path.join(responsesDir, 'task-001.json'),
      JSON.stringify({
        requestId: 'task-001',
        status: 'complete',
        response: 'Found 3 flights to Tokyo',
        metadata: { turnDurationMs: 2500 },
      }),
    );

    const result = readTaskResult(tmpDir, 'user1', 'task-001');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('task_result');
    expect(result!.task_id).toBe('task-001');
    expect(result!.status).toBe('completed');
    expect(result!.output).toEqual({ text: 'Found 3 flights to Tokyo' });

    // File should be deleted after reading
    expect(fs.existsSync(path.join(responsesDir, 'task-001.json'))).toBe(false);
  });

  it('returns null when no response file exists', () => {
    const result = readTaskResult(tmpDir, 'user1', 'nonexistent');
    expect(result).toBeNull();
  });

  it('translates error responses', () => {
    const responsesDir = path.join(tmpDir, 'web-user1', 'responses');
    fs.mkdirSync(responsesDir, { recursive: true });
    fs.writeFileSync(
      path.join(responsesDir, 'task-err.json'),
      JSON.stringify({
        requestId: 'task-err',
        status: 'error',
        error: { code: 'AGENT_TIMEOUT', message: 'Agent timed out' },
      }),
    );

    const result = readTaskResult(tmpDir, 'user1', 'task-err');
    expect(result!.status).toBe('failed');
    expect(result!.error).toBe('Agent timed out');
  });
});
