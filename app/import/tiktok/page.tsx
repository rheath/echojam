import { redirect } from "next/navigation";
import { buildLegacyTikTokRedirectPath } from "@/lib/mixedImportRouting";

export default async function TikTokImportPage() {
  redirect(buildLegacyTikTokRedirectPath());
}
