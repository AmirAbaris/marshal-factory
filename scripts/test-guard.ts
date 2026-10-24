import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { endpointOf, TEST_BRANCH_ENV, TEST_ENDPOINT_ENV } from "../lib/test-mode";

const ENV_FILE = ".env.local";
const DB_VARS = ["DATABASE_URL", "DATABASE_URL_UNPOOLED"];

function refuse(reason: string): never {
  console.error(`Refusing to run: ${reason}.\nRegressions write to the database. Run them with: bun run test:regressions`);
  process.exit(1);
}

const fileEnv = existsSync(ENV_FILE) ? parseEnv(readFileSync(ENV_FILE, "utf8")) : {};
// loadEnvFile never overrides what the harness set, so a branch URL beats the file's production URL.
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const branch = process.env[TEST_BRANCH_ENV];
const endpoint = process.env[TEST_ENDPOINT_ENV];
if (!branch || !endpoint) refuse("it was not started by the regression harness");

const production = new Set(DB_VARS.flatMap((name) => (fileEnv[name] ? [endpointOf(fileEnv[name])] : [])));
if (production.has(endpoint)) refuse(`endpoint ${endpoint} is the one ${ENV_FILE} points at`);

for (const name of DB_VARS) {
  const url = process.env[name];
  if (!url) refuse(`${name} is not set`);
  if (endpointOf(url) !== endpoint) refuse(`${name} targets ${endpointOf(url)}, not test branch ${branch} (${endpoint})`);
}
