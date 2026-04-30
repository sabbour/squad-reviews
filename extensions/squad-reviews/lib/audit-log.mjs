/**
 * Audit log: append-only JSONL file for review actions.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const AUDIT_LOG_RELATIVE_PATH = join('reviews', 'audit.jsonl');

/**
 * Append a review action to the audit log.
 * @param {string} repoRoot
 * @param {object} entry
 * @param {string} entry.action - e.g. 'review_posted', 'thread_resolved', 'feedback_acknowledged'
 * @param {object} [entry.meta] - additional metadata
 */
export function appendAuditEntry(repoRoot, { action, ...meta }) {
  const logPath = join(repoRoot, AUDIT_LOG_RELATIVE_PATH);
  mkdirSync(dirname(logPath), { recursive: true });

  const entry = {
    timestamp: new Date().toISOString(),
    action,
    ...meta,
  };

  appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}
