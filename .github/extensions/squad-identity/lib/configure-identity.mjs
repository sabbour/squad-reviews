#!/usr/bin/env node
/**
 * configure-identity.mjs — Squad identity configuration tool
 *
 * Flags:
 *   --update-charters           Parse team.md, infer agentNameMap, write to config.json,
 *                               inject ROLE_SLUG into each agent charter.
 *   --update-copilot-instructions  Replace identity block in .github/copilot-instructions.md
 *   --doctor                    Health check: config, keys, resolve-token, token resolution
 *   --status                    Print agentNameMap + registered apps
 *   --inject-context <json>     Inject identity context block into an agent's charter
 *   --inject-coordinator-context  Inject coordinator context into the lead agent's charter
 *
 * Zero runtime dependencies — only Node.js built-ins.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Resolve REPO_ROOT (the target Squad repo, not this package)
// ---------------------------------------------------------------------------

function findRepoRoot(startDir) {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Could not find git repo root from: ' + startDir);
    dir = parent;
  }
}

const REPO_ROOT = findRepoRoot(process.cwd());
const SQUAD_DIR = join(REPO_ROOT, '.squad');
const IDENTITY_DIR = join(SQUAD_DIR, 'identity');
const CONFIG_PATH = join(IDENTITY_DIR, 'config.json');
const TEAM_MD = join(SQUAD_DIR, 'team.md');
const AGENTS_DIR = join(SQUAD_DIR, 'agents');
const COPILOT_INSTRUCTIONS = join(REPO_ROOT, '.github', 'copilot-instructions.md');

// ---------------------------------------------------------------------------
// Role keyword inference map
// ---------------------------------------------------------------------------

const ROLE_KEYWORDS = {
  lead: ['lead', 'leader', 'coordinator', 'architect', 'tech lead', 'principal'],
  frontend: ['frontend', 'front-end', 'ui', 'ux', 'react', 'vue', 'angular', 'web'],
  backend: ['backend', 'back-end', 'api', 'server', 'database', 'db', 'service'],
  tester: ['tester', 'test', 'qa', 'quality', 'observability', 'monitoring'],
  security: ['security', 'sec', 'appsec', 'auth', 'compliance'],
  codereview: ['codereview', 'code review', 'reviewer', 'review', 'watchdog', 'critic'],
  devops: ['devops', 'dev ops', 'ops', 'platform', 'infra', 'infrastructure', 'sre', 'ci', 'cd'],
  docs: ['docs', 'documentation', 'doc', 'writer', 'devrel', 'technical writer'],
  scribe: ['scribe', 'logger', 'session logger', 'memory'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function saveConfig(cfg) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
}

/**
 * Parse team.md Members table rows.
 * Returns array of { name: string, role: string }.
 */
function parseTeamMembers() {
  if (!existsSync(TEAM_MD)) {
    console.error('⚠ team.md not found at:', TEAM_MD);
    return [];
  }
  const lines = readFileSync(TEAM_MD, 'utf-8').split('\n');
  const members = [];
  let inTable = false;
  let headerPassed = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##\s+Members/i.test(trimmed)) {
      inTable = true;
      headerPassed = false;
      continue;
    }
    if (inTable && trimmed.startsWith('#')) {
      inTable = false;
      continue;
    }
    if (!inTable) continue;
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    if (!headerPassed) {
      if (/name/i.test(cells[0])) { headerPassed = true; continue; }
      if (/^[-:]+$/.test(cells[0])) continue;
    }
    if (/^[-:]+$/.test(cells[0])) continue;
    const [name, role] = cells;
    if (!name || !role) continue;
    // Skip known non-castable members
    if (/^(Squad|Ralph|@copilot|Scribe)/i.test(name)) continue;
    members.push({ name: name.toLowerCase(), role });
  }
  return members;
}

/**
 * Infer role slug from a role description string.
 */
function inferRoleSlug(roleDesc, configApps) {
  const lower = roleDesc.toLowerCase();
  for (const [slug, keywords] of Object.entries(ROLE_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) return slug;
  }
  // Fallback: check config.json apps keys
  if (configApps) {
    for (const key of Object.keys(configApps)) {
      if (lower.includes(key)) return key;
    }
  }
  return null;
}

/**
 * Build agentNameMap from team.md + existing config.json apps.
 */
function buildAgentNameMap(configApps) {
  const members = parseTeamMembers();
  const map = {};
  const warnings = [];

  for (const { name, role } of members) {
    let slug = inferRoleSlug(role, configApps);
    if (!slug && configApps && Object.prototype.hasOwnProperty.call(configApps, name)) {
      slug = name;
    }
    if (slug) {
      map[name] = slug;
    } else {
      warnings.push(`  ⚠ Could not infer role slug for ${name} (role: "${role}") — add manually to config.json agentNameMap`);
    }
  }

  if (warnings.length > 0) {
    console.log('\nWarnings:');
    warnings.forEach(w => console.log(w));
  }

  return map;
}

function getAgentDirs() {
  if (!existsSync(AGENTS_DIR)) return [];
  return readdirSync(AGENTS_DIR).filter(name => {
    const charterPath = join(AGENTS_DIR, name, 'charter.md');
    return existsSync(charterPath) && statSync(join(AGENTS_DIR, name)).isDirectory();
  });
}

// ---------------------------------------------------------------------------
// --status
// ---------------------------------------------------------------------------

function cmdStatus() {
  const cfg = loadConfig();
  if (!cfg) {
    console.log('❌ No identity config found at:', CONFIG_PATH);
    console.log('   Run: node configure-identity.mjs --update-charters');
    process.exitCode = 1;
    return;
  }

  console.log('\n🔍 Squad Identity Status\n');
  console.log('Tier:', cfg.tier ?? 'unknown');
  console.log('Config:', CONFIG_PATH);
  console.log();

  if (cfg.agentNameMap && Object.keys(cfg.agentNameMap).length > 0) {
    console.log('Agent → Role Slug mapping:');
    for (const [agent, slug] of Object.entries(cfg.agentNameMap)) {
      const app = cfg.apps?.[slug];
      const appInfo = app ? ` (${app.appSlug})` : ' ⚠ no app configured';
      console.log(`  ${agent.padEnd(12)} → ${slug}${appInfo}`);
    }
  } else {
    console.log('⚠ No agentNameMap. Run --update-charters to populate.');
  }

  console.log();
  if (cfg.apps && Object.keys(cfg.apps).length > 0) {
    console.log('Registered apps:');
    for (const [slug, app] of Object.entries(cfg.apps)) {
      console.log(`  ${slug.padEnd(14)} appId=${app.appId}  slug=${app.appSlug}`);
    }
  } else {
    console.log('⚠ No apps registered.');
  }
}

// ---------------------------------------------------------------------------
// --doctor
// ---------------------------------------------------------------------------

function loadRegistrationFiles() {
  const appsDir = join(IDENTITY_DIR, 'apps');
  const registrations = new Map();
  if (!existsSync(appsDir)) return registrations;

  for (const file of readdirSync(appsDir)) {
    if (!file.endsWith('.json')) continue;
    const role = file.replace(/\.json$/, '');
    const path = join(appsDir, file);
    try {
      registrations.set(role, { path, data: JSON.parse(readFileSync(path, 'utf-8')), error: null });
    } catch (error) {
      registrations.set(role, { path, data: null, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return registrations;
}

function getConfiguredRoles(cfg, registrations) {
  // Only show roles that the team actually uses (from agentNameMap values)
  const teamRoles = new Set(Object.values(cfg?.agentNameMap ?? {}));

  // If agentNameMap exists and has entries, filter to team roles only
  if (teamRoles.size > 0) {
    // Include roles that have both a registration AND are used by the team
    const roles = new Set();
    for (const role of teamRoles) {
      if (registrations.has(role) || cfg?.apps?.[role]) {
        roles.add(role);
      }
    }
    return [...roles].sort();
  }

  // Fallback: no agentNameMap — show all registered roles
  const roles = new Set();
  for (const role of Object.keys(cfg?.apps ?? {})) {
    if (!role.startsWith('_')) roles.add(role);
  }
  for (const role of registrations.keys()) {
    roles.add(role);
  }
  return [...roles].sort();
}

async function verifyRoleHealth(role, cfgApp, registration, keychainModule, keychainAvailable, resolveTokenPath) {
  let ok = true;
  console.log(`  ${role}`);

  if (!registration) {
    console.log(`    ❌ No registration file — run: squad-identity create-apps --roles ${role}`);
    return false;
  }

  if (registration.error || !registration.data) {
    console.log(`    ❌ Registration unreadable: ${registration.path}`);
    if (registration.error) console.log(`       ${registration.error}`);
    return false;
  }

  const appId = registration.data.appId ?? cfgApp?.appId;
  console.log(`    ✅ Registration: ${registration.path.replace(REPO_ROOT + '/', '')} (appId: ${appId ?? 'missing'})`);

  if (!appId || appId === 0) {
    console.log(`    ❌ Registration missing appId — run: squad-identity create-app --role ${role}`);
    return false;
  }

  if (!keychainModule) {
    console.log('    ⚠ Keychain module unavailable — cannot verify private key locally');
    return false;
  }

  if (!keychainAvailable) {
    console.log('    ❌ OS keychain unavailable — install libsecret-tools (Linux) or use macOS Keychain');
    return false;
  }

  let pem = null;
  try {
    pem = await keychainModule.keychainLoad(String(appId));
  } catch {
    pem = null;
  }

  if (!pem) {
    console.log(`    ❌ No private key in keychain — run: squad-identity create-app --role ${role}`);
    ok = false;
  } else {
    console.log('    ✅ Private key in keychain');
  }

  const installationId = registration.data.installationId;
  if (!installationId) {
    console.log(`    ❌ No installation ID — run: squad-identity setup`);
    return false;
  }
  console.log(`    ✅ Installation ID: ${installationId}`);

  if (!pem) return false;

  if (!existsSync(resolveTokenPath)) {
    console.log('    ❌ resolve-token.mjs missing — run: squad-identity init');
    return false;
  }

  try {
    const token = execFileSync(
      process.execPath,
      [resolveTokenPath, '--required', role],
      { cwd: REPO_ROOT, encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    if (!token) {
      console.log('    ❌ Token resolution returned empty output');
      return false;
    }

    console.log(`    ✅ Token resolves (length: ${token.length})`);
  } catch (err) {
    const stderr = err.stderr?.trim() || '';
    const msg = stderr || err.message;
    console.log(`    ❌ Token resolution failed: ${msg}`);
    return false;
  }

  return ok;
}

async function cmdDoctor() {
  console.log('\n🩺 Identity Doctor\n');
  let ok = true;

  const cfg = loadConfig();
  if (!cfg) {
    console.log('❌ config.json missing:', CONFIG_PATH);
    ok = false;
  } else {
    console.log('✅ config.json found');

    if (!cfg.agentNameMap || Object.keys(cfg.agentNameMap).length === 0) {
      console.log('⚠  agentNameMap empty — run --update-charters');
      ok = false;
    } else {
      console.log(`✅ agentNameMap: ${Object.keys(cfg.agentNameMap).length} agents`);
    }
  }

  let keychainModule = null;
  let keychainAvailable = false;
  try {
    keychainModule = await import(new URL('./keychain.mjs', import.meta.url));
  } catch {
    keychainModule = null;
  }

  if (keychainModule) {
    keychainAvailable = await keychainModule.keychainAvailable();
    if (keychainAvailable) {
      console.log('✅ OS keychain available');
    } else {
      console.log('⚠  OS keychain not available — PEM keys cannot be resolved locally');
      console.log('   macOS: install Keychain Access (built-in)');
      console.log('   Linux: install libsecret-tools');
      ok = false;
    }
  } else {
    console.log('⚠  keychain.mjs not found — skipping keychain check');
    ok = false;
  }

  const resolveTokenPath = join(REPO_ROOT, '.github', 'extensions', 'squad-identity', 'lib', 'resolve-token.mjs');
  if (!existsSync(resolveTokenPath)) {
    console.log('⚠  resolve-token.mjs not found in extension lib — run squad-identity init');
    ok = false;
  } else {
    console.log('✅ resolve-token.mjs accessible');
  }

  const registrations = loadRegistrationFiles();
  const roles = getConfiguredRoles(cfg, registrations);
  if (roles.length === 0) {
    console.log('❌ No registered roles found in config.json or .squad/identity/apps/.');
    ok = false;
  } else {
    console.log('\nPer-role health:');
    for (const role of roles) {
      const roleOk = await verifyRoleHealth(
        role,
        cfg?.apps?.[role] ?? null,
        registrations.get(role) ?? null,
        keychainModule,
        keychainAvailable,
        resolveTokenPath,
      );
      if (!roleOk) ok = false;
    }
  }

  console.log('\n' + (ok ? '✅ Identity looks healthy.' : '⚠  Issues detected — see above.'));
}

// ---------------------------------------------------------------------------
// --update-charters
// ---------------------------------------------------------------------------

function cmdUpdateCharters() {
  console.log('\n🔄 Updating agent charters...\n');

  const cfg = loadConfig();
  if (!cfg) {
    console.log('❌ No config.json found at:', CONFIG_PATH);
    console.log('   Cannot infer role slugs without an existing identity config.');
    process.exit(1);
  }

  // Build agentNameMap, merging inferred with any existing manual overrides
  const inferred = buildAgentNameMap(cfg.apps);
  const existing = cfg.agentNameMap ?? {};
  const merged = { ...inferred };
  // Preserve manual overrides that aren't empty placeholders
  for (const [k, v] of Object.entries(existing)) {
    if (v && v !== '') merged[k] = v;
  }

  cfg.agentNameMap = merged;
  saveConfig(cfg);
  console.log(`✅ agentNameMap written (${Object.keys(merged).length} agents):`);
  for (const [agent, slug] of Object.entries(merged)) {
    console.log(`   ${agent.padEnd(12)} → ${slug}`);
  }
  console.log();

  const agents = getAgentDirs();
  if (agents.length === 0) {
    console.log('⚠  No agent directories found in:', AGENTS_DIR);
    return;
  }

  const SKILL_POINTER = `.squad/skills/squad-identity/SKILL.md`;
  const SKILL_REF_LINE = `Relevant skill: '${SKILL_POINTER}' — read before any GitHub write.`;

  for (const agentName of agents) {
    const charterPath = join(AGENTS_DIR, agentName, 'charter.md');
    let content = readFileSync(charterPath, 'utf-8');

    const slug = merged[agentName];
    let changed = false;

    // Inject concrete ROLE_SLUG, replacing template var or existing injected line
    if (slug) {
      const roleSlugLine = `ROLE_SLUG="${slug}"  # injected by configure-identity --update-charters; do not edit`;
      if (/ROLE_SLUG=["']\{role_slug\}["']/.test(content)) {
        content = content.replace(/ROLE_SLUG=["']\{role_slug\}["'][^\n]*/g, roleSlugLine);
        changed = true;
      } else if (/ROLE_SLUG=["'][^"']*["'].*# injected/.test(content)) {
        content = content.replace(/ROLE_SLUG=["'][^"']*["'][^\n]*# injected[^\n]*/g, roleSlugLine);
        changed = true;
      }
      // If no ROLE_SLUG at all, the agent will use squad_identity_status — no injection needed
    }

    // Add skill pointer if not already present
    if (!content.includes(SKILL_REF_LINE)) {
      content = content.trimEnd() + '\n\n' + SKILL_REF_LINE + '\n';
      changed = true;
    }

    if (changed) {
      writeFileSync(charterPath, content, 'utf-8');
      console.log(`✅ ${agentName}${slug ? ` (ROLE_SLUG="${slug}")` : ''} — charter updated`);
    } else {
      console.log(`✓  ${agentName} — already up to date`);
    }
  }

  console.log('\n✅ Charter update complete.');
}

// ---------------------------------------------------------------------------
// --update-copilot-instructions
// ---------------------------------------------------------------------------

const IDENTITY_BLOCK_START = '<!-- squad-identity: start -->';
const IDENTITY_BLOCK_END   = '<!-- squad-identity: end -->';

function buildIdentityBlock() {
  return `${IDENTITY_BLOCK_START}
## GIT IDENTITY — Bot Authentication

This project uses GitHub App bot identity for all agent-authored writes.
Read \`.squad/skills/squad-identity/SKILL.md\` before any GitHub write.

**Use the \`squad_identity_resolve_token\` tool** to get a bot token for your ROLE_SLUG.

Your ROLE_SLUG is injected into your charter — look for:
\`\`\`
ROLE_SLUG="<slug>"  # injected by configure-identity --update-charters
\`\`\`

If absent, call \`squad_identity_status\` to see the full agentNameMap.

**Token usage (inline per-call, never export):**
\`\`\`bash
GH_TOKEN="$TOKEN" gh pr create ...
GH_TOKEN="$TOKEN" gh api /repos/{owner}/{repo}/issues -f title="..." 
git push "https://x-access-token:\${TOKEN}@github.com/{owner}/{repo}.git" HEAD
\`\`\`
${IDENTITY_BLOCK_END}`;
}

function cmdUpdateCopilotInstructions() {
  console.log('\n🔄 Updating .github/copilot-instructions.md...\n');

  const block = buildIdentityBlock();

  if (!existsSync(COPILOT_INSTRUCTIONS)) {
    writeFileSync(COPILOT_INSTRUCTIONS, block + '\n', 'utf-8');
    console.log('✅ Created .github/copilot-instructions.md with identity block');
    return;
  }

  let content = readFileSync(COPILOT_INSTRUCTIONS, 'utf-8');
  const startIdx = content.indexOf(IDENTITY_BLOCK_START);
  const endIdx   = content.indexOf(IDENTITY_BLOCK_END);

  if (startIdx !== -1 && endIdx !== -1) {
    content = content.slice(0, startIdx) + block + content.slice(endIdx + IDENTITY_BLOCK_END.length);
    console.log('✅ Replaced existing identity block');
  } else {
    content = content.trimEnd() + '\n\n' + block + '\n';
    console.log('✅ Appended identity block');
  }

  writeFileSync(COPILOT_INSTRUCTIONS, content, 'utf-8');
  console.log('   File:', COPILOT_INSTRUCTIONS);
}

// ---------------------------------------------------------------------------
// --inject-context
// ---------------------------------------------------------------------------

async function cmdInjectContext(jsonStr) {
  const parsed = JSON.parse(jsonStr);
  const { role, scopeId, appSlug, installationId, repoRoot } = parsed;

  const { buildIdentityContext } = await import(
    new URL('./identity-context-builder.mjs', import.meta.url)
  );

  const contextBlock = buildIdentityContext({ role, scopeId, appSlug, installationId, repoRoot });

  const cfg = loadConfig();
  if (!cfg) {
    console.error(JSON.stringify({ success: false, error: 'config.json not found' }));
    process.exit(1);
  }

  // Find agent name that maps to this role
  const agentNameMap = cfg.agentNameMap ?? {};
  const agent = Object.entries(agentNameMap).find(([, slug]) => slug === role)?.[0];
  if (!agent) {
    console.error(JSON.stringify({ success: false, error: `No agent mapped to role "${role}"` }));
    process.exit(1);
  }

  const charterPath = join(AGENTS_DIR, agent, 'charter.md');
  if (!existsSync(charterPath)) {
    console.error(JSON.stringify({ success: false, error: `Charter not found: ${charterPath}` }));
    process.exit(1);
  }

  let content = readFileSync(charterPath, 'utf-8');
  const startTag = '<IDENTITY_CONTEXT>';
  const endTag = '</IDENTITY_CONTEXT>';
  const wrappedBlock = `${startTag}\n${contextBlock}\n${endTag}`;

  const startIdx = content.indexOf(startTag);
  const endIdx = content.indexOf(endTag);

  if (startIdx !== -1 && endIdx !== -1) {
    content = content.slice(0, startIdx) + wrappedBlock + content.slice(endIdx + endTag.length);
  } else {
    content = content.trimEnd() + '\n\n' + wrappedBlock + '\n';
  }

  writeFileSync(charterPath, content, 'utf-8');
  console.log(JSON.stringify({ success: true, agent, charterPath }));
}

// ---------------------------------------------------------------------------
// --inject-coordinator-context
// ---------------------------------------------------------------------------

async function cmdInjectCoordinatorContext() {
  const { buildCoordinatorContext } = await import(
    new URL('./identity-context-builder.mjs', import.meta.url)
  );

  const cfg = loadConfig();
  if (!cfg) {
    console.error(JSON.stringify({ success: false, error: 'config.json not found' }));
    process.exit(1);
  }

  // Build roles array from apps section
  const apps = cfg.apps ?? {};
  const roles = Object.entries(apps)
    .filter(([slug]) => !slug.startsWith('_'))
    .map(([slug, app]) => ({
      role: slug,
      appSlug: app.appSlug,
      appId: app.appId,
      installationId: app.installationId,
    }));

  const contextBlock = buildCoordinatorContext(roles);

  // Find the coordinator/lead agent
  const agentNameMap = cfg.agentNameMap ?? {};
  const leadEntry = Object.entries(agentNameMap).find(
    ([, slug]) => slug === 'lead' || slug === 'coordinator'
  );
  if (!leadEntry) {
    console.error(JSON.stringify({ success: false, error: 'No agent mapped to "lead" or "coordinator" role' }));
    process.exit(1);
  }

  const charterPath = join(AGENTS_DIR, leadEntry[0], 'charter.md');
  if (!existsSync(charterPath)) {
    console.error(JSON.stringify({ success: false, error: `Charter not found: ${charterPath}` }));
    process.exit(1);
  }

  let content = readFileSync(charterPath, 'utf-8');
  const startTag = '<COORDINATOR_IDENTITY_CONTEXT>';
  const endTag = '</COORDINATOR_IDENTITY_CONTEXT>';
  const wrappedBlock = `${startTag}\n${contextBlock}\n${endTag}`;

  const startIdx = content.indexOf(startTag);
  const endIdx = content.indexOf(endTag);

  if (startIdx !== -1 && endIdx !== -1) {
    content = content.slice(0, startIdx) + wrappedBlock + content.slice(endIdx + endTag.length);
  } else {
    content = content.trimEnd() + '\n\n' + wrappedBlock + '\n';
  }

  writeFileSync(charterPath, content, 'utf-8');
  console.log(JSON.stringify({ success: true, charterPath }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.includes('--status')) {
  cmdStatus();
} else if (args.includes('--doctor')) {
  await cmdDoctor();
} else if (args.includes('--update-charters')) {
  cmdUpdateCharters();
} else if (args.includes('--update-copilot-instructions')) {
  cmdUpdateCopilotInstructions();
} else if (args.includes('--inject-context')) {
  const idx = args.indexOf('--inject-context');
  const jsonArg = args[idx + 1];
  if (!jsonArg) {
    console.error(JSON.stringify({ success: false, error: '--inject-context requires a JSON string argument' }));
    process.exit(1);
  }
  await cmdInjectContext(jsonArg);
} else if (args.includes('--inject-coordinator-context')) {
  await cmdInjectCoordinatorContext();
} else {
  console.log(`
Usage: node configure-identity.mjs <flag>

Flags:
  --status                      Print agentNameMap + registered apps
  --doctor                      Health check
  --update-charters             Infer agentNameMap from team.md, write to config.json,
                                inject ROLE_SLUG into each agent charter
  --update-copilot-instructions Replace/append identity block in .github/copilot-instructions.md
  --inject-context <json>       Inject identity context block into an agent's charter
                                JSON: { "role", "scopeId", "appSlug", "installationId", "repoRoot" }
  --inject-coordinator-context  Inject coordinator identity context into the lead agent's charter
`);
  process.exit(1);
}
