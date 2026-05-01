import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  generateReusableWorkflow,
  generateCallerWorkflow,
  scaffoldGate,
} from '../extensions/squad-reviews/lib/scaffold-gate.mjs';

describe('scaffold-gate', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = join(tmpdir(), `squad-reviews-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tempDir, '.squad', 'reviews'), { recursive: true });
    writeFileSync(
      join(tempDir, '.squad', 'reviews', 'config.json'),
      JSON.stringify({
        schemaVersion: '1.1.0',
        reviewers: {
          codereview: { agent: 'nibbler', dimension: 'Code quality', charterPath: '.squad/agents/nibbler/charter.md' },
          security: { agent: 'zapp', dimension: 'Security', charterPath: '.squad/agents/zapp/charter.md' },
        },
        threadResolution: { requireReplyBeforeResolve: true, templates: { addressed: '{sha}', dismissed: '{justification}' } },
        feedbackSources: ['squad-agents'],
      }),
      'utf8'
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('generateReusableWorkflow', () => {
    it('produces valid YAML with the roles as default input', () => {
      const yaml = generateReusableWorkflow(['codereview', 'security']);
      assert.ok(yaml.includes("default: 'codereview,security'"));
      assert.ok(yaml.includes('workflow_call'));
      assert.ok(yaml.includes('Squad Review Gate'));
    });

    it('includes the approval check logic', () => {
      const yaml = generateReusableWorkflow(['codereview']);
      assert.ok(yaml.includes('APPROVED'));
      assert.ok(yaml.includes('unresolved'));
    });

    it('includes merge-commit guard to preserve labels on branch catch-up', () => {
      const yaml = generateReusableWorkflow(['codereview', 'security']);
      // Should detect merge-only updates via compare API
      assert.ok(yaml.includes('compareCommitsWithBasehead'), 'should use compare API');
      assert.ok(yaml.includes('isMergeOnly'), 'should have merge-only detection variable');
      assert.ok(yaml.includes('parents'), 'should check commit parents to identify merges');
      assert.ok(yaml.includes('preserving approval labels'), 'should log when preserving labels');
      assert.ok(yaml.includes('New non-merge commits detected'), 'should log when stripping labels');
    });
  });

  describe('generateCallerWorkflow', () => {
    it('produces a caller workflow triggered on pull_request_review', () => {
      const yaml = generateCallerWorkflow(['codereview', 'security']);
      assert.ok(yaml.includes('pull_request_review'));
      assert.ok(yaml.includes('issue_comment'));
      assert.ok(yaml.includes("roles: 'codereview,security'"));
      assert.ok(yaml.includes('squad-review-gate.yml'));
    });
  });

  describe('scaffoldGate', () => {
    it('creates both workflow files with all roles from config when no roles specified', () => {
      const result = scaffoldGate(tempDir, {});
      assert.ok(result.scaffolded);
      assert.deepEqual(result.roles, ['codereview', 'security']);
      assert.ok(existsSync(join(tempDir, '.github', 'workflows', 'squad-review-gate.yml')));
      assert.ok(existsSync(join(tempDir, '.github', 'workflows', 'review-gate.yml')));
    });

    it('uses specified roles when provided', () => {
      const result = scaffoldGate(tempDir, { roles: ['security'] });
      assert.deepEqual(result.roles, ['security']);
      const caller = readFileSync(join(tempDir, '.github', 'workflows', 'review-gate.yml'), 'utf8');
      assert.ok(caller.includes("roles: 'security'"));
    });

    it('throws on invalid roles', () => {
      assert.throws(
        () => scaffoldGate(tempDir, { roles: ['nonexistent'] }),
        /Unknown roles: nonexistent/
      );
    });

    it('is idempotent — re-running overwrites files', () => {
      scaffoldGate(tempDir, {});
      const firstContent = readFileSync(join(tempDir, '.github', 'workflows', 'squad-review-gate.yml'), 'utf8');
      scaffoldGate(tempDir, { roles: ['security'] });
      const secondContent = readFileSync(join(tempDir, '.github', 'workflows', 'squad-review-gate.yml'), 'utf8');
      assert.notEqual(firstContent, secondContent);
      assert.ok(secondContent.includes("default: 'security'"));
    });

    it('creates .github/workflows directory if missing', () => {
      const workflowsDir = join(tempDir, '.github', 'workflows');
      assert.ok(!existsSync(workflowsDir));
      scaffoldGate(tempDir, {});
      assert.ok(existsSync(workflowsDir));
    });
  });
});
