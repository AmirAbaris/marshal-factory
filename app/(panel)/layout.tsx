import { cookies } from "next/headers";
import { COLLAPSED_COOKIE, PanelShell } from "@/components/panel/panel-shell";

export default async function PanelLayout({ children }: LayoutProps<"/">) {
  const collapsed = (await cookies()).get(COLLAPSED_COOKIE)?.value === "false";
  return <PanelShell defaultCollapsed={collapsed}>{children}</PanelShell>;
}
