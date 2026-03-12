/**
 * IPC Translator — WS <-> filesystem IPC (M2-P3 T1.3, REQ-10.3)
 *
 * Translates WebSocket JSON messages to/from filesystem IPC files.
 * The translator is a transparent relay — it never modifies task content.
 *
 * Message types:
 * - Client -> Server: task_submit -> writes IPC file
 * - Server -> Client: task_result <- reads IPC response file
 * - Server -> Client: task_ack (immediate on submit)
 * - Server -> Client: error (schema validation, IPC write failure, timeout)
 */

import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Types (V1 protocol — REQ-10.3)
// ---------------------------------------------------------------------------

export interface TaskSubmitMessage {
  type: 'task_submit';
  task_id: string;
  skill: string;
  input: Record<string, unknown>;
  confirmation_token?: string;
}

export interface TaskAckMessage {
  type: 'task_ack';
  task_id: string;
}

export interface TaskResultMessage {
  type: 'task_result';
  task_id: string;
  status: 'completed' | 'failed' | 'pending_confirmation';
  output: Record<string, unknown>;
  error?: string;
}

export interface WSErrorMessage {
  type: 'error';
  code: string;
  detail: string;
  task_id?: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a task_submit message schema.
 * Returns null if valid, or an error detail string.
 */
export function validateTaskSubmit(msg: unknown): string | null {
  if (typeof msg !== 'object' || msg === null) {
    return 'Message must be a JSON object';
  }

  const m = msg as Record<string, unknown>;

  if (m.type !== 'task_submit') {
    return `Unknown message type: ${String(m.type)}`;
  }
  if (typeof m.task_id !== 'string' || m.task_id.length === 0) {
    return 'task_id is required and must be a non-empty string';
  }
  if (typeof m.skill !== 'string' || m.skill.length === 0) {
    return 'skill is required and must be a non-empty string';
  }
  if (typeof m.input !== 'object' || m.input === null) {
    return 'input is required and must be an object';
  }

  return null;
}

// ---------------------------------------------------------------------------
// IPC File Operations
// ---------------------------------------------------------------------------

/**
 * Write a task_submit to the filesystem IPC directory as an agent_request.
 * Translates the WS protocol format to NanoClaw's IPC format.
 *
 * @param ipcDir - Base IPC directory (DATA_DIR/ipc)
 * @param userId - Auth0 user ID (determines group folder: web-{userId})
 * @param msg - The validated task_submit message
 */
export function writeTaskToIpc(
  ipcDir: string,
  userId: string,
  msg: TaskSubmitMessage,
): void {
  const groupFolder = `web-${userId}`;
  const messagesDir = path.join(ipcDir, groupFolder, 'messages');
  fs.mkdirSync(messagesDir, { recursive: true });

  // Translate WS protocol -> NanoClaw IPC format
  const ipcMessage = {
    type: 'agent_request',
    requestId: msg.task_id,
    text: `[skill:${msg.skill}] ${JSON.stringify(msg.input)}`,
    chatJid: `web:${userId}`,
    timestamp: new Date().toISOString(),
    ...(msg.confirmation_token
      ? { confirmationToken: msg.confirmation_token }
      : {}),
  };

  const tmpPath = path.join(messagesDir, `${msg.task_id}.tmp`);
  const finalPath = path.join(messagesDir, `${msg.task_id}.json`);

  fs.writeFileSync(tmpPath, JSON.stringify(ipcMessage, null, 2), 'utf-8');
  fs.renameSync(tmpPath, finalPath);

  logger.debug({ taskId: msg.task_id, groupFolder }, 'WS task written to IPC');
}

/**
 * Check for an IPC response file and return it if found.
 * Returns the parsed response or null if not yet available.
 * Deletes the response file after reading.
 */
export function readTaskResult(
  ipcDir: string,
  userId: string,
  taskId: string,
): TaskResultMessage | null {
  const groupFolder = `web-${userId}`;
  const responsePath = path.join(
    ipcDir,
    groupFolder,
    'responses',
    `${taskId}.json`,
  );

  if (!fs.existsSync(responsePath)) return null;

  try {
    const raw = fs.readFileSync(responsePath, 'utf-8');
    fs.unlinkSync(responsePath);

    const ipcResponse = JSON.parse(raw);

    // Translate NanoClaw IPC format -> WS protocol
    // Support pending_confirmation status for TRAVEL-003
    let status: TaskResultMessage['status'];
    if (ipcResponse.status === 'complete') {
      status = 'completed';
    } else if (ipcResponse.status === 'pending_confirmation') {
      status = 'pending_confirmation';
    } else {
      status = 'failed';
    }

    return {
      type: 'task_result',
      task_id: taskId,
      status,
      output: ipcResponse.response
        ? typeof ipcResponse.response === 'string'
          ? { text: ipcResponse.response }
          : ipcResponse.response
        : {},
      error: ipcResponse.error?.message,
    };
  } catch (err) {
    logger.error({ err, taskId }, 'Failed to read IPC response file');
    return {
      type: 'task_result',
      task_id: taskId,
      status: 'failed',
      output: {},
      error: 'Internal error reading task result',
    };
  }
}

/**
 * Write a cancellation file to the IPC directory (TRAVEL-003).
 * Used when a confirmation times out or is denied.
 */
export function writeCancelToIpc(
  ipcDir: string,
  userId: string,
  taskId: string,
  reason: string,
): void {
  const groupFolder = `web-${userId}`;
  const messagesDir = path.join(ipcDir, groupFolder, 'messages');
  fs.mkdirSync(messagesDir, { recursive: true });

  const cancelPath = path.join(messagesDir, `${taskId}.cancel.json`);
  fs.writeFileSync(
    cancelPath,
    JSON.stringify({ taskId, reason, timestamp: new Date().toISOString() }),
    'utf-8',
  );

  logger.info({ taskId, reason }, 'WS cancel file written to IPC');
}
