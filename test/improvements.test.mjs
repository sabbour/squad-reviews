import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
  generateReusableWorkflow,
  generateCallerWorkflow,
  scaffoldGate,
} from '../extensions/squad-reviews/lib/scaffold-gate.mjs';

import { checkGateStatus } from '../extensions/squad-reviews/lib/gate-status.mjs';
import { appendAuditEntry } from '../extensions/squad-reviews/lib/audit-log.mjs';
import { migrateConfig, LATEST_SCHEMA_VERSION } from '../extensions/squad-reviews/lib/review-config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, '..', 'bin', 'squad-reviews.mjs');

function createTempRepo() {
  const tempDir = join(tmpdir(), `squad-reviews-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tempDir, 'reviews'), { recursive: true });
  mkdirSync(join(tempDir, '.git'), { recursive: true });
  writeFileSync(
    join(tempDir, 'reviews', 'config.json'),
    JSON.stringify({
      schemaVersion: '1.0.0',
      reviewers: {
        codereview: { agent: 'nibbler', dimension: 'Code quality', charterPath: '.squad/agents/nibbler/charter.md' },
        security: { agent: 'zapp', dimension: 'Security', charterPath: '.squad/agents/zapp/charter.md', botLogin: 'sqd-zapp[bot]' },
      },
      threadResolution: { requireReplyBeforeResolve: true, templates: { addressed: '{sha}', dismissed: '{justification}' } },
      feedbackSources: ['squad-agents'],
    }),
    'utf8'
  );
  writeFileSync(
    join(tempDir, 'reviews', 'config.json.template'),
    readFileSync(join(__dirname, '..', 'reviews', 'config.json.template'), 'utf8'),
    'utf8'
  );
  return tempDir;
}

describe('CLI integration - scaffold-gate', () => {
  let tempDir;

  beforeEach(() => { tempDir = createTempRepo(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('scaffold-gate runs through CLI binary', () => {
    const result = spawnSync(process.execPath, [CLI_PATH, 'scaffold-gate'], {
      cwd: tempDir,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.ok(output.scaffolded);
    assert.deepEqual(output.roles, ['codereview', 'security']);
  });

  it('scaffold-gate --dry-run does not write files', () => {
    const result = spawnSync(process.execPath, [CLI_PATH, 'scaffold-gate', '--dry-run'], {
      cwd: tempDir,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.dryRun, true);
    assert.equal(output.scaffolded, false);
    assert.ok(!existsSync(join(tempDir, '.github', 'workflows', 'squad-review-gate.yml')));
  });

  it('scaffold-gate --roles filters roles', () => {
    const result = spawnSync(process.execPath, [CLI_PATH, 'scaffold-gate', '--roles', 'security'], {
      cwd: tempDir,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.roles, ['security']);
  });
});

describe('YAML validation - scaffold-gate output', () => {
  it('generated reusable workflow is valid YAML structure', () => {
    const yaml = generateReusableWorkflow(['codereview', 'security']);
    // Validate it has proper YAML structure markers
    assert.ok(yaml.startsWith('name:'));
    assert.ok(yaml.includes('on:'));
    assert.ok(yaml.includes('jobs:'));
    assert.ok(yaml.includes('steps:'));
    // Validate indentation consistency (2-space)
    const lines = yaml.split('\n');
    for (const line of lines) {
      if (line.trim() === '') continue;
      const indent = line.match(/^( *)/)[1].length;
      assert.ok(indent % 2 === 0, `Line has odd indentation: "${line}"`);
    }
  });

  it('generated caller workflow is valid YAML structure', () => {
    const yaml = generateCallerWorkflow(['codereview']);
    assert.ok(yaml.startsWith('name:'));
    assert.ok(yaml.includes('on:'));
    assert.ok(yaml.includes('jobs:'));
  });

  it('botLogin is injected into reusable workflow when configured', () => {
    const config = {
      reviewers: {
        security: { agent: 'zapp', dimension: 'Security', charterPath: 'c.md', botLogin: 'sqd-zapp[bot]' },
      },
    };
    const yaml = generateReusableWorkflow(['security'], config);
    assert.ok(yaml.includes('sqd-zapp[bot]'));
  });
});

describe('dry-run scaffold', () => {
  let tempDir;

  beforeEach(() => { tempDir = createTempRepo(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('returns content without writing when dryRun=true', () => {
    const result = scaffoldGate(tempDir, { dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(result.scaffolded, false);
    assert.ok(Object.keys(result.content).length === 2);
    assert.ok(!existsSync(join(tempDir, '.github', 'workflows')));
  });
});

describe('audit-log', () => {
  let tempDir;

  beforeEach(() => { tempDir = createTempRepo(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('appends entries to audit.jsonl', () => {
    appendAuditEntry(tempDir, { action: 'review_posted', pr: 42, role: 'codereview' });
    appendAuditEntry(tempDir, { action: 'thread_resolved', pr: 42, threadId: 'abc' });

    const logPath = join(tempDir, 'reviews', 'audit.jsonl');
    assert.ok(existsSync(logPath));
    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);

    const entry1 = JSON.parse(lines[0]);
    assert.equal(entry1.action, 'review_posted');
    assert.equal(entry1.pr, 42);
    assert.ok(entry1.timestamp);

    const entry2 = JSON.parse(lines[1]);
    assert.equal(entry2.action, 'thread_resolved');
  });
});

describe('config migration', () => {
  it('migrates 1.0.0 to latest', () => {
    const oldConfig = {
      schemaVersion: '1.0.0',
      reviewers: { codereview: { agent: 'nibbler', dimension: 'Code quality', charterPath: 'c.md' } },
      threadResolution: { requireReplyBeforeResolve: true, templates: { addressed: '{sha}', dismissed: '{j}' } },
      feedbackSources: ['squad-agents'],
    };

    const result = migrateConfig(oldConfig);
    assert.equal(result.migrated, true);
    assert.equal(result.fromVersion, '1.0.0');
    assert.equal(result.toVersion, LATEST_SCHEMA_VERSION);
    assert.equal(result.config.schemaVersion, LATEST_SCHEMA_VERSION);
  });

  it('does not migrate if already at latest', () => {
    const config = {
      schemaVersion: LATEST_SCHEMA_VERSION,
      reviewers: { codereview: { agent: 'nibbler', dimension: 'Code quality', charterPath: 'c.md' } },
      threadResolution: { requireReplyBeforeResolve: true, templates: { addressed: '{sha}', dismissed: '{j}' } },
      feedbackSources: ['squad-agents'],
    };

    const result = migrateConfig(config);
    assert.equal(result.migrated, false);
  });
});

describe('CLI integration - migrate', () => {
  let tempDir;

  beforeEach(() => { tempDir = createTempRepo(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('migrate upgrades config version', () => {
    const result = spawnSync(process.execPath, [CLI_PATH, 'migrate'], {
      cwd: tempDir,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.migrated, true);
    assert.equal(output.toVersion, LATEST_SCHEMA_VERSION);

    // Verify file was updated
    const config = JSON.parse(readFileSync(join(tempDir, 'reviews', 'config.json'), 'utf8'));
    assert.equal(config.schemaVersion, LATEST_SCHEMA_VERSION);
  });
});
