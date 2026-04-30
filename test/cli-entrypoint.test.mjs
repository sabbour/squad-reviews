import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const repoRoot = process.cwd();
const binPath = resolve(repoRoot, 'bin', 'squad-reviews.mjs');
const runtimeRoot = resolve(repoRoot, 'test', '.runtime');
const requestReviewConfig = resolve(repoRoot, 'test', 'fixtures', 'request-review', 'repo', 'reviews', 'config.json');
const templateSource = resolve(repoRoot, 'reviews', 'config.json.template');
let workspaceCounter = 0;

async function createWorkspace(t) {
  const workspace = resolve(runtimeRoot, `cli-entrypoint-${process.pid}-${Date.now()}-${workspaceCounter++}`);
  await mkdir(workspace, { recursive: true });
  t.after(() => rm(workspace, { recursive: true, force: true }));
  return workspace;
}

function runCli(args, { cwd, env } = {}) {
  const result = spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    env: {
      ...process.env,
      SQUAD_REVIEW_TOKEN: '',
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      ...env,
    },
    encoding: 'utf8',
  });

  return {
    ...result,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

test('prints global help with --help', () => {
  const result = runCli(['--help'], { cwd: repoRoot });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: squad-reviews <command> \[options\]/);
  assert.match(result.stdout, /request-pr-review/);
  assert.match(result.stdout, /execute-issue-review/);
});

test('status reports config, token, and GitHub remote defaults', async (t) => {
  const workspace = await createWorkspace(t);
  await mkdir(resolve(workspace, 'reviews'), { recursive: true });
  await mkdir(resolve(workspace, 'src', 'nested'), { recursive: true });
  await copyFile(requestReviewConfig, resolve(workspace, 'reviews', 'config.json'));

  execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:octo-org/hello-world.git'], {
    cwd: workspace,
    stdio: 'ignore',
  });

  const result = runCli(['status'], {
    cwd: resolve(workspace, 'src', 'nested'),
    env: { GH_TOKEN: 'ghs_test_token' },
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.repoRoot, workspace);
  assert.equal(output.config.valid, true);
  assert.equal(output.config.reviewerCount, 2);
  assert.equal(output.github.owner, 'octo-org');
  assert.equal(output.github.repo, 'hello-world');
  assert.equal(output.token.present, true);
  assert.equal(output.token.source, 'GH_TOKEN');
});

test('init installs files and reports result with --json', async (t) => {
  const workspace = await createWorkspace(t);
  await mkdir(resolve(workspace, '.git'), { recursive: true });
  await mkdir(resolve(workspace, 'packages', 'app'), { recursive: true });

  const result = runCli(['init', '--json', '--target', workspace], { cwd: resolve(workspace, 'packages', 'app') });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);

  assert.equal(output.initialized, true);
  assert.equal(output.target, workspace);
  assert.ok(output.files.template);
  assert.ok(output.files.extension);
  assert.ok(output.files.skill);
});

test('request-pr-review falls back to git origin when owner/repo are omitted', async (t) => {
  const workspace = await createWorkspace(t);
  await mkdir(resolve(workspace, 'reviews'), { recursive: true });
  await mkdir(resolve(workspace, 'packages', 'service'), { recursive: true });
  await copyFile(requestReviewConfig, resolve(workspace, 'reviews', 'config.json'));

  execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/octo-org/hello-world.git'], {
    cwd: workspace,
    stdio: 'ignore',
  });

  const result = runCli(['request-pr-review', '--pr', '42', '--reviewer', 'security'], {
    cwd: resolve(workspace, 'packages', 'service'),
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.pr, 42);
  assert.equal(output.owner, 'octo-org');
  assert.equal(output.repo, 'hello-world');
  assert.equal(output.roleSlug, 'security');
  assert.match(output.instruction, /squad_reviews_execute_pr_review/);
});

test('command-specific help works', () => {
  const result = runCli(['resolve-thread', '--help'], { cwd: repoRoot });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /squad-reviews resolve-thread --pr <number>/);
});
