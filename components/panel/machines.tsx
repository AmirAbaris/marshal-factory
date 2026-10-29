"use client";

import { ChevronDownIcon, FolderGit2Icon, FolderIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import type { MachineRow } from "@/db/schema";
import {
  isOnline,
  parseHeartbeat,
  parseInventory,
  UNKNOWN,
  type Heartbeat,
  type Inventory,
  type Known,
} from "@/lib/machine";
import { cn } from "@/lib/utils";
import { useFeed, type Feed } from "./sealed";
import { PanelFooter, PanelHeader } from "./panel-header";
import { Time, useNow } from "./time";

const CLOCK_TICK_MS = 30_000;
const GIB = 1024 ** 3;
/** Projects shown before the list folds; a Mac's T3 can hold dozens that have nothing to do with the factory. */
const PROJECTS_SHOWN = 5;

const gb = (bytes: number) => `${(bytes / GIB).toFixed(bytes >= 100 * GIB ? 0 : 1)} GB`;

function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s ago`;
  const min = Math.round(s / 60);
  if (min < 90) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 36 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

const known = <T,>(value: Known<T> | null | undefined): T | null => (value === null || value === undefined || value === UNKNOWN ? null : (value as T));

/** One resource as a bar: how full it is, with the numbers beside the label. */
function Meter({ label, value, detail, used }: { label: string; value: ReactNode; detail?: ReactNode; used: number | null }) {
  const pct = used === null ? null : Math.min(100, Math.max(0, Math.round(used * 100)));
  const tone = pct === null ? "" : pct >= 90 ? "bg-destructive" : pct >= 75 ? "bg-warning" : "bg-foreground/70";
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border bg-card px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{pct === null ? "" : `${pct}%`}</span>
      </div>
      <div className="truncate font-medium tabular-nums">{value}</div>
      <div className="h-1 overflow-hidden rounded-full bg-muted" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
        {pct !== null && <div className={cn("h-full rounded-full", tone)} style={{ width: `${pct}%` }} />}
      </div>
      {detail && <div className="truncate text-xs text-muted-foreground">{detail}</div>}
    </div>
  );
}

const unknownValue = <span className="text-muted-foreground">unknown</span>;

function Resources({ heartbeat }: { heartbeat: Heartbeat | null }) {
  const cpu = known(heartbeat?.cpu);
  const memory = known(heartbeat?.memory);
  const disk = known(heartbeat?.disk);
  const capacity = known(heartbeat?.capacity);
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      <Meter
        label="Jobs"
        value={capacity ? `${capacity.inFlight} of ${capacity.max}` : unknownValue}
        detail={capacity && (capacity.inFlight >= capacity.max ? "Full; new jobs wait" : `${capacity.max - capacity.inFlight} free`)}
        used={capacity && capacity.inFlight / capacity.max}
      />
      <Meter
        label="CPU"
        value={cpu ? `load ${cpu.load1.toFixed(2)}` : unknownValue}
        detail={cpu && `${cpu.cores} cores`}
        used={cpu && cpu.load1 / cpu.cores}
      />
      <Meter
        label="Memory"
        value={memory ? gb(memory.usedBytes) : unknownValue}
        detail={memory && `of ${gb(memory.totalBytes)}`}
        used={memory && memory.usedBytes / memory.totalBytes}
      />
      <Meter
        label="Disk"
        value={disk ? `${gb(disk.freeBytes)} free` : unknownValue}
        detail={disk && `of ${gb(disk.totalBytes)}`}
        used={disk && 1 - disk.freeBytes / disk.totalBytes}
      />
    </div>
  );
}

const PROJECT_SOURCE: Record<string, string> = {
  sqlite: "from T3's state",
  probe: "probed with the t3 CLI",
  [UNKNOWN]: "unknown",
};

function ListSection({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="flex items-baseline gap-2 text-xs font-medium text-muted-foreground">
        {title}
        {note && <span className="font-normal text-faint">{note}</span>}
      </h3>
      <ul className="flex flex-col divide-y rounded-lg border">{children}</ul>
    </section>
  );
}

function PathRow({ icon, title, path, aside }: { icon: ReactNode; title: ReactNode; path: string; aside?: ReactNode }) {
  return (
    <li className="flex min-w-0 items-center gap-2.5 px-3 py-2">
      <span className="shrink-0 text-muted-foreground [&_svg]:size-4">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{title}</span>
        <span className="truncate font-mono text-xs text-muted-foreground" title={path}>
          {path}
        </span>
      </span>
      {aside && <span className="shrink-0 text-xs text-muted-foreground">{aside}</span>}
    </li>
  );
}

/** The factory's checkouts on this machine, then the rest of its T3 projects, folded past a few. */
function Workspaces({ inventory }: { inventory: Inventory | null }) {
  const [expanded, setExpanded] = useState(false);
  if (!inventory) return <p className="text-muted-foreground">The runner has not reported its repos and T3 projects yet.</p>;
  // When T3's projects could not be read, nothing is known to be missing from it.
  const scanned = inventory.projects.source !== UNKNOWN;
  const projects = inventory.projects.source === UNKNOWN ? [] : inventory.projects.items;
  const projectPaths = new Set(projects.map((p) => p.path));
  const repoPaths = new Set(inventory.repos.map((r) => r.path));
  const others = projects.filter((p) => !repoPaths.has(p.path));
  const shown = expanded ? others : others.slice(0, PROJECTS_SHOWN);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ListSection title="Factory repos" note={inventory.repos.length}>
        {inventory.repos.length === 0 && <li className="px-3 py-2 text-muted-foreground">No checkouts for the factory on this machine.</li>}
        {inventory.repos.map((r) => (
          <PathRow
            key={r.path}
            icon={<FolderGit2Icon />}
            title={<span className="font-mono text-[13px]">{known(r.origin) ?? "origin unknown"}</span>}
            path={r.path}
            aside={!scanned ? undefined : projectPaths.has(r.path) ? "T3 project" : <span className="text-warning">not in T3</span>}
          />
        ))}
      </ListSection>
      <ListSection title="Other T3 projects" note={inventory.projects.source === UNKNOWN ? "unknown" : `${others.length} · ${PROJECT_SOURCE[inventory.projects.source]}`}>
        {others.length === 0 && <li className="px-3 py-2 text-muted-foreground">{scanned ? "None" : "The runner could not read T3's projects."}</li>}
        {shown.map((p) => (
          <PathRow key={p.path} icon={<FolderIcon />} title={p.title} path={p.path} />
        ))}
        {others.length > PROJECTS_SHOWN && (
          <li>
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              aria-expanded={expanded}
              className="flex w-full items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
              <ChevronDownIcon className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
              {expanded ? "Show fewer" : `Show ${others.length - PROJECTS_SHOWN} more`}
            </button>
          </li>
        )}
      </ListSection>
    </div>
  );
}

/** The facts that say whether the machine can take work, in one line under its name. */
function Facts({ machine, inventory }: { machine: MachineRow; inventory: Inventory | null }) {
  const t3 = known(inventory?.t3);
  const sha = known(inventory?.runnerSha);
  const connect = inventory ? known(inventory.connect) : null;
  return (
    <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <div className="flex gap-1.5">
        <dt>T3</dt>
        <dd className={cn(t3 && !t3.up && "text-destructive")}>
          {t3 ? (t3.up ? "up" : "down") : "unknown"}
          {t3?.version && <span className="ms-1.5 font-mono text-faint">{t3.version}</span>}
        </dd>
      </div>
      <div className="flex gap-1.5">
        <dt>Connect</dt>
        <dd>{connect ?? "unknown"}</dd>
      </div>
      <div className="flex gap-1.5">
        <dt>Runner</dt>
        <dd className="font-mono">{sha ? sha.slice(0, 7) : "unknown"}</dd>
      </div>
      <div className="flex min-w-0 gap-1.5">
        <dt>ID</dt>
        <dd className="truncate font-mono text-faint">{machine.id}</dd>
      </div>
    </dl>
  );
}

function MachineSection({ machine, now }: { machine: MachineRow; now: number | null }) {
  const heartbeat = parseHeartbeat(machine.heartbeat);
  const inventory = parseInventory(machine.inventory);
  const online = now === null ? null : isOnline(machine.last_seen_at, now);
  return (
    <section aria-label={machine.name} className="flex flex-col gap-4 py-6 first:pt-0 last:pb-0">
      <header className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span
            className={cn("size-2 shrink-0 rounded-full", online === null ? "bg-faint" : online ? "bg-success" : "bg-muted-foreground/40")}
            aria-hidden
          />
          <h2 className="text-base font-semibold">{machine.name}</h2>
          {online !== null && (
            <Badge variant="outline" className={cn("rounded-md font-normal", online ? "text-success" : "text-muted-foreground")}>
              {online ? "Online" : "Offline"}
            </Badge>
          )}
          <span className="text-xs text-muted-foreground">
            Last heartbeat <Time date={machine.last_seen_at} />
            {now !== null && ` · ${ago(now - machine.last_seen_at.getTime())}`}
          </span>
        </div>
        <Facts machine={machine} inventory={inventory} />
      </header>
      {/* An offline machine's numbers are its last heartbeat's, so they fade. */}
      <div className={cn(online === false && "opacity-60")}>
        <Resources heartbeat={heartbeat} />
      </div>
      <Workspaces inventory={inventory} />
    </section>
  );
}

export function Machines({ machines }: { machines: Feed<MachineRow> }) {
  const { rows, status } = useFeed(machines, "/api/live/machines");
  const now = useNow(CLOCK_TICK_MS);
  const onlineMachines =
    now === null ? null : rows.filter((m) => isOnline(m.last_seen_at, now)).length;
  // Online machines first, then the most recently seen.
  const sorted =
    now === null
      ? rows
      : [...rows].sort(
          (a, b) =>
            Number(isOnline(b.last_seen_at, now)) - Number(isOnline(a.last_seen_at, now)) || b.last_seen_at.getTime() - a.last_seen_at.getTime(),
        );

  return (
    <>
      <PanelHeader title="Machines" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl p-4 md:p-6">
          {rows.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyTitle>No machines yet</EmptyTitle>
                <EmptyDescription>
                  A machine appears here as soon as its runner sends its first heartbeat.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="flex flex-col divide-y">
              {sorted.map((machine) => (
                <MachineSection key={machine.id} machine={machine} now={now} />
              ))}
            </div>
          )}
        </div>
      </div>
      <PanelFooter
        status={status}
        summary={`${rows.length} ${rows.length === 1 ? "machine" : "machines"}${onlineMachines === null ? "" : ` · ${onlineMachines} online`}`}
      />
    </>
  );
}
