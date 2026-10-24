import "./test-guard";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { migrateRefusal } from "../lib/migrate-guard";

const PRODUCTION = "postgresql://u:p@ep-odd-field-b95xpf9v.c-2.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const PRODUCTION_POOLED = "postgresql://u:p@ep-odd-field-b95xpf9v-pooler.c-2.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const PREVIEW = "postgresql://u:p@ep-preview-branch-a1b2c3d4.c-2.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const PREVIEW_POOLED = "postgresql://u:p@ep-preview-branch-a1b2c3d4-pooler.c-2.eu-central-1.aws.neon.tech/neondb?sslmode=require";

const preview = { VERCEL_ENV: "preview", DATABASE_URL: PREVIEW_POOLED, DATABASE_URL_UNPOOLED: PREVIEW };
assert.equal(migrateRefusal(preview), null, "a preview migrates its own branch");
assert.match(migrateRefusal({ ...preview, DATABASE_URL_UNPOOLED: PRODUCTION }) ?? "", /DATABASE_URL_UNPOOLED points at the production branch/);
assert.match(migrateRefusal({ ...preview, DATABASE_URL: PRODUCTION_POOLED }) ?? "", /DATABASE_URL points at the production branch/, "the pooled host counts as production");
assert.match(migrateRefusal({ ...preview, DATABASE_URL_UNPOOLED: undefined }) ?? "", /DATABASE_URL_UNPOOLED is not set/, "a missing URL refuses");
assert.match(migrateRefusal({ ...preview, DATABASE_URL: "not a url" }) ?? "", /not a valid URL/, "an unparsable URL refuses");
assert.match(
  migrateRefusal({ DATABASE_URL: PRODUCTION_POOLED, DATABASE_URL_UNPOOLED: PRODUCTION }) ?? "",
  /in a non-production build/,
  "a build that names no environment is not production",
);
assert.match(migrateRefusal({ ...preview, VERCEL_ENV: "development", DATABASE_URL_UNPOOLED: PRODUCTION }) ?? "", /development build/);
assert.equal(
  migrateRefusal({ VERCEL_ENV: "production", DATABASE_URL: PRODUCTION_POOLED, DATABASE_URL_UNPOOLED: PRODUCTION }),
  null,
  "a production build migrates production",
);

function guard(env: Record<string, string>) {
  try {
    execFileSync("bun", ["scripts/migrate-guard.ts"], { env: { ...process.env, ...env }, stdio: "pipe" });
    return { code: 0, stderr: "" };
  } catch (error) {
    const failed = error as { status: number; stderr: Buffer };
    return { code: failed.status, stderr: failed.stderr.toString() };
  }
}
const refused = guard({ ...preview, DATABASE_URL_UNPOOLED: PRODUCTION });
assert.equal(refused.code, 1, "the build command stops before drizzle-kit runs");
assert.match(refused.stderr, /Refusing to migrate/);
assert.doesNotMatch(refused.stderr, /u:p@/, "the refusal never prints a connection string");
assert.equal(guard(preview).code, 0);

const { buildCommand } = JSON.parse(readFileSync("vercel.json", "utf8")) as { buildCommand: string };
assert.ok(buildCommand.startsWith("bun scripts/migrate-guard.ts && bun run db:migrate"), "the Vercel build checks before it migrates");

console.log("migrate guard regressions passed");
