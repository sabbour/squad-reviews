#!/usr/bin/env node
// sync-secrets.mjs — Upload squad PEM keys and app IDs as GitHub repo secrets.
//
// Usage:
//   node sync-secrets.mjs           # sync all roles
//   node sync-secrets.mjs --check    # dry-run: show status
//   node sync-secrets.mjs --role lead # sync one role only
//
// Reads PEM keys from OS keychain (keyed by appId).
//
// Secrets created per role (matching the names resolve-token.mjs expects):
//   SQUAD_{ROLE}_PRIVATE_KEY      (PEM file content)
//   SQUAD_{ROLE}_APP_ID           (numeric app ID)
//   SQUAD_{ROLE}_INSTALLATION_ID  (numeric installation ID)

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// OS keychain integration
let keychainLoad = null;
let keychainAvailable = null;
try {
  const keychain = await import('./keychain.mjs');
  keychainLoad = keychain.keychainLoad;
  keychainAvailable = keychain.keychainAvailable;
} catch {
  // Keychain module unavailable
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const projectRoot = join(dirname(__filename), '..', '..');

function secretNameKey(role) {
  return `SQUAD_${role.toUpperCase()}_PRIVATE_KEY`;
}
function secretNameId(role) {
  return `SQUAD_${role.toUpperCase()}_APP_ID`;
}
function secretNameInstallId(role) {
  return `SQUAD_${role.toUpperCase()}_INSTALLATION_ID`;
}

function detectRepo() {
  const res = spawnSync('git', ['remote', 'get-url', 'origin'], {
    cwd: projectRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  const url = (res.stdout || '').trim();
  // Handle HTTPS (github.com/owner/repo.git) and SSH (git@github.com:owner/repo.git)
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) {
    console.error('❌  Could not detect owner/repo from git remote origin');
    process.exit(1);
  }
  return { owner: m[1], repo: m[2] };
}

function ghSecretSet(secretName, value, nwo) {
  const res = spawnSync('gh', ['secret', 'set', secretName, '--repo', nwo], {
    input: value,
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  return res.status === 0;
}

function ghSecretList(nwo) {
  const res = spawnSync('gh', ['secret', 'list', '--repo', nwo, '--json', 'name'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  if (res.status !== 0) return new Set();
  try {
    return new Set(JSON.parse(res.stdout).map((s) => s.name));
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const roleIdx = args.indexOf('--role');
const filterRole = roleIdx !== -1 ? args[roleIdx + 1] : null;

if (roleIdx !== -1 && (!filterRole || filterRole.startsWith('--'))) {
  console.error('❌  --role requires a non-empty value. Usage: --role <role>');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load identity config
// ---------------------------------------------------------------------------

const configPath = join(projectRoot, '.squad', 'identity', 'config.json');
if (!existsSync(configPath)) {
  console.error('❌  Missing', configPath);
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, 'utf-8'));

if (!keychainLoad || !keychainAvailable || !keychainAvailable()) {
  console.error(
    '❌  OS keychain is not available on this system.\n' +
    '    sync-secrets reads PEM keys from the OS keychain.\n\n' +
    '    To fix this:\n' +
    '      macOS: Keychain Access is built-in (security command should be available)\n' +
    '      Linux: Install libsecret — apt install libsecret-tools (Ubuntu/Debian)\n' +
    '             or dnf install libsecret (Fedora/RHEL)'
  );
  process.exit(1);
}

const { owner, repo } = detectRepo();
const nwo = `${owner}/${repo}`;

console.log(`\n🔐  sync-secrets — repo: ${nwo}`);

// ---------------------------------------------------------------------------
// Discover roles from .squad/identity/apps/ directory
// ---------------------------------------------------------------------------

const appsDir = join(projectRoot, '.squad', 'identity', 'apps');
let allRoles = [];

if (existsSync(appsDir)) {
  const files = readdirSync(appsDir).filter((f) => extname(f) === '.json');
  allRoles = files.map((f) => f.replace(/\.json$/, ''));
} else {
  // Fallback to config.apps if apps/ directory doesn't exist
  allRoles = Object.keys(config.apps);
}

// ---------------------------------------------------------------------------
// Build work list
// ---------------------------------------------------------------------------

const roles = allRoles.filter((r) => !filterRole || r === filterRole);
if (filterRole && roles.length === 0) {
  console.error(`❌  Role "${filterRole}" not found in config.json`);
  process.exit(1);
}

// Fetch existing secrets once for --check or summary
const existing = ghSecretList(nwo);

// ---------------------------------------------------------------------------
// Process
// ---------------------------------------------------------------------------

const results = [];

for (const role of roles) {
  // Load app registration from individual role file
  let appId = null;
  let installationId = null;
  const appFilePath = join(projectRoot, '.squad', 'identity', 'apps', `${role}.json`);
  
  if (existsSync(appFilePath)) {
    try {
      const appData = JSON.parse(readFileSync(appFilePath, 'utf-8'));
      appId = appData.appId;
      installationId = appData.installationId ?? null;
    } catch (e) {
      console.error(`❌  Failed to parse ${appFilePath}`);
      process.exit(1);
    }
  } else if (config.apps?.[role]) {
    appId = config.apps[role].appId;
    installationId = config.apps[role].installationId ?? null;
  }
  
  if (!appId) {
    console.error(`❌  Could not find app ID for role "${role}"`);
    process.exit(1);
  }

  // Load PEM from keychain
  const pem = keychainLoad(appId);
  const hasPem = Boolean(pem);
  const keySecret = secretNameKey(role);
  const idSecret = secretNameId(role);
  const installSecret = secretNameInstallId(role);
  const hasInstallId = installationId != null;

  if (checkOnly) {
    results.push({
      role,
      keySecret,
      keyStatus: existing.has(keySecret) ? '✅ exists' : hasPem ? '⚠️  missing (PEM in keychain)' : '❌ missing (no PEM in keychain)',
      idSecret,
      idStatus: existing.has(idSecret) ? '✅ exists' : '⚠️  missing',
      installSecret,
      installStatus: existing.has(installSecret) ? '✅ exists' : hasInstallId ? '⚠️  missing' : '⏭️  no installationId',
    });
    continue;
  }

  // --- Upload PEM ---
  let keyStatus;
  if (hasPem) {
    const ok = ghSecretSet(keySecret, pem, nwo);
    keyStatus = ok ? '✅ synced' : '❌ failed';
  } else {
    keyStatus = '⏭️  skipped (no PEM in keychain)';
  }

  // --- Upload App ID ---
  const ok = ghSecretSet(idSecret, String(appId), nwo);
  const idStatus = ok ? '✅ synced' : '❌ failed';

  // --- Upload Installation ID ---
  let installStatus;
  if (hasInstallId) {
    const okInstall = ghSecretSet(installSecret, String(installationId), nwo);
    installStatus = okInstall ? '✅ synced' : '❌ failed';
  } else {
    installStatus = '⏭️  skipped (no installationId)';
  }

  results.push({ role, keySecret, keyStatus, idSecret, idStatus, installSecret, installStatus });
}

// ---------------------------------------------------------------------------
// Summary table
// ---------------------------------------------------------------------------

console.log('Role'.padEnd(14) + 'Private Key Secret'.padEnd(36) + 'Status'.padEnd(26) + 'App ID Secret'.padEnd(30) + 'Status'.padEnd(16) + 'Install ID Secret'.padEnd(36) + 'Status');
console.log('─'.repeat(172));
for (const r of results) {
  console.log(
    r.role.padEnd(14) +
      r.keySecret.padEnd(36) +
      r.keyStatus.padEnd(26) +
      r.idSecret.padEnd(30) +
      r.idStatus.padEnd(16) +
      r.installSecret.padEnd(36) +
      r.installStatus,
  );
}
console.log();
