import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { FeedStatus } from "./sealed";

const STATUS: Record<FeedStatus, { dot: string; label: string }> = {
  live: { dot: "animate-pulse bg-success", label: "Live" },
  connecting: { dot: "bg-warning", label: "Connecting" },
  off: { dot: "bg-faint", label: "Live updates off in previews" },
};

export type SidebarProps = {
  status: FeedStatus;
} & (
  | { active: "board"; cardCount: number; unstagedCount: number; liveSessions: number }
  | { active: "machines"; onlineMachines: number | null }
);

const linkClass = (active: boolean) =>
  cn(
    "flex items-center justify-between rounded-md px-2.5 py-1.5",
    active ? "bg-accent" : "text-muted-foreground hover:bg-accent hover:text-foreground",
  );

export function Sidebar(props: SidebarProps) {
  const { status } = props;
  const footer =
    props.active === "board"
      ? ` · ${props.liveSessions} active`
      : props.onlineMachines === null
        ? ""
        : ` · ${props.onlineMachines} online`;
  return (
    <nav className="flex flex-col gap-1 border-r bg-sidebar px-3 py-4">
      <div className="flex items-center gap-2.5 px-2 pt-1 pb-4 font-semibold">
        <div className="size-5.5 rounded-md bg-[conic-gradient(from_210deg,var(--primary),var(--violet),var(--info),var(--primary))]" />
        Marshal Factory
      </div>
      <Link href="/" className={linkClass(props.active === "board")}>
        Board {props.active === "board" && <Badge variant="secondary">{props.cardCount}</Badge>}
      </Link>
      {props.active === "board" && (
        <a href="#other-activity" className={linkClass(false)}>
          Other activity <Badge variant="secondary">{props.unstagedCount}</Badge>
        </a>
      )}
      <Link href="/machines" className={linkClass(props.active === "machines")}>
        Machines
      </Link>
      <div className="mt-auto flex items-center gap-2 px-2.5 py-2 text-muted-foreground">
        <span className={cn("size-1.5 shrink-0 rounded-full", STATUS[status].dot)} />
        {STATUS[status].label}
        {footer}
      </div>
    </nav>
  );
}
