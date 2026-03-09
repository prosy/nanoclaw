import { describe, it, expect } from 'vitest';

import { augmentClaudeMd, stripSessionContext } from './context-assembler.js';
import { SessionPayload } from './memory-client.js';

function makePayload(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return {
    sessionId: 'sess_abc123',
    groupFolder: 'trip-planning',
    conversationHistory: 'User: Find flights to Tokyo\nAssistant: Found 3 options.',
    skillInvocations: [
      {
        requestId: 'sr-123',
        skillName: 'flight-search',
        timestamp: '2026-03-08T10:00:00.000Z',
        status: 'success',
        resultSummary: '3 flights found, cheapest $450',
      },
    ],
    agentNotes: 'User prefers direct flights.',
    createdAt: '2026-03-08T10:00:00.000Z',
    updatedAt: '2026-03-08T10:05:00.000Z',
    turnCount: 2,
    ...overrides,
  };
}

const TEMPLATE = `# TravelAW Trip Planning Agent

## Identity

You are TravelAW, a travel planning assistant.

## Rules

1. Never book without confirmation.

## Available Skills

Skills are invoked via IPC.

## Trip Context

No active trip context.

## User Preferences

No preferences loaded.`;

// --- CLAUDE.md augmentation (AC-6) ---

describe('augmentClaudeMd', () => {
  it('appends Session Context section when none exists', () => {
    const result = augmentClaudeMd(TEMPLATE, makePayload(), true);

    expect(result).toContain('## Session Context');
    expect(result).toContain('Session: sess_abc123 | Turns: 2');
    expect(result).toContain('### Conversation History');
    expect(result).toContain('flights to Tokyo');
    expect(result).toContain('### Skill Results');
    expect(result).toContain('flight-search');
    expect(result).toContain('### Agent Notes');
    expect(result).toContain('prefers direct flights');
  });

  it('preserves Identity section unchanged', () => {
    const result = augmentClaudeMd(TEMPLATE, makePayload(), true);
    expect(result).toContain('## Identity\n\nYou are TravelAW, a travel planning assistant.');
  });

  it('preserves Rules section unchanged', () => {
    const result = augmentClaudeMd(TEMPLATE, makePayload(), true);
    expect(result).toContain('## Rules\n\n1. Never book without confirmation.');
  });

  it('preserves Available Skills section unchanged', () => {
    const result = augmentClaudeMd(TEMPLATE, makePayload(), true);
    expect(result).toContain('## Available Skills\n\nSkills are invoked via IPC.');
  });

  it('preserves Trip Context section unchanged', () => {
    const result = augmentClaudeMd(TEMPLATE, makePayload(), true);
    expect(result).toContain('## Trip Context\n\nNo active trip context.');
  });

  it('preserves User Preferences section unchanged', () => {
    const result = augmentClaudeMd(TEMPLATE, makePayload(), true);
    expect(result).toContain('## User Preferences\n\nNo preferences loaded.');
  });

  it('replaces existing Session Context section', () => {
    const withExisting = TEMPLATE + '\n\n## Session Context\n\nOld session data here.';
    const result = augmentClaudeMd(withExisting, makePayload(), true);

    // Should have new content
    expect(result).toContain('Session: sess_abc123');
    // Should NOT have old content
    expect(result).not.toContain('Old session data here.');
    // Should only have one Session Context section
    const count = (result.match(/## Session Context/g) || []).length;
    expect(count).toBe(1);
  });

  it('writes fresh conversation marker when no session payload', () => {
    const result = augmentClaudeMd(TEMPLATE, null, true);

    expect(result).toContain('## Session Context');
    expect(result).toContain('No active session. This is a fresh conversation.');
  });

  it('writes fallback marker when Redis is unavailable', () => {
    const result = augmentClaudeMd(TEMPLATE, null, false);

    expect(result).toContain('## Session Context');
    expect(result).toContain('No active session (Redis unavailable). Using flat-file session.');
  });

  it('handles payload with no skill invocations', () => {
    const payload = makePayload({ skillInvocations: [] });
    const result = augmentClaudeMd(TEMPLATE, payload, true);

    expect(result).toContain('### Conversation History');
    expect(result).not.toContain('### Skill Results');
  });

  it('handles payload with no agent notes', () => {
    const payload = makePayload({ agentNotes: '' });
    const result = augmentClaudeMd(TEMPLATE, payload, true);

    expect(result).toContain('### Conversation History');
    expect(result).not.toContain('### Agent Notes');
  });

  it('handles empty template', () => {
    const result = augmentClaudeMd('', makePayload(), true);
    expect(result).toContain('## Session Context');
    expect(result).toContain('Session: sess_abc123');
  });
});

// --- stripSessionContext ---

describe('stripSessionContext', () => {
  it('removes Session Context section from content', () => {
    const withSession = TEMPLATE + '\n\n## Session Context\n\nSome session data.\nMore data.';
    const result = stripSessionContext(withSession);

    expect(result).not.toContain('## Session Context');
    expect(result).not.toContain('Some session data');
    // Other sections preserved
    expect(result).toContain('## Identity');
    expect(result).toContain('## Rules');
  });

  it('returns content unchanged if no Session Context section', () => {
    const result = stripSessionContext(TEMPLATE);
    expect(result.trim()).toBe(TEMPLATE.trim());
  });

  it('preserves sections after Session Context if any', () => {
    const withMiddle = `## Identity\n\nAgent.\n\n## Session Context\n\nOld data.\n\n## Rules\n\n1. Be good.`;
    const result = stripSessionContext(withMiddle);

    expect(result).toContain('## Identity');
    expect(result).toContain('## Rules');
    expect(result).not.toContain('Old data');
  });
});
