import type { RouteDef } from "@/app/content/routeTypes";
import { toSafeResolvedRouteStopImage } from "@/lib/resolvedRouteStops";

type WalkRouteStop = Pick<RouteDef["stops"][number], "sourceProvider" | "sourceUrl" | "images" | "sourcePreviewImageUrl">;

export type WalkScriptModalSourceLink = {
  provider: "instagram" | "tiktok";
  href: string;
  imageSrc: string;
  title: string;
  description: string;
  ctaLabel: string;
};

function normalizeHttpUrl(value: string | null | undefined) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) return null;

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function buildWalkScriptModalSourceLink(
  stop: WalkRouteStop | null | undefined
): WalkScriptModalSourceLink | null {
  const provider = stop?.sourceProvider ?? null;
  const href = normalizeHttpUrl(stop?.sourceUrl);
  if (!href) return null;

  if (provider === "instagram") {
    return {
      provider,
      href,
      imageSrc: toSafeResolvedRouteStopImage(stop?.sourcePreviewImageUrl || stop?.images?.[0]),
      title: "Instagram source",
      description: "View the original Instagram post for this stop.",
      ctaLabel: "Open Instagram",
    };
  }

  if (provider === "tiktok") {
    return {
      provider,
      href,
      imageSrc: toSafeResolvedRouteStopImage(stop?.sourcePreviewImageUrl || stop?.images?.[0]),
      title: "TikTok source",
      description: "Open the original TikTok that inspired this stop.",
      ctaLabel: "Open on TikTok",
    };
  }

  return null;
}
