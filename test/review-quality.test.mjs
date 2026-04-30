import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateReviewQuality, QUALITY_STANDARDS } from '../extensions/squad-reviews/lib/review-quality.mjs';

// Helper: generate a review body of N words with citations
function makeReview(wordCount, { citations = true, shallow = false } = {}) {
  if (shallow) return 'LGTM';
  const words = [];
  for (let i = 0; i < wordCount; i++) {
    words.push(`word${i}`);
  }
  let body = words.join(' ');
  if (citations) {
    body += '\n\nSee src/auth.ts:45-62 and lib/utils.mjs:10 for details.';
  }
  return body;
}

describe('review-quality', () => {
  describe('validateReviewQuality', () => {
    it('passes a compliant review', () => {
      const body = makeReview(160);
      const result = validateReviewQuality(body, 'REQUEST_CHANGES');
      assert.equal(result.valid, true);
      assert.equal(result.violations.length, 0);
      assert.ok(result.metrics.wordCount >= 160);
    });

    it('rejects reviews under minimum word count', () => {
      const body = makeReview(50);
      const result = validateReviewQuality(body, 'REQUEST_CHANGES');
      assert.equal(result.valid, false);
      assert.ok(result.violations.some(v => v.includes('words')));
    });

    it('rejects shallow one-liners', () => {
      const result = validateReviewQuality('LGTM', 'APPROVE');
      assert.equal(result.valid, false);
      assert.ok(result.violations.some(v => v.includes('shallow')));
    });

    it('rejects "looks good" variants', () => {
      for (const body of ['Looks good!', 'Ship it', 'Approved', 'No issues', '👍']) {
        const result = validateReviewQuality(body, 'APPROVE');
        assert.equal(result.valid, false, `Should reject: "${body}"`);
      }
    });

    it('rejects reviews without citations', () => {
      const body = makeReview(160, { citations: false });
      const result = validateReviewQuality(body, 'COMMENT');
      assert.equal(result.valid, false);
      assert.ok(result.violations.some(v => v.includes('cite')));
    });

    it('accepts reviews with inline comments instead of body citations', () => {
      // Short body but substantial inline comments with citations
      const body = 'Summary of findings across multiple files. ' + 'word '.repeat(50);
      const inlineComments = [
        'This function at src/auth.ts:12 has a security issue. ' + 'detail '.repeat(40),
        'The handler at lib/api.mjs:88-95 needs error handling. ' + 'explanation '.repeat(40),
      ];
      const result = validateReviewQuality(body, 'REQUEST_CHANGES', { inlineComments });
      assert.equal(result.valid, true);
    });

    it('rejects APPROVE with caveats (suggestions + concern language)', () => {
      const body = makeReview(160) +
        '\n\nHowever, you should fix the null check. Here is a suggestion:\n```suggestion\nif (x != null) {\n```';
      const result = validateReviewQuality(body, 'APPROVE');
      assert.equal(result.valid, false);
      assert.ok(result.violations.some(v => v.includes('REQUEST_CHANGES')));
    });

    it('allows REQUEST_CHANGES with suggestions (no contradiction)', () => {
      const body = makeReview(160) +
        '\n\nHowever, this needs fixing:\n```suggestion\nconst x = validate(input);\n```';
      const result = validateReviewQuality(body, 'REQUEST_CHANGES');
      assert.equal(result.valid, true);
    });

    it('counts suggestion blocks in metrics', () => {
      const body = makeReview(160) +
        '\n```suggestion\nfix1\n```\n```suggestion\nfix2\n```';
      const result = validateReviewQuality(body, 'REQUEST_CHANGES');
      assert.equal(result.metrics.suggestions, 2);
    });

    it('does not count code blocks toward word count', () => {
      // Body with lots of words inside code blocks
      const code = '```\n' + 'code '.repeat(200) + '\n```';
      const actual = 'Real review content. ' + 'word '.repeat(30);
      const body = actual + '\n' + code + '\nSee src/file.ts:1';
      const result = validateReviewQuality(body, 'COMMENT');
      // Should count only the non-code words
      assert.ok(result.metrics.wordCount < 100);
    });

    it('respects custom minWords override', () => {
      const body = makeReview(80);
      const result = validateReviewQuality(body, 'COMMENT', { minWords: 50 });
      assert.equal(result.valid, true);
    });

    it('allows disabling citation requirement', () => {
      const body = makeReview(160, { citations: false });
      const result = validateReviewQuality(body, 'COMMENT', { requireCitations: false });
      assert.equal(result.valid, true);
    });
  });

  describe('QUALITY_STANDARDS', () => {
    it('exports expected standards', () => {
      assert.equal(QUALITY_STANDARDS.minWords, 150);
      assert.equal(QUALITY_STANDARDS.requireCitations, true);
      assert.equal(QUALITY_STANDARDS.noShallowApprovals, true);
      assert.equal(QUALITY_STANDARDS.noApproveWithCaveats, true);
      assert.equal(QUALITY_STANDARDS.preferNativeSuggestions, true);
    });
  });
});
