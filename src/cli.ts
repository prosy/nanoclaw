#!/usr/bin/env node
/**
 * NanoClaw CLI entry point (M2-P3 T5.1, REQ-11.2)
 *
 * Commands:
 *   nanoclaw start   - Start the NanoClaw host process
 *   nanoclaw setup   - First-run onboarding (T6.1)
 *   nanoclaw health  - Check prerequisites
 */

import { execSync } from 'child_process';

const command = process.argv[2];

async function checkPrereqs(): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];

  // Node.js version check
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1).split('.')[0], 10);
  if (major < 20) {
    errors.push(
      `[DEP-ERR] Node.js 20+ required. Current: ${nodeVersion}.`,
    );
  }

  // Docker check
  try {
    execSync('docker info', { stdio: 'pipe' });
  } catch {
    errors.push(
      '[DEP-ERR] Docker not found or not running. Install from https://docker.com',
    );
  }

  // Ollama check
  try {
    const res = await fetch('http://localhost:11434/api/tags');
    if (!res.ok) throw new Error('not ok');
  } catch {
    errors.push(
      '[DEP-ERR] Ollama not found at localhost:11434. Install from https://ollama.ai',
    );
  }

  return { ok: errors.length === 0, errors };
}

async function startCommand(): Promise<void> {
  const { ok, errors } = await checkPrereqs();
  if (!ok) {
    console.error('Prerequisite checks failed:');
    for (const err of errors) {
      console.error(`  ${err}`);
    }
    process.exit(1);
  }

  console.log('[NC] Starting NanoClaw...');
  // Dynamic import to avoid loading everything at CLI parse time
  await import('./index.js');
}

async function healthCommand(): Promise<void> {
  const { ok, errors } = await checkPrereqs();
  if (ok) {
    console.log('[NC] All prerequisites satisfied.');
  } else {
    console.error('Prerequisite checks failed:');
    for (const err of errors) {
      console.error(`  ${err}`);
    }
    process.exit(1);
  }
}

async function setupCommand(): Promise<void> {
  const token = process.argv.find((a) => a.startsWith('--token='))?.split('=')[1]
    ?? process.argv[process.argv.indexOf('--token') + 1];

  if (!token) {
    console.error('[SETUP-ERR] Usage: nanoclaw setup --token <invite-token>');
    process.exit(1);
  }

  console.log('[NC] Validating invite token...');

  try {
    const res = await fetch('https://travel.aw/api/invite/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.error(
        `[SETUP-ERR] ${(data as Record<string, string>).message ?? 'Invalid or expired invite code.'}`,
      );
      console.error('Visit https://travel.aw/setup to get a new invite.');
      process.exit(1);
    }

    const config = await res.json();
    console.log('[NC] Token validated. Configuring local instance...');

    // Write config
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');

    const configDir = path.join(os.homedir(), '.nanoclaw');
    fs.mkdirSync(configDir, { recursive: true });

    // Write config.json
    const configPath = path.join(configDir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          ws_auth_secret: (config as Record<string, string>).ws_auth_secret,
          ws_port: 9347,
          ws_bind: '127.0.0.1',
          ollama_host: 'http://localhost:11434',
          database_url: 'postgresql://postgres:nanoclaw@localhost:5432/nanoclaw',
          redis_url: 'redis://localhost:6379',
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    // Write .env for docker-compose compatibility
    const envPath = path.join(configDir, '.env');
    const envContent = [
      `WS_AUTH_SECRET=${(config as Record<string, string>).ws_auth_secret}`,
      'WS_PORT=9347',
      'WS_BIND=127.0.0.1',
      'PG_PASSWORD=nanoclaw',
      'NANOCLAW_HEADLESS=true',
      'EMBEDDER_PROVIDER=ollama',
      '',
    ].join('\n');
    fs.writeFileSync(envPath, envContent, { mode: 0o600 });

    console.log(`[NC] Config written to ${configPath} (permissions: 600)`);

    // Run self-test
    console.log('[NC] Running self-test...');
    const { ok, errors } = await checkPrereqs();

    if (!ok) {
      console.error('[SETUP-ERR] Self-test failed:');
      for (const err of errors) {
        console.error(`  ${err}`);
      }
      process.exit(1);
    }

    console.log('Setup complete. Open https://travel.aw to start planning.');
  } catch (err) {
    console.error(`[SETUP-ERR] ${(err as Error).message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

switch (command) {
  case 'start':
    startCommand();
    break;
  case 'setup':
    setupCommand();
    break;
  case 'health':
    healthCommand();
    break;
  default:
    console.log('Usage: nanoclaw <command>');
    console.log('');
    console.log('Commands:');
    console.log('  start   Start the NanoClaw host process');
    console.log('  setup   First-run onboarding (--token <invite-token>)');
    console.log('  health  Check prerequisites');
    process.exit(command ? 1 : 0);
}
