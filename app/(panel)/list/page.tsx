import { redirect } from "next/navigation";

/** The list used to be its own page; old links land on the jobs page in list view. */
export default async function ListPage(props: PageProps<"/list">) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await props.searchParams)) {
    for (const v of [value ?? []].flat()) params.append(key, v);
  }
  params.set("view", "list");
  redirect(`/?${params}`);
}
