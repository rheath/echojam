export const DISCOVERY_THEMES = [
  "history",
  "architecture",
  "animals",
  "comics",
  "weird_history",
  "ghosts_folklore",
] as const;

export type DiscoveryTheme = (typeof DISCOVERY_THEMES)[number];

type ThemeMatchCandidate = {
  title?: string | null;
  primaryType?: string | null;
  types?: string[] | null;
};

type RouteThemeInput = {
  discoveryThemes?: DiscoveryTheme[] | null;
  title?: string | null;
  description?: string | null;
  narratorGuidance?: string | null;
  contentPriority?: string | null;
  voice?: {
    archetypeId?: string | null;
    displayName?: string | null;
    storyLens?: string | null;
  } | null;
};

type ThemeConfig = {
  primaryTypes: string[];
  keywords: string[];
};

const DISCOVERY_THEME_SET = new Set<DiscoveryTheme>(DISCOVERY_THEMES);

const THEME_CONFIG: Record<DiscoveryTheme, ThemeConfig> = {
  history: {
    primaryTypes: [
      "tourist_attraction",
      "museum",
      "historical_landmark",
      "monument",
      "church",
      "library",
      "visitor_center",
    ],
    keywords: [
      "history",
      "historic",
      "historical",
      "revolution",
      "monument",
      "memorial",
      "museum",
      "heritage",
      "founding",
      "tavern",
      "meeting house",
    ],
  },
  architecture: {
    primaryTypes: [
      "tourist_attraction",
      "historical_landmark",
      "monument",
      "museum",
      "art_gallery",
      "plaza",
      "library",
    ],
    keywords: [
      "architecture",
      "architectural",
      "building",
      "skyscraper",
      "tower",
      "art deco",
      "design",
      "plaza",
      "terminal",
      "cathedral",
      "bridge",
    ],
  },
  animals: {
    primaryTypes: [
      "zoo",
      "aquarium",
      "park",
      "garden",
      "tourist_attraction",
      "museum",
    ],
    keywords: [
      "animal",
      "animals",
      "wildlife",
      "zoo",
      "aquarium",
      "bird",
      "birds",
      "duck",
      "turtle",
      "pond",
      "garden",
      "nature",
      "habitat",
    ],
  },
  comics: {
    primaryTypes: [
      "tourist_attraction",
      "museum",
      "art_gallery",
      "historical_landmark",
      "monument",
      "book_store",
    ],
    keywords: [
      "comic",
      "comics",
      "superhero",
      "superheroes",
      "marvel",
      "dc",
      "hero",
      "heroes",
      "mural",
      "art",
      "creator",
      "stan lee",
    ],
  },
  weird_history: {
    primaryTypes: [
      "tourist_attraction",
      "museum",
      "historical_landmark",
      "monument",
      "library",
      "park",
    ],
    keywords: [
      "weird",
      "strange",
      "odd",
      "secret",
      "hidden",
      "tiny",
      "narrow",
      "triangle",
      "whisper",
      "unusual",
      "curious",
    ],
  },
  ghosts_folklore: {
    primaryTypes: [
      "cemetery",
      "historical_landmark",
      "museum",
      "church",
      "monument",
      "tourist_attraction",
    ],
    keywords: [
      "ghost",
      "ghosts",
      "haunted",
      "witch",
      "witches",
      "folklore",
      "cemetery",
      "grave",
      "burying",
      "memorial",
      "dark",
      "spirit",
    ],
  },
};

function normalizeText(value: string | null | undefined) {
  return (value || "").trim().toLowerCase();
}

export function normalizeDiscoveryThemes(
  values: readonly string[] | null | undefined
): DiscoveryTheme[] {
  const normalized = (values ?? [])
    .map((value) => normalizeText(value))
    .filter((value): value is DiscoveryTheme => DISCOVERY_THEME_SET.has(value as DiscoveryTheme));
  return Array.from(new Set(normalized));
}

function scoreThemeKeywords(text: string, theme: DiscoveryTheme) {
  const config = THEME_CONFIG[theme];
  let score = 0;
  for (const keyword of config.keywords) {
    if (text.includes(keyword)) score += keyword.includes(" ") ? 3 : 2;
  }
  return score;
}

export function inferDiscoveryThemes(input: RouteThemeInput | null | undefined): DiscoveryTheme[] {
  const explicit = normalizeDiscoveryThemes(input?.discoveryThemes);
  if (explicit.length > 0) return explicit;

  const searchable = [
    input?.title,
    input?.description,
    input?.narratorGuidance,
    input?.voice?.storyLens,
    input?.voice?.displayName,
    input?.voice?.archetypeId,
  ]
    .map((value) => normalizeText(value))
    .filter(Boolean)
    .join(" ");

  if (!searchable) return [];

  const scored = DISCOVERY_THEMES.map((theme) => ({
    theme,
    score: scoreThemeKeywords(searchable, theme),
  })).filter((entry) => entry.score > 0);

  if (scored.length === 0) {
    if (normalizeText(input?.contentPriority) === "history_first") {
      return ["history"];
    }
    return [];
  }

  scored.sort((a, b) => b.score - a.score);
  const topScore = scored[0]?.score ?? 0;
  return scored.filter((entry) => entry.score === topScore || entry.score >= Math.max(3, topScore - 1)).map((entry) => entry.theme);
}

export function discoveryPrimaryTypesForThemes(themes: readonly DiscoveryTheme[] | null | undefined) {
  const normalized = normalizeDiscoveryThemes(themes);
  if (normalized.length === 0) return null;
  return Array.from(
    new Set(normalized.flatMap((theme) => THEME_CONFIG[theme].primaryTypes))
  );
}

export function scoreDiscoveryThemeMatch(
  candidate: ThemeMatchCandidate,
  themes: readonly DiscoveryTheme[] | null | undefined
) {
  const normalizedThemes = normalizeDiscoveryThemes(themes);
  if (normalizedThemes.length === 0) return 0;

  const normalizedTitle = normalizeText(candidate.title);
  const normalizedPrimaryType = normalizeText(candidate.primaryType);
  const normalizedTypes = new Set(
    (candidate.types ?? []).map((value) => normalizeText(value)).filter(Boolean)
  );

  let bestScore = 0;
  for (const theme of normalizedThemes) {
    const config = THEME_CONFIG[theme];
    let score = scoreThemeKeywords(normalizedTitle, theme);
    if (config.primaryTypes.includes(normalizedPrimaryType)) score += 6;
    for (const type of normalizedTypes) {
      if (config.primaryTypes.includes(type)) score += 4;
    }
    bestScore = Math.max(bestScore, score);
  }

  return bestScore;
}
