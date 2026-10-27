import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { stageReportSchema, stageReportShape, type FactoryEvent, type StageReport } from "../lib/events";
import { REPORT_SERVER, REPORT_TOOL } from "../lib/factory";
import { reportEvents } from "../lib/outbox";
import { mcpIdentity, mcpPosts, type McpIdentity } from "../lib/report-identity";

// Under Claude Code the PostToolUse hook (hooks/report.ts), which knows the session id, turns the
// accepted call into the stage event, so the tool only validates. Under any other harness the tool
// posts the event itself, through the outbox, for the job its env or its branch names.
const FLUSH_BUDGET_MS = 3000;
const server = new McpServer({ name: REPORT_SERVER, version: "0.1.0" });
let started = false;

function eventsFor(identity: McpIdentity, report: StageReport, at: number, opening: boolean): FactoryEvent[] {
  const { jobKey, branch, sessionId, repo } = identity;
  const stage: FactoryEvent = {
    eventId: createHash("sha256").update(`mcp\n${sessionId}\n${at}\n${JSON.stringify(report)}`).digest("hex"),
    sessionId,
    at,
    kind: "stage",
    ...report,
    jobKey,
    branch,
  };
  if (!opening) return [stage];
  // Opens the run and links it to the job; the same id from a restarted server is stored once.
  return [{ eventId: `mcp-start:${sessionId}`, sessionId, at, kind: "session_start", cwd: process.cwd(), branch, repo }, stage];
}

async function post(report: StageReport) {
  if (!mcpPosts(process.env)) return `Recorded stage ${report.stage}.`;
  const identity = mcpIdentity(process.env, process.cwd());
  if (!identity) return `Stage ${report.stage} is valid, but this session is on no factory branch, so nothing was reported.`;
  const flushed = await reportEvents(eventsFor(identity, report, Date.now(), !started), FLUSH_BUDGET_MS);
  if (!flushed) return `Stage ${report.stage} is valid, but this machine has no factory ingest config, so nothing was reported.`;
  started = true;
  return flushed.error ? `Recorded stage ${report.stage}; ingest did not answer, so it is queued and will be delivered later.` : `Recorded stage ${report.stage}.`;
}

server.registerTool(
  REPORT_TOOL,
  {
    title: "Report factory stage",
    description:
      "Report that this factory run entered a stage. Call it at every stage transition. " +
      "Stage pr needs prUrl and should carry your merge assessment; stage waiting needs a concrete question; " +
      "stage failed puts the reason in summary.",
    inputSchema: stageReportShape,
  },
  async (input) => {
    const parsed = stageReportSchema.safeParse(input);
    if (!parsed.success) {
      return {
        isError: true,
        content: [{ type: "text", text: parsed.error.issues.map((i) => i.message).join("; ") }],
      };
    }
    // A reporting failure must never fail the call; the outbox keeps whatever was queued.
    const text = await post(parsed.data).catch((error: unknown) => `Stage ${parsed.data.stage} is valid, but reporting it failed: ${error instanceof Error ? error.message : String(error)}`);
    return { content: [{ type: "text", text }] };
  },
);

await server.connect(new StdioServerTransport());
