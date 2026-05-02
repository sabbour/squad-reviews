import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const repoRoot = process.cwd();
const binPath = resolve(repoRoot, 'bin', 'squad-reviews.mjs');
const runtimeRoot = resolve(repoRoot, 'test', '.runtime');
const requestReviewConfig = resolve(repoRoot, 'test', 'fixtures', 'request-review', 'repo', '.squad', 'reviews', 'config.json');
const templateSource = resolve(repoRoot, '.squad', 'reviews', 'config.json.template');
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
  assert.match(result.stdout, /upgrade/);
});

test('status reports config, token, and GitHub remote defaults', async (t) => {
  const workspace = await createWorkspace(t);
  await mkdir(resolve(workspace, '.squad', 'reviews'), { recursive: true });
  await mkdir(resolve(workspace, 'src', 'nested'), { recursive: true });
  await copyFile(requestReviewConfig, resolve(workspace, '.squad', 'reviews', 'config.json'));

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
  await mkdir(resolve(workspace, '.squad', 'reviews'), { recursive: true });
  await mkdir(resolve(workspace, 'packages', 'service'), { recursive: true });
  await copyFile(requestReviewConfig, resolve(workspace, '.squad', 'reviews', 'config.json'));

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

test('setup → doctor round-trip: doctor reports ok with no warnings after setup', async (t) => {
  const workspace = await createWorkspace(t);
  await mkdir(resolve(workspace, '.squad', 'reviews'), { recursive: true });
  await copyFile(requestReviewConfig, resolve(workspace, '.squad', 'reviews', 'config.json'));

  // Pre-create charter files referenced by the fixture config so the `charters`
  // doctor check is satisfied (otherwise it fails for unrelated reasons and
  // masks the path-alignment regression we care about).
  const fixtureConfig = JSON.parse(await readFile(requestReviewConfig, 'utf-8'));
  for (const reviewer of Object.values(fixtureConfig.reviewers)) {
    if (reviewer.charterPath) {
      const charterAbs = resolve(workspace, reviewer.charterPath);
      await mkdir(resolve(charterAbs, '..'), { recursive: true });
      await writeFile(charterAbs, '# charter\n');
    }
  }

  execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/octo-org/hello-world.git'], {
    cwd: workspace,
    stdio: 'ignore',
  });

  // Run setup.
  const setupResult = runCli(['setup', '--target', workspace, '--json'], {
    cwd: workspace,
    env: { GH_TOKEN: 'ghs_test_token' },
  });
  assert.equal(setupResult.status, 0, setupResult.stderr);
  const setupOutput = JSON.parse(setupResult.stdout);

  // Setup itself should report ok and embed a clean doctor report.
  assert.equal(
    setupOutput.ok,
    true,
    `setup.ok must be true; doctor=${JSON.stringify(setupOutput.doctor?.checks)}`,
  );
  assert.match(setupResult.stderr, /✅ squad-reviews setup complete\./);
  assert.doesNotMatch(setupResult.stderr, /completed with .* warning/);

  // Now run doctor as a separate process against the same workspace and
  // verify it reports every check green. This is the regression test for
  // the v1.5.2 doctor-paths bug introduced in 8a168f4.
  const doctorResult = runCli(['doctor', '--json'], {
    cwd: workspace,
    env: { GH_TOKEN: 'ghs_test_token' },
  });
  assert.equal(doctorResult.status, 0, doctorResult.stderr);
  const doctor = JSON.parse(doctorResult.stdout);

  const checkByName = Object.fromEntries(doctor.checks.map((c) => [c.name, c]));
  for (const name of ['extension', 'skill']) {
    assert.equal(
      checkByName[name]?.ok,
      true,
      `doctor check '${name}' must be ok after setup; got ${JSON.stringify(checkByName[name])}`,
    );
    assert.notEqual(
      checkByName[name]?.warn,
      true,
      `doctor check '${name}' must not warn after setup`,
    );
  }
  assert.equal(
    doctor.checks.filter((c) => c.warn).length,
    0,
    `expected zero doctor warnings, got: ${JSON.stringify(doctor.checks.filter((c) => c.warn))}`,
  );
  assert.equal(doctor.ok, true, 'doctor.ok must be true after a successful setup');
});
