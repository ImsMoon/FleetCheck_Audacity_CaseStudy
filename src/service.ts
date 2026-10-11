import { createHash } from 'node:crypto';
import {
  digestEligible,
  percentToBasisPoints,
  seedFingerprint,
  selectByBasisPoints,
  ALGORITHM_VERSION,
  type SelectionInput,
  type SelectionResult,
} from './selection';

/** What is persisted per (company, quarter). */
export interface StoredSelection extends SelectionResult {
  /** Digest of every input that influenced the draw; used to notice a re-run with different inputs. */
  inputDigest: string;
  createdAt: string;
}

/**
 * Persistence port. The real implementation is PostgreSQL with
 * UNIQUE (company_id, quarter) and INSERT ... ON CONFLICT DO NOTHING (see README).
 * putIfAbsent must be atomic: exactly one concurrent caller creates the row,
 * and every caller gets the winning row back.
 */
export interface SelectionStore {
  get(companyId: string, quarter: string): Promise<StoredSelection | undefined>;
  putIfAbsent(record: StoredSelection): Promise<{ stored: StoredSelection; created: boolean }>;
}

export class InMemorySelectionStore implements SelectionStore {
  private readonly rows = new Map<string, StoredSelection>();
  private key(companyId: string, quarter: string): string {
    return JSON.stringify([companyId, quarter]);
  }
  async get(companyId: string, quarter: string): Promise<StoredSelection | undefined> {
    const row = this.rows.get(this.key(companyId, quarter));
    return row ? structuredClone(row) : undefined;
  }
  async putIfAbsent(record: StoredSelection): Promise<{ stored: StoredSelection; created: boolean }> {
    const key = this.key(record.companyId, record.quarter);
    const existing = this.rows.get(key);
    if (existing) return { stored: structuredClone(existing), created: false };
    this.rows.set(key, structuredClone(record));
    return { stored: structuredClone(record), created: true };
  }
  get size(): number {
    return this.rows.size;
  }
}

export interface RunOutcome {
  record: StoredSelection;
  /** True when a selection for this company and quarter already existed and was returned unchanged. */
  reused: boolean;
  /** True when a reused selection was produced from different inputs than the ones passed now. */
  inputsChanged: boolean;
}

function inputDigest(eligibleDigest: string, percentBp: number, rounding: string, seedFp: string): string {
  return createHash('sha256')
    .update(JSON.stringify([ALGORITHM_VERSION, eligibleDigest, percentBp, rounding, seedFp]))
    .digest('hex');
}

/**
 * Idempotent entry point. The first call for a (company, quarter) draws and
 * stores the result; every later call, however many and however concurrent,
 * returns that same stored result, even if the fleet has changed since.
 */
export async function runQuarterlySelection(
  store: SelectionStore,
  input: SelectionInput,
  now: () => Date = () => new Date(),
): Promise<RunOutcome> {
  const percentBp = percentToBasisPoints(input.percent);
  const rounding = input.rounding ?? 'ceil';
  const currentDigest = inputDigest(
    digestEligible(input.vehicleIds),
    percentBp,
    rounding,
    seedFingerprint(input.seed),
  );

  const existing = await store.get(input.companyId, input.quarter);
  if (existing) {
    return { record: existing, reused: true, inputsChanged: existing.inputDigest !== currentDigest };
  }

  const result = selectByBasisPoints(input, percentBp);
  const candidate: StoredSelection = {
    ...result,
    inputDigest: currentDigest,
    createdAt: now().toISOString(),
  };
  const { stored, created } = await store.putIfAbsent(candidate);
  return {
    record: stored,
    reused: !created,
    inputsChanged: !created && stored.inputDigest !== currentDigest,
  };
}
