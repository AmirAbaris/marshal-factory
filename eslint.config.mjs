import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const restrictLinear = (...regex) => ({
  "no-restricted-imports": [
    "error",
    {
      patterns: regex.map((r) => ({
        regex: r,
        message: "Only the Linear adapter (lib/sources/linear.ts) may import the Linear client. Go through sourceFor(source).",
      })),
    },
  ],
});
const ANYWHERE = "^(@/|(\\.\\.?/)+)lib/linear$";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "convex/_generated/**",
  ]),
  { rules: restrictLinear(ANYWHERE) },
  { files: ["lib/*.ts"], rules: restrictLinear(ANYWHERE, "^\\./linear$") },
  { files: ["lib/sources/**/*.ts"], rules: restrictLinear(ANYWHERE, "^\\.\\./linear$") },
  { files: ["lib/sources/linear.ts", "scripts/linear-regressions.ts"], rules: { "no-restricted-imports": "off" } },
]);

export default eslintConfig;
