import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildSquadReviewsInstructionsBlock,
  updateCopilotInstructions,
  SQUAD_REVIEWS_BLOCK_START,
  SQUAD_REVIEWS_BLOCK_END,
} from '../extensions/squad-reviews/lib/copilot-instructions.mjs';

describe('copilot-instructions injection', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = join(process.cwd(), '.test-workdir', `copilot-instructions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  });

  it('block contains SIGNAL ONLY clarification and follow-up spawn rule', () => {
    const block = buildSquadReviewsInstructionsBlock();
    assert.match(block, /SIGNAL ONLY/);
    assert.match(block, /MUST in the\s+same turn dispatch the named reviewer agent/);
    assert.match(block, /squad_reviews_dispatch_review/);
    assert.ok(/^<!--\s*squad-reviews:\s*start(?:\s+v[^\s>-]+)?\s*-->/.test(block));
    assert.ok(block.endsWith(SQUAD_REVIEWS_BLOCK_END));
  });

  it('block contains line-level comments rule', () => {
    const block = buildSquadReviewsInstructionsBlock();
    assert.match(block, /Line-level comments are for change requests only/);
  });

  it('creates copilot-instructions.md when missing', () => {
    const result = updateCopilotInstructions(tempDir);
    assert.equal(result.action, 'Created');
    const content = readFileSync(result.path, 'utf-8');
    assert.match(content, /REVIEW GATE/);
    assert.match(content, /SIGNAL ONLY/);
  });

  it('appends block when file exists without markers', () => {
    const path = join(tempDir, '.github', 'copilot-instructions.md');
    mkdirSync(join(tempDir, '.github'), { recursive: true });
    writeFileSync(path, '# Project\n\nSome existing content.\n', 'utf-8');

    const result = updateCopilotInstructions(tempDir);
    assert.equal(result.action, 'Appended');
    const content = readFileSync(path, 'utf-8');
    assert.match(content, /Some existing content\./);
    assert.match(content, /REVIEW GATE/);
  });

  it('replaces existing block in place (idempotent)', () => {
    const path = join(tempDir, '.github', 'copilot-instructions.md');
    mkdirSync(join(tempDir, '.github'), { recursive: true });
    const initial = `# Top\n\n${SQUAD_REVIEWS_BLOCK_START}\nold stale content\n${SQUAD_REVIEWS_BLOCK_END}\n\n# Bottom\n`;
    writeFileSync(path, initial, 'utf-8');

    const result = updateCopilotInstructions(tempDir);
    assert.equal(result.action, 'Replaced');
    const content = readFileSync(path, 'utf-8');
    assert.match(content, /^# Top/);
    assert.match(content, /# Bottom/);
    assert.doesNotMatch(content, /old stale content/);
    assert.match(content, /SIGNAL ONLY/);

    // Second run should be Replaced again, not duplicated
    const result2 = updateCopilotInstructions(tempDir);
    assert.equal(result2.action, 'Replaced');
    const content2 = readFileSync(path, 'utf-8');
    const startCount = (content2.match(/<!--\s*squad-reviews:\s*start(?:\s+v[^\s>-]+)?\s*-->/g) || []).length;
    assert.equal(startCount, 1, 'should only have one block after re-run');
  });
});
