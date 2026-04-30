/**
 * squad-identity extension for GitHub Copilot CLI
 *
 * Registers identity management tools. Tools call lib/*.mjs directly.
 * on session start so Squad bot agents can call scripts without knowing paths.
 *
 * @see https://github.com/github/copilot-sdk
 */

import { joinSession } from '@github/copilot-sdk/extension';
import {
  existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB_DIR   = join(__dirname, 'lib');

// Resolve REPO_ROOT by walking up from extension dir (.github/extensions/squad-identity/)
const REPO_ROOT   = join(__dirname, '..', '..', '..');
const CONFIGURE   = join(LIB_DIR, 'configure-identity.mjs');

// ---------------------------------------------------------------------------
// Helper: run configure-identity.mjs with a flag, return stdout
// ---------------------------------------------------------------------------

async function runConfigure(session, flag) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [CONFIGURE, flag],
      { cwd: REPO_ROOT, timeout: 30000 }
    );
    if (stderr) session.log(stderr);
    return stdout;
  } catch (err) {
    const msg = err.stdout || err.stderr || err.message;
    session.log(`configure-identity ${flag} error: ${msg}`);
    return msg;
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

joinSession(async session => {

  // -------------------------------------------------------------------------
  // Tool: squad_identity_status
  // -------------------------------------------------------------------------

  session.registerTool({
    name: 'squad_identity_status',
    description: 'Show the current Squad identity configuration: agentNameMap (agent name → role slug) and registered GitHub App registrations.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const out = await runConfigure(session, '--status');
      return { type: 'text', text: out || 'No output.' };
    },
  });

  // -------------------------------------------------------------------------
  // Tool: squad_identity_doctor
  // -------------------------------------------------------------------------

  session.registerTool({
    name: 'squad_identity_doctor',
    description: 'Run a health check on the Squad identity setup: verifies config.json exists, agentNameMap is populated, PEM keys are readable, resolve-token.mjs is accessible, and token resolution succeeds for the lead role.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const out = await runConfigure(session, '--doctor');
      return { type: 'text', text: out || 'No output.' };
    },
  });

  // -------------------------------------------------------------------------
  // Tool: squad_identity_update_charters
  // -------------------------------------------------------------------------

  session.registerTool({
    name: 'squad_identity_update_charters',
    description: 'Parse .squad/team.md to infer the agent-name → role-slug mapping, write it to .squad/identity/config.json as agentNameMap, and inject a concrete ROLE_SLUG="<slug>" line into each agent charter. Also adds a skill pointer to .squad/skills/squad-identity/SKILL.md. Idempotent.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const out = await runConfigure(session, '--update-charters');
      return { type: 'text', text: out || 'No output.' };
    },
  });

  // -------------------------------------------------------------------------
  // Tool: squad_identity_update_copilot_instructions
  // -------------------------------------------------------------------------

  session.registerTool({
    name: 'squad_identity_update_copilot_instructions',
    description: 'Replace or append the Squad identity block in .github/copilot-instructions.md. The block explains how agents should resolve ROLE_SLUG and obtain a bot token. Safe to run after every squad upgrade.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const out = await runConfigure(session, '--update-copilot-instructions');
      return { type: 'text', text: out || 'No output.' };
    },
  });

  // -------------------------------------------------------------------------
  // Tool: squad_identity_setup_steps
  // -------------------------------------------------------------------------

  session.registerTool({
    name: 'squad_identity_setup_steps',
    description: 'Return step-by-step instructions for setting up GitHub App bot identity from scratch. Some steps (GitHub App creation, OAuth) require a browser and are run manually.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const text = `
# Squad Identity — Setup Steps

These steps configure GitHub App bot identity so each Squad agent writes to
GitHub as its own \`{app-slug}[bot]\` account instead of the human operator.

## Quick Setup (recommended)

Run in terminal:
\`\`\`bash
squad-identity setup
\`\`\`

This reads .squad/team.md, shows discovered roles, and creates+installs a GitHub App for each one.

## Manual Setup (step by step)

### Prerequisites
- \`gh\` CLI authenticated (\`gh auth status\`)
- \`node\` >= 18

### Step 1 — Create GitHub Apps (browser required)

Use the \`squad_identity_rotate_key\` tool or run the CLI:
\`\`\`bash
squad-identity setup
\`\`\`

### Step 2 — Verify

Call \`squad_identity_doctor\` or:
\`\`\`bash
squad-identity doctor
\`\`\`

### Step 3 — Update charters (if needed)

Call \`squad_identity_update_charters\` to inject ROLE_SLUG into each agent charter.

### Step 4 — Update copilot-instructions.md

Call \`squad_identity_update_copilot_instructions\` to restore the identity block.

## Key files

| File | Purpose |
|------|---------|
| \`.squad/identity/config.json\` | App registrations + agentNameMap |
| OS Keychain (service: squad-identity) | PEM private keys (keyed by app ID) |
| \`.squad/identity/apps/{role}.json\` | Per-role app registration |
| \`.squad/skills/squad-identity/SKILL.md\` | Protocol agents read at spawn |
`.trim();

      return { type: 'text', text };
    },
  });

  // -------------------------------------------------------------------------
  // Tool: squad_identity_setup_all (GUIDED SETUP)
  // -------------------------------------------------------------------------

  session.registerTool({
    name: 'squad_identity_setup_all',
    description: 'Run the guided setup flow: reads .squad/team.md, discovers needed roles, creates GitHub Apps for each role (opens browser), installs them, captures installation IDs, and updates charters. Requires user interaction (browser).',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      try {
        // Show current status first
        const out = await runConfigure(session, '--status');
        
        const instructions = [
          '🚀 To run full guided setup, use the CLI in your terminal:',
          '',
          '  squad-identity setup',
          '',
          'This will:',
          '1. Read .squad/team.md to discover roles',
          '2. Show roles and ask for confirmation',
          '3. Create a GitHub App per role (opens browser)',
          '4. Install all apps into the repository',
          '5. Capture installation IDs',
          '6. Update charters with ROLE_SLUG',
          '',
          'Current status:',
          out?.trim() || '(no configuration found — run setup first)',
        ].join('\n');
        
        return { type: 'text', text: instructions };
      } catch (err) {
        return { type: 'text', text: `❌ Setup check failed: ${err.message}\n\nRun \`squad-identity setup\` in your terminal to start the guided flow.` };
      }
    },
  });

  // -------------------------------------------------------------------------
  // Tool: squad_identity_resolve_token (AGENT RUNTIME)
  // -------------------------------------------------------------------------

  session.registerTool({
    name: 'squad_identity_resolve_token',
    description: 'Resolve bot GitHub App token for the current agent. Derives ROLE_SLUG from charter, looks up app ID, signs JWT with private key, and exchanges for installation access token. Returns token or error.',
    inputSchema: {
      type: 'object',
      properties: {
        roleSlug: {
          type: 'string',
          description: 'Optional: explicit role slug (e.g., "backend"). If omitted, derives from charter ROLE_SLUG.',
        },
      },
      required: [],
    },
    handler: async (input) => {
      try {
        const resolveScript = join(LIB_DIR, 'resolve-token.mjs');
        const roleSlug = input.roleSlug || process.env.ROLE_SLUG || '';
        
        const { stdout, stderr } = await execFileAsync(
          process.execPath,
          [resolveScript, roleSlug],
          { cwd: REPO_ROOT, timeout: 10000 }
        );
        
        if (stderr) session.log(`[squad-identity] resolve-token stderr: ${stderr}`);
        
        if (!stdout || !stdout.trim()) {
          return { type: 'text', text: '❌ Could not resolve token. Check squad_identity_doctor for diagnostics.' };
        }
        
        return { type: 'text', text: `✅ Token resolved:\n${stdout.trim()}` };
      } catch (err) {
        const msg = err.stderr || err.message || 'unknown error';
        return { type: 'text', text: `❌ Token resolution failed: ${msg}` };
      }
    },
  });

  // -------------------------------------------------------------------------
  // Tool: squad_identity_rotate_key (KEY ROTATION)
  // -------------------------------------------------------------------------

  session.registerTool({
    name: 'squad_identity_rotate_key',
    description: 'Rotate a GitHub App private key for a role. Opens the GitHub App settings page so the user can generate a new key, then imports the downloaded PEM into the OS keychain. Guided two-step flow.',
    inputSchema: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          description: 'Role slug to rotate key for (e.g., "backend", "frontend", "lead").',
        },
        pemPath: {
          type: 'string',
          description: 'Optional: path to the already-downloaded PEM file. If provided, skips the browser step and imports directly.',
        },
      },
      required: ['role'],
    },
    handler: async (input) => {
      try {
        const createAppScript = join(LIB_DIR, 'create-app.mjs');

        if (input.pemPath) {
          // Direct import — user already has the PEM file
          const { stdout, stderr } = await execFileAsync(
            process.execPath,
            [createAppScript, '--import-key', input.pemPath, '--role', input.role],
            { cwd: REPO_ROOT, timeout: 15000 }
          );
          if (stderr) session.log(`[squad-identity] rotate-key stderr: ${stderr}`);
          return { type: 'text', text: stdout?.trim() || '✅ Key rotated and stored in OS keychain.' };
        }

        // Step 1: Open settings page so user can generate a new key
        const { stdout, stderr } = await execFileAsync(
          process.execPath,
          [createAppScript, '--generate-key', '--role', input.role, '--owner', 'placeholder'],
          { cwd: REPO_ROOT, timeout: 15000 }
        );
        if (stderr) session.log(`[squad-identity] rotate-key stderr: ${stderr}`);

        const instructions = [
          stdout?.trim() || '',
          '',
          '📋 Next steps:',
          '1. In the browser, click "Generate a private key" to create a new key',
          '2. Download the PEM file',
          `3. Run: squad_identity_rotate_key with role="${input.role}" and pemPath="~/Downloads/<app-slug>*.pem"`,
          '4. Delete the old key from the GitHub App settings page',
        ].join('\n');

        return { type: 'text', text: instructions };
      } catch (err) {
        const msg = err.stderr || err.message || 'unknown error';
        return { type: 'text', text: `❌ Key rotation failed: ${msg}` };
      }
    },
  });

  // -------------------------------------------------------------------------
  // Tool: squad_identity_lease_token (COORDINATOR USE ONLY)
  // -------------------------------------------------------------------------

  session.registerTool({
    name: 'squad_identity_lease_token',
    description: 'Issue a scoped token lease for an agent role (coordinator use only)',
    inputSchema: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          description: 'Role slug to issue a token lease for (e.g., "backend", "frontend").',
        },
        maxOps: {
          type: 'number',
          description: 'Maximum number of operations allowed under this lease. Default: 3.',
        },
        maxTime: {
          type: 'number',
          description: 'Maximum lease duration in seconds. Default: 300.',
        },
      },
      required: ['role'],
    },
    handler: async (input) => {
      try {
        const leaseScript = join(LIB_DIR, 'token-lease.mjs');
        const maxOps = input.maxOps ?? 3;
        const maxTime = input.maxTime ?? 300;

        const { stdout, stderr } = await execFileAsync(
          process.execPath,
          [leaseScript, '--role', input.role, '--max-ops', String(maxOps), '--max-time', String(maxTime)],
          { cwd: REPO_ROOT, timeout: 15000 }
        );
        if (stderr) session.log(`[squad-identity] lease-token stderr: ${stderr}`);
        return { type: 'text', text: stdout?.trim() || 'No output.' };
      } catch (err) {
        const msg = err.stderr || err.message || 'unknown error';
        return { type: 'text', text: `❌ Token lease failed: ${msg}` };
      }
    },
  });

  // -------------------------------------------------------------------------
  // Tool: squad_identity_attest_write
  // -------------------------------------------------------------------------

  session.registerTool({
    name: 'squad_identity_attest_write',
    description: 'Record and verify an attestation for a bot-authored GitHub write',
    inputSchema: {
      type: 'object',
      properties: {
        owner: {
          type: 'string',
          description: 'GitHub repository owner (user or org).',
        },
        repo: {
          type: 'string',
          description: 'GitHub repository name.',
        },
        writeType: {
          type: 'string',
          description: 'Type of write operation (e.g., "pr", "comment", "push", "label").',
        },
        writeRef: {
          type: 'string',
          description: 'Reference to the write (e.g., PR number, commit SHA).',
        },
        roleSlug: {
          type: 'string',
          description: 'Role slug of the agent that performed the write.',
        },
        expectedActor: {
          type: 'string',
          description: 'Expected GitHub actor (e.g., "squad-identity-backend[bot]").',
        },
        token: {
          type: 'string',
          description: 'GitHub token used for the write operation.',
        },
        verify: {
          type: 'boolean',
          description: 'Whether to verify the attestation after recording. Default: true.',
        },
      },
      required: ['owner', 'repo', 'writeType', 'writeRef', 'roleSlug', 'expectedActor', 'token'],
    },
    handler: async (input) => {
      try {
        const attestScript = join(LIB_DIR, 'attest-write.mjs');
        const verify = input.verify ?? true;

        const args = [
          attestScript,
          '--repo-root', REPO_ROOT,
          '--owner', input.owner,
          '--repo', input.repo,
          '--write-type', input.writeType,
          '--write-ref', input.writeRef,
          '--role-slug', input.roleSlug,
          '--expected-actor', input.expectedActor,
          '--token', input.token,
        ];
        if (!verify) args.push('--no-verify');

        const { stdout, stderr } = await execFileAsync(
          process.execPath,
          args,
          { cwd: REPO_ROOT, timeout: 15000 }
        );
        if (stderr) session.log(`[squad-identity] attest-write stderr: ${stderr}`);
        return { type: 'text', text: stdout?.trim() || 'No output.' };
      } catch (err) {
        const msg = err.stderr || err.message || 'unknown error';
        return { type: 'text', text: `❌ Attestation failed: ${msg}` };
      }
    },
  });

});
