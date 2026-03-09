/**
 * Context Assembler for NanoClaw
 * Augments per-group CLAUDE.md with session context from Redis.
 * Implements REQ-6.8.5 from memory-mvp-redis.md.
 *
 * MVP scope: session layer only. V1 adds preference injection.
 */
import fs from 'fs';
import path from 'path';

import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { isRedisAvailable, readSession, SessionPayload } from './memory-client.js';

// Sections that must never be modified by augmentation (REQ-6.8.5)
const PROTECTED_SECTIONS = [
  '## Identity',
  '## Rules',
  '## Available Skills',
  '## Trip Context',
  '## User Preferences',
];

const SESSION_SECTION_HEADER = '## Session Context';
const FRESH_SESSION_CONTENT = 'No active session. This is a fresh conversation.';
const FALLBACK_SESSION_CONTENT = 'No active session (Redis unavailable). Using flat-file session.';

/**
 * Build the session context markdown block from a SessionPayload.
 */
function buildSessionSection(payload: SessionPayload): string {
  const lines: string[] = [SESSION_SECTION_HEADER, ''];

  // Metadata line
  lines.push(
    `Session: ${payload.sessionId} | Turns: ${payload.turnCount} | Updated: ${payload.updatedAt}`,
  );
  lines.push('');

  // Conversation history
  if (payload.conversationHistory) {
    lines.push('### Conversation History');
    lines.push('');
    lines.push(payload.conversationHistory);
    lines.push('');
  }

  // Skill results
  if (payload.skillInvocations.length > 0) {
    lines.push('### Skill Results');
    lines.push('');
    for (const skill of payload.skillInvocations) {
      lines.push(
        `- **${skill.skillName}** (${skill.status}, ${skill.timestamp}): ${skill.resultSummary}`,
      );
    }
    lines.push('');
  }

  // Agent notes
  if (payload.agentNotes) {
    lines.push('### Agent Notes');
    lines.push('');
    lines.push(payload.agentNotes);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Augment CLAUDE.md template content with session context (REQ-6.8.5).
 *
 * If a session payload is provided, injects conversation history, skill
 * results, and agent notes into a `## Session Context` section.
 *
 * If no payload is provided, writes a "fresh conversation" marker.
 *
 * All other sections (Identity, Rules, Available Skills, Trip Context,
 * User Preferences) are preserved unchanged.
 */
export function augmentClaudeMd(
  templateContent: string,
  sessionPayload: SessionPayload | null,
  redisUp: boolean,
): string {
  // Determine the session section content
  let sessionSection: string;
  if (sessionPayload) {
    sessionSection = buildSessionSection(sessionPayload);
  } else if (!redisUp) {
    sessionSection = `${SESSION_SECTION_HEADER}\n\n${FALLBACK_SESSION_CONTENT}\n`;
  } else {
    sessionSection = `${SESSION_SECTION_HEADER}\n\n${FRESH_SESSION_CONTENT}\n`;
  }

  // Check if Session Context section already exists
  const sectionRegex = /^## Session Context\b.*(?:\n(?!## ).*)*$/m;
  if (sectionRegex.test(templateContent)) {
    // Replace existing section
    return templateContent.replace(sectionRegex, sessionSection.trimEnd());
  }

  // Append after last content
  const trimmed = templateContent.trimEnd();
  return `${trimmed}\n\n${sessionSection}`;
}

/**
 * Strip the `## Session Context` section from CLAUDE.md content.
 * Useful for getting a clean template.
 */
export function stripSessionContext(content: string): string {
  const sectionRegex = /\n*^## Session Context\b.*(?:\n(?!## ).*)*$/m;
  return content.replace(sectionRegex, '').trimEnd() + '\n';
}

/**
 * Assemble context for a group before container spawn (REQ-6.8.3, REQ-6.8.5).
 *
 * 1. Read session from Redis (or null if unavailable/expired).
 * 2. Read CLAUDE.md template from group folder.
 * 3. Write augmented CLAUDE.md back to group folder.
 *
 * Returns the session payload (or null) for use by the caller in
 * the post-response writeSession step.
 */
export async function assembleContext(
  groupFolder: string,
): Promise<SessionPayload | null> {
  const groupDir = resolveGroupFolderPath(groupFolder);
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');

  // Read session from Redis (REQ-6.8.3)
  const redisUp = isRedisAvailable();
  let session: SessionPayload | null = null;

  if (redisUp) {
    session = await readSession(groupFolder);
    if (!session) {
      logger.debug(`[MEMORY] No active session for group ${groupFolder}, starting fresh`);
    }
  } else {
    logger.info(`[MEMORY] Redis unavailable, falling back to CLAUDE.md session for group ${groupFolder}`);
  }

  // Read CLAUDE.md template (REQ-6.8.5)
  let templateContent: string;
  try {
    templateContent = fs.readFileSync(claudeMdPath, 'utf-8');
  } catch {
    logger.warn(`[MEMORY-WARN] CLAUDE.md missing for group ${groupFolder}, created from template`);
    // Minimal fallback template
    templateContent = `# ${groupFolder}\n\n## Identity\n\nAgent for ${groupFolder}.\n`;
    fs.mkdirSync(groupDir, { recursive: true });
  }

  // Augment and write (REQ-6.8.5)
  const augmented = augmentClaudeMd(templateContent, session, redisUp);

  try {
    fs.writeFileSync(claudeMdPath, augmented);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[MEMORY-ERROR] Cannot write CLAUDE.md for group ${groupFolder}: ${message}`);
    // Proceed with existing CLAUDE.md -- agent runs without session context
  }

  return session;
}
