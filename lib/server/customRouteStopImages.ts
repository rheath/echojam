function normalize(value: string | null | undefined) {
  return (value || "").trim();
}

function isNonPlaceholderImage(value: string | null | undefined) {
  const normalized = normalize(value);
  if (!normalized) return false;
  return !normalized.toLowerCase().includes("/placeholder");
}

export function pickCustomRouteStopImage(args: {
  canonicalImage: string | null | undefined;
  placeIdPhoto: string | null | undefined;
  curatedFallback: string | null | undefined;
  stopImage: string | null | undefined;
  canonicalSource: "places" | "curated" | "placeholder" | "link_seed" | null;
  placeholder: string;
}) {
  const preferStopSpecific =
    args.canonicalSource === "places" &&
    isNonPlaceholderImage(args.stopImage) &&
    isNonPlaceholderImage(args.canonicalImage);
  const rankedCandidates = preferStopSpecific
    ? [args.stopImage, args.canonicalImage, args.placeIdPhoto, args.curatedFallback]
    : [args.canonicalImage, args.placeIdPhoto, args.curatedFallback, args.stopImage];

  const strongCandidates = rankedCandidates
    .map((value) => normalize(value))
    .filter((value): value is string => Boolean(value) && isNonPlaceholderImage(value));

  if (strongCandidates[0]) return strongCandidates[0];
  return normalize(args.stopImage) || args.placeholder;
}
