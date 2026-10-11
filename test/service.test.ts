import { describe, expect, it } from 'vitest';
import { InMemorySelectionStore, runQuarterlySelection, type SelectionStore, type StoredSelection } from '../src/service';
import { verifySelection, type SelectionInput } from '../src/selection';

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `veh-${i}`);
const input = (over: Partial<SelectionInput> = {}): SelectionInput => ({
  companyId: 'co-1',
  quarter: '2026-Q4',
  percent: 25,
  seed: 'quarter-seed-abcdef',
  vehicleIds: ids(100),
  ...over,
});

describe('idempotency', () => {
  it('running twice for the same company and quarter returns the same selection', async () => {
    const store = new InMemorySelectionStore();
    const first = await runQuarterlySelection(store, input());
    const second = await runQuarterlySelection(store, input());

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.record).toEqual(first.record);
    expect(store.size).toBe(1);
  });

  it('keeps the stored selection even if the fleet changed in between', async () => {
    const store = new InMemorySelectionStore();
    const first = await runQuarterlySelection(store, input());

    const changedFleet = [...ids(100).slice(10), 'veh-new-1', 'veh-new-2'];
    const second = await runQuarterlySelection(store, input({ vehicleIds: changedFleet }));

    expect(second.reused).toBe(true);
    expect(second.inputsChanged).toBe(true);
    expect(second.record.selectedIds).toEqual(first.record.selectedIds);
    // The stored snapshot is what an auditor must use, and it still verifies.
    expect(verifySelection(second.record, { vehicleIds: ids(100), seed: 'quarter-seed-abcdef' }).ok).toBe(true);
  });

  it('reports inputsChanged = false for an identical re-run', async () => {
    const store = new InMemorySelectionStore();
    await runQuarterlySelection(store, input());
    const again = await runQuarterlySelection(store, input({ vehicleIds: [...ids(100)].reverse() }));
    expect(again.inputsChanged).toBe(false);
  });

  it('different quarters and different companies get their own selections', async () => {
    const store = new InMemorySelectionStore();
    await runQuarterlySelection(store, input());
    await runQuarterlySelection(store, input({ quarter: '2027-Q1' }));
    await runQuarterlySelection(store, input({ companyId: 'co-2' }));
    expect(store.size).toBe(3);
  });

  it('concurrent runs all see one winner and one stored row', async () => {
    // A store whose get() is slow, so every caller misses the cache and races to insert.
    class SlowStore implements SelectionStore {
      readonly inner = new InMemorySelectionStore();
      async get(companyId: string, quarter: string): Promise<StoredSelection | undefined> {
        await new Promise((r) => setTimeout(r, 10));
        return this.inner.get(companyId, quarter);
      }
      putIfAbsent(record: StoredSelection) {
        return this.inner.putIfAbsent(record);
      }
    }
    const store = new SlowStore();
    const outcomes = await Promise.all(Array.from({ length: 10 }, () => runQuarterlySelection(store, input())));

    expect(store.inner.size).toBe(1);
    expect(outcomes.filter((o) => !o.reused)).toHaveLength(1);
    const winner = outcomes.find((o) => !o.reused)!.record;
    for (const o of outcomes) expect(o.record).toEqual(winner);
  });

  it('stores an audit record that an auditor can verify', async () => {
    const store = new InMemorySelectionStore();
    const { record } = await runQuarterlySelection(store, input(), () => new Date('2026-10-01T00:00:00Z'));
    expect(record.createdAt).toBe('2026-10-01T00:00:00.000Z');
    expect(record.seedFingerprint).toHaveLength(64);
    expect(verifySelection(record, { vehicleIds: ids(100), seed: 'quarter-seed-abcdef' }).ok).toBe(true);
  });

  it('does not store anything when the input is invalid', async () => {
    const store = new InMemorySelectionStore();
    await expect(runQuarterlySelection(store, input({ percent: 0 }))).rejects.toThrow(RangeError);
    await expect(runQuarterlySelection(store, input({ vehicleIds: ['a', 'a'] }))).rejects.toThrow(/duplicate/);
    expect(store.size).toBe(0);
  });
});
