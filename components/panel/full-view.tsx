"use client";

import { Maximize2Icon, Minimize2Icon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { fullViewHref } from "@/lib/run-links";
import { isTyping } from "./panel-shell";

export type FullView = { full: boolean; toggleHref: string };

/** Whether `?full=1` asks for the open detail to fill the page, and the link that flips it. */
export function useFullView(): FullView {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const full = searchParams.get("full") === "1";
  return { full, toggleHref: fullViewHref(pathname, searchParams, !full) };
}

const OVERLAY = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/** Esc in full view goes back to the side panel, unless a field, dialog or menu has the key. */
export function useEscapeToSidePanel({ full, toggleHref }: FullView) {
  const router = useRouter();
  useEffect(() => {
    if (!full) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (e.target instanceof Element && e.target.closest(OVERLAY)) return;
      router.push(toggleHref, { scroll: false });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router, full, toggleHref]);
}

export function FullViewToggle({ full, toggleHref }: FullView) {
  return (
    <Button render={<Link href={toggleHref} scroll={false} />} variant="ghost" size="icon-sm" aria-label={full ? "Back to side panel" : "Open full view"}>
      {full ? <Minimize2Icon /> : <Maximize2Icon />}
    </Button>
  );
}
