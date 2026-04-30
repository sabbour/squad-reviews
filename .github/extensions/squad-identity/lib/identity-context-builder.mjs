#!/usr/bin/env node
import { parseArgs } from 'node:util';

/**
 * Builds the IDENTITY_CONTEXT block injected into agent charters/prompts.
 * Tells agents how to use the token lease system, attest writes, and which identity to use.
 */
export function buildIdentityContext({ role, scopeId, appSlug, installationId, repoRoot }) {
  const owner = '{owner}';
  const repo = '{repo}';

  return `<IDENTITY_CONTEXT>
## Your Bot Identity

You are operating as **${appSlug}[bot]** (role: ${role}).
Your GitHub App installation ID is ${installationId}.

## Token Usage Protocol

You have been issued a scoped token lease. **Never** resolve tokens directly.

To obtain your GitHub token for any API call:
\`\`\`
node ${repoRoot}/.squad/scripts/exchange-lease.mjs --scope-id ${scopeId} --role ${role}
\`\`\`

Each exchange decrements your operation budget. Use tokens efficiently.
If exchange fails with "exhausted" or "expired", request a new lease from the coordinator.

## Attestation Protocol

After ANY GitHub write (PR, comment, push, label), record an attestation:
\`\`\`
node ${repoRoot}/.squad/scripts/attest-write.mjs --repo-root ${repoRoot} --owner ${owner} --repo ${repo} --write-type <type> --write-ref <ref> --role-slug ${role} --expected-actor ${appSlug}[bot] --token <your-token>
\`\`\`

Write types: pr-create, pr-comment, issue-comment, commit-push, label-add

## Anti-Patterns (NEVER do these)
- ❌ Call resolve-token.mjs directly (use exchange-lease instead)
- ❌ Use \`gh\` CLI without GH_TOKEN set to your leased token
- ❌ Use the human operator's token for any write
- ❌ Skip attestation after a GitHub write
- ❌ Ignore lease exhaustion errors (request new lease from coordinator)
</IDENTITY_CONTEXT>`;
}

/**
 * Builds the COORDINATOR_IDENTITY_CONTEXT block for the coordinator agent.
 * Tells the coordinator how to issue leases and manage agent identities.
 */
export function buildCoordinatorContext({ repoRoot, roles }) {
  const roleLines = roles
    .map(({ role, appSlug, installationId }) => `- ${role}: ${appSlug}[bot] (installation ${installationId})`)
    .join('\n');

  return `<COORDINATOR_IDENTITY_CONTEXT>
## Identity Governance (Coordinator)

You manage token leases for your agents. Before spawning any agent that needs GitHub access:

1. Issue a lease:
   \`\`\`
   node ${repoRoot}/.squad/scripts/token-lease.mjs --role <role> --max-ops <N> --max-time <seconds>
   \`\`\`
2. Pass the returned scopeId to the agent via their IDENTITY_CONTEXT block.
3. Monitor lease exhaustion — agents will request new leases when needed.

Available roles:
${roleLines}

</COORDINATOR_IDENTITY_CONTEXT>`;
}

// CLI mode: run directly to print identity context block
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMain) {
  const { values } = parseArgs({
    options: {
      role: { type: 'string' },
      'scope-id': { type: 'string' },
      'app-slug': { type: 'string' },
      'installation-id': { type: 'string' },
      'repo-root': { type: 'string' },
    },
    strict: false,
  });

  const role = values.role;
  const scopeId = values['scope-id'];
  const appSlug = values['app-slug'];
  const installationId = values['installation-id'];
  const repoRoot = values['repo-root'];

  if (!role || !scopeId || !appSlug || !installationId || !repoRoot) {
    console.error('Usage: node identity-context-builder.mjs --role <role> --scope-id <id> --app-slug <slug> --installation-id <id> --repo-root <path>');
    process.exit(1);
  }

  const output = buildIdentityContext({ role, scopeId, appSlug, installationId, repoRoot });
  process.stdout.write(output + '\n');
}
