import { useRouter } from "next/navigation";
import { type RefObject, useEffect, useRef } from "react";
import { isTyping } from "./panel-shell";

type RowKeys = {
  /** The row J and K stand on, by its data-row id. */
  cursor: string | null;
  setCursor: (id: string | null) => void;
  /** Where Enter on the cursor's row goes; null when the row opens nothing. */
  hrefOf: (id: string) => string | null;
  /** Where Esc goes while something is open; null when nothing is. */
  closeHref: string | null;
};

/**
 * J and K (or the arrows) walk the list's [data-row] elements, Enter opens the cursor's row and
 * Esc closes what is open. Keys typed in a field, or pressed in a dialog, a menu or a detail pane,
 * belong to them.
 */
export function useRowKeys(listRef: RefObject<HTMLElement | null>, keys: RowKeys) {
  const router = useRouter();
  // The handler reads these on each key press, so it never needs to re-subscribe.
  const latest = useRef(keys);
  useEffect(() => {
    latest.current = keys;
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (e.target !== document.body && !(e.target instanceof Node && listRef.current?.contains(e.target))) return;
      const { cursor, setCursor, hrefOf, closeHref } = latest.current;
      switch (e.key) {
        case "j":
        case "k":
        case "ArrowDown":
        case "ArrowUp": {
          const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-row]") ?? []);
          const at = rows.findIndex((row) => row.dataset.row === cursor);
          const down = e.key === "j" || e.key === "ArrowDown";
          const next = rows[at === -1 ? 0 : down ? Math.min(rows.length - 1, at + 1) : Math.max(0, at - 1)];
          next?.focus();
          setCursor(next?.dataset.row ?? null);
          e.preventDefault();
          return;
        }
        case "Enter": {
          // A focused row is a link and opens itself.
          if (e.target !== document.body) return;
          const href = cursor && hrefOf(cursor);
          if (href) router.push(href, { scroll: false });
          return;
        }
        case "Escape":
          if (closeHref) router.push(closeHref, { scroll: false });
          return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router, listRef]);
}
