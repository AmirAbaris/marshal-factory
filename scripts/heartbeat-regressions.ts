import "./test-guard";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

const { db } = await import("../db/client");
const { jobs, machines } = await import("../db/schema");
const { isOnline, heartbeatSchema, inventorySchema } = await import("../lib/machine");
const { parseConnectStatus, readProjects } = await import("../lib/t3-state");
const { collectHeartbeat, inventoryReporter, parseDf, parseOrigin, parseVmStat, writeHeartbeat, writeInventory } = await import("../runner/heartbeat");
const { claimLaunch, releaseLaunch } = await import("../runner/ops");
const { linearJob } = await import("./fixtures");

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures/heartbeat", name), "utf8");

assert.equal(parseConnectStatus(fixture("connect-linked.json")), "linked", "authenticated true is linked");
assert.equal(parseConnectStatus(fixture("connect-missing.json")), "unlinked", "authenticated false is unlinked");
assert.equal(parseConnectStatus(fixture("connect-garbled.txt")), "unknown", "cut-off human text is unknown");
assert.equal(parseConnectStatus(fixture("connect-linked.json").slice(0, 60)), "unknown", "truncated JSON is unknown");
assert.equal(parseConnectStatus('{"linked": true}'), "unknown", "JSON without the authenticated field is unknown");

assert.deepEqual(
  parseVmStat(fixture("vm_stat.txt"), 25_769_803_776),
  { usedBytes: 20_432_748_544, totalBytes: 25_769_803_776 },
  "memory in use excludes free, inactive, speculative and purgeable pages",
);
assert.throws(() => parseVmStat("Mach Virtual Memory Statistics: (page size of 16384 by", 1), "garbled vm_stat throws");
assert.throws(() => parseVmStat(fixture("vm_stat.txt").replace(/Pages inactive.*\n/, ""), 1), "vm_stat without a needed line throws");
assert.deepEqual(
  parseDf(fixture("df.txt")),
  { freeBytes: 337_503_380 * 1024, totalBytes: 971_298_980 * 1024 },
  "df reports available and total from the 1024-blocks table",
);
assert.throws(() => parseDf("Filesystem   1024-blocks"), "garbled df throws");

assert.equal(parseOrigin("git@github.com:ski043/marshal-factory.git\n"), "ski043/marshal-factory", "an ssh remote");
assert.equal(parseOrigin("https://github.com/ski043/factory-demo"), "ski043/factory-demo", "an https remote");

const stateDir = mkdtempSync(join(tmpdir(), "t3-state-"));
try {
  const { Database } = await import("bun:sqlite");
  const state = new Database(join(stateDir, "state.sqlite"));
  state.query("create table projection_projects (project_id text, title text, workspace_root text, deleted_at text)").all();
  state.query("insert into projection_projects values ('p2', 'Zed', '/work/zed', null), ('p1', 'Demo', '/work/demo', null), ('p3', 'Gone', '/work/gone', '2026-10-01')").all();
  state.close();
  assert.deepEqual(
    await readProjects({ statePath: join(stateDir, "state.sqlite"), repos: [] }),
    {
      source: "sqlite",
      items: [
        { id: "p1", title: "Demo", path: "/work/demo" },
        { id: "p2", title: "Zed", path: "/work/zed" },
      ],
    },
    "live projects come from the state database, ordered by path, deleted ones left out",
  );
} finally {
  rmSync(stateDir, { recursive: true });
}

const repo = "/work/factory-demo";
const missing = join(import.meta.dirname, "fixtures/heartbeat/no-such-state.sqlite");
assert.deepEqual(
  await readProjects({
    statePath: missing,
    repos: [repo, "/work/other"],
    probe: async (path) => {
      if (path !== repo) throw new Error("not a T3 project");
    },
  }),
  { source: "probe", items: [{ id: null, title: "factory-demo", path: repo }] },
  "without the state database, a probed repo is a project",
);
assert.deepEqual(
  await readProjects({
    statePath: missing,
    repos: [repo],
    probe: async () => {
      throw new Error("t3 failed");
    },
  }),
  { source: "unknown" },
  "when every probe throws the projects are unknown",
);
assert.deepEqual(await readProjects({ statePath: missing, repos: [], probe: async () => undefined }), { source: "unknown" }, "no repos to probe");

const at = new Date("2026-10-24T12:00:00Z");
assert.equal(isOnline(new Date(at.getTime() - 269_000), at.getTime()), true, "269 s ago is online");
assert.equal(isOnline(new Date(at.getTime() - 271_000), at.getTime()), false, "271 s ago is offline");

const machine = { id: `heartbeat-regress-${Date.now()}`, name: "Test Mac" };
const ok = {
  cpu: async () => ({ load1: 1.5, cores: 8 }),
  memory: async () => ({ usedBytes: 1, totalBytes: 2 }),
  disk: async () => ({ freeBytes: 1, totalBytes: 2 }),
  capacity: async () => ({ max: 2, inFlight: 0 }),
};
const inventoryA = inventorySchema.parse({
  runnerSha: "a".repeat(40),
  t3: { up: true, version: "1", environmentId: "env" },
  connect: "linked",
  projects: { source: "unknown" },
  repos: [],
});
const inventoryB = { ...inventoryA, connect: "unlinked" as const };
const id = `heartbeat-regress-${Date.now()}`;
await db.insert(jobs).values(linearJob(id, id));
try {
  const heartbeat = await collectHeartbeat({
    ...ok,
    memory: async () => {
      throw new Error("vm_stat failed");
    },
  });
  assert.equal(heartbeat.memory, "unknown", "a failing collector reports unknown");
  assert.deepEqual(heartbeat.cpu, { load1: 1.5, cores: 8 }, "the other collectors still report");
  assert.deepEqual(heartbeat.capacity, { max: 2, inFlight: 0 }, "the beat is not skipped");

  const seen = new Date("2026-10-24T12:00:00Z");
  await writeHeartbeat(machine, heartbeat, seen);
  const [row] = await db.select().from(machines).where(eq(machines.id, machine.id));
  assert.equal(row!.last_seen_at.getTime(), seen.getTime(), "last_seen_at is written");
  assert.equal(heartbeatSchema.parse(row!.heartbeat).memory, "unknown", "the row holds the unknown memory");

  const absent = `${machine.id}-absent`;
  let writes = 0;
  const reportAbsent = inventoryReporter(async (inventory) => {
    writes++;
    return writeInventory(absent, inventory, seen);
  });
  assert.equal(await reportAbsent(inventoryA), "written", "the first report writes");
  assert.equal(writes, 1);
  assert.equal(await reportAbsent(inventoryA), "written", "a write that found no row is not remembered, so the next report retries");
  assert.equal(writes, 2);

  writes = 0;
  const report = inventoryReporter(async (inventory) => {
    writes++;
    return writeInventory(machine.id, inventory, seen);
  });
  assert.deepEqual(
    [await report(inventoryA), await report(inventoryA), await report(inventoryB)],
    ["written", "unchanged", "written"],
    "only a changed inventory is written",
  );
  assert.equal(writes, 2, "the unchanged report cost no database write");
  const [after] = await db.select().from(machines).where(eq(machines.id, machine.id));
  assert.deepEqual(inventorySchema.parse(after!.inventory), inventoryB, "the row holds the latest inventory");

  assert.equal(await claimLaunch(id, "pending:1", "test-machine"), true);
  const claimed = async () => (await db.select().from(jobs).where(eq(jobs.key, id)))[0]!;
  assert.equal((await claimed()).machine_id, "test-machine", "a launch claim records the machine");
  await releaseLaunch(id, "pending:1");
  assert.equal((await claimed()).machine_id, null, "releasing the launch clears the machine");
} finally {
  await db.delete(jobs).where(eq(jobs.key, id));
  await db.delete(machines).where(eq(machines.id, machine.id));
}

console.log("heartbeat regressions passed");
