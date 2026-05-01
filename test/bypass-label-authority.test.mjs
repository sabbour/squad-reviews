import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isRoleRequired } from '../extensions/squad-reviews/lib/gate-status.mjs';

describe('bypass label authority enforcement', () => {
  const conditionalGateRule = {
    required: 'conditional',
    bypassLabels: ['docs:not-applicable'],
    bypassLabelAuthority: 'docs',
  };

  it('skips role when bypass label applied by authorized bot', () => {
    const labelAuthority = { 'docs:not-applicable': 'sqd-docs[bot]' };
    const authorizedActors = ['sqd-docs[bot]'];

    const result = isRoleRequired(
      conditionalGateRule,
      ['docs:not-applicable'],
      ['src/index.ts'],
      labelAuthority,
      authorizedActors
    );

    assert.equal(result.required, false);
    assert.equal(result.reason, 'bypass label present');
  });

  it('requires role when bypass label applied by unauthorized actor', () => {
    const labelAuthority = { 'docs:not-applicable': 'sqd-backend[bot]' };
    const authorizedActors = ['sqd-docs[bot]'];

    const result = isRoleRequired(
      conditionalGateRule,
      ['docs:not-applicable'],
      ['src/index.ts'],
      labelAuthority,
      authorizedActors
    );

    assert.equal(result.required, true);
    assert.equal(result.reason, 'bypass label applied by unauthorized actor');
  });

  it('requires role when bypass label applied by human (not bot)', () => {
    const labelAuthority = { 'docs:not-applicable': 'some-human' };
    const authorizedActors = ['sqd-docs[bot]'];

    const result = isRoleRequired(
      conditionalGateRule,
      ['docs:not-applicable'],
      ['src/index.ts'],
      labelAuthority,
      authorizedActors
    );

    assert.equal(result.required, true);
    assert.equal(result.reason, 'bypass label applied by unauthorized actor');
  });

  it('skips authority check when bypassLabelAuthority not configured', () => {
    const gateRule = {
      required: 'conditional',
      bypassLabels: ['docs:not-applicable'],
    };

    const result = isRoleRequired(
      gateRule,
      ['docs:not-applicable'],
      ['src/index.ts'],
      { 'docs:not-applicable': 'random-user' },
      null // no authorizedActors
    );

    assert.equal(result.required, false);
    assert.equal(result.reason, 'bypass label present');
  });

  it('skips authority check when labelAuthority is null (fetch failed)', () => {
    const authorizedActors = ['sqd-docs[bot]'];

    const result = isRoleRequired(
      conditionalGateRule,
      ['docs:not-applicable'],
      ['src/index.ts'],
      null, // label authority fetch failed
      authorizedActors
    );

    // Graceful degradation: treat as authorized (fail open)
    assert.equal(result.required, false);
    assert.equal(result.reason, 'bypass label present');
  });

  it('case-insensitive actor matching', () => {
    const labelAuthority = { 'docs:not-applicable': 'SQD-Docs[bot]' };
    const authorizedActors = ['sqd-docs[bot]'];

    const result = isRoleRequired(
      conditionalGateRule,
      ['docs:not-applicable'],
      ['src/index.ts'],
      labelAuthority,
      authorizedActors
    );

    assert.equal(result.required, false);
  });

  it('still requires if requiredWhen paths match even with authorized bypass', () => {
    const gateRule = {
      required: 'conditional',
      bypassLabels: ['docs:not-applicable'],
      bypassLabelAuthority: 'docs',
      requiredWhen: { paths: ['src/**'] },
    };
    const labelAuthority = { 'docs:not-applicable': 'sqd-docs[bot]' };
    const authorizedActors = ['sqd-docs[bot]'];

    const result = isRoleRequired(
      gateRule,
      ['docs:not-applicable'],
      ['src/main.ts'],
      labelAuthority,
      authorizedActors
    );

    assert.equal(result.required, true);
    assert.equal(result.reason, 'bypass label present but required paths matched');
  });

  it('no bypass label on PR — authority irrelevant', () => {
    const result = isRoleRequired(
      conditionalGateRule,
      ['other-label'],
      ['src/index.ts'],
      {},
      ['sqd-docs[bot]']
    );

    // No requiredWhen paths, no bypass → required
    assert.equal(result.required, true);
  });

  it('skips conditional security for docs-only PRs without sensitive paths or architecture label', () => {
    const result = isRoleRequired(
      {
        required: 'conditional',
        bypassWhen: { docsOnly: true, noArchitectureLabel: true, noSensitivePaths: true },
        sensitivePaths: ['.github/workflows/**', '**/security/**'],
      },
      [],
      ['docs/guide.md', '.changeset/fix.md'],
      {},
      null
    );

    assert.equal(result.required, false);
    assert.equal(result.reason, 'docs-only PR; no sensitive paths or architecture label');
  });

  it('requires conditional security for docs-only PRs with sensitive paths', () => {
    const result = isRoleRequired(
      {
        required: 'conditional',
        bypassWhen: { docsOnly: true, noArchitectureLabel: true, noSensitivePaths: true },
        sensitivePaths: ['.github/workflows/**', '**/security/**'],
      },
      [],
      ['docs/guide.md', '.github/workflows/ci.yml'],
      {},
      null
    );

    assert.equal(result.required, true);
  });

  it('supports label-triggered architecture requirements', () => {
    const result = isRoleRequired(
      {
        required: 'conditional',
        requiredWhen: { labels: ['architecture'] },
      },
      ['architecture'],
      ['docs/adr.md'],
      {},
      null
    );

    assert.equal(result.required, true);
    assert.equal(result.reason, 'labels match required labels');
  });

  it('hard-block labels make the role required and blocked', () => {
    const result = isRoleRequired(
      {
        required: 'conditional',
        hardBlockLabel: 'docs:rejected',
      },
      ['docs:rejected'],
      ['docs/guide.md'],
      {},
      null
    );

    assert.equal(result.required, true);
    assert.equal(result.blocked, true);
    assert.equal(result.reason, 'hard block label present: docs:rejected');
  });
});
