import { redirect } from "next/navigation";
import {
  buildLegacyInstagramRedirectPath,
} from "@/lib/mixedImportRouting";

function toSingleSearchParam(value: string | string[] | undefined) {
  return typeof value === "string" ? value : Array.isArray(value) ? value[0] : null;
}

export default async function InstagramImportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = await searchParams;
  const draftId = toSingleSearchParam(resolvedSearchParams.draft);

  redirect(
    buildLegacyInstagramRedirectPath({
      draftId,
    })
  );
}
