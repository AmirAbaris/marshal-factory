import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const MESSAGE = "Only the Linear adapter (lib/sources/linear.ts) may import the Linear client. Go through sourceFor(source).";
const SUFFIX = "(\\.[jt]s|/index(\\.[jt]s)?)?$";
const restrictLinear = (...prefixes) => ({
  "no-restricted-imports": [
    "error",
    { patterns: prefixes.map((prefix) => ({ regex: prefix + SUFFIX, message: MESSAGE })) },
  ],
  "no-restricted-syntax": [
    "error",
    ...prefixes.flatMap((prefix) => {
      const source = `Literal[value=/${prefix.replaceAll("/", "\\/") + SUFFIX.replaceAll("/", "\\/")}/]`;
      return [
        { selector: `ImportExpression > ${source}.source`, message: MESSAGE },
        { selector: `CallExpression[callee.name='require'] > ${source}.arguments`, message: MESSAGE },
      ];
    }),
  ],
});
const ANYWHERE = "^(@/|(\\.\\.?/)+)lib/linear";

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
  { files: ["lib/*.ts"], rules: restrictLinear(ANYWHERE, "^\\./linear") },
  { files: ["lib/sources/**/*.ts"], rules: restrictLinear(ANYWHERE, "^\\.\\./linear") },
  { files: ["lib/sources/linear.ts", "scripts/linear-regressions.ts"], rules: { "no-restricted-imports": "off", "no-restricted-syntax": "off" } },
]);

export default eslintConfig;
