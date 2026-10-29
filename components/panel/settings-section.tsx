import type { ReactNode } from "react";

/** One settings group: what it is about on the left, its form on the right; stacked on narrow screens. */
export function SettingsSection({ id, title, description, children }: { id: string; title: string; description: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-4 py-8 first:pt-0 last:pb-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-10">
      <div className="flex flex-col gap-1.5 lg:sticky lg:top-0 lg:self-start">
        <h2 id={`${id}-title`} className="font-semibold">
          {title}
        </h2>
        <div className="text-sm text-pretty text-muted-foreground">{description}</div>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}
