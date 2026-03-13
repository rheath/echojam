import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import {
  isInstagramCreatorAccessAuthorizedFromCookieStore,
  isInstagramImportEnabled,
} from "@/lib/server/instagramCreatorAccess";
import InstagramCreatorAccessClient from "./InstagramCreatorAccessClient";

export default async function InstagramImportAccessPage() {
  if (!isInstagramImportEnabled()) {
    notFound();
  }

  const cookieStore = await cookies();
  if (isInstagramCreatorAccessAuthorizedFromCookieStore(cookieStore)) {
    redirect("/import/instagram");
  }

  return <InstagramCreatorAccessClient />;
}
