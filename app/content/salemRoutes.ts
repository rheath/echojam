// app/content/salemRoutes.ts
export type Persona = "adult" | "preteen";

export type Stop = {
  id: string;
  title: string;
  lat: number;
  lng: number;

  // Audio is preferred; text is a fallback (and helpful during dev).
  audio: Record<Persona, string>;
  text?: Record<Persona, string>;

  // 1–2 image paths under /public/images/...
  images: string[];
};

export type RouteDef = {
  id: "salem-core-15" | "salem-story-30" | "salem-deepdive-60";
  title: string;
  durationLabel: "15 min" | "30 min" | "60 min";
  description: string;
  stops: Stop[];
};

// NOTE: These are placeholders for now. Replace lat/lng + assets as you finalize stops.
export const salemRoutes: RouteDef[] = [
  {
    id: "salem-core-15",
    title: "The Core",
    durationLabel: "15 min",
    description: "A tight loop of Salem’s essential landmarks—quick, iconic, easy.",
    stops: [
      {
        id: "core-01",
        title: "Start: Salem Common",
        lat: 42.5196,
        lng: -70.8967,
        audio: {
          adult: "/audio/adult-01.mp3",
          preteen: "/audio/kid-01.mp3",
        },
        text: {
          adult: "Welcome to Salem Common—your launch point for the city’s most iconic storylines.",
          preteen: "Welcome! This is Salem Common—think of it like the city’s front yard.",
        },
        images: ["/images/salem/placeholder-01.jpg"],
      },
      {
        id: "core-02",
        title: "Witch Trials Memorial (placeholder)",
        lat: 42.5232,
        lng: -70.8958,
        audio: {
          adult: "/audio/adult-02.mp3",
          preteen: "/audio/kid-02.mp3",
        },
        text: {
          adult: "This stop focuses on memory, justice, and what Salem learned the hard way.",
          preteen: "This spot is about remembering—and making sure people are treated fairly.",
        },
        images: ["/images/salem/placeholder-02.jpg"],
      },
      {
        id: "core-03",
        title: "Old Town Hall (placeholder)",
        lat: 42.5216,
        lng: -70.8955,
        audio: {
          adult: "/audio/adult-01.mp3",
          preteen: "/audio/kid-01.mp3",
        },
        text: {
          adult: "Salem reinvented itself—again and again. This building watched a lot of it happen.",
          preteen: "This building has been here for a long time—like a time machine in brick form.",
        },
        images: ["/images/salem/placeholder-03.jpg"],
      },
    ],
  },

  {
    id: "salem-story-30",
    title: "The Story",
    durationLabel: "30 min",
    description: "More context, more texture—how Salem became Salem.",
    stops: [
      {
        id: "story-01",
        title: "Start: Salem Common",
        lat: 42.5196,
        lng: -70.8967,
        audio: { adult: "/audio/adult-01.mp3", preteen: "/audio/kid-01.mp3" },
        images: ["/images/salem/placeholder-01.jpg"],
      },
      {
        id: "story-02",
        title: "Essex Street (placeholder)",
        lat: 42.5219,
        lng: -70.8939,
        audio: { adult: "/audio/adult-02.mp3", preteen: "/audio/kid-02.mp3" },
        images: ["/images/salem/placeholder-02.jpg"],
      },
      {
        id: "story-03",
        title: "Salem Maritime (placeholder)",
        lat: 42.5212,
        lng: -70.8877,
        audio: { adult: "/audio/adult-01.mp3", preteen: "/audio/kid-01.mp3" },
        images: ["/images/salem/placeholder-03.jpg"],
      },
      {
        id: "story-04",
        title: "Return / Wrap (placeholder)",
        lat: 42.5205,
        lng: -70.8949,
        audio: { adult: "/audio/adult-02.mp3", preteen: "/audio/kid-02.mp3" },
        images: ["/images/salem/placeholder-01.jpg"],
      },
    ],
  },

  {
    id: "salem-deepdive-60",
    title: "The Deep Dive",
    durationLabel: "60 min",
    description: "A fuller arc: landmarks + hidden context + the ‘why it matters’ layer.",
    stops: [
      {
        id: "deep-01",
        title: "Start: Salem Common",
        lat: 42.5196,
        lng: -70.8967,
        audio: { adult: "/audio/adult-01.mp3", preteen: "/audio/kid-01.mp3" },
        images: ["/images/salem/placeholder-01.jpg"],
      },
      {
        id: "deep-02",
        title: "Architecture / Streetscape (placeholder)",
        lat: 42.5226,
        lng: -70.8946,
        audio: { adult: "/audio/adult-02.mp3", preteen: "/audio/kid-02.mp3" },
        images: ["/images/salem/placeholder-02.jpg"],
      },
      {
        id: "deep-03",
        title: "Maritime Layer (placeholder)",
        lat: 42.5212,
        lng: -70.8877,
        audio: { adult: "/audio/adult-01.mp3", preteen: "/audio/kid-01.mp3" },
        images: ["/images/salem/placeholder-03.jpg"],
      },
      {
        id: "deep-04",
        title: "Trials Layer (placeholder)",
        lat: 42.5232,
        lng: -70.8958,
        audio: { adult: "/audio/adult-02.mp3", preteen: "/audio/kid-02.mp3" },
        images: ["/images/salem/placeholder-01.jpg"],
      },
      {
        id: "deep-05",
        title: "Modern Salem (placeholder)",
        lat: 42.5199,
        lng: -70.8951,
        audio: { adult: "/audio/adult-01.mp3", preteen: "/audio/kid-01.mp3" },
        images: ["/images/salem/placeholder-02.jpg"],
      },
      {
        id: "deep-06",
        title: "Wrap (placeholder)",
        lat: 42.5205,
        lng: -70.8949,
        audio: { adult: "/audio/adult-02.mp3", preteen: "/audio/kid-02.mp3" },
        images: ["/images/salem/placeholder-03.jpg"],
      },
    ],
  },
];

export function getRouteById(routeId: string | null | undefined): RouteDef | null {
  if (!routeId) return null;
  return salemRoutes.find((r) => r.id === routeId) ?? null;
}

