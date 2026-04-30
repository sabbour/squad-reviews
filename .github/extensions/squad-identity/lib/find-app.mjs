#!/usr/bin/env node
// find-app.mjs — Locate an existing GitHub App by name/slug and register it for a role.
//
// Usage: node find-app.mjs --name <name> [--org <org>] [--role <role>] [--pem <path>]
//
// Search order:
//   1. gh api /apps/{slug}           — public app lookup by exact slug
//   2. gh api /user/installations    — user-owned installations (paginated)
//   3. gh api /orgs/{org}/installations — org installations (if --org given)
//
// After finding the app, opens the install URL in the browser, prompts for
// installation ID, then delegates to import-app logic for registration.

import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HELP_TEXT = `Usage: node find-app.mjs --name <name> [--org <org>] [--role <role>] [--pem <path>] [--force]

Search for an existing GitHub App by name or slug and register it for a Squad role.

Options:
  --name <name>     App name or slug to search for (required)
  --org <org>       Search this org's installations too (optional)
  --role <role>     Role slug to register the app under (optional, prompts if omitted)
  --pem <path>      Path to PEM private key file (optional, prompts if omitted)
  --force           Overwrite existing role registration without prompting
  --help, -h        Show this help message`;

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const values = { name: null, org: null, role: null, pem: null, force: false };
  const valueFlags = new Set(['--name', '--org', '--role', '--pem']);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') { values.help = true; continue; }
    if (arg === '--force') { values.force = true; continue; }

    if (!arg.startsWith('--')) fail(`Unknown argument: ${arg}`);

    const [flag, inlineValue] = arg.split('=', 2);
    if (!valueFlags.has(flag)) fail(`Unknown flag: ${arg}`);

    const nextValue = inlineValue ?? argv[i + 1];
    if (!nextValue || nextValue.startsWith('--')) fail(`Missing value for ${flag}.`);

    values[flag.slice(2)] = nextValue;
    if (inlineValue === undefined) i++;
  }

  return values;
}

function getProjectRoot() {
  // From extensions/squad-identity/lib/ → .github/ → repo root
  return join(__dirname, '..', '..', '..', '..');
}

function isWsl() {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try { return /microsoft/i.test(readFileSync('/proc/version', 'utf8')); } catch { return false; }
}

function openBrowser(url) {
  let bin, args;
  if (isWsl()) {
    bin = 'cmd.exe'; args = ['/c', 'start', '', url];
  } else if (process.platform === 'darwin') {
    bin = 'open'; args = [url];
  } else if (process.platform === 'win32') {
    bin = 'cmd.exe'; args = ['/c', 'start', '', url];
  } else {
    bin = 'xdg-open'; args = [url];
  }
  execFile(bin, args, err => {
    if (err) {
      console.log('  Could not open browser automatically.');
      console.log(`  Open manually: ${url}`);
    }
  });
}

function ghApi(endpoint, extraArgs = []) {
  const result = spawnSync('gh', ['api', endpoint, ...extraArgs], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) fail(`gh CLI error: ${result.error.message}`);
  if (result.status !== 0) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}

function normalizeSlug(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function matchApp(app, searchName) {
  const lowerName = searchName.toLowerCase();
  const slug = (app.slug ?? app.app_slug ?? '').toLowerCase();
  const name = (app.name ?? app.app?.name ?? '').toLowerCase();
  return slug.includes(lowerName) || name.includes(lowerName);
}

async function searchForApp(searchName, org) {
  const slug = normalizeSlug(searchName);

  // 1. Direct public app lookup by slug
  console.log(`🔍 Looking up public app by slug: ${slug}`);
  const directApp = ghApi(`/apps/${slug}`);
  if (directApp && directApp.id) {
    console.log(`   Found: ${directApp.name} (ID: ${directApp.id}, slug: ${directApp.slug})`);
    return {
      appId: directApp.id,
      appSlug: directApp.slug,
      appName: directApp.name,
      owner: directApp.owner?.login ?? null,
      htmlUrl: directApp.html_url ?? null,
      permissions: directApp.permissions ?? {},
      source: 'public-lookup',
    };
  }

  // 2. Search user installations
  console.log(`🔍 Searching user installations...`);
  const userInstalls = ghApi('/user/installations', ['--paginate']);
  if (Array.isArray(userInstalls?.installations)) {
    for (const inst of userInstalls.installations) {
      if (matchApp(inst.app ?? inst, searchName)) {
        const app = inst.app ?? inst;
        return {
          appId: app.id ?? inst.app_id,
          appSlug: app.slug ?? inst.app_slug,
          appName: app.name ?? inst.app?.name,
          owner: inst.account?.login ?? null,
          htmlUrl: app.html_url ?? null,
          installationId: inst.id,
          permissions: inst.permissions ?? {},
          source: 'user-installations',
        };
      }
    }
  }

  // 3. Org installations if --org provided
  if (org) {
    console.log(`🔍 Searching org "${org}" installations...`);
    const orgInstalls = ghApi(`/orgs/${org}/installations`);
    const list = orgInstalls?.installations ?? [];
    for (const inst of list) {
      if (matchApp(inst.app ?? inst, searchName)) {
        const app = inst.app ?? inst;
        return {
          appId: app.id ?? inst.app_id,
          appSlug: app.slug ?? inst.app_slug,
          appName: app.name ?? inst.app?.name,
          owner: org,
          htmlUrl: app.html_url ?? null,
          installationId: inst.id,
          permissions: inst.permissions ?? {},
          source: `org:${org}`,
        };
      }
    }
  }

  return null;
}

function displayApp(found) {
  console.log('\n┌─────────────────────────────────────────┐');
  console.log('│              App Found                  │');
  console.log('├─────────────────────────────────────────┤');
  console.log(`│  Name:   ${(found.appName ?? '(unknown)').padEnd(31)}│`);
  console.log(`│  ID:     ${String(found.appId ?? '(unknown)').padEnd(31)}│`);
  console.log(`│  Slug:   ${(found.appSlug ?? '(unknown)').padEnd(31)}│`);
  console.log(`│  Owner:  ${(found.owner ?? '(unknown)').padEnd(31)}│`);
  if (found.installationId) {
    console.log(`│  Inst.:  ${String(found.installationId).padEnd(31)}│`);
  }
  console.log(`│  Source: ${found.source.padEnd(31)}│`);
  console.log('└─────────────────────────────────────────┘');

  const perms = Object.entries(found.permissions);
  if (perms.length) {
    console.log('\nPermissions:');
    for (const [k, v] of perms) console.log(`  ${k}: ${v}`);
  }
}

async function promptLine(rl, question) {
  return new Promise(res => rl.question(question, res));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getExistingInstallationIds() {
  const data = ghApi('/user/installations', ['--paginate']);
  const installations = data?.installations ?? [];
  return new Set(installations.map(inst => String(inst.id)));
}

async function pollForNewInstallation(appSlug, preInstallIds, timeoutSec, intervalSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  const slugLower = appSlug.toLowerCase();

  while (Date.now() < deadline) {
    await sleep(intervalSec * 1000);
    const data = ghApi('/user/installations', ['--paginate']);
    const installations = data?.installations ?? [];
    for (const inst of installations) {
      const instSlug = (inst.app_slug ?? inst.app?.slug ?? '').toLowerCase();
      if (instSlug === slugLower && !preInstallIds.has(String(inst.id))) {
        return String(inst.id);
      }
    }
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP_TEXT); return; }
  if (!args.name) fail('--name is required. Example: node find-app.mjs --name my-squad-backend');

  const projectRoot = getProjectRoot();

  // Search for the app
  const found = await searchForApp(args.name, args.org);
  if (!found) {
    fail(`No GitHub App found matching "${args.name}".
Tried:
  • Public app slug lookup: /apps/${normalizeSlug(args.name)}
  • User installations: /user/installations
${args.org ? `  • Org installations: /orgs/${args.org}/installations` : '  • (No --org provided; use --org <org> to search org installations)'}

If the app was created manually, use import-app instead:
  squad-identity import-app --role <role> --app-id <id> --app-slug <slug> --pem <path>`);
  }

  displayApp(found);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => promptLine(rl, q);

  // Resolve role
  let role = args.role;
  if (!role) {
    role = (await ask('\nRole slug to register this app under (e.g., backend, lead, tester): ')).trim();
    if (!role) { rl.close(); fail('Role slug is required.'); }
  }

  // Determine install URL and open browser if no installation ID yet
  const installUrl = `https://github.com/apps/${found.appSlug}/installations/new`;
  let installationId = found.installationId ? String(found.installationId) : null;

  if (!installationId) {
    // Snapshot existing installations before opening browser
    const preInstalls = getExistingInstallationIds();

    console.log(`\n🌐 Opening browser to install the app into your repo:\n   ${installUrl}`);
    openBrowser(installUrl);

    // Poll for new installation matching this app's slug
    console.log('\n⏳ Waiting for installation to complete (polling every 3s, timeout: 2min)...');
    installationId = await pollForNewInstallation(found.appSlug, preInstalls, 120, 3);

    if (installationId) {
      console.log(`✅ Detected installation ID: ${installationId}`);
    } else {
      // Timeout — fall back to manual prompt
      console.log('\n⚠️  Could not auto-detect the installation. Please provide it manually.');
      installationId = (await ask('   Paste the installation ID (from the browser URL, e.g., /installations/12345678): ')).trim();
      // Strip leading/trailing non-digits in case they pasted a URL fragment
      const match = installationId.match(/\d+/);
      if (match) installationId = match[0];
      if (!installationId) { rl.close(); fail('Installation ID is required.'); }
    }
  }

  // Resolve PEM path (optional prompt)
  let pemPath = args.pem;
  if (!pemPath) {
    const pemInput = (await ask('\nPath to PEM private key file (leave blank to skip): ')).trim();
    if (pemInput) pemPath = pemInput;
  }

  rl.close();

  // Validate PEM if provided
  let pemContent = null;
  if (pemPath) {
    const resolvedPem = resolve(pemPath.replace(/^~/, process.env.HOME ?? ''));
    if (!existsSync(resolvedPem)) fail(`PEM file not found: ${resolvedPem}`);
    pemContent = readFileSync(resolvedPem, 'utf-8');
    if (!pemContent.includes('-----BEGIN RSA PRIVATE KEY-----') && !pemContent.includes('-----BEGIN PRIVATE KEY-----')) {
      fail(`File at ${resolvedPem} does not appear to be a PEM private key.`);
    }
    pemPath = resolvedPem;
  }

  // Idempotency guard — check for existing registration
  const appsDir = join(projectRoot, '.squad', 'identity', 'apps');
  mkdirSync(appsDir, { recursive: true });
  const appPath = join(appsDir, `${role}.json`);
  if (existsSync(appPath)) {
    try {
      const existing = JSON.parse(readFileSync(appPath, 'utf-8'));
      console.warn(`⚠️  Role "${role}" already has an app registered: ${existing.slug ?? '(unknown)'} (ID: ${existing.appId ?? '?'})`);
    } catch {
      console.warn(`⚠️  Role "${role}" already has a registration file: ${appPath}`);
    }
    if (!args.force) {
      if (process.stdin.isTTY) {
        const rl2 = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise(res => rl2.question('Overwrite? [y/N] ', res));
        rl2.close();
        if (answer.trim().toLowerCase() !== 'y') {
          console.log('Aborted.');
          process.exit(0);
        }
      } else {
        fail('Role already registered. Use --force to overwrite in non-interactive mode.');
      }
    }
  }

  // Save app registration
  const appData = {
    appId: found.appId,
    slug: found.appSlug,
    appName: found.appName,
    installationId: Number(installationId),
    ...(found.owner && { owner: found.owner }),
  };
  writeFileSync(appPath, JSON.stringify(appData, null, 2) + '\n', 'utf-8');
  console.log(`\n✅ App registration saved: ${appPath}`);

  // Import PEM into keychain if provided
  if (pemPath) {
    const createAppPath = join(__dirname, 'create-app.mjs');
    const result = spawnSync(process.execPath, [createAppPath, '--import-key', pemPath, '--role', role], {
      cwd: projectRoot,
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      console.error('\n⚠️  PEM import failed. Registration saved — run `squad-identity rotate-key` to import the PEM later.');
      process.exit(result.status ?? 1);
    }
  } else {
    console.log('   No PEM provided — skipped keychain storage. Use `squad-identity rotate-key --role ' + role + '` to import later.');
  }

  console.log(`\n✅ App "${found.appSlug}" (ID: ${found.appId}) registered for role "${role}".`);
  console.log('   Next: run `squad-identity setup` to update charters, or `squad-identity doctor` to verify.');
}

main().catch(err => { console.error(err.message); process.exit(2); });
