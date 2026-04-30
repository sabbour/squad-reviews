#!/usr/bin/env node

import { execFile, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const ROLE_PATTERNS = [
  { slug: "security", keywords: ["security", "auth", "compliance"] },
  { slug: "frontend", keywords: ["frontend", "ui", "design"] },
  { slug: "backend", keywords: ["backend", "api", "server"] },
  { slug: "tester", keywords: ["test", "qa", "quality"] },
  { slug: "codereview", keywords: ["code review", "reviewer", "review"] },
  { slug: "scribe", keywords: ["scribe"] },
  { slug: "devops", keywords: ["devops", "infra", "platform"] },
  { slug: "docs", keywords: ["docs", "devrel", "writer"] },
  { slug: "data", keywords: ["data", "database", "analytics"] },
  { slug: "lead", keywords: ["lead", "architect", "tech lead"] },
];

const HELP_TEXT = `Usage: node install-apps.mjs [--check] [--role <role>]

Options:
  --check          Report installation status without opening browser tabs
  --role <role>    Check/install only the specified configured role
  --help, -h       Show this help message`;

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const values = { check: false, roles: [] };
  const valueFlags = new Set(["--role", "--roles"]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      values.help = true;
      continue;
    }

    if (arg === "--check") {
      values.check = true;
      continue;
    }

    if (!arg.startsWith("--")) {
      fail(`Unknown argument: ${arg}`);
    }

    const [flag, inlineValue] = arg.split("=", 2);
    if (!valueFlags.has(flag)) {
      fail(`Unknown argument: ${arg}`);
    }

    const nextValue = inlineValue ?? argv[index + 1];
    if (!nextValue || nextValue.startsWith("--")) {
      fail(`Missing value for ${flag}.`);
    }

    if (flag === "--role" || flag === "--roles") {
      // Support comma-separated: --roles lead,backend,tester
      for (const r of nextValue.split(',')) {
        const trimmed = r.trim();
        if (trimmed) values.roles.push(trimmed);
      }
    }

    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return values;
}

function getProjectRoot() {
  let currentDir = resolve(process.cwd());

  while (true) {
    if (existsSync(join(currentDir, ".squad"))) {
      return currentDir;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      fail('Could not find repository root containing ".squad". Run this from the repo.');
    }

    currentDir = parentDir;
  }
}

function loadIdentityConfig(projectRoot) {
  const configPath = join(projectRoot, ".squad", "identity", "config.json");
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Load all per-role app registrations from .squad/identity/apps/*.json.
 * Returns a Map<roleSlug, { appId, slug, clientId, installationId, ... }>.
 */
function loadAppRegistrations(projectRoot) {
  const appsDir = join(projectRoot, ".squad", "identity", "apps");
  const registrations = new Map();

  if (!existsSync(appsDir)) return registrations;

  for (const file of readdirSync(appsDir)) {
    if (extname(file) !== ".json") continue;
    const role = file.replace(/\.json$/, "");
    try {
      const data = JSON.parse(readFileSync(join(appsDir, file), "utf8"));
      registrations.set(role, data);
    } catch {
      // Skip unparseable files
    }
  }

  return registrations;
}

function normalizeRoleKey(roleKey) {
  if (typeof roleKey !== "string") return null;
  const normalized = roleKey
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || null;
}

function stripMarkdownCell(value) {
  return value
    .replace(/`/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMarkdownRow(line) {
  if (!line.trim().startsWith("|")) return [];
  return line
    .trim()
    .slice(1, -1)
    .split("|")
    .map(cell => stripMarkdownCell(cell.trim()));
}

function parseTeamRoster(projectRoot) {
  const teamPath = join(projectRoot, ".squad", "team.md");

  try {
    const lines = readFileSync(teamPath, "utf8").split(/\r?\n/);
    const membersIndex = lines.findIndex(line => /^##\s+Members\b/i.test(line.trim()));
    if (membersIndex === -1) return [];

    let headerIndex = -1;
    for (let index = membersIndex + 1; index < lines.length - 1; index += 1) {
      if (
        lines[index].trim().startsWith("|") &&
        /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(lines[index + 1])
      ) {
        headerIndex = index;
        break;
      }
      if (index > membersIndex + 1 && /^##\s+/.test(lines[index].trim())) {
        break;
      }
    }

    if (headerIndex === -1) return [];

    const headers = parseMarkdownRow(lines[headerIndex]).map(header => normalizeRoleKey(header));
    const nameIndex = headers.indexOf("name");
    const roleIndex = headers.indexOf("role");
    if (nameIndex === -1 || roleIndex === -1) return [];

    const roster = [];
    for (let index = headerIndex + 2; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      if (!line.startsWith("|")) break;

      const cells = parseMarkdownRow(lines[index]);
      const name = cells[nameIndex];
      const role = cells[roleIndex];
      if (name && role) {
        roster.push({ name, role });
      }
    }

    return roster;
  } catch {
    return [];
  }
}

function matchRolePattern(role) {
  const roleText = typeof role === "string" ? role.toLowerCase() : "";
  let bestMatch = null;

  for (const [priority, pattern] of ROLE_PATTERNS.entries()) {
    const hits = pattern.keywords.filter(keyword => roleText.includes(keyword)).length;
    if (!hits) continue;

    if (
      !bestMatch ||
      hits > bestMatch.hits ||
      (hits === bestMatch.hits && priority < bestMatch.priority)
    ) {
      bestMatch = { slug: pattern.slug, hits, priority };
    }
  }

  return bestMatch?.slug ?? null;
}

function getUsedIdentitySlugs(projectRoot, registrations) {
  const slugs = new Set();

  for (const member of parseTeamRoster(projectRoot)) {
    const resolvedSlug = matchRolePattern(member.role) ?? normalizeRoleKey(member.role);
    if (resolvedSlug && registrations.has(resolvedSlug)) {
      slugs.add(resolvedSlug);
    }
  }

  return slugs;
}

function parseGitHubRemote(remoteUrl) {
  const trimmed = remoteUrl.trim();
  const match = trimmed.match(/github\.com[:/](?<owner>[^/\s]+)\/(?<repo>[^/\s]+?)(?:\.git)?$/i);
  if (!match?.groups?.owner || !match.groups.repo) {
    fail(`Could not parse owner/repo from git remote origin URL: ${trimmed}`);
  }

  return {
    owner: match.groups.owner,
    repo: match.groups.repo,
    remoteUrl: trimmed,
  };
}

function getOriginRepo(projectRoot) {
  const result = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    fail(`Failed to read git remote origin: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const message = result.stderr?.trim() || "git remote get-url origin failed.";
    fail(message);
  }

  return parseGitHubRemote(result.stdout ?? "");
}

function getConfiguredApps(registrations, usedIdentitySlugs, selectedRoles) {
  if (!registrations.size) {
    fail("No app registrations found in .squad/identity/apps/.");
  }

  // When specific roles are requested, bypass team roster matching — the caller
  // (e.g., setup) already decided these roles are needed.
  if (selectedRoles && selectedRoles.length > 0) {
    const apps = [];
    for (const role of selectedRoles) {
      const reg = registrations.get(role);
      if (!reg) {
        fail(`Role "${role}" has no registration in .squad/identity/apps/${role}.json.`);
      }
      const appSlug = reg.slug ?? reg.appSlug ?? null;
      if (!appSlug) {
        fail(`No slug found for role "${role}" in .squad/identity/apps/${role}.json.`);
      }
      apps.push({ role, appSlug });
    }
    return apps;
  }

  if (!usedIdentitySlugs.size) {
    fail("No team member roles in .squad/team.md map to configured app identities.");
  }

  const teamApps = [...registrations.entries()]
    .filter(([role]) => usedIdentitySlugs.has(role))
    .map(([role, reg]) => ({
      role,
      appSlug: reg.slug ?? reg.appSlug ?? null,
    }));

  if (!teamApps.length) {
    fail("No registered apps are used by the current team.");
  }

  for (const app of teamApps) {
    if (!app.appSlug) {
      fail(`No slug found for role "${app.role}" in .squad/identity/apps/${app.role}.json.`);
    }
  }

  return teamApps;
}

function canResolveInstallationToken(projectRoot, role) {
  const resolveTokenPath = join(dirname(fileURLToPath(import.meta.url)), "resolve-token.mjs");
  const result = spawnSync(process.execPath, [resolveTokenPath, "--required", role], {
    cwd: projectRoot,
    stdio: "ignore",
  });

  if (result.error) {
    fail(`Failed to check installation for role "${role}": ${result.error.message}`);
  }

  return result.status === 0;
}

function isWsl() {
  if (process.platform !== "linux") {
    return false;
  }

  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    return true;
  }

  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

function openBrowser(url) {
  const platform = process.platform;
  let bin;
  let args;

  if (isWsl()) {
    bin = "cmd.exe";
    args = ["/c", "start", "", url];
  } else if (platform === "darwin") {
    bin = "open";
    args = [url];
  } else if (platform === "win32") {
    bin = "cmd.exe";
    args = ["/c", "start", "", url];
  } else {
    bin = "xdg-open";
    args = [url];
  }

  execFile(bin, args, error => {
    if (error) {
      console.log("Could not open the browser automatically.");
      console.log(`Open this URL manually: ${url}`);
    }
  });
}

function pad(value, width) {
  return String(value).padEnd(width, " ");
}

function renderTable(rows) {
  const headers = ["Role", "App Slug", "Installed"];
  const widths = headers.map((header, index) =>
    rows.reduce((max, row) => Math.max(max, String(row[index]).length), header.length),
  );

  const headerLine = headers.map((header, index) => pad(header, widths[index])).join("   ");
  const dividerLine = widths.map(width => "─".repeat(width)).join("   ");
  const body = rows
    .map(row => row.map((value, index) => pad(value, widths[index])).join("   "))
    .join("\n");

  return `${headerLine}\n${dividerLine}\n${body}`;
}

function getInstallUrl(appSlug) {
  return `https://github.com/apps/${appSlug}/installations/new`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP_TEXT);
    return;
  }

  const projectRoot = getProjectRoot();
  const registrations = loadAppRegistrations(projectRoot);
  if (!registrations.size) {
    fail("No app registrations found in .squad/identity/apps/. Create at least one {role}.json file.");
  }

  const origin = getOriginRepo(projectRoot);
  const usedIdentitySlugs = getUsedIdentitySlugs(projectRoot, registrations);
  const apps = getConfiguredApps(registrations, usedIdentitySlugs, args.roles);

  const missingApps = [];
  const rows = apps.map(app => {
    const installed = canResolveInstallationToken(projectRoot, app.role);
    const installUrl = getInstallUrl(app.appSlug);

    if (!installed && !args.check) {
      missingApps.push({ ...app, installUrl });
    }

    return [
      app.role,
      app.appSlug,
      installed ? "✅" : args.check ? "❌" : "❌ → opening install page...",
    ];
  });

  console.log(`GitHub App installation status for ${origin.owner}/${origin.repo}`);
  console.log(renderTable(rows));

  if (args.check || missingApps.length === 0) {
    return;
  }

  for (const app of missingApps) {
    console.log(`Opening browser: ${app.installUrl}`);
    openBrowser(app.installUrl);
  }

  // Wait for user to complete browser installs, then capture installation IDs
  console.log("\n⏳ After installing the apps in the browser, press Enter to continue...");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(resolve => rl.question("", () => { rl.close(); resolve(); }));

  // Try to capture installation IDs for missing apps
  console.log("\n🔍 Checking installation status...\n");
  for (const app of missingApps) {
    await verifyInstallation(projectRoot, app, origin);
    console.log("");
  }
}

function getAppRegistrationPath(projectRoot, role) {
  return join(projectRoot, ".squad", "identity", "apps", `${role}.json`);
}

function loadAppRegistration(projectRoot, role) {
  const appPath = getAppRegistrationPath(projectRoot, role);
  if (!existsSync(appPath)) {
    return { appPath, appData: null };
  }

  try {
    return { appPath, appData: JSON.parse(readFileSync(appPath, "utf8")) };
  } catch {
    return { appPath, appData: null };
  }
}

function getEnvPrivateKey(role) {
  const envKey = role.toUpperCase();
  const pemRaw = process.env[`SQUAD_${envKey}_PRIVATE_KEY`];
  if (!pemRaw) return null;

  return pemRaw.trimStart().startsWith("-----BEGIN")
    ? pemRaw
    : Buffer.from(pemRaw, "base64").toString("utf8");
}

async function loadVerificationModules() {
  const keychainPath = join(dirname(fileURLToPath(import.meta.url)), "keychain.mjs");
  const resolveTokenPath = join(dirname(fileURLToPath(import.meta.url)), "resolve-token.mjs");

  const keychainModule = await import(keychainPath).catch(() => null);
  const resolveTokenModule = await import(resolveTokenPath);

  return {
    keychainLoad: keychainModule?.keychainLoad ?? null,
    generateAppJWT: resolveTokenModule.generateAppJWT,
    getInstallationToken: resolveTokenModule.getInstallationToken,
  };
}

async function discoverInstallationId(projectRoot, app, origin, privateKeyPem, helpers) {
  const { appPath, appData } = loadAppRegistration(projectRoot, app.role);
  if (!appData?.appId || !privateKeyPem) {
    return { installationId: null, saved: false, appPath, error: null };
  }

  try {
    const jwt = helpers.generateAppJWT(appData.appId, privateKeyPem);
    const response = await fetch("https://api.github.com/app/installations", {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!response.ok) {
      return {
        installationId: null,
        saved: false,
        appPath,
        error: `GitHub API error ${response.status} listing app installations.`,
      };
    }

    const installations = await response.json();
    const match = installations.find(inst =>
      inst.account?.login?.toLowerCase() === origin.owner.toLowerCase()
    );

    if (!match?.id) {
      return { installationId: null, saved: false, appPath, error: null };
    }

    const installationId = match.id;
    let saved = false;
    if (appData.installationId !== installationId) {
      appData.installationId = installationId;
      writeFileSync(appPath, `${JSON.stringify(appData, null, 2)}\n`, "utf8");
      saved = true;
    }

    return { installationId, saved, appPath, error: null };
  } catch (error) {
    return {
      installationId: null,
      saved: false,
      appPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function captureInstallationId(projectRoot, app, origin) {
  const helpers = await loadVerificationModules();
  const { appData } = loadAppRegistration(projectRoot, app.role);
  if (!appData?.appId) return;

  const pem = getEnvPrivateKey(app.role)
    ?? (helpers.keychainLoad ? helpers.keychainLoad(String(appData.appId)) : null);
  if (!pem) return;

  const result = await discoverInstallationId(projectRoot, app, origin, pem, helpers);
  if (result.saved && result.installationId) {
    console.log(`  → Saved installationId=${result.installationId} to ${app.role}.json`);
  }
}

async function verifyInstallation(projectRoot, app, origin) {
  console.log(`🔍 Verifying ${app.role} (${app.appSlug})...`);

  const { appData } = loadAppRegistration(projectRoot, app.role);
  if (!appData) {
    console.log(`  ❌ App registration not found at .squad/identity/apps/${app.role}.json`);
    console.log(`  💡 Install at: ${app.installUrl}`);
    return;
  }

  if (!appData.appId) {
    console.log("  ❌ App registration missing appId");
    return;
  }

  console.log(`  ✅ App registration found (appId: ${appData.appId})`);

  const helpers = await loadVerificationModules();
  const envPem = getEnvPrivateKey(app.role);
  const keychainPem = envPem || !helpers.keychainLoad ? null : helpers.keychainLoad(String(appData.appId));
  const privateKeyPem = envPem ?? keychainPem;

  if (envPem) {
    console.log("  ✅ Private key found in environment");
  } else if (keychainPem) {
    console.log("  ✅ Private key found in keychain");
  } else {
    console.log(
      helpers.keychainLoad
        ? "  ❌ No private key found in keychain or environment"
        : "  ❌ No private key found in environment, and keychain support is unavailable"
    );
    return;
  }

  let installationId = appData.installationId ?? null;
  let savedInstallationId = false;

  if (installationId) {
    console.log(`  ✅ Installation ID present (${installationId})`);
  } else {
    const discovery = await discoverInstallationId(projectRoot, app, origin, privateKeyPem, helpers);
    installationId = discovery.installationId;
    savedInstallationId = discovery.saved;

    if (installationId) {
      console.log(`  ✅ Installation ID discovered (${installationId})`);
      if (savedInstallationId) {
        console.log(`  → Saved installationId=${installationId} to ${app.role}.json`);
      }
    } else {
      const suffix = discovery.error ? ` (${discovery.error})` : "";
      console.log(`  ❌ No installation ID — app may not be installed on this repo${suffix}`);
      console.log(`  💡 Install at: ${app.installUrl}`);
      return;
    }
  }

  try {
    const jwt = helpers.generateAppJWT(appData.appId, privateKeyPem);
    await helpers.getInstallationToken(jwt, installationId);
    console.log("  ✅ Token resolved successfully");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ❌ Token resolution failed: ${message}`);
  }
}

main();
