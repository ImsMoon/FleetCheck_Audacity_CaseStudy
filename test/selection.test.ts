import { describe, expect, it } from 'vitest';
import {
  percentToBasisPoints,
  selectVehicles,
  targetCount,
  verifySelection,
  type SelectionInput,
} from '../src/selection';

const ids = (n: number, prefix = 'veh'): string[] => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

const base = (over: Partial<SelectionInput> = {}): SelectionInput => ({
  companyId: 'co-1',
  quarter: '2026-Q4',
  percent: 25,
  seed: 'test-seed-0001',
  vehicleIds: ids(20),
  ...over,
});

/** Small deterministic shuffle so the tests never depend on Math.random. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const a = [...items];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) % 4294967296;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

describe('count', () => {
  it('picks 5 of 20 at 25%', () => {
    const r = selectVehicles(base());
    expect(r.selectedCount).toBe(5);
    expect(r.selectedIds).toHaveLength(5);
    expect(new Set(r.selectedIds).size).toBe(5);
  });

  it('every picked ID comes from the eligible set', () => {
    const fleet = ids(20);
    const r = selectVehicles(base({ vehicleIds: fleet }));
    for (const id of r.selectedIds) expect(fleet).toContain(id);
  });

  it('rounds up by default so a tiny fleet still gets one pick', () => {
    expect(selectVehicles(base({ vehicleIds: ids(3) })).selectedCount).toBe(1); // 0.75 -> 1
    expect(selectVehicles(base({ vehicleIds: ids(1) })).selectedCount).toBe(1);
  });

  it('supports floor and round', () => {
    expect(selectVehicles(base({ vehicleIds: ids(3), rounding: 'floor' })).selectedCount).toBe(0);
    expect(selectVehicles(base({ vehicleIds: ids(6), rounding: 'round' })).selectedCount).toBe(2); // 1.5 -> 2
    expect(selectVehicles(base({ vehicleIds: ids(6), rounding: 'floor' })).selectedCount).toBe(1);
  });

  it('uses exact integer arithmetic (no float drift)', () => {
    expect(targetCount(100, percentToBasisPoints(29), 'ceil')).toBe(29); // 100 * 0.29 is 28.999... in floats
    expect(targetCount(100, percentToBasisPoints(0.07), 'ceil')).toBe(1);
    expect(targetCount(200_000, percentToBasisPoints(25), 'ceil')).toBe(50_000);
  });

  it('handles 100% and an empty fleet', () => {
    expect(selectVehicles(base({ percent: 100 })).selectedCount).toBe(20);
    const empty = selectVehicles(base({ vehicleIds: [] }));
    expect(empty.selectedIds).toEqual([]);
    expect(empty.eligibleCount).toBe(0);
  });
});

describe('determinism and reproducibility', () => {
  it('gives the same result for the same inputs', () => {
    expect(selectVehicles(base())).toEqual(selectVehicles(base()));
  });

  it('does not depend on the order of the input list', () => {
    const fleet = ids(200);
    const a = selectVehicles(base({ vehicleIds: fleet }));
    const b = selectVehicles(base({ vehicleIds: shuffled(fleet, 7) }));
    expect(b).toEqual(a);
  });

  it('changes with the seed, the quarter and the company', () => {
    const a = selectVehicles(base({ vehicleIds: ids(200) })).selectedIds;
    expect(selectVehicles(base({ vehicleIds: ids(200), seed: 'another-seed-0002' })).selectedIds).not.toEqual(a);
    expect(selectVehicles(base({ vehicleIds: ids(200), quarter: '2027-Q1' })).selectedIds).not.toEqual(a);
    expect(selectVehicles(base({ vehicleIds: ids(200), companyId: 'co-2' })).selectedIds).not.toEqual(a);
  });

  it('an auditor can reproduce and verify a stored result', () => {
    const fleet = ids(500);
    const record = selectVehicles(base({ vehicleIds: fleet }));
    expect(verifySelection(record, { vehicleIds: shuffled(fleet, 3), seed: 'test-seed-0001' })).toEqual({
      ok: true,
      problems: [],
    });
  });

  it('verification fails for a wrong seed, a changed fleet, or a tampered result', () => {
    const fleet = ids(100);
    const record = selectVehicles(base({ vehicleIds: fleet }));

    expect(verifySelection(record, { vehicleIds: fleet, seed: 'wrong-seed-000000' }).ok).toBe(false);
    expect(verifySelection(record, { vehicleIds: [...fleet, 'veh-new'], seed: 'test-seed-0001' }).ok).toBe(false);

    const outsider = fleet.find((id) => !record.selectedIds.includes(id))!;
    const tampered = { ...record, selectedIds: [outsider, ...record.selectedIds.slice(1)].sort() };
    const report = verifySelection(tampered, { vehicleIds: fleet, seed: 'test-seed-0001' });
    expect(report.ok).toBe(false);
    expect(report.problems.join(' ')).toContain('selected vehicles differ');
  });
});

describe('fairness', () => {
  it('gives each of 20 vehicles the same chance (k/n = 25%) across 4000 seeds', () => {
    const fleet = ids(20);
    const hits = new Map<string, number>(fleet.map((id) => [id, 0]));
    const draws = 4000;
    for (let i = 0; i < draws; i++) {
      for (const id of selectVehicles(base({ vehicleIds: fleet, seed: `fairness-seed-${i}` })).selectedIds) {
        hits.set(id, hits.get(id)! + 1);
      }
    }
    // Expected 1000 each, standard deviation about 27; allow roughly 5.5 sigma.
    for (const [id, count] of hits) {
      expect(Math.abs(count - 1000), `${id} was picked ${count} times`).toBeLessThan(150);
    }
  });

  it('every 2-subset of a 6-vehicle fleet is equally likely', () => {
    const fleet = ids(6);
    const draws = 3000;
    const counts = new Map<string, number>();
    for (let i = 0; i < draws; i++) {
      const selected = selectVehicles(
        base({ vehicleIds: fleet, percent: 33.33, seed: `fairness-pair-${i}` }),
      ).selectedIds;
      expect(selected).toHaveLength(2);
      const pair = selected.join(',');
      counts.set(pair, (counts.get(pair) ?? 0) + 1);
    }

    // 33.33% of 6 rounds up to k = 2. C(6, 2) = 15 subsets, so each pair's expected count is 200.
    // Pinned from one local run of these seeds. Each pin is within 80 of 200 (~4 standard deviations).
    const expected: Record<string, number> = {
      'veh-0,veh-1': 177,
      'veh-0,veh-2': 181,
      'veh-0,veh-3': 198,
      'veh-0,veh-4': 188,
      'veh-0,veh-5': 204,
      'veh-1,veh-2': 193,
      'veh-1,veh-3': 204,
      'veh-1,veh-4': 218,
      'veh-1,veh-5': 207,
      'veh-2,veh-3': 209,
      'veh-2,veh-4': 240,
      'veh-2,veh-5': 175,
      'veh-3,veh-4': 193,
      'veh-3,veh-5': 218,
      'veh-4,veh-5': 195,
    };

    expect([...counts.keys()].sort()).toEqual(Object.keys(expected).sort());
    for (const [pair, count] of Object.entries(expected)) {
      expect(counts.get(pair), pair).toBe(count);
      expect(Math.abs(count - draws / 15), pair).toBeLessThanOrEqual(80);
    }
  });

  it('does not exclude vehicles that were picked last quarter', () => {
    const fleet = ids(20);
    let overlap = 0;
    let pairs = 0;
    let previous = new Set<string>();
    for (let year = 1900; year < 2100; year++) {
      for (let q = 1; q <= 4; q++) {
        const picked = new Set(selectVehicles(base({ vehicleIds: fleet, quarter: `${year}-Q${q}` })).selectedIds);
        if (previous.size > 0) {
          for (const id of picked) if (previous.has(id)) overlap++;
          pairs++;
        }
        previous = picked;
      }
    }
    // Expected overlap between consecutive quarters is 5 * 5/20 = 1.25. An exclusion rule would give 0.
    expect(overlap / pairs).toBeGreaterThan(0.9);
    expect(overlap / pairs).toBeLessThan(1.6);
  });

  it('a vehicle picked in one quarter can be picked in the next', () => {
    const fleet = ids(20);
    const named = 'veh-1';
    expect(fleet).toContain(named);

    const firstQuarter = selectVehicles(base({ vehicleIds: fleet, quarter: '2026-Q1' }));
    const nextQuarter = selectVehicles(base({ vehicleIds: fleet, quarter: '2026-Q2' }));

    expect(firstQuarter.eligibleCount).toBe(20);
    expect(nextQuarter.eligibleCount).toBe(20);
    expect(firstQuarter.selectedIds).toContain(named);
    expect(nextQuarter.selectedIds).toContain(named);
  });
});

describe('scale', () => {
  it('works for 200,000 vehicles', () => {
    const fleet = ids(200_000);
    const fleetSet = new Set(fleet);
    const input = base({ vehicleIds: fleet });
    const started = performance.now();
    const first = selectVehicles(input);
    const second = selectVehicles(input);
    const elapsedMs = performance.now() - started;
    expect(first.selectedCount).toBe(50_000);
    expect(new Set(first.selectedIds).size).toBe(50_000);
    expect(first.selectedIds.filter((id) => !fleetSet.has(id))).toEqual([]);
    expect(second).toEqual(first);
    expect(elapsedMs).toBeLessThan(15_000); // generous ceiling for both calls; typically well under 2 s each
    console.log(`200,000 vehicles at 25%, two calls: ${Math.round(elapsedMs)} ms`);
  });
});

describe('input validation', () => {
  it('rejects a bad percentage', () => {
    for (const percent of [0, -5, 100.01, Number.NaN, Number.POSITIVE_INFINITY, 12.345]) {
      expect(() => selectVehicles(base({ percent })), String(percent)).toThrow(RangeError);
    }
  });

  it('accepts fractional percentages with up to two decimals', () => {
    expect(selectVehicles(base({ percent: 12.5, vehicleIds: ids(80) })).selectedCount).toBe(10);
  });

  it('rejects a malformed quarter', () => {
    for (const quarter of ['2026Q4', '2026-Q5', '26-Q1', '2026-q1', '']) {
      expect(() => selectVehicles(base({ quarter })), quarter).toThrow(RangeError);
    }
  });

  it('rejects duplicate or empty vehicle IDs and missing company or seed', () => {
    expect(() => selectVehicles(base({ vehicleIds: ['a', 'b', 'a'] }))).toThrow(/duplicate/);
    expect(() => selectVehicles(base({ vehicleIds: ['a', ''] }))).toThrow(TypeError);
    expect(() => selectVehicles(base({ companyId: '' }))).toThrow(TypeError);
    expect(() => selectVehicles(base({ seed: '' }))).toThrow(TypeError);
  });
});
