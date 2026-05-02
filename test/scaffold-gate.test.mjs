import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  generateReusableWorkflow,
  generateCallerWorkflow,
  scaffoldGate,
} from '../extensions/squad-reviews/lib/scaffold-gate.mjs';

describe('scaffold-gate', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = join(process.cwd(), '.test-workdir', `squad-reviews-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

    it('includes PR diff guard to preserve labels on pure base catch-up', () => {
      const yaml = generateReusableWorkflow(['codereview', 'security']);
      // Should compare PR-vs-base file signatures before and after synchronize
      assert.ok(yaml.includes('compareCommitsWithBasehead'), 'should use compare API');
      assert.ok(yaml.includes('isPureBaseSync'), 'should have pure base-sync detection variable');
      assert.ok(yaml.includes('sigOf'), 'should compare file signatures');
      assert.ok(yaml.includes('preserving approval labels'), 'should log when preserving labels');
      assert.ok(yaml.includes('affected domains'), 'should log scoped invalidation');
      assert.ok(yaml.includes('roleAffectedBySync'), 'should classify affected reviewer roles');
      assert.ok(yaml.includes('invalidationPaths'), 'should honor configured invalidation path triggers');
      assert.ok(!yaml.includes('for (const role of allRoles) {\n                  const label = `\${role}:approved`;'), 'should not blanket-clear every role');
    });

    it('clears stale approvals by affected reviewer domain, not blanket synchronize', () => {
      const yaml = generateReusableWorkflow(['codereview', 'security', 'architecture'], {
        reviewers: {
          codereview: { gateRule: { required: 'always' } },
          security: {
            gateRule: {
              required: 'conditional',
              bypassWhen: { docsOnly: true, noArchitectureLabel: true, noSensitivePaths: true },
            },
          },
          architecture: {
            gateRule: {
              required: 'conditional',
              requiredWhen: { labels: ['architecture'] },
            },
          },
        },
      });

      assert.ok(yaml.includes('syncChangedPaths = changedBetween'), 'should compute changed paths between synchronize SHAs');
      assert.ok(yaml.includes('roleAffectedBySync'), 'should evaluate affected reviewer domains');
      assert.ok(yaml.includes('rolesToClear = allRoles.filter(roleAffectedBySync)'), 'should clear only affected roles');
      assert.ok(yaml.includes('no reviewer domains were affected'), 'should preserve labels when no domain triggers changed');
      assert.ok(!yaml.includes('for (const role of allRoles) {\\n                  const label'), 'should not blanket-clear every role');
    });

    it('includes docs-only and hard-block label gate logic', () => {
      const yaml = generateReusableWorkflow(['codereview', 'security', 'docs'], {
        reviewers: {
          codereview: { gateRule: { required: 'always' } },
          security: {
            gateRule: {
              required: 'conditional',
              bypassWhen: { docsOnly: true, noArchitectureLabel: true, noSensitivePaths: true },
            },
          },
          docs: {
            gateRule: {
              required: 'conditional',
              bypassLabels: ['docs:not-applicable', 'docs:approved'],
              hardBlockLabel: 'docs:rejected',
            },
          },
        },
      });

      assert.ok(yaml.includes('docs-only PR; no sensitive paths or architecture label'));
      assert.ok(yaml.includes('hardBlockLabel'));
      assert.ok(yaml.includes('docs:not-applicable'));
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

    it('generated reusable workflow includes normalizeBotLogin for [bot] suffix handling (issue #315)', () => {
      const yaml = generateReusableWorkflow(['codereview']);
      assert.ok(
        yaml.includes('normalizeBotLogin'),
        'should include normalizeBotLogin function'
      );
      assert.ok(
        yaml.includes('[bot]'),
        'should reference [bot] suffix in normalization comment or regex'
      );
      // The normalization should strip [bot] suffix — verify the comparison uses normalized logins
      assert.ok(
        yaml.includes('normalizeBotLogin(botLogin)'),
        'should normalize the configured botLogin before comparing'
      );
      assert.ok(
        yaml.includes('normalizeBotLogin(r.user?.login)'),
        'should normalize the reviewer login before comparing'
      );
    });
  });
});
