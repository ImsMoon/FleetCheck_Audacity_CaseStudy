import { createHash, createHmac } from 'node:crypto';

/**
 * Pure, deterministic quarterly selection.
 *
 * Method: "bottom-k by keyed hash". Each vehicle gets a score
 *   HMAC-SHA256(seed, [algorithmVersion, companyId, quarter, vehicleId])
 * and the k vehicles with the smallest scores are picked. Because the scores
 * behave like independent uniform random values, every k-subset is equally
 * likely, so every vehicle has the same chance (k / n). There is no modulo
 * bias and no dependence on input order or on previous quarters.
 */

export const ALGORITHM_VERSION = 'bottom-k-hmac-sha256/v1';

export type Rounding = 'ceil' | 'floor' | 'round';

export interface SelectionInput {
  companyId: string;
  /** Format YYYY-Qn, for example 2026-Q4. */
  quarter: string;
  /** Share of the fleet to pick, in (0, 100]. At most two decimals (0.01% steps). */
  percent: number;
  /** IDs of the company's active vehicles. Order does not matter. Must be unique. */
  vehicleIds: readonly string[];
  /**
   * Secret per-quarter seed held by the platform (for example in Secrets Manager).
   * Only its SHA-256 fingerprint is stored with the result; the seed itself is
   * revealed to an auditor on request so they can reproduce the draw.
   */
  seed: string;
  /** How a fractional count is rounded. Default 'ceil' (a non-empty fleet always gets a pick). */
  rounding?: Rounding;
}

export interface SelectionResult {
  algorithmVersion: string;
  companyId: string;
  quarter: string;
  percentBp: number;
  rounding: Rounding;
  eligibleCount: number;
  selectedCount: number;
  /** SHA-256 over the sorted eligible IDs: proves which fleet snapshot was used. */
  eligibleDigest: string;
  /** SHA-256 of the seed: a commitment that can be published before the draw. */
  seedFingerprint: string;
  /** Selected vehicle IDs, sorted. */
  selectedIds: string[];
}

const QUARTER_RE = /^\d{4}-Q[1-4]$/;

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Percent -> integer basis points (1% = 100). Rejects NaN, <= 0, > 100 and sub-0.01% precision. */
export function percentToBasisPoints(percent: number): number {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) {
    throw new RangeError('percent must be a finite number');
  }
  if (percent <= 0 || percent > 100) {
    throw new RangeError('percent must be greater than 0 and at most 100');
  }
  const bp = Math.round(percent * 100);
  if (Math.abs(percent * 100 - bp) > 1e-6) {
    throw new RangeError('percent supports at most two decimal places');
  }
  return bp;
}

/** Number of vehicles to pick, using integer arithmetic only (no floating point drift). */
export function targetCount(n: number, percentBp: number, rounding: Rounding = 'ceil'): number {
  const numerator = n * percentBp;
  let k: number;
  switch (rounding) {
    case 'ceil':
      k = Math.floor((numerator + 9999) / 10000);
      break;
    case 'floor':
      k = Math.floor(numerator / 10000);
      break;
    case 'round':
      k = Math.floor((numerator + 5000) / 10000);
      break;
    default:
      throw new RangeError(`unknown rounding mode: ${String(rounding)}`);
  }
  return Math.min(k, n);
}

function validate(input: SelectionInput): void {
  if (!input.companyId) throw new TypeError('companyId is required');
  if (!QUARTER_RE.test(input.quarter)) {
    throw new RangeError('quarter must look like 2026-Q4');
  }
  if (!input.seed) throw new TypeError('seed is required');
  const seen = new Set<string>();
  for (const id of input.vehicleIds) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('vehicle IDs must be non-empty strings');
    }
    if (seen.has(id)) throw new Error(`duplicate vehicle ID: ${id}`);
    seen.add(id);
  }
}

/** Digest of the eligible set; independent of input order. */
export function digestEligible(vehicleIds: readonly string[]): string {
  return sha256Hex(JSON.stringify([...vehicleIds].sort()));
}

export function seedFingerprint(seed: string): string {
  return sha256Hex(seed);
}

function score(seed: string, companyId: string, quarter: string, vehicleId: string): string {
  return createHmac('sha256', seed)
    .update(JSON.stringify([ALGORITHM_VERSION, companyId, quarter, vehicleId]))
    .digest('hex'); // fixed-length lowercase hex, so string order equals numeric order
}

/** Core draw, taking basis points directly. Used by selectVehicles and verifySelection. */
export function selectByBasisPoints(
  input: Omit<SelectionInput, 'percent'>,
  percentBp: number,
): SelectionResult {
  validate({ ...input, percent: 100 });
  const rounding = input.rounding ?? 'ceil';
  const n = input.vehicleIds.length;
  const k = targetCount(n, percentBp, rounding);

  const scored = input.vehicleIds.map((id) => ({
    id,
    s: score(input.seed, input.companyId, input.quarter, id),
  }));
  // Score first, ID as a tie-break (ties are astronomically unlikely, but the order stays total).
  scored.sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const selectedIds = scored.slice(0, k).map((e) => e.id).sort();

  return {
    algorithmVersion: ALGORITHM_VERSION,
    companyId: input.companyId,
    quarter: input.quarter,
    percentBp,
    rounding,
    eligibleCount: n,
    selectedCount: selectedIds.length,
    eligibleDigest: digestEligible(input.vehicleIds),
    seedFingerprint: seedFingerprint(input.seed),
    selectedIds,
  };
}

export function selectVehicles(input: SelectionInput): SelectionResult {
  return selectByBasisPoints(input, percentToBasisPoints(input.percent));
}

export interface VerifyReport {
  ok: boolean;
  problems: string[];
}

/**
 * Auditor entry point: recompute the draw from the stored record plus the
 * original inputs (fleet snapshot and revealed seed) and compare every field.
 */
export function verifySelection(
  record: SelectionResult,
  inputs: { vehicleIds: readonly string[]; seed: string },
): VerifyReport {
  const problems: string[] = [];
  if (record.algorithmVersion !== ALGORITHM_VERSION) {
    problems.push(`algorithm version ${record.algorithmVersion} is not supported by this verifier`);
    return { ok: false, problems };
  }
  const recomputed = selectByBasisPoints(
    {
      companyId: record.companyId,
      quarter: record.quarter,
      vehicleIds: inputs.vehicleIds,
      seed: inputs.seed,
      rounding: record.rounding,
    },
    record.percentBp,
  );
  if (recomputed.seedFingerprint !== record.seedFingerprint) problems.push('seed does not match the stored fingerprint');
  if (recomputed.eligibleDigest !== record.eligibleDigest) problems.push('fleet snapshot does not match the stored digest');
  if (recomputed.eligibleCount !== record.eligibleCount) problems.push('eligible count differs');
  if (recomputed.selectedCount !== record.selectedCount) problems.push('selected count differs');
  if (JSON.stringify(recomputed.selectedIds) !== JSON.stringify(record.selectedIds)) {
    problems.push('selected vehicles differ from the recomputed draw');
  }
  return { ok: problems.length === 0, problems };
}
