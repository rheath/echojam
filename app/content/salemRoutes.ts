// app/content/salemRoutes.ts
export type Persona = "adult" | "preteen";

export type Stop = {
  id: string;
  title: string;
  lat: number;
  lng: number;
  isOverview?: boolean;

  // Audio is preferred; text is a fallback (and helpful during dev).
  audio: Record<Persona, string>;
  text?: Record<Persona, string>;

  // 1–2 image paths under /public/images/...
  images: string[];
};

export type RouteDef = {
  id: string;
  title: string;
  durationLabel: string;
  description: string;
  stops: Stop[];
};

const SALEM_HARBOR_STOP_ID = "deep-salem-harbor";

function distanceMeters(a: Stop, b: Stop) {
  const avgLatRad = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const metersPerLat = 111_320;
  const metersPerLng = 111_320 * Math.cos(avgLatRad);
  const dLat = (a.lat - b.lat) * metersPerLat;
  const dLng = (a.lng - b.lng) * metersPerLng;
  return Math.hypot(dLat, dLng);
}

function deriveAnchoredStops(stops: Stop[], targetCount: number, anchorId: string): Stop[] {
  if (!stops.length || targetCount <= 0) return [];
  const clampedTarget = Math.min(targetCount, stops.length);
  const anchor = stops.find((s) => s.id === anchorId) ?? stops[0];
  const remaining = stops.filter((s) => s.id !== anchor.id);
  const ordered: Stop[] = [anchor];

  while (ordered.length < clampedTarget && remaining.length) {
    const current = ordered[ordered.length - 1];
    let bestIdx = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < remaining.length; i += 1) {
      const dist = distanceMeters(current, remaining[i]);
      if (dist < bestDistance) {
        bestDistance = dist;
        bestIdx = i;
      }
    }
    ordered.push(remaining.splice(bestIdx, 1)[0]);
  }

  return ordered;
}

const deepDiveCanonicalStops: Stop[] = [
  // To use external images for preset stops, replace placeholder paths with HTTPS URLs, e.g.:
  // images: ["https://example.com/stop-image.jpg"]
  {
    id: "deep-salem-harbor",
    title: "Salem Harbor",
    lat: 42.5212,
    lng: -70.8877,
    audio: { adult: "", preteen: "" },
    images: ["/images/salem/placeholder-01.png"],
  },
  {
    id: "deep-house-seven-gables",
    title: "House of the Seven Gables",
    lat: 42.521756, 
    lng: -70.883507,
    audio: { adult: "", preteen: "" },
    images: [
      "https://commons.wikimedia.org/wiki/Special:FilePath/House_of_the_Seven_Gables_MA1.jpg",
      "https://commons.wikimedia.org/wiki/Special:FilePath/House%20of%20Seven%20Gables%2C%20Salem%20MA%201.jpg",
      "/images/salem/placeholder-02.png",
    ],
  },
  {
    id: "deep-old-burying-point-cemetery",
    title: "Old Burying Point Cemetery",
    lat: 42.5206,
    lng: -70.8922,
    audio: { adult: "", preteen: "" },
    images: ["https://salemhauntedadventures.com/wp-content/uploads/2024/08/Old-Burying-Point-Cemetery-Salem-Massachusetts.png",
      "/images/salem/placeholder-02.png"],
  },
  {
    id: "deep-salem-witch-trials-memorial",
    title: "Salem Witch Trials Memorial",
    lat: 42.5232,
    lng: -70.8958,
    audio: { adult: "", preteen: "" },
    images: ["https://en.wikipedia.org/wiki/Special:FilePath/Salem_witch2.jpg",
      "/images/salem/placeholder-03.png"],
  },
  {
    id: "deep-joshua-ward-house",
    title: "Joshua Ward House",
    lat: 42.5203982, 
    lng: -70.8959536,
    audio: { adult: "", preteen: "" },
    images: ["https://en.wikipedia.org/wiki/Special:FilePath/Joshua_Ward_House_in_Salem_MA.jpg",
      "/images/salem/placeholder-01.png"],
  },
  {
    id: "deep-ropes-mansion-garden",
    title: "Ropes Mansion & Garden",
    lat: 42.5211,
    lng: -70.8972,
    audio: { adult: "", preteen: "" },
    images: ["https://en.wikipedia.org/wiki/Special:FilePath/Ropes_Mansion_-_Salem,_Massachusetts.JPG",
      "/images/salem/placeholder-03.png"],
  },
  {
    id: "deep-salem-witch-house",
    title: "Salem Witch House",
    lat: 42.5229,
    lng: -70.8985,
    audio: { adult: "", preteen: "" },
    images: ["https://en.wikipedia.org/wiki/Special:FilePath/Witch_House,_Salem.jpg",
      "/images/salem/placeholder-01.png"],
  },
];

const deepDiveStops = deriveAnchoredStops(deepDiveCanonicalStops, 7, SALEM_HARBOR_STOP_ID);
const strollStops = deriveAnchoredStops(deepDiveStops, 5, SALEM_HARBOR_STOP_ID);
const speedWalkerStops = deriveAnchoredStops(strollStops, 3, SALEM_HARBOR_STOP_ID);

export const salemRoutes: RouteDef[] = [
  {
    id: "salem-core-15",
    title: "Speed Walker",
    durationLabel: "15 min",
    description: "A tight loop of Salem’s essential landmarks—quick, iconic, easy.",
    stops: speedWalkerStops,
  },

  {
    id: "salem-story-30",
    title: "The Stroll",
    durationLabel: "30 min",
    description: "More context, more texture—how Salem became Salem.",
    stops: strollStops,
  },

  {
    id: "salem-deepdive-60",
    title: "Deep Dive",
    durationLabel: "60 min",
    description: "A fuller arc: landmarks + hidden context + the ‘why it matters’ layer.",
    stops: deepDiveStops,
  },
];

export function getRouteById(routeId: string | null | undefined): RouteDef | null {
  if (!routeId) return null;
  return salemRoutes.find((r) => r.id === routeId) ?? null;
}
