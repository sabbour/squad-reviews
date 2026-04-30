import crypto from 'node:crypto';

const leases = new Map();

const now = () => Math.floor(Date.now() / 1000);

/**
 * Create a time-bound, operation-counted lease for a resolved token.
 * @param {object} opts
 * @param {string} opts.role - Role slug the lease is scoped to.
 * @param {string} opts.token - GitHub App installation token.
 * @param {number} [opts.maxOps=3] - Maximum exchange operations allowed.
 * @param {number} [opts.maxTimeSec=300] - Lease lifetime in seconds.
 * @returns {{ scopeId: string, role: string, token: string, deadlineUnix: number, remainingOps: number, leasedAtUnix: number }}
 */
export function createLease({ role, token, maxOps = 3, maxTimeSec = 300 }) {
  const scopeId = `lease_${crypto.randomBytes(8).toString('hex')}`;
  const leasedAtUnix = now();
  const deadlineUnix = leasedAtUnix + maxTimeSec;
  const lease = { scopeId, role, token, deadlineUnix, remainingOps: maxOps, leasedAtUnix, revoked: false };
  leases.set(scopeId, lease);
  return { scopeId, role, token, deadlineUnix, remainingOps: maxOps, leasedAtUnix };
}

/**
 * Exchange a lease for its token, decrementing the operation counter.
 * @param {string} scopeId - Lease identifier.
 * @param {string} role - Expected role slug (must match the lease).
 * @returns {{ token: string, remainingOps: number }}
 * @throws If lease is missing, expired, exhausted, revoked, or role mismatches.
 */
export function exchangeLease(scopeId, role) {
  const lease = leases.get(scopeId);
  if (!lease) throw new Error(`Lease not found: ${scopeId}`);
  if (lease.revoked) throw new Error('Lease revoked');
  if (now() >= lease.deadlineUnix) throw new Error('Lease expired: deadline reached');
  if (lease.remainingOps === 0) throw new Error('Lease exhausted: no remaining operations');
  if (lease.role !== role) throw new Error(`Role mismatch: lease is for '${lease.role}', not '${role}'`);

  lease.remainingOps -= 1;
  return { token: lease.token, remainingOps: lease.remainingOps };
}

/**
 * Validate a lease without consuming an operation.
 * @param {string} scopeId
 * @returns {{ valid: boolean, reason?: string, remainingOps?: number, deadlineUnix?: number }}
 */
export function validateLease(scopeId) {
  const lease = leases.get(scopeId);
  if (!lease) return { valid: false, reason: `Lease not found: ${scopeId}` };
  if (lease.revoked) return { valid: false, reason: 'Lease revoked' };
  if (now() >= lease.deadlineUnix) return { valid: false, reason: 'Lease expired: deadline reached' };
  if (lease.remainingOps === 0) return { valid: false, reason: 'Lease exhausted: no remaining operations' };
  return { valid: true, remainingOps: lease.remainingOps, deadlineUnix: lease.deadlineUnix };
}

/**
 * Explicitly revoke a lease.
 * @param {string} scopeId
 */
export function revokeLease(scopeId) {
  const lease = leases.get(scopeId);
  if (lease) lease.revoked = true;
}

/**
 * Remove all expired or exhausted leases from memory.
 */
export function cleanupExpired() {
  const ts = now();
  for (const [id, lease] of leases) {
    if (lease.revoked || ts >= lease.deadlineUnix || lease.remainingOps === 0) {
      leases.delete(id);
    }
  }
}

/**
 * List all active leases (for debugging / status).
 * @returns {Array<{ scopeId: string, role: string, deadlineUnix: number, remainingOps: number, leasedAtUnix: number }>}
 */
export function listLeases() {
  return [...leases.values()].map(({ scopeId, role, deadlineUnix, remainingOps, leasedAtUnix }) => ({
    scopeId, role, deadlineUnix, remainingOps, leasedAtUnix,
  }));
}
