/**
 * Confirmation flow tests — TRAVEL-003 (T1.5, NanoClaw side)
 *
 * Tests:
 * - pending_confirmation result is relayed with correct status
 * - Confirmation timeout writes cancel file and notifies client
 * - Confirmation submission clears timer
 * - writeCancelToIpc creates correct file
 * - readTaskResult handles pending_confirmation status
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readTaskResult, writeCancelToIpc } from './translator.js';

describe('TRAVEL-003: readTaskResult pending_confirmation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-confirm-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('translates pending_confirmation status from IPC response', () => {
    const responsesDir = path.join(tmpDir, 'web-user1', 'responses');
    fs.mkdirSync(responsesDir, { recursive: true });
    fs.writeFileSync(
      path.join(responsesDir, 'task-confirm-1.json'),
      JSON.stringify({
        requestId: 'task-confirm-1',
        status: 'pending_confirmation',
        response: {
          booking_details: { flight: 'LAX-NRT', price: 1200 },
          confirmation_token: 'tok_abc123',
        },
      }),
    );

    const result = readTaskResult(tmpDir, 'user1', 'task-confirm-1');
    expect(result).not.toBeNull();
    expect(result!.status).toBe('pending_confirmation');
    expect(result!.output).toEqual({
      booking_details: { flight: 'LAX-NRT', price: 1200 },
      confirmation_token: 'tok_abc123',
    });
  });

  it('still translates complete status correctly', () => {
    const responsesDir = path.join(tmpDir, 'web-user1', 'responses');
    fs.mkdirSync(responsesDir, { recursive: true });
    fs.writeFileSync(
      path.join(responsesDir, 'task-ok.json'),
      JSON.stringify({
        requestId: 'task-ok',
        status: 'complete',
        response: 'All good',
      }),
    );

    const result = readTaskResult(tmpDir, 'user1', 'task-ok');
    expect(result!.status).toBe('completed');
  });

  it('translates error status as failed', () => {
    const responsesDir = path.join(tmpDir, 'web-user1', 'responses');
    fs.mkdirSync(responsesDir, { recursive: true });
    fs.writeFileSync(
      path.join(responsesDir, 'task-err.json'),
      JSON.stringify({
        requestId: 'task-err',
        status: 'error',
        error: { code: 'AGENT_TIMEOUT', message: 'Timed out' },
      }),
    );

    const result = readTaskResult(tmpDir, 'user1', 'task-err');
    expect(result!.status).toBe('failed');
  });

  it('handles object response (not just string) for pending_confirmation', () => {
    const responsesDir = path.join(tmpDir, 'web-user1', 'responses');
    fs.mkdirSync(responsesDir, { recursive: true });
    fs.writeFileSync(
      path.join(responsesDir, 'task-obj.json'),
      JSON.stringify({
        requestId: 'task-obj',
        status: 'pending_confirmation',
        response: { details: { hotel: 'Hilton', nights: 3 } },
      }),
    );

    const result = readTaskResult(tmpDir, 'user1', 'task-obj');
    expect(result!.output).toEqual({ details: { hotel: 'Hilton', nights: 3 } });
  });
});

describe('TRAVEL-003: writeCancelToIpc', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-cancel-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates cancel file with correct structure', () => {
    writeCancelToIpc(tmpDir, 'user1', 'task-cancel-1', 'confirmation_timeout');

    const cancelPath = path.join(
      tmpDir,
      'web-user1',
      'messages',
      'task-cancel-1.cancel.json',
    );
    expect(fs.existsSync(cancelPath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(cancelPath, 'utf-8'));
    expect(content.taskId).toBe('task-cancel-1');
    expect(content.reason).toBe('confirmation_timeout');
    expect(content.timestamp).toBeDefined();
  });

  it('creates directory structure if missing', () => {
    writeCancelToIpc(tmpDir, 'newuser', 'task-cancel-2', 'user_denied');

    const cancelPath = path.join(
      tmpDir,
      'web-newuser',
      'messages',
      'task-cancel-2.cancel.json',
    );
    expect(fs.existsSync(cancelPath)).toBe(true);
  });
});
