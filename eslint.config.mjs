import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const LINEAR = "Only the Linear adapter (lib/sources/linear.ts) may import the Linear client. Go through sourceFor(source).";
const ADAPTER = "Only lib/sources may import a source adapter. Go through sourceFor(job.source), allSources() or panelSource() from lib/sources.";
const NAMED = "Pick the source from the job, as in sourceFor(job.source); only lib/sources names a source.";
const SUFFIX = "(\\.[jt]s|/index(\\.[jt]s)?)?$";
const ANYWHERE = "^(@/|(\\.\\.?/)+)lib/linear";
// Every module in lib/sources except the boundary itself: index, shapes and types.
const ADAPTERS = "^(@/lib/|(\\.\\.?/)+(lib/)?)sources/(?!(index|shapes|types)(\\.[jt]s)?$)[^/]+$";

const literal = (regex) => `Literal[value=/${regex.replaceAll("/", "\\/")}/]`;
const dynamicImports = (regex, message) => [
  { selector: `ImportExpression > ${literal(regex)}.source`, message },
  { selector: `CallExpression[callee.name='require'] > ${literal(regex)}.arguments`, message },
];

/** The import boundaries for a set of files: the Linear client by these prefixes, and optionally adapter modules and sources named by a literal. */
const boundary = ({ linear, adapters = false, named = false }) => {
  const paths = [...linear.map((prefix) => ({ regex: prefix + SUFFIX, message: LINEAR })), ...(adapters ? [{ regex: ADAPTERS, message: ADAPTER }] : [])];
  return {
    "no-restricted-imports": ["error", { patterns: paths }],
    "no-restricted-syntax": [
      "error",
      ...paths.flatMap(({ regex, message }) => dynamicImports(regex, message)),
      ...(named
        ? [
            { selector: "CallExpression[callee.name='sourceFor'] > Literal.arguments", message: NAMED },
            { selector: "CallExpression[callee.name='sourceFor'] > TemplateLiteral.arguments", message: NAMED },
          ]
        : []),
    ],
  };
};

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
  { rules: boundary({ linear: [ANYWHERE], adapters: true, named: true }) },
  { files: ["lib/*.ts"], rules: boundary({ linear: [ANYWHERE, "^\\./linear"], adapters: true, named: true }) },
  { files: ["lib/sources/**/*.ts"], rules: boundary({ linear: [ANYWHERE, "^\\.\\./linear"] }) },
  // Regressions drive adapters directly with fake clients.
  { files: ["scripts/**/*.ts"], rules: boundary({ linear: [ANYWHERE] }) },
  { files: ["lib/sources/linear.ts", "scripts/linear-regressions.ts"], rules: { "no-restricted-imports": "off", "no-restricted-syntax": "off" } },
  {
    rules: {
      "no-restricted-properties": [
        "error",
        { property: "mergePull", message: "Only the runner's merge service (runner/merge-service.ts) merges a pull request. Record an approve_merge intent instead." },
      ],
    },
  },
  { files: ["runner/merge-service.ts", "scripts/github-regressions.ts"], rules: { "no-restricted-properties": "off" } },
]);

export default eslintConfig;
