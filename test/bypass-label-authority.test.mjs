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
      bypassLabels: ['skip-docs'],
    };

    const result = isRoleRequired(
      gateRule,
      ['skip-docs'],
      ['src/index.ts'],
      { 'skip-docs': 'random-user' },
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
});
