# Quarterly random selection (FleetCheck case study, Part 4 Option A)

Picks a percentage of a company's active vehicles for the quarterly surprise inspection.
Every vehicle has an equal chance, an auditor can reproduce the result, and running it twice
for the same company and quarter returns the same stored selection.

## Run it

Requires Node 20 or newer.

```bash
npm install
npm test            # 27 tests, including 200,000 vehicles and a fairness check
npm run typecheck

# Try the auditor workflow from the command line
cat > input.json <<'JSON'
{ "companyId": "co-1", "quarter": "2026-Q4", "percent": 25,
  "seed": "a-long-random-quarter-seed",
  "vehicleIds": ["v1","v2","v3","v4","v5","v6","v7","v8","v9","v10","v11","v12","v13","v14","v15","v16","v17","v18","v19","v20"] }
JSON
npm run select -- input.json > result.json
npm run verify -- input.json result.json      # prints { "ok": true, ... }, exit code 0
```

## How it works

| Requirement | How it is met |
| --- | --- |
| Equal chance | Each vehicle gets `HMAC-SHA256(seed, [version, companyId, quarter, vehicleId])`. The `k` vehicles with the smallest scores are picked. Scores behave like independent uniform values, so every `k`-subset is equally likely. No modulo bias, no PRNG state. |
| Reproducible by an auditor | The function is pure. Inputs: fleet snapshot, percentage, quarter, company, seed, rounding. The stored record holds the algorithm version, the SHA-256 of the sorted fleet, the SHA-256 of the seed, the count and the picked IDs. `verifySelection` recomputes all of it. |
| Picked last quarter, still eligible | The draw takes no history as input. A test checks that consecutive quarters overlap at the rate chance predicts (about 1.25 of 5 vehicles), which an exclusion rule would make zero. |
| Same company and quarter twice gives the same selection | `runQuarterlySelection` checks the store first and inserts with `putIfAbsent`. In PostgreSQL that is `UNIQUE (company_id, quarter)` plus `INSERT ... ON CONFLICT DO NOTHING`. Concurrent callers all receive the one winning row. Tested with 10 concurrent runs. |
| 20 to 200,000 vehicles | One HMAC per vehicle plus one sort. 200,000 vehicles at 25% takes about 1.5 s on a laptop. |

### The seed

The seed is a secret per-quarter value held by the platform (for example in Secrets Manager).
If the seed were public or derivable from company and quarter, an admin could try fleet
changes and see in advance who would be picked. So: publish `SHA-256(seed)` before the
quarter's draw (commit), keep the seed secret until the draw is stored, then reveal it to an
auditor, who runs `verify`. Use at least 32 random bytes.

### Persistence (PostgreSQL)

The store is an interface; tests use an in-memory version. The production version is:

```sql
CREATE TABLE quarterly_selections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  quarter          text NOT NULL CHECK (quarter ~ '^\d{4}-Q[1-4]$'),
  algorithm_version text NOT NULL,
  percent_bp       int  NOT NULL,
  rounding         text NOT NULL,
  eligible_count   int  NOT NULL,
  eligible_digest  text NOT NULL,
  seed_fingerprint text NOT NULL,
  input_digest     text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, quarter)
);
-- selected vehicles live in selection_vehicles(selection_id, vehicle_id, company_id)

-- putIfAbsent: run in one transaction together with the selection_vehicles insert
INSERT INTO quarterly_selections (...) VALUES (...)
ON CONFLICT (company_id, quarter) DO NOTHING
RETURNING *;
-- no row returned means someone else won: SELECT the existing row and return it
```

## Complexity

Let `n` be the number of active vehicles and `k` the number picked (about `n * percent`).

- Time: `O(n log n)`. `n` HMAC computations (`O(n)`), one sort of `n` scores (`O(n log n)`), and a sort of the `k` picked IDs. The idempotent re-run path skips scoring and costs `O(n log n)` only for the fleet digest. A selection step with quickselect or a heap of size `k` would give `O(n)` or `O(n log k)`; I kept the full sort because it is simpler to audit and 200,000 vehicles already runs in about 1.5 s.
- Space: `O(n)` for the scored list, plus `O(k)` for the result.

## Edge case the brief does not mention

**The fleet changes between the first run and a later one.** A vehicle is added, sold or
deactivated after the draw, and someone re-runs the job (a retry, a deploy, an ops click).
Recomputing from today's vehicle list produces a different selection, which breaks both
idempotency and the auditor's ability to reproduce what was actually drawn. The fix here:
the result is stored together with a digest of the exact fleet snapshot and the first call
wins; later calls return the stored selection and flag `inputsChanged` when the inputs differ.
It also forces a product decision to confirm with the client: what happens to a vehicle added
after the draw (not eligible until next quarter, in my assumption) and to a picked vehicle
that is deactivated afterwards (stays picked, with a recorded reason).

Related policy choices that are configurable and should be confirmed with the client:
rounding of fractional counts (default rounds up, so a fleet of 3 at 25% still gets 1 pick)
and which instant defines "active".

## Files

- `src/selection.ts`: pure draw, count rounding, verification.
- `src/service.ts`: idempotent runner and the store interface with an in-memory store.
- `src/cli.ts`: `select` and `verify` commands for auditors.
- `test/`: 27 tests (determinism, order independence, fairness, scale, idempotency, concurrency, validation).
