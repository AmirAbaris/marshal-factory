import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { MAX_SCREENSHOT_BYTES, SCREENSHOT_DIR, sniffType, type ScreenshotRef, type ScreenshotType } from "./screenshots";

// The reporter's side of lib/screenshots.ts: reading the attached files on the agent's machine.

export type ReadScreenshot = { ok: true; bytes: Buffer; contentType: ScreenshotType } | { ok: false; reason: string };

/** Reads one attached file from `dir`, refusing anything outside it, too large, or not an image. */
export function readScreenshot(file: string, dir = SCREENSHOT_DIR): ReadScreenshot {
  let path: string;
  let root: string;
  try {
    root = realpathSync(dir);
    path = realpathSync(isAbsolute(file) ? file : join(dir, file));
  } catch {
    return { ok: false, reason: `${file} does not exist in ${dir}` };
  }
  const rel = relative(root, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return { ok: false, reason: `${file} is not inside ${dir}` };
  const size = statSync(path).size;
  if (size > MAX_SCREENSHOT_BYTES) return { ok: false, reason: `${file} is ${size} bytes, over the ${MAX_SCREENSHOT_BYTES} limit; take a viewport screenshot instead of a full page` };
  const bytes = readFileSync(path);
  const contentType = sniffType(bytes);
  if (!contentType) return { ok: false, reason: `${file} is not a PNG, JPEG or WebP image` };
  return { ok: true, bytes, contentType };
}

/** Every attached file that can't be sent, as one reason each. */
export const unreadable = (refs: readonly ScreenshotRef[], dir = SCREENSHOT_DIR) =>
  refs.flatMap((ref) => {
    const read = readScreenshot(ref.file, dir);
    return read.ok ? [] : [read.reason];
  });

type ScreenshotEventFields = { kind: "screenshot"; jobKey: string; stageEventId: string; file: string; contentType: ScreenshotType; data: string };

/**
 * The screenshot events for one pr report, each with an id derived from the stage event and the
 * file, so a retried report stores each image once. Files that can't be read are left out.
 */
export function screenshotEvents(
  refs: readonly ScreenshotRef[],
  { jobKey, stageEventId, sessionId, at }: { jobKey: string; stageEventId: string; sessionId: string; at: number },
  dir = SCREENSHOT_DIR,
): (ScreenshotEventFields & { eventId: string; sessionId: string; at: number })[] {
  return [...new Set(refs.map((r) => r.file))].flatMap((file) => {
    const read = readScreenshot(file, dir);
    if (!read.ok) return [];
    return [{ eventId: `screenshot:${stageEventId}:${file}`, sessionId, at, kind: "screenshot" as const, jobKey, stageEventId, file, contentType: read.contentType, data: read.bytes.toString("base64") }];
  });
}
