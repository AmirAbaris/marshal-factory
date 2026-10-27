import { PanelPage } from "@/components/panel/panel-page";

export default function InboxPage(props: PageProps<"/inbox">) {
  return <PanelPage view="inbox" searchParams={props.searchParams} />;
}
