import { join } from "node:path";

// Creates the Harness and Runs on label groups in the configured Linear team (factory.teamKey),
// with a child per enabled harness the machines report and Local and Modal. It only adds labels:
// nothing is renamed, moved or deleted. Run it again after enabling a new harness in T3.
//   bun scripts/sync-linear-labels.ts

process.chdir(join(import.meta.dirname, ".."));
process.loadEnvFile(".env.local");

const { syncLinearLabels } = await import("../runner/overrides");

const result = await syncLinearLabels();
if ("skipped" in result) {
  console.log(`Nothing synced: ${result.skipped}. Start a runner so it reports its harnesses, then run this again.`);
} else {
  console.log(result.created.length > 0 ? `Created in ${result.team}:\n${result.created.map((c) => `  ${c}`).join("\n")}` : `${result.team} has every override label already.`);
  for (const problem of result.problems) console.log(`Not created: ${problem}`);
}
process.exit(0);
