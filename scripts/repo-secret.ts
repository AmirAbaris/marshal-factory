import { join } from "node:path";

// Saves one env value a repo's setup recipe names into the repo's Modal secret, from the runner
// Mac's Modal login (~/.modal.toml), and records the name (never the value) on the registry row.
//   bun scripts/repo-secret.ts owner/name NAME        prompts for the value without echoing it
//   printf %s "$VALUE" | bun scripts/repo-secret.ts owner/name NAME
// The value goes from stdin to Modal and nowhere else: not to the database, a log or the terminal.

process.chdir(join(import.meta.dirname, ".."));
process.loadEnvFile(".env.local");

const { eq } = await import("drizzle-orm");
const { db } = await import("../db/client");
const { repoSettings } = await import("../db/schema");
const { modalSecretName, parseDetail } = await import("../lib/onboarding");
const { modalSecretStore } = await import("../lib/modal-secrets");
const { recordSecretNames } = await import("../lib/repo-onboarding");

const [repo, name] = process.argv.slice(2);
if (!repo || !name || !/^[^/\s]+\/[^/\s]+$/.test(repo) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
  console.error("Usage: bun scripts/repo-secret.ts owner/name ENV_NAME");
  process.exit(2);
}

const [row] = await db.select().from(repoSettings).where(eq(repoSettings.repo, repo));
if (!row) {
  console.error(`${repo} is not a registered repository.`);
  process.exit(1);
}
const env = parseDetail(row.onboarding_detail).recipe?.env ?? [];
if (!env.some((e) => e.name === name)) {
  console.error(`${repo}'s recipe names no env var ${name}${env.length > 0 ? `; it names ${env.map((e) => e.name).join(", ")}` : ""}.`);
  process.exit(1);
}

/** The value from a terminal without echo, or all of piped stdin; one trailing newline is dropped. */
async function readValue(): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }
  process.stderr.write(`Value for ${name} (hidden): `);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    stdin.on("data", (data: Buffer) => {
      for (const char of data.toString("utf8")) {
        if (char === "\r" || char === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          process.stderr.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          stdin.setRawMode(false);
          process.stderr.write("\n");
          reject(new Error("cancelled"));
          return;
        }
        if (char === "\u007f") value = value.slice(0, -1);
        else value += char;
      }
    });
  });
}

const value = await readValue();
if (value === "") {
  console.error("No value given; nothing saved.");
  process.exit(1);
}
const secret = modalSecretName(repo);
await modalSecretStore().upsert(secret, { [name]: value });
await recordSecretNames(db, repo, [name], new Date());
console.log(`${name} is set in the Modal secret ${secret}.`);
process.exit(0);
