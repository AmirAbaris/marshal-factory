"use client";

import { ChevronRightIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useRef, useState } from "react";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import type { AgentRow, MachineRow } from "@/db/schema";
import { STAGES, type Stage } from "@/lib/events";
import { stopLine } from "@/lib/stop";
import { cn } from "@/lib/utils";
import { harnessLine, showsDecision, whereLine, type BoardCard } from "./cards";
import { formatUsd, spendOf } from "./format";
import { jobsHref } from "./job-view";
import { decisionLine } from "./merge-decision";
import { useRowKeys } from "./row-keys";
import { STAGE_META } from "./stages";
import { ShortTime } from "./time";

const spring = { type: "spring", stiffness: 500, damping: 40 } as const;

const openHref = (card: BoardCard) => (card.latest ? jobsHref("list", card.latest.session_id) : null);

function Row({
  card,
  machineName,
  agentsBySession,
  open,
  cursor,
  onFocus,
  repoLabels,
}: {
  card: BoardCard;
  machineName: string | null;
  repoLabels: ReadonlyMap<string, string> | undefined;
  agentsBySession: Map<string, AgentRow[]>;
  open: boolean;
  cursor: boolean;
  onFocus: () => void;
}) {
  const href = openHref(card);
  const cost = spendOf(card.attemptRuns, agentsBySession);
  const decision = card.stop
    ? { text: stopLine(card.stop.view), tone: card.stop.view.kind === "unconfirmed" ? "text-destructive" : card.stop.view.kind === "stopping" ? "text-warning" : undefined }
    : showsDecision(card)
      ? decisionLine(card.mergeDecision)
      : null;
  const where = card.runsOn && (card.runsOn.kind === "modal" && card.runsOn.sandbox ? `Modal sandbox · ${card.runsOn.sandbox}` : whereLine(card.runsOn, machineName));
  const className = cn(
    "relative flex h-9 w-full items-center gap-3 px-4 text-left outline-none transition-colors duration-150 hover:bg-accent/60 focus-visible:bg-accent @3xl:px-5",
    open ? "bg-accent" : cursor && "bg-accent/60",
    !href && "cursor-default",
  );
  const content = (
    <>
      {cursor && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-foreground" />}
      <span className={cn("size-2 shrink-0 rounded-full", STAGE_META[card.stage].dot)} title={STAGE_META[card.stage].label} />
      <span className="sr-only">{STAGE_META[card.stage].label}</span>
      <span className="hidden w-24 shrink-0 truncate font-mono text-xs text-muted-foreground @lg:block">{card.jobKey ?? card.id.slice(0, 8)}</span>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate">{card.title}</span>
        {card.latest?.status === "active" && <Spinner className="size-3 shrink-0 text-muted-foreground" />}
      </span>
      {repoLabels && <span className="hidden w-28 shrink-0 truncate text-xs text-muted-foreground @2xl:block">{card.repo && repoLabels.get(card.repo)}</span>}
      <span className={cn("hidden w-32 shrink-0 truncate text-xs @sm:block @xl:w-56", decision?.tone)}>{decision?.text}</span>
      <span className="hidden w-44 shrink-0 truncate text-xs text-muted-foreground @4xl:block">{where}</span>
      <span className="hidden w-28 shrink-0 truncate text-xs text-muted-foreground @5xl:block">{card.harness && harnessLine(card.harness)}</span>
      <span
        className={cn(
          "hidden w-14 shrink-0 text-right font-mono text-xs text-muted-foreground tabular-nums @3xl:block",
          card.budgetUsd !== null && cost >= card.budgetUsd && "text-destructive",
        )}
      >
        {formatUsd(cost)}
      </span>
      <span className="hidden w-12 shrink-0 text-right text-xs text-muted-foreground tabular-nums @md:block">
        <ShortTime date={card.updatedAt} />
      </span>
    </>
  );
  return href ? (
    <Link href={href} scroll={false} data-row={card.id} onFocus={onFocus} aria-current={open ? "true" : undefined} className={className}>
      {content}
    </Link>
  ) : (
    // A claimed job without a session yet has no run to open, but J and K still stop on it.
    <div tabIndex={0} data-row={card.id} onFocus={onFocus} className={className}>
      {content}
    </div>
  );
}

/** Every job as one dense row, grouped by stage in the board's order. J and K walk the rows, Enter opens the run, Esc closes it. */
export function JobList({
  cards,
  agentsBySession,
  selected,
  machines,
  repoLabels,
}: {
  cards: readonly BoardCard[];
  agentsBySession: Map<string, AgentRow[]>;
  selected: string | undefined;
  machines: ReadonlyMap<string, MachineRow>;
  /** Each repo's short name, while more than one repo has jobs; undefined shows no repo. */
  repoLabels?: ReadonlyMap<string, string>;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [closed, setClosed] = useState<readonly Stage[]>([]);
  const isOpen = (card: BoardCard) => card.runs.some((r) => r.session_id === selected);
  const [cursor, setCursor] = useState<string | null>(() => cards.find(isOpen)?.id ?? null);
  useRowKeys(listRef, {
    cursor,
    setCursor,
    hrefOf: (id) => {
      const card = cards.find((c) => c.id === id);
      return card ? openHref(card) : null;
    },
    closeHref: selected ? jobsHref("list") : null,
  });

  if (cards.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No jobs yet</EmptyTitle>
            <EmptyDescription>Jobs appear here as soon as the factory claims a ticket or a run reports its first stage.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <div ref={listRef} className="@container min-h-0 min-w-0 flex-1 overflow-y-auto">
      {STAGES.map((stage) => {
        const rows = cards.filter((c) => c.stage === stage);
        if (rows.length === 0) return null;
        const open = !closed.includes(stage);
        return (
          <section key={stage} aria-label={STAGE_META[stage].label}>
            <div className="sticky top-0 z-10 flex h-9 items-center border-b bg-muted/72 backdrop-blur-sm">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setClosed((c) => (open ? [...c, stage] : c.filter((s) => s !== stage)))}
                className="flex h-full min-w-0 flex-1 items-center gap-2 ps-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset @3xl:ps-5"
              >
                <ChevronRightIcon className={cn("size-3.5 text-muted-foreground transition-transform duration-200 ease-out", open && "rotate-90")} />
                <span className={cn("size-2 rounded-full", STAGE_META[stage].dot)} />
                <span className="font-medium">{STAGE_META[stage].label}</span>
                <span className="text-xs text-muted-foreground tabular-nums">{rows.length}</span>
              </button>
            </div>
            <AnimatePresence initial={false}>
              {open && (
                <motion.ul initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }} transition={spring} className="overflow-hidden">
                  <AnimatePresence initial={false}>
                    {rows.map((card) => (
                      <motion.li
                        key={card.id}
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
                        className="border-b"
                      >
                        <Row
                          card={card}
                          machineName={card.machineId && (machines.get(card.machineId)?.name ?? card.machineId)}
                          agentsBySession={agentsBySession}
                          open={isOpen(card)}
                          cursor={cursor === card.id}
                          onFocus={() => setCursor(card.id)}
                          repoLabels={repoLabels}
                        />
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </motion.ul>
              )}
            </AnimatePresence>
          </section>
        );
      })}
    </div>
  );
}
