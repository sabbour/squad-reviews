/**
 * Review quality validation.
 *
 * Enforces minimum quality standards on reviews before they are posted.
 * Returns actionable error messages when a review fails validation.
 */

// Minimum word count for the review body (excluding code blocks and citations)
const MIN_WORD_COUNT = 150;

// Pattern matching file citations like "src/auth.ts:45" or "src/auth.ts:45-62"
const CITATION_PATTERN = /[\w./\\-]+\.\w+:\d+(?:-\d+)?/g;

// Pattern matching GitHub suggestion blocks
const SUGGESTION_BLOCK_PATTERN = /```suggestion[\s\S]*?```/g;

// Shallow one-liner patterns (case-insensitive)
const SHALLOW_PATTERNS = [
  /^(lgtm|looks good|ship it|approved?|nice|great|👍|✅)\s*[.!]?$/i,
  /^(no issues?|no comments?|no concerns?)\s*[.!]?$/i,
];

/**
 * Count words in text, excluding code blocks and suggestion blocks.
 */
function countReviewWords(body) {
  let text = body;
  // Strip fenced code blocks (including suggestions)
  text = text.replace(/```[\s\S]*?```/g, '');
  // Strip inline code
  text = text.replace(/`[^`]+`/g, '');
  // Strip markdown links URL portion
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Split on whitespace and count non-empty tokens
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

/**
 * Extract file:line citations from the review body.
 */
function extractCitations(body) {
  return body.match(CITATION_PATTERN) || [];
}

/**
 * Check if a review body is a shallow one-liner.
 */
function isShallowReview(body) {
  const trimmed = body.trim();
  return SHALLOW_PATTERNS.some(pattern => pattern.test(trimmed));
}

/**
 * Validate a review body against quality standards.
 *
 * @param {string} reviewBody - The review text
 * @param {string} event - The review event (COMMENT, REQUEST_CHANGES, APPROVE)
 * @param {object} [options] - Optional overrides
 * @param {number} [options.minWords] - Override minimum word count
 * @param {boolean} [options.requireCitations] - Whether citations are required (default: true)
 * @param {string[]} [options.inlineComments] - Inline review comments (count toward depth)
 * @returns {{ valid: boolean, violations: string[], metrics: object }}
 */
export function validateReviewQuality(reviewBody, event, options = {}) {
  const {
    minWords = MIN_WORD_COUNT,
    requireCitations = true,
    inlineComments = [],
  } = options;

  const violations = [];
  const wordCount = countReviewWords(reviewBody);
  const citations = extractCitations(reviewBody);
  const suggestions = (reviewBody.match(SUGGESTION_BLOCK_PATTERN) || []).length;

  // Also count citations and words in inline comments
  let inlineCitations = [];
  let inlineWordCount = 0;
  let inlineSuggestions = 0;
  for (const comment of inlineComments) {
    inlineCitations.push(...extractCitations(comment));
    inlineWordCount += countReviewWords(comment);
    inlineSuggestions += (comment.match(SUGGESTION_BLOCK_PATTERN) || []).length;
  }

  const totalWords = wordCount + inlineWordCount;
  const totalCitations = citations.length + inlineCitations.length;
  const totalSuggestions = suggestions + inlineSuggestions;

  // 1. Reject shallow one-liners
  if (isShallowReview(reviewBody) && inlineComments.length === 0) {
    violations.push(
      'Review is too shallow. Provide substantive analysis referencing specific code paths, ' +
      'charter dimensions, and actionable findings.'
    );
  }

  // 2. Minimum length (total across body + inline comments)
  if (totalWords < minWords) {
    violations.push(
      `Review has ${totalWords} words (minimum: ${minWords}). ` +
      'Expand analysis to cover relevant dimensions with specific findings.'
    );
  }

  // 3. Citations required
  if (requireCitations && totalCitations === 0 && inlineComments.length === 0) {
    violations.push(
      'Review must cite specific file paths with line numbers (e.g., "src/auth.ts:45-62"). ' +
      'Alternatively, use inline review comments attached to specific lines.'
    );
  }

  // 4. APPROVE with issues pattern (approve with caveats)
  if (event === 'APPROVE') {
    const bodyLower = reviewBody.toLowerCase();
    const hasIssueLanguage = /\b(however|but|issue|concern|problem|fix|should|must|need to)\b/i.test(bodyLower);
    const hasSuggestionOrRequest = totalSuggestions > 0 ||
      /\b(request[_\s]?change|suggestion|recommend changing)\b/i.test(bodyLower);

    if (hasIssueLanguage && hasSuggestionOrRequest) {
      violations.push(
        'Do not approve with caveats. If changes are needed, use REQUEST_CHANGES instead of APPROVE. ' +
        'APPROVE means the code is ready to merge as-is.'
      );
    }
  }

  const metrics = {
    wordCount: totalWords,
    bodyWordCount: wordCount,
    inlineWordCount,
    citations: totalCitations,
    suggestions: totalSuggestions,
    inlineComments: inlineComments.length,
  };

  return {
    valid: violations.length === 0,
    violations,
    metrics,
  };
}

/**
 * Default quality standards exported for documentation/tooling.
 */
export const QUALITY_STANDARDS = {
  minWords: MIN_WORD_COUNT,
  requireCitations: true,
  noShallowApprovals: true,
  noApproveWithCaveats: true,
  preferNativeSuggestions: true,
};
