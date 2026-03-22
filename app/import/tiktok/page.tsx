import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import {
  isTikTokCreatorAccessAuthorizedFromCookieStore,
  isTikTokImportEnabled,
} from "@/lib/server/tiktokCreatorAccess";
import TikTokImportClient from "./TikTokImportClient";

export default async function TikTokImportPage() {
  if (!isTikTokImportEnabled()) {
    notFound();
  }

  const cookieStore = await cookies();
  if (!isTikTokCreatorAccessAuthorizedFromCookieStore(cookieStore)) {
    redirect(`/import/tiktok/access?next=${encodeURIComponent("/import/mixed?provider=tiktok")}`);
  }

  return <TikTokImportClient />;
}
