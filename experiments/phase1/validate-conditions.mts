// Checks every condition file with the pipeline's own parser, so a bad file fails here, not mid-experiment.
// Usage, from PiMAS/: node --import tsx ../experiments/phase1/validate-conditions.ts ../experiments/phase1/conditions
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseCondition } from "../../PiMAS/src/faults.ts";

const root = process.argv[2]!;
let count = 0;
for (const entry of readdirSync(root, { withFileTypes: true }).filter((item) => item.isDirectory())) {
  for (const file of readdirSync(path.join(root, entry.name))) {
    try {
      parseCondition(JSON.parse(readFileSync(path.join(root, entry.name, file), "utf8")));
    } catch (error) {
      throw new Error(`${entry.name}/${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    count++;
  }
}
console.log(`${count} condition files are valid`);
