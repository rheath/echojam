import type { RouteDef } from "@/app/content/routeTypes";

type RouteStopSourceCredit = Pick<RouteDef["stops"][number], "sourceCreatorName">;

function normalizeCreatorName(value: string | null | undefined) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

export function hasMultipleWalkSourceCredits(
  stops: Array<RouteStopSourceCredit | null | undefined> | null | undefined
) {
  const uniqueCreators = new Set<string>();

  for (const stop of stops ?? []) {
    const creator = normalizeCreatorName(stop?.sourceCreatorName);
    if (!creator) continue;
    uniqueCreators.add(creator.toLowerCase());
    if (uniqueCreators.size > 1) return true;
  }

  return false;
}

export function formatWalkStopSourceLabel(
  stop: RouteStopSourceCredit | null | undefined,
  hasMultipleCredits: boolean
) {
  if (!hasMultipleCredits) return null;
  return normalizeCreatorName(stop?.sourceCreatorName);
}
