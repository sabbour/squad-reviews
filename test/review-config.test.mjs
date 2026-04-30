import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createMockConfig, fixturePath } from './helpers.mjs';
import { loadConfig, resolveReviewer } from '../extensions/squad-reviews/lib/review-config.mjs';

let workspaceCounter = 0;

async function createWorkspace(t) {
  const workspace = resolve(
    process.cwd(),
    'test',
    '.runtime',
    `review-config-${process.pid}-${Date.now()}-${workspaceCounter++}`,
  );

  await mkdir(resolve(workspace, 'reviews'), { recursive: true });
  t.after(() => rm(workspace, { recursive: true, force: true }));
  return workspace;
}

describe('review-config.mjs', () => {
  it('loads valid config successfully', async (t) => {
    const workspace = await createWorkspace(t);
    await copyFile(fixturePath('valid-config.json'), resolve(workspace, 'reviews', 'config.json'));

    const config = loadConfig(workspace);

    assert.equal(config.schemaVersion, '1.0.0');
    assert.equal(config.reviewers.codereview.agent, 'nibbler');
    assert.deepEqual(config.feedbackSources, ['squad-agents', 'humans', 'github-copilot-bot']);
  });

  it('throws when config file missing', async (t) => {
    const workspace = await createWorkspace(t);

    assert.throws(() => loadConfig(workspace), /Config not found|ENOENT|missing/i);
  });

  it('throws on invalid schema version', async (t) => {
    const workspace = await createWorkspace(t);
    const config = createMockConfig();
    config.schemaVersion = '9.9.9';
    await writeFile(resolve(workspace, 'reviews', 'config.json'), `${JSON.stringify(config, null, 2)}\n`);

    assert.throws(() => loadConfig(workspace), /schemaVersion/i);
  });

  it('throws when reviewers is empty', async (t) => {
    const workspace = await createWorkspace(t);
    const config = createMockConfig();
    config.reviewers = {};
    await writeFile(resolve(workspace, 'reviews', 'config.json'), `${JSON.stringify(config, null, 2)}\n`);

    assert.throws(() => loadConfig(workspace), /reviewers/i);
  });

  it('resolveReviewer returns correct reviewer', () => {
    const reviewer = resolveReviewer(createMockConfig(), 'security');

    assert.deepEqual(reviewer, {
      agent: 'zapp',
      dimension: 'Security surface, injection, auth, trust boundaries',
      charterPath: '.squad/agents/zapp/charter.md',
      botLogin: null,
      gateRule: null,
    });
  });

  it('resolveReviewer throws for unknown role', () => {
    assert.throws(() => resolveReviewer(createMockConfig(), 'unknown-role'), /Unknown reviewer role/i);
  });
});
