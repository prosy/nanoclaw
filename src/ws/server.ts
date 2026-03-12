/**
 * WebSocket Server for NanoClaw (M2-P3 T1.1, REQ-10.1)
 *
 * Transparent relay between the web UI and NanoClaw's filesystem IPC.
 * Runs in the NanoClaw host process (not inside any skill container).
 *
 * Responsibilities:
 * - Accept authenticated WS connections (REQ-10.2)
 * - Translate WS messages <-> IPC files (REQ-10.3)
 * - Poll for IPC responses and relay back (REQ-10.3)
 *
 * Does NOT: execute skills, make LLM calls, access memory, modify task content.
 */

import { IncomingMessage, createServer, Server as HttpServer } from 'http';

import { WebSocketServer, WebSocket } from 'ws';

import { DATA_DIR, WS_CONFIRMATION_TIMEOUT_MS } from '../config.js';
import { logger } from '../logger.js';
import { extractToken, verifyToken, type WSTokenPayload } from './auth.js';
import {
  validateTaskSubmit,
  writeTaskToIpc,
  readTaskResult,
  writeCancelToIpc,
  type TaskSubmitMessage,
} from './translator.js';

import path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingConfirmation {
  taskId: string;
  timer: ReturnType<typeof setTimeout>;
  userId: string;
}

interface AuthenticatedClient {
  ws: WebSocket;
  payload: WSTokenPayload;
  /** Pending task IDs being polled for results */
  pendingTasks: Set<string>;
  /** Tasks awaiting user confirmation (TRAVEL-003) */
  pendingConfirmations: Map<string, PendingConfirmation>;
}

export interface WSServerOptions {
  /** Port to listen on (default: 9347) */
  port?: number;
  /** Bind address (default: 127.0.0.1) */
  bind?: string;
  /** Shared secret for JWT validation */
  authSecret: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 9347;
const DEFAULT_BIND = '127.0.0.1';
const RESULT_POLL_INTERVAL_MS = 500;
const TASK_TIMEOUT_MS = 120_000; // REQ-10.3: 120s

// ---------------------------------------------------------------------------
// WS Server
// ---------------------------------------------------------------------------

export class NanoClawWSServer {
  private httpServer: HttpServer;
  private wss: WebSocketServer;
  private clients = new Map<WebSocket, AuthenticatedClient>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private authSecret: string;
  private port: number;
  private bind: string;

  constructor(options: WSServerOptions) {
    this.authSecret = options.authSecret;
    this.port = options.port ?? DEFAULT_PORT;
    this.bind = options.bind ?? DEFAULT_BIND;

    this.httpServer = createServer();
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
  }

  /**
   * Start the WebSocket server.
   * REQ-10.1a: Logs "[WS] Listening on {bind}:{port}"
   * REQ-10.1b: Fails fast on port conflict
   * REQ-10.1c: Warns on 0.0.0.0 bind
   */
  async start(): Promise<void> {
    if (this.bind === '0.0.0.0') {
      logger.warn(
        '[WS-WARN] Binding to 0.0.0.0 -- NanoClaw is accessible from non-localhost clients',
      );
    }

    return new Promise((resolve, reject) => {
      this.httpServer.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          logger.error(
            `[WS-ERR] Port ${this.port} in use. NanoClaw cannot start WS listener.`,
          );
          reject(err);
        } else {
          reject(err);
        }
      });

      this.httpServer.listen(this.port, this.bind, () => {
        logger.info(`[WS] Listening on ${this.bind}:${this.port}`);
        this.startResultPolling();
        resolve();
      });
    });
  }

  /**
   * Graceful shutdown.
   */
  async shutdown(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Close all client connections, clear confirmation timers
    for (const [ws, client] of this.clients) {
      for (const [, pc] of client.pendingConfirmations) {
        clearTimeout(pc.timer);
      }
      client.pendingConfirmations.clear();
      ws.close(1001, 'Server shutting down');
    }
    this.clients.clear();

    // Close servers
    this.wss.close();
    return new Promise((resolve) => {
      this.httpServer.close(() => resolve());
    });
  }

  // -------------------------------------------------------------------------
  // Connection handling (REQ-10.2)
  // -------------------------------------------------------------------------

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const token = extractToken(req.url);
    if (!token) {
      ws.close(4001, 'Authentication required');
      return;
    }

    const auth = verifyToken(token, this.authSecret);
    if (!auth.valid || !auth.payload) {
      ws.close(
        auth.closeCode ?? 4003,
        auth.error ?? 'Invalid or expired token',
      );
      logger.warn(
        { remoteIp: req.socket.remoteAddress, error: auth.error },
        '[WS-AUTH] Connection rejected',
      );
      return;
    }

    const client: AuthenticatedClient = {
      ws,
      payload: auth.payload,
      pendingTasks: new Set(),
      pendingConfirmations: new Map(),
    };
    this.clients.set(ws, client);

    logger.info({ userId: auth.payload.sub }, '[WS] Client connected');

    ws.on('message', (data) => this.handleMessage(client, data.toString()));

    ws.on('close', () => {
      // TRAVEL-003: connection drop during pending confirmation = DENY
      // Timers continue running; they will fire and write cancel files.
      // Clear client reference but let timers complete.
      for (const [, pc] of client.pendingConfirmations) {
        // Timer still fires, writes cancel. No client to notify (disconnected).
        logger.info(
          { taskId: pc.taskId },
          '[WS-CONFIRM] Client disconnected during pending confirmation -- DENY default applies',
        );
      }
      this.clients.delete(ws);
      logger.info({ userId: auth.payload!.sub }, '[WS] Client disconnected');
    });

    ws.on('error', (err) => {
      logger.error({ err, userId: auth.payload!.sub }, '[WS] Client error');
    });
  }

  // -------------------------------------------------------------------------
  // Message handling (REQ-10.3)
  // -------------------------------------------------------------------------

  private handleMessage(client: AuthenticatedClient, raw: string): void {
    // REQ-10.2 invariant: check token expiration on every message
    const now = Math.floor(Date.now() / 1000);
    if (client.payload.exp && client.payload.exp < now) {
      client.ws.close(4003, 'Invalid or expired token');
      return;
    }

    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.sendError(client.ws, 'INVALID_MESSAGE', 'Invalid JSON');
      return;
    }

    const validationError = validateTaskSubmit(msg);
    if (validationError) {
      this.sendError(client.ws, 'INVALID_MESSAGE', validationError);
      return;
    }

    const taskMsg = msg as TaskSubmitMessage;
    const userId = client.payload.userId ?? client.payload.sub;
    const ipcDir = path.join(DATA_DIR, 'ipc');

    // TRAVEL-003: if this is a confirmation submission, clear the confirmation timer
    if (taskMsg.confirmation_token) {
      // Find and clear any pending confirmation for this skill
      // The confirmation_token submission is a NEW task_submit, so it gets its own task_id.
      // We clear confirmations by matching the skill name (the original task's timer).
      for (const [origTaskId, pc] of client.pendingConfirmations) {
        clearTimeout(pc.timer);
        client.pendingConfirmations.delete(origTaskId);
        logger.info(
          { originalTaskId: origTaskId, newTaskId: taskMsg.task_id },
          '[WS-CONFIRM] Confirmation received -- timer cleared',
        );
        break; // Only one pending confirmation per skill in V1
      }
    }

    // Write to IPC
    try {
      writeTaskToIpc(ipcDir, userId, taskMsg);
    } catch (err) {
      logger.error({ err, taskId: taskMsg.task_id }, '[WS] IPC write failed');
      this.sendError(
        client.ws,
        'IPC_WRITE_FAILED',
        'Failed to write task to IPC',
        taskMsg.task_id,
      );
      return;
    }

    // Send immediate ack (REQ-10.3: every task_submit gets exactly one task_ack)
    this.send(client.ws, { type: 'task_ack', task_id: taskMsg.task_id });

    // Track for result polling
    client.pendingTasks.add(taskMsg.task_id);

    // Set timeout for this task (REQ-10.3: 120s)
    setTimeout(() => {
      if (client.pendingTasks.has(taskMsg.task_id)) {
        client.pendingTasks.delete(taskMsg.task_id);
        this.send(client.ws, {
          type: 'task_result',
          task_id: taskMsg.task_id,
          status: 'failed',
          output: {},
          error: 'Task timed out after 120s',
        });
      }
    }, TASK_TIMEOUT_MS);
  }

  // -------------------------------------------------------------------------
  // Result polling
  // -------------------------------------------------------------------------

  private startResultPolling(): void {
    const ipcDir = path.join(DATA_DIR, 'ipc');

    this.pollTimer = setInterval(() => {
      for (const [, client] of this.clients) {
        if (client.pendingTasks.size === 0) continue;

        const userId = client.payload.userId ?? client.payload.sub;

        for (const taskId of client.pendingTasks) {
          const result = readTaskResult(ipcDir, userId, taskId);
          if (result) {
            client.pendingTasks.delete(taskId);
            this.send(client.ws, result);

            // TRAVEL-003: if result is pending_confirmation, start confirmation timer
            if (result.status === 'pending_confirmation') {
              this.startConfirmationTimer(client, taskId, userId, ipcDir);
            }
          }
        }
      }
    }, RESULT_POLL_INTERVAL_MS);
  }

  // -------------------------------------------------------------------------
  // TRAVEL-003: Confirmation timeout (REQ-T1.5.1)
  // -------------------------------------------------------------------------

  private startConfirmationTimer(
    client: AuthenticatedClient,
    taskId: string,
    userId: string,
    ipcDir: string,
  ): void {
    const timer = setTimeout(() => {
      // Timeout expired without confirmation -- DENY
      client.pendingConfirmations.delete(taskId);

      // Write cancellation file to IPC
      writeCancelToIpc(ipcDir, userId, taskId, 'confirmation_timeout');

      // Notify client (if still connected)
      this.send(client.ws, {
        type: 'task_result',
        task_id: taskId,
        status: 'failed',
        output: {},
        error: 'Confirmation timed out. Action was not performed.',
      });

      logger.info({ taskId }, '[WS-CONFIRM] Timeout for task -- action denied');
    }, WS_CONFIRMATION_TIMEOUT_MS);

    client.pendingConfirmations.set(taskId, { taskId, timer, userId });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private send(ws: WebSocket, msg: object): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private sendError(
    ws: WebSocket,
    code: string,
    detail: string,
    taskId?: string,
  ): void {
    this.send(ws, {
      type: 'error',
      code,
      detail,
      ...(taskId ? { task_id: taskId } : {}),
    });
  }
}
