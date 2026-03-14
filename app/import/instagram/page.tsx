import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import {
  isInstagramCreatorAccessAuthorizedFromCookieStore,
  isInstagramImportEnabled,
} from "@/lib/server/instagramCreatorAccess";
import InstagramImportClient from "./InstagramImportClient";

function toSingleSearchParam(value: string | string[] | undefined) {
  return typeof value === "string" ? value : Array.isArray(value) ? value[0] : null;
}

export default async function InstagramImportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!isInstagramImportEnabled()) {
    notFound();
  }

  const cookieStore = await cookies();
  if (!isInstagramCreatorAccessAuthorizedFromCookieStore(cookieStore)) {
    const resolvedSearchParams = await searchParams;
    const nextParams = new URLSearchParams();
    const draft = toSingleSearchParam(resolvedSearchParams.draft);
    const route = toSingleSearchParam(resolvedSearchParams.route);
    if (draft) nextParams.set("draft", draft);
    if (route) nextParams.set("route", route);
    const nextPath = nextParams.size > 0 ? `/import/instagram?${nextParams.toString()}` : "/import/instagram";
    redirect(`/import/instagram/access?next=${encodeURIComponent(nextPath)}`);
  }

  return <InstagramImportClient />;
}
