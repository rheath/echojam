import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import {
  isInstagramCreatorAccessAuthorizedFromCookieStore,
  isInstagramImportEnabled,
} from "@/lib/server/instagramCreatorAccess";
import InstagramCreatorAccessClient from "./InstagramCreatorAccessClient";

function resolveNextPath(value: string | string[] | undefined) {
  const candidate = typeof value === "string" ? value : Array.isArray(value) ? value[0] : null;
  if (!candidate || !candidate.startsWith("/import/instagram")) {
    return "/import/instagram";
  }
  return candidate;
}

export default async function InstagramImportAccessPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!isInstagramImportEnabled()) {
    notFound();
  }

  const cookieStore = await cookies();
  if (isInstagramCreatorAccessAuthorizedFromCookieStore(cookieStore)) {
    const resolvedSearchParams = await searchParams;
    redirect(resolveNextPath(resolvedSearchParams.next));
  }

  return <InstagramCreatorAccessClient />;
}
