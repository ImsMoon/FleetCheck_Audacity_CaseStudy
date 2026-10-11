import { readFileSync } from 'node:fs';
import { selectVehicles, verifySelection, type SelectionInput, type SelectionResult } from './selection';

const usage = `Usage:
  npm run select -- <input.json>             draw and print the result as JSON
  npm run verify -- <input.json> <result.json>   recompute and compare with a stored result

input.json: { "companyId": "...", "quarter": "2026-Q4", "percent": 25, "seed": "...", "vehicleIds": ["..."] }`;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

const [command, inputPath, resultPath] = process.argv.slice(2);

if (command === 'select' && inputPath) {
  console.log(JSON.stringify(selectVehicles(readJson<SelectionInput>(inputPath)), null, 2));
} else if (command === 'verify' && inputPath && resultPath) {
  const input = readJson<SelectionInput>(inputPath);
  const report = verifySelection(readJson<SelectionResult>(resultPath), input);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
} else {
  console.error(usage);
  process.exit(2);
}
