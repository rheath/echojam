import { getPresetCityMeta } from "@/lib/presetOverview";
import type { Persona, PresetCity, PresetRouteSummary } from "@/app/content/routeTypes";
import { personaCatalog } from "@/lib/personas/catalog";

const presetRouteSummaries: PresetRouteSummary[] = [
  {
    id: "boston-revolutionary-secrets",
    title: "Boston Revolutionary Secrets",
    durationLabel: "45 mins",
    durationMinutes: 45,
    description: "Hidden stories from the American Revolution.",
    discoveryThemes: ["history"],
    defaultPersona: "adult",
    city: "boston",
    pricing: { status: "free", displayLabel: "FREE", amountUsdCents: null },
    stopCount: 8,
    firstStopTitle: "Granary Burying Ground",
    previewPlaceId: "ChIJDXUUlIRw44kRT_pEDqwG790",
    requiresPurchase: false,
    accessState: "unknown",
  },
  {
    id: "boston-old-taverns",
    title: "Boston Old Taverns",
    durationLabel: "40 mins",
    durationMinutes: 40,
    description: "Historic pubs and gathering places where politics and nightlife overlapped.",
    discoveryThemes: ["history"],
    defaultPersona: "adult",
    city: "boston",
    pricing: { status: "paid", displayLabel: "$0.99", amountUsdCents: 99 },
    stopCount: 7,
    firstStopTitle: "Bell in Hand",
    previewPlaceId: "ChIJHTF784Vw44kRgfkpGmXBtic",
    requiresPurchase: true,
    accessState: "unknown",
  },
  {
    id: "nyc-architecture-walk",
    title: "New York City Architecture Walk",
    durationLabel: "45 mins",
    durationMinutes: 45,
    description: "A walk through centuries of design.",
    discoveryThemes: ["architecture"],
    defaultPersona: "adult",
    city: "nyc",
    pricing: { status: "free", displayLabel: "FREE", amountUsdCents: null },
    stopCount: 9,
    firstStopTitle: "Grand Central Terminal",
    previewPlaceId: "ChIJhRwB-yFawokRi0AhGH87UTc",
    requiresPurchase: false,
    accessState: "unknown",
  },
  {
    id: "nyc-city-animals-adventure",
    title: "NYC Animals Adventure",
    durationLabel: "35 mins",
    durationMinutes: 35,
    description: "A playful walk through the wild side of Central Park.",
    discoveryThemes: ["animals"],
    defaultPersona: "preteen",
    storyBy: "AI Explorer",
    city: "nyc",
    pricing: { status: "free", displayLabel: "FREE", amountUsdCents: null },
    stopCount: 6,
    firstStopTitle: "Central Park Zoo",
    previewPlaceId: "ChIJaWjW_PFYwokRFD8a2YQu12U",
    requiresPurchase: false,
    accessState: "unknown",
  },
  {
    id: "nyc-superhero-city",
    title: "Superheroes of NYC",
    durationLabel: "35 mins",
    durationMinutes: 35,
    description:
      "A comic-book adventure through Midtown ending at the Brooklyn Bridge, where real New York history meets the world of superheroes.",
    discoveryThemes: ["comics", "history"],
    defaultPersona: "preteen",
    storyBy: "AI Explorer",
    city: "nyc",
    pricing: { status: "free", displayLabel: "FREE", amountUsdCents: null },
    stopCount: 6,
    firstStopTitle: "Times Square",
    previewPlaceId: "ChIJmQJIxlVYwokRLgeuocVOGVU",
    requiresPurchase: false,
    accessState: "unknown",
  },
  {
    id: "nyc-weird-wacky-history",
    title: "Weird & Wacky NYC History",
    durationLabel: "35 mins",
    durationMinutes: 35,
    description: "Odd landmarks, secret corners, and the strangest stories in the city.",
    discoveryThemes: ["weird_history"],
    defaultPersona: "preteen",
    storyBy: "AI Explorer",
    city: "nyc",
    pricing: { status: "free", displayLabel: "FREE", amountUsdCents: null },
    stopCount: 6,
    firstStopTitle: "Flatiron Building",
    previewPlaceId: "ChIJZx8c96NZwokRJklw7SVhKt4",
    requiresPurchase: false,
    accessState: "unknown",
  },
  {
    id: "salem-after-dark",
    title: "Salem After Dark",
    durationLabel: "30 mins",
    durationMinutes: 30,
    description: "Ghost stories and folklore.",
    discoveryThemes: ["ghosts_folklore"],
    defaultPersona: "ghost",
    city: "salem",
    pricing: { status: "free", displayLabel: "FREE", amountUsdCents: null },
    stopCount: 6,
    firstStopTitle: "Old Burying Point Cemetery",
    previewPlaceId: "ChIJB916r2UU44kRKAWug1nsKlI",
    requiresPurchase: false,
    accessState: "unknown",
  },
];

export function getPresetRouteSummariesByCity(city: PresetCity): PresetRouteSummary[] {
  return presetRouteSummaries.filter((route) => route.city === city);
}

export function getPresetRouteSummaryById(routeId: string | null | undefined): PresetRouteSummary | null {
  if (!routeId) return null;
  return presetRouteSummaries.find((route) => route.id === routeId) ?? null;
}

export function getPresetRouteSummaryNarratorLabel(
  route: Pick<PresetRouteSummary, "storyBy" | "defaultPersona"> | null | undefined
) {
  const override = typeof route?.storyBy === "string" ? route.storyBy.trim() : "";
  if (override) return override;
  return personaCatalog[(route?.defaultPersona ?? "adult") as Persona].displayName;
}

export function getPresetRouteSummaryStopCount(route: Pick<PresetRouteSummary, "city" | "stopCount">) {
  return route.city ? route.stopCount + 1 : route.stopCount;
}

export function getPresetRouteSummaryImage(route: PresetRouteSummary) {
  if (route.previewImageUrl) return route.previewImageUrl;
  if (route.previewPlaceId) {
    return `/api/google-image?kind=place-id-photo&placeId=${encodeURIComponent(route.previewPlaceId)}&maxWidthPx=1400`;
  }
  return getPresetCityMeta(route.city ?? "salem").fallbackImage;
}
