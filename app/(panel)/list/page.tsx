import { PanelPage } from "@/components/panel/panel-page";

export default function ListPage(props: PageProps<"/list">) {
  return <PanelPage view="list" searchParams={props.searchParams} />;
}
