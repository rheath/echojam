export type PlaceGroundingSource =
  | "google_place_details"
  | "reverse_geocode"
  | "provided_place";

export type PlaceGrounding = {
  placeId: string | null;
  resolvedName: string | null;
  formattedAddress: string | null;
  venueCategory: string | null;
  neighborhood: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  localContext: string | null;
  source: PlaceGroundingSource;
  signature: string;
};

function normalizeOptionalText(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function buildPlaceGroundingSignature(
  value:
    | Pick<
        Partial<PlaceGrounding>,
        "placeId" | "resolvedName" | "formattedAddress" | "venueCategory" | "neighborhood" | "city" | "region" | "country"
      >
    | null
    | undefined
) {
  const parts = [
    normalizeOptionalText(value?.placeId),
    normalizeOptionalText(value?.resolvedName),
    normalizeOptionalText(value?.formattedAddress),
    normalizeOptionalText(value?.venueCategory),
    normalizeOptionalText(value?.neighborhood),
    normalizeOptionalText(value?.city),
    normalizeOptionalText(value?.region),
    normalizeOptionalText(value?.country),
  ];
  return parts.map((part) => (part || "").toLowerCase()).join("|");
}

export function buildPlaceGroundingPromptLines(placeGrounding: PlaceGrounding | null | undefined) {
  if (!placeGrounding) return [] as string[];

  const lines = [
    "Confirmed place grounding:",
    ...(placeGrounding.resolvedName ? [`- Confirmed place: ${placeGrounding.resolvedName}`] : []),
    ...(placeGrounding.venueCategory ? [`- Venue type: ${placeGrounding.venueCategory}`] : []),
    ...(placeGrounding.neighborhood ? [`- Neighborhood or borough: ${placeGrounding.neighborhood}`] : []),
    ...(placeGrounding.city ? [`- City: ${placeGrounding.city}`] : []),
    ...(placeGrounding.region ? [`- Region: ${placeGrounding.region}`] : []),
    ...(placeGrounding.country ? [`- Country: ${placeGrounding.country}`] : []),
    ...(placeGrounding.localContext ? [`- Local context: ${placeGrounding.localContext}`] : []),
    "- Let this confirmed place context shape the script's specificity and sense of place.",
    "- Do not mention raw coordinates, latitude/longitude, or map-style phrasing.",
    "- Do not mechanically recite the full street address unless the source material naturally depends on it.",
  ];

  return lines;
}
