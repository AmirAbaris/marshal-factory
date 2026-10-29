import { z } from "zod";
import { matchesAny } from "./globs";

// Browser screenshots the agent attaches to its pr assessment, so the owner sees what the agent saw.
// The assessment names files in the Playwright MCP server's output dir; the reporter (hooks/report.ts
// under Claude Code, mcp/factory-report.ts elsewhere) reads each one (lib/screenshot-files.ts) and
// sends it as a screenshot event ahead of the stage event. Ingest keeps the bytes in
// job_screenshots, keyed by that stage event and the file, and the panel serves them to the owner.

/** Where the sandbox's headless browser writes its screenshots; see browserServer in lib/sandbox.ts. */
export const SCREENSHOT_DIR = "/work/browser";
export const MAX_SCREENSHOTS = 6;
/** Per image, before base64; a 1280×720 PNG is usually well under it. */
export const MAX_SCREENSHOT_BYTES = 1_000_000;
const MAX_DATA_CHARS = Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4;

export const SCREENSHOT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type ScreenshotType = (typeof SCREENSHOT_TYPES)[number];

export const screenshotRefSchema = z.object({
  file: z.string().min(1).max(200).describe(`The screenshot file the playwright server wrote, relative to ${SCREENSHOT_DIR} or absolute inside it.`),
  caption: z.string().min(1).max(300).describe("What the screenshot shows: the page, the state, and what to look for."),
});
export type ScreenshotRef = z.infer<typeof screenshotRefSchema>;

export const screenshotsInputSchema = z.array(screenshotRefSchema).max(MAX_SCREENSHOTS);

/** What a screenshot event carries besides the event's own id, session and time. */
export const screenshotShape = {
  jobKey: z.string().min(1),
  /** The pr stage event whose assessment names this file. */
  stageEventId: z.string().min(1),
  file: screenshotRefSchema.shape.file,
  contentType: z.enum(SCREENSHOT_TYPES),
  /** The image, base64. */
  data: z.base64().max(MAX_DATA_CHARS),
};

/** The image type its first bytes name; null when it is none the panel shows. */
export function sniffType(bytes: Uint8Array): ScreenshotType | null {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

/** Where the panel serves one of the current assessment's screenshots; `v` changes with each report, so a cached image never outlives it. */
export const screenshotUrl = (jobKey: string, index: number, stageEventId: string | null) =>
  `/api/jobs/${encodeURIComponent(jobKey)}/screenshots/${index}?v=${encodeURIComponent(stageEventId ?? "")}`;

/** Files whose change shows on a page or screen. */
export const UI_GLOBS = ["**/*.tsx", "**/*.jsx", "**/*.vue", "**/*.svelte", "**/*.astro", "**/*.html", "**/*.css", "**/*.scss", "**/*.sass", "**/*.less"];

/** The changed files a merge should have screenshots for. */
export const uiFiles = (paths: readonly string[]) => paths.filter((path) => matchesAny(path, UI_GLOBS));
