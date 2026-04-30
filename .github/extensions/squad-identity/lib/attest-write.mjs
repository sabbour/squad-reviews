#!/usr/bin/env node
/**
 * Convenience wrapper that records an attestation and optionally verifies it
 * against the GitHub API in a single call.
 */

import { join } from 'node:path';
import { recordAttestation } from './attestation-store.mjs';
import { verifyWrite } from './attestation-verify.mjs';

/**
 * Record an attestation for a GitHub write and optionally verify the actor.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot      Absolute path to the repository root.
 * @param {string} opts.owner         GitHub org/user that owns the repo.
 * @param {string} opts.repo          Repository name.
 * @param {string} opts.writeType     Type of write (pr-create, pr-comment, etc.).
 * @param {string} opts.writeRef      Reference identifier (PR number, comment ID, SHA).
 * @param {string} opts.roleSlug      Agent role slug from config.
 * @param {string} opts.expectedActor Expected bot login (e.g. "my-bot[bot]").
 * @param {string} opts.token         GitHub token for API verification.
 * @param {boolean} [opts.verify=true] Whether to verify via GitHub API after recording.
 * @returns {Promise<{attestationId: string, recorded: boolean, verification: object|null}>}
 */
export async function attestWrite({
  repoRoot,
  owner,
  repo,
  writeType,
  writeRef,
  roleSlug,
  expectedActor,
  token,
  verify = true,
}) {
  const logDir = join(repoRoot, '.squad', 'attestation');

  // Step 1: Record the attestation with actualActor as 'pending'
  const record = recordAttestation({
    attestationDir: logDir,
    writeType,
    owner,
    repo,
    targetObject: writeRef,
    roleSlug,
    expectedActor,
    actualActor: 'pending',
  });

  const attestationId = record.attestation_id;

  // Step 2: Optionally verify the write via the GitHub API
  let verification = null;
  if (verify) {
    const result = await verifyWrite({ owner, repo, writeType, writeRef, expectedActor, token });
    verification = { verified: result.verified, actualActor: result.actualActor };

    // If actual actor differs from expected, append a correction record
    if (result.actualActor && result.actualActor !== 'pending') {
      recordAttestation({
        attestationDir: logDir,
        writeType,
        owner,
        repo,
        targetObject: writeRef,
        roleSlug,
        expectedActor,
        actualActor: result.actualActor,
        writeId: attestationId, // link correction to original
      });
    }
  }

  return { attestationId, recorded: true, verification };
}

// CLI mode
const scriptPath = new URL(import.meta.url).pathname;
const invoked = process.argv[1] && new URL(`file://${process.argv[1]}`).pathname === scriptPath;

if (invoked) {
  const args = process.argv.slice(2);

  function flag(name) {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 ? args[idx + 1] : undefined;
  }

  function hasFlag(name) {
    return args.includes(`--${name}`);
  }

  const opts = {
    repoRoot: flag('repo-root'),
    owner: flag('owner'),
    repo: flag('repo'),
    writeType: flag('write-type'),
    writeRef: flag('write-ref'),
    roleSlug: flag('role-slug'),
    expectedActor: flag('expected-actor'),
    token: flag('token'),
    verify: !hasFlag('no-verify'),
  };

  const required = ['repoRoot', 'owner', 'repo', 'writeType', 'writeRef', 'roleSlug', 'expectedActor', 'token'];
  const missing = required.filter((k) => !opts[k]);
  if (missing.length) {
    console.error(`Missing required flags: ${missing.map((k) => '--' + k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())).join(', ')}`);
    process.exit(1);
  }

  attestWrite(opts).then((result) => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    const failed = result.verification && !result.verification.verified;
    process.exit(failed ? 1 : 0);
  }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
