import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import MixedComposerClient from "../MixedComposerClient";
import { buildMixedImportPath } from "@/lib/mixedImportRouting";
import {
  isInstagramCreatorAccessAuthorizedFromCookieStore,
  isInstagramImportEnabled,
} from "@/lib/server/instagramCreatorAccess";
import {
  isTikTokCreatorAccessAuthorizedFromCookieStore,
  isTikTokImportEnabled,
} from "@/lib/server/tiktokCreatorAccess";

function toSingleSearchParam(value: string | string[] | undefined) {
  return typeof value === "string" ? value : Array.isArray(value) ? value[0] : null;
}

export default async function MixedImportCreatePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolved = await searchParams;
  const initialSessionId = toSingleSearchParam(resolved.session);
  const initialResumeJamId = toSingleSearchParam(resolved.resumeJam);
  const initialProvider = toSingleSearchParam(resolved.provider);
  const initialInstagramDraftId = toSingleSearchParam(resolved.instagramDraft);
  const initialTikTokDraftId = toSingleSearchParam(resolved.tiktokDraft);

  if (initialProvider === "instagram" || initialInstagramDraftId) {
    if (!isInstagramImportEnabled()) {
      notFound();
    }
    const cookieStore = await cookies();
    if (!isInstagramCreatorAccessAuthorizedFromCookieStore(cookieStore)) {
      redirect(
        `/import/instagram/access?next=${encodeURIComponent(
          buildMixedImportPath({
            sessionId: initialSessionId,
            resumeJamId: initialResumeJamId,
            provider: initialProvider,
            instagramDraftId: initialInstagramDraftId,
            tiktokDraftId: initialTikTokDraftId,
          })
        )}`
      );
    }
  }

  if (initialProvider === "tiktok" || initialTikTokDraftId) {
    if (!isTikTokImportEnabled()) {
      notFound();
    }
    const cookieStore = await cookies();
    if (!isTikTokCreatorAccessAuthorizedFromCookieStore(cookieStore)) {
      redirect(
        `/import/tiktok/access?next=${encodeURIComponent(
          buildMixedImportPath({
            sessionId: initialSessionId,
            resumeJamId: initialResumeJamId,
            provider: initialProvider,
            instagramDraftId: initialInstagramDraftId,
            tiktokDraftId: initialTikTokDraftId,
          })
        )}`
      );
    }
  }

  return (
    <MixedComposerClient
      initialSessionId={initialSessionId}
      initialResumeJamId={initialResumeJamId}
      initialProvider={initialProvider}
      initialInstagramDraftId={initialInstagramDraftId}
      initialTikTokDraftId={initialTikTokDraftId}
      initialPublishTarget={null}
    />
  );
}
