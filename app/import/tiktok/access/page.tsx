import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { normalizeMixedImportNextPath } from "@/lib/mixedImportRouting";
import {
  isTikTokCreatorAccessAuthorizedFromCookieStore,
  isTikTokImportEnabled,
} from "@/lib/server/tiktokCreatorAccess";
import TikTokCreatorAccessClient from "./TikTokCreatorAccessClient";

function resolveNextPath(value: string | string[] | undefined) {
  const candidate = typeof value === "string" ? value : Array.isArray(value) ? value[0] : null;
  return normalizeMixedImportNextPath(candidate, "tiktok");
}

export default async function TikTokAccessPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!isTikTokImportEnabled()) {
    notFound();
  }

  const cookieStore = await cookies();
  if (isTikTokCreatorAccessAuthorizedFromCookieStore(cookieStore)) {
    const resolvedSearchParams = await searchParams;
    redirect(resolveNextPath(resolvedSearchParams.next));
  }

  return <TikTokCreatorAccessClient />;
}
