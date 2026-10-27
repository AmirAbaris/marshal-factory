import { PanelPage } from "@/components/panel/panel-page";

export default function JobsPage(props: PageProps<"/">) {
  return <PanelPage view="jobs" searchParams={props.searchParams} />;
}
