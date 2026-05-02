import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SQUAD_REVIEWS_BLOCK_START = '<!-- squad-reviews: start -->';
export const SQUAD_REVIEWS_BLOCK_END = '<!-- squad-reviews: end -->';

const BLOCK_START_RE = /<!--\s*squad-reviews:\s*start(?:\s+v([^\s>-]+))?\s*-->/;

function readPackageVersion() {
  try {
    const pkgUrl = new URL('../../../package.json', import.meta.url);
    return JSON.parse(readFileSync(fileURLToPath(pkgUrl), 'utf-8')).version;
  } catch {
    return null;
  }
}

export function buildSquadReviewsInstructionsBlock() {
  const version = readPackageVersion();
  const startTag = version
    ? `<!-- squad-reviews: start v${version} -->`
    : SQUAD_REVIEWS_BLOCK_START;
  return `${startTag}
## REVIEW GATE — PR Merge Requirements

This project enforces a CI review gate that blocks PR merges until:
1. All required reviewer roles have submitted a native GitHub review with \`APPROVED\` state.
2. All review conversation threads are resolved (no unresolved threads).

### Coordinator workflow — requesting reviews

\`squad_reviews_dispatch_review\` is a **SIGNAL ONLY** tool. It applies the
\`review:{role}:requested\` label and posts a notification comment — it does
**NOT** spawn the reviewer agent. Returning \`dispatched: true\` only means the
label and comment were applied.

After every \`squad_reviews_dispatch_review\` call, the coordinator MUST in the
same turn dispatch the named reviewer agent via the platform's spawn tool
(\`task\` on CLI, \`runSubagent\` on VS Code) so the review actually runs.

For parallel reviews, call \`squad_reviews_dispatch_review\` once per role AND
spawn each reviewer agent — both in the same turn.

### Agent workflow before merge

1. After pushing changes, call \`squad_reviews_acknowledge_feedback\` to check for unresolved threads.
2. For each unresolved thread:
   - If you fixed the issue: call \`squad_reviews_resolve_thread\` with action \`addressed\` and reference the fix commit.
   - If the feedback does not apply: call \`squad_reviews_resolve_thread\` with action \`dismissed\` with a justification.
3. **Never** resolve a thread without replying first — silent dismissal is a governance failure.
4. **Never** self-approve your own PR.
5. Do not manually apply \`{role}:approved\` labels — the gate applies them automatically.

The gate will not pass until all threads are resolved and all required roles have approved.
${SQUAD_REVIEWS_BLOCK_END}`;
}

export function readInstalledReviewsVersion(targetRepo) {
  const instructionsPath = join(targetRepo, '.github', 'copilot-instructions.md');
  if (!existsSync(instructionsPath)) return null;
  try {
    const content = readFileSync(instructionsPath, 'utf-8');
    const match = content.match(BLOCK_START_RE);
    return match && match[1] ? match[1] : null;
  } catch {
    return null;
  }
}

export function updateCopilotInstructions(targetRepo) {
  const instructionsPath = join(targetRepo, '.github', 'copilot-instructions.md');
  const previousVersion = readInstalledReviewsVersion(targetRepo);
  const block = buildSquadReviewsInstructionsBlock();
  const newVersion = readPackageVersion();

  if (!existsSync(instructionsPath)) {
    const githubDir = dirname(instructionsPath);
    if (!existsSync(githubDir)) {
      mkdirSync(githubDir, { recursive: true });
    }
    writeFileSync(instructionsPath, block + '\n', 'utf-8');
    return { action: 'Created', path: instructionsPath, previousVersion: null, newVersion };
  }

  let content = readFileSync(instructionsPath, 'utf-8');
  const startMatch = content.match(BLOCK_START_RE);
  const endIdx = content.indexOf(SQUAD_REVIEWS_BLOCK_END);

  if (startMatch && endIdx !== -1 && endIdx > startMatch.index) {
    const before = content.slice(0, startMatch.index);
    const after = content.slice(endIdx + SQUAD_REVIEWS_BLOCK_END.length);
    content = before + block + after;
    writeFileSync(instructionsPath, content, 'utf-8');
    return { action: 'Replaced', path: instructionsPath, previousVersion, newVersion };
  }

  content = content.trimEnd() + '\n\n' + block + '\n';
  writeFileSync(instructionsPath, content, 'utf-8');
  return { action: 'Appended', path: instructionsPath, previousVersion, newVersion };
}
