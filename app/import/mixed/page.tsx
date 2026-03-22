import MixedComposerClient from "./MixedComposerClient";

function toSingleSearchParam(value: string | string[] | undefined) {
  return typeof value === "string" ? value : Array.isArray(value) ? value[0] : null;
}

export default async function MixedImportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolved = await searchParams;
  return (
    <MixedComposerClient
      initialSessionId={toSingleSearchParam(resolved.session)}
      initialProvider={toSingleSearchParam(resolved.provider)}
      initialInstagramDraftId={toSingleSearchParam(resolved.instagramDraft)}
      initialTikTokDraftId={toSingleSearchParam(resolved.tiktokDraft)}
    />
  );
}
