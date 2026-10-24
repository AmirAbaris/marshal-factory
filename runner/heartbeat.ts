import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cpus, hostname, loadavg, totalmem } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { machines } from "../db/schema";
import { loadConfig } from "../lib/config";
import { UNKNOWN, type Heartbeat, type Inventory } from "../lib/machine";
import { connectStatus, readProjects, readT3Runtime } from "../lib/t3-state";

const run = promisify(execFile);
const RUNNER_DIR = join(import.meta.dirname, "..");
const text = async (cmd: string, args: string[], cwd?: string) =>
  (await run(cmd, args, { cwd, timeout: 5_000, maxBuffer: 1024 * 1024 })).stdout;

export type Machine = { id: string; name: string };

export async function identify(override?: string): Promise<Machine> {
  const id = override ?? /"IOPlatformUUID" = "([^"]+)"/.exec(await text("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]))?.[1];
  if (!id) throw new Error("ioreg printed no IOPlatformUUID");
  const name = await text("scutil", ["--get", "ComputerName"]).then((out) => out.trim(), () => "");
  return { id, name: name || hostname() };
}

let machine: Promise<Machine> | undefined;
export const thisMachine = () => (machine ??= identify(loadConfig().factory.machineId));

/** macOS keeps "free" low on purpose, so memory in use excludes the pages the kernel can hand back at once. */
export function parseVmStat(output: string, totalBytes: number) {
  const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1]);
  if (!(pageSize > 0)) throw new Error("vm_stat has no page size");
  const pages = (name: string) => {
    const value = /^Pages (\w+):\s+(\d+)\.$/gm;
    for (const match of output.matchAll(value)) if (match[1] === name) return Number(match[2]);
    throw new Error(`vm_stat has no "Pages ${name}" line`);
  };
  const reclaimable = pages("free") + pages("inactive") + pages("speculative") + pages("purgeable");
  const usedBytes = totalBytes - reclaimable * pageSize;
  if (usedBytes < 0) throw new Error("vm_stat reports more reclaimable memory than the machine has");
  return { usedBytes, totalBytes };
}

export function parseDf(output: string) {
  const [header, row] = output.trim().split("\n");
  if (!header?.startsWith("Filesystem") || !header.includes("1024-blocks") || !row) throw new Error("df output has no 1024-blocks table");
  const columns = row.trim().split(/\s+/);
  const totalKb = Number(columns[1]);
  const freeKb = Number(columns[3]);
  if (!Number.isFinite(totalKb) || !Number.isFinite(freeKb) || totalKb <= 0) throw new Error("df row has no block counts");
  return { freeBytes: freeKb * 1024, totalBytes: totalKb * 1024 };
}

export type HeartbeatCollectors = { [K in keyof Heartbeat]: () => Promise<Heartbeat[K]> };
export type InventoryCollectors = { [K in keyof Inventory]: () => Promise<Inventory[K]> };

const settle = <T>(collect: () => Promise<T>) => collect().catch((): typeof UNKNOWN => UNKNOWN);

export function systemCollectors(capacity: () => Promise<Heartbeat["capacity"]>): HeartbeatCollectors {
  return {
    cpu: async () => ({ load1: loadavg()[0]!, cores: cpus().length }),
    memory: async () => parseVmStat(await text("vm_stat", []), totalmem()),
    disk: async () => parseDf(await text("df", ["-k", "/System/Volumes/Data"])),
    capacity,
  };
}

export async function collectHeartbeat(collectors: HeartbeatCollectors): Promise<Heartbeat> {
  const [cpu, memory, disk, capacity] = await Promise.all([
    settle(collectors.cpu),
    settle(collectors.memory),
    settle(collectors.disk),
    settle(collectors.capacity),
  ]);
  return { cpu, memory, disk, capacity };
}

export function parseOrigin(url: string) {
  return /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim())?.slice(1).join("/");
}

export function inventoryCollectors(): InventoryCollectors {
  const { factory } = loadConfig();
  return {
    runnerSha: async () => (await text("git", ["rev-parse", "HEAD"], RUNNER_DIR)).trim(),
    t3: async () => readT3Runtime(),
    connect: connectStatus,
    projects: () => readProjects({ statePath: factory.t3StatePath, repos: factory.repos }),
    repos: async () =>
      Promise.all(
        factory.repos.map(async (path) => ({
          path,
          origin: await text("git", ["-C", path, "remote", "get-url", "origin"]).then((url) => parseOrigin(url) ?? UNKNOWN, () => UNKNOWN),
        })),
      ),
  };
}

export async function collectInventory(collectors: InventoryCollectors): Promise<Inventory> {
  const [runnerSha, t3, connect, projects, repos] = await Promise.all([
    settle(collectors.runnerSha),
    settle(collectors.t3),
    settle(collectors.connect),
    collectors.projects().catch((): Inventory["projects"] => ({ source: UNKNOWN })),
    collectors.repos().catch((): Inventory["repos"] => []),
  ]);
  return { runnerSha, t3, connect, projects, repos };
}

export async function writeHeartbeat(machine: Machine, heartbeat: Heartbeat, now: Date) {
  await db
    .insert(machines)
    .values({ id: machine.id, name: machine.name, last_seen_at: now, heartbeat })
    .onConflictDoUpdate({ target: machines.id, set: { name: machine.name, last_seen_at: now, heartbeat } });
}

export async function writeInventory(machineId: string, inventory: Inventory, now: Date) {
  const updated = await db
    .update(machines)
    .set({ inventory, inventory_at: now })
    .where(eq(machines.id, machineId))
    .returning({ id: machines.id });
  return updated.length > 0;
}

const hashOf = (inventory: Inventory) => createHash("sha256").update(JSON.stringify(inventory)).digest("hex");

export function inventoryReporter(write: (inventory: Inventory) => Promise<boolean>) {
  let written: string | undefined;
  return async (inventory: Inventory): Promise<"written" | "unchanged"> => {
    const hash = hashOf(inventory);
    if (hash === written) return "unchanged";
    if (await write(inventory)) written = hash;
    return "written";
  };
}

type Log = (event: string, detail?: Record<string, unknown>) => void;

export function createBeat({
  machine,
  heartbeatCollectors,
  inventoryCollectors: inventory,
  inventoryMs,
  log,
  now = Date.now,
}: {
  machine: Machine;
  heartbeatCollectors: HeartbeatCollectors;
  inventoryCollectors: InventoryCollectors;
  inventoryMs: number;
  log: Log;
  now?: () => number;
}) {
  const report = inventoryReporter((value) => writeInventory(machine.id, value, new Date(now())));
  let running = false;
  let inventoryAt: number | undefined;

  return async function beat() {
    if (running) return;
    running = true;
    try {
      const started = now();
      const heartbeat = await collectHeartbeat(heartbeatCollectors);
      await writeHeartbeat(machine, heartbeat, new Date(now()));
      log("heartbeat", { ms: now() - started, unknown: Object.entries(heartbeat).filter(([, v]) => v === UNKNOWN).map(([k]) => k) });
      if (inventoryAt !== undefined && now() - inventoryAt < inventoryMs) return;
      inventoryAt = now();
      const collected = await collectInventory(inventory);
      log("inventory", { ms: now() - inventoryAt, result: await report(collected) });
    } catch (error) {
      log("heartbeat:error", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      running = false;
    }
  };
}
