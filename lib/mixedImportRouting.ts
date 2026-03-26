import { toNullableTrimmed } from "@/lib/instagramImport";
import {
  normalizeMixedComposerSessionSnapshot,
  type MixedComposerSessionSnapshot,
} from "@/lib/mixedComposerSession";

export type MixedImportProvider = "instagram" | "tiktok";

type BuildMixedImportPathParams = {
  sessionId?: string | null;
  resumeJamId?: string | null;
  provider?: string | null;
  instagramDraftId?: string | null;
  tiktokDraftId?: string | null;
};

function normalizeProvider(value: string | null | undefined): MixedImportProvider | null {
  return value === "instagram" || value === "tiktok" ? value : null;
}

export function buildMixedImportPath(params: BuildMixedImportPathParams = {}) {
  const search = new URLSearchParams();
  const sessionId = toNullableTrimmed(params.sessionId);
  const resumeJamId = toNullableTrimmed(params.resumeJamId);
  const provider = normalizeProvider(toNullableTrimmed(params.provider));
  const instagramDraftId = toNullableTrimmed(params.instagramDraftId);
  const tiktokDraftId = toNullableTrimmed(params.tiktokDraftId);

  if (sessionId) search.set("session", sessionId);
  if (resumeJamId) search.set("resumeJam", resumeJamId);
  if (provider) search.set("provider", provider);
  if (instagramDraftId) search.set("instagramDraft", instagramDraftId);
  if (tiktokDraftId) search.set("tiktokDraft", tiktokDraftId);

  const query = search.toString();
  return query ? `/import/mixed?${query}` : "/import/mixed";
}

export function isMixedImportPath(value: string | null | undefined) {
  const normalized = toNullableTrimmed(value);
  return Boolean(normalized && normalized.startsWith("/import/mixed"));
}

export function normalizeMixedImportNextPath(
  value: string | null | undefined,
  fallbackProvider?: MixedImportProvider | null
) {
  if (isMixedImportPath(value)) return value as string;
  return buildMixedImportPath({ provider: fallbackProvider ?? null });
}

export function resolveMixedImportRequiredProvider(args: {
  provider?: string | null;
  instagramDraftId?: string | null;
  tiktokDraftId?: string | null;
  sessionSnapshot?: Partial<MixedComposerSessionSnapshot> | null;
}) {
  if (toNullableTrimmed(args.instagramDraftId)) return "instagram" as const;
  if (toNullableTrimmed(args.tiktokDraftId)) return "tiktok" as const;

  const explicitProvider = normalizeProvider(toNullableTrimmed(args.provider));
  if (explicitProvider) return explicitProvider;

  const snapshot = normalizeMixedComposerSessionSnapshot(args.sessionSnapshot);
  if (snapshot.activeImportJob?.provider) return snapshot.activeImportJob.provider;
  if (snapshot.activeProvider === "tiktok" && snapshot.tiktokDraftId) return "tiktok" as const;
  if (
    snapshot.activeProvider === "instagram" &&
    (snapshot.instagramDraftId || snapshot.instagramDraftIds.length > 0)
  ) {
    return "instagram" as const;
  }
  if (snapshot.tiktokDraftId) return "tiktok" as const;
  if (snapshot.instagramDraftId || snapshot.instagramDraftIds.length > 0) return "instagram" as const;
  return null;
}

export function buildLegacyInstagramRedirectPath(args: {
  draftId?: string | null;
  mixedComposerSessionId?: string | null;
}) {
  if (toNullableTrimmed(args.mixedComposerSessionId)) {
    return buildMixedImportPath({ sessionId: args.mixedComposerSessionId });
  }
  if (toNullableTrimmed(args.draftId)) {
    return buildMixedImportPath({
      provider: "instagram",
      instagramDraftId: args.draftId,
    });
  }
  return buildMixedImportPath({ provider: "instagram" });
}

export function buildLegacyTikTokRedirectPath() {
  return buildMixedImportPath({ provider: "tiktok" });
}
