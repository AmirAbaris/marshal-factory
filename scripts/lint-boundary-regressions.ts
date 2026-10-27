import "./test-guard";
import assert from "node:assert/strict";
import { join } from "node:path";
import { ESLint } from "eslint";

// The source boundary as ESLint enforces it: outside lib/sources nothing imports an adapter or the
// Linear client, and nothing picks a source by name.
const root = join(import.meta.dirname, "..");
const eslint = new ESLint({ cwd: root });
const messages = async (file: string, code: string) =>
  (await eslint.lintText(code, { filePath: join(root, file) })).flatMap((r) => r.messages.map((m) => m.ruleId ?? m.message));

const RESTRICTED = ["no-restricted-imports"];
const SYNTAX = ["no-restricted-syntax"];
const cases: { file: string; code: string; want: string[] }[] = [
  { file: "runner/x.ts", code: 'import { linear } from "../lib/sources/linear";\nvoid linear;\n', want: RESTRICTED },
  { file: "app/x.ts", code: 'import { linear } from "@/lib/sources/linear";\nvoid linear;\n', want: RESTRICTED },
  { file: "lib/x.ts", code: 'import { linear } from "./sources/linear";\nvoid linear;\n', want: RESTRICTED },
  { file: "lib/x.ts", code: 'export const m = import("./sources/linear");\n', want: SYNTAX },
  { file: "runner/x.ts", code: 'import { linearClient } from "../lib/linear";\nvoid linearClient;\n', want: RESTRICTED },
  { file: "runner/x.ts", code: 'import { sourceFor } from "../lib/sources";\nexport const s = sourceFor("linear");\n', want: SYNTAX },
  { file: "app/x.ts", code: 'import { sourceFor } from "@/lib/sources";\nexport const s = sourceFor(`linear`);\n', want: SYNTAX },
  // What the boundary allows.
  { file: "runner/x.ts", code: 'import { sourceFor } from "../lib/sources";\nimport type { Job } from "../lib/sources/types";\nexport const s = (job: Job) => sourceFor(job.source);\n', want: [] },
  { file: "app/x.ts", code: 'import { sourceLink } from "@/lib/sources/shapes";\nvoid sourceLink;\n', want: [] },
  { file: "lib/sources/index.ts", code: 'import { linear } from "./linear";\nexport const s = linear;\n', want: [] },
  { file: "lib/sources/x.ts", code: 'import { sourceFor } from "./index";\nexport const s = sourceFor("linear");\n', want: [] },
  { file: "scripts/x-regressions.ts", code: 'import { createLinearAdapter } from "../lib/sources/linear";\nvoid createLinearAdapter;\n', want: [] },
];
for (const c of cases) assert.deepEqual(await messages(c.file, c.code), c.want, `${c.file}: ${c.code.split("\n")[0]}`);

console.log("lint boundary regressions passed");
