import { z } from "zod";
import { EXECUTIONS, executionSchema, type Execution } from "./execution";
import type { Harness } from "./harness";

// A ticket can pick its lead harness and where it runs with two Linear label groups. Linear lets
// an issue carry one child label per group; anything outside these groups is not an override.

export const HARNESS_GROUP = "Harness";
export const RUNS_ON_GROUP = "Runs on";
export const RUNS_ON_LABELS: Record<Execution, string> = { local: "Local", modal: "Modal" };

/** A label as stored on a job; a row stored before groups were read has no group for any label. */
export type TicketLabel = { name: string; group: string | null };

export const labelGroupSchema = z.object({ name: z.string(), group: z.string() });

export function ticketLabels(state: { labels: readonly string[]; labelGroups?: readonly { name: string; group: string }[] }): TicketLabel[] {
  const grouped = state.labelGroups ?? [];
  return [
    ...grouped.map(({ name, group }) => ({ name, group })),
    ...state.labels.filter((name) => !grouped.some((g) => g.name === name)).map((name) => ({ name, group: null })),
  ];
}

export type TicketOverrides = { provider?: string; execution?: Execution; problems: string[] };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const quoted = (labels: readonly TicketLabel[]) => labels.map((l) => `"${l.name}"`).join(", ");

/** What the ticket's labels ask for, by group and child name; a label that cannot apply is a problem and falls back to Settings. */
export function ticketOverrides(labels: readonly TicketLabel[], harnesses: readonly Harness[] | null): TicketOverrides {
  const problems: string[] = [];
  const inGroup = (group: string) => labels.filter((l) => l.group !== null && same(l.group, group));
  const result: TicketOverrides = { problems };

  const harnessLabels = inGroup(HARNESS_GROUP);
  if (harnessLabels.length > 1) {
    problems.push(`The issue has more than one ${HARNESS_GROUP} label (${quoted(harnessLabels)}), so it runs on the Settings harness.`);
  } else if (harnessLabels.length === 1) {
    const { name } = harnessLabels[0]!;
    const matches = (harnesses ?? []).filter((h) => same(h.name, name));
    const enabled = matches.find((h) => h.enabled);
    if (enabled) result.provider = enabled.id;
    else if (matches.length > 0) problems.push(`The ${HARNESS_GROUP} label "${name}" names a harness that is disabled in T3, so it runs on the Settings harness.`);
    else problems.push(`The ${HARNESS_GROUP} label "${name}" matches no harness a runner reports, so it runs on the Settings harness.`);
  }

  const runsOnLabels = inGroup(RUNS_ON_GROUP);
  if (runsOnLabels.length > 1) {
    problems.push(`The issue has more than one ${RUNS_ON_GROUP} label (${quoted(runsOnLabels)}), so it runs where Settings say.`);
  } else if (runsOnLabels.length === 1) {
    const { name } = runsOnLabels[0]!;
    const execution = EXECUTIONS.find((e) => same(RUNS_ON_LABELS[e], name));
    if (execution) result.execution = execution;
    else problems.push(`The ${RUNS_ON_GROUP} label "${name}" is neither ${Object.values(RUNS_ON_LABELS).join(" nor ")}, so it runs where Settings say.`);
  }
  return result;
}

/** The child labels each group should have: one per enabled harness, by display name, and one per execution. */
export function desiredLabelGroups(harnesses: readonly Harness[]) {
  const names: string[] = [];
  for (const h of harnesses) if (h.enabled && !names.some((n) => same(n, h.name))) names.push(h.name);
  return [
    { group: HARNESS_GROUP, children: names },
    { group: RUNS_ON_GROUP, children: EXECUTIONS.map((e) => RUNS_ON_LABELS[e]) },
  ];
}

/** What a job records about its ticket's overrides: what applied, and each fallback the runner took instead. */
export const ticketRecordSchema = z.object({
  provider: z.string().optional(),
  execution: executionSchema.optional(),
  notes: z.array(z.string()),
});
export type TicketRecord = z.infer<typeof ticketRecordSchema>;
