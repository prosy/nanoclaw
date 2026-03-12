/**
 * WebSocket bridge module barrel export (M2-P3)
 */
export { NanoClawWSServer, type WSServerOptions } from './server.js';
export { verifyToken, extractToken, type WSTokenPayload, type AuthResult } from './auth.js';
export {
  validateTaskSubmit,
  writeTaskToIpc,
  readTaskResult,
  type TaskSubmitMessage,
  type TaskAckMessage,
  type TaskResultMessage,
  type WSErrorMessage,
} from './translator.js';
