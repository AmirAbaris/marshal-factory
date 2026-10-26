import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { stageReportSchema, stageReportShape } from "../lib/events";
import { REPORT_SERVER, REPORT_TOOL } from "../lib/factory";

// The tool only validates. MCP servers don't learn the Claude session id, so the PostToolUse
// hook (hooks/report.ts), which does, turns the accepted call into the stage event.
const server = new McpServer({ name: REPORT_SERVER, version: "0.1.0" });

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
    return { content: [{ type: "text", text: `Recorded stage ${parsed.data.stage}.` }] };
  },
);

await server.connect(new StdioServerTransport());
