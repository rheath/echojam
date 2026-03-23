import { cityPlaceholderImage } from "@/lib/placesImages";
import { toNullableTrimmed } from "@/lib/instagramImport";
import type { MixedSourceProvider, SocialSourceProvider } from "@/lib/mixGeneration";

export type ComposerStopKind = "social_import" | "place_search";
export type GooglePlaceDraftStatus = "generating_script" | "ready" | "failed";

export type ComposerStop = {
  id: string;
  kind: ComposerStopKind;
  provider: MixedSourceProvider;
  title: string;
  lat: number;
  lng: number;
  image: string;
  googlePlaceId?: string | null;
  sourceUrl?: string | null;
  sourceId?: string | null;
  creatorName?: string | null;
  creatorUrl?: string | null;
  creatorAvatarUrl?: string | null;
  script?: string | null;
  originalDraftId?: string | null;
  scriptEditedByUser?: boolean | null;
  generatedNarratorSignature?: string | null;
  generatedRouteSignature?: string | null;
};

export type GooglePlaceComposerCandidate = {
  id: string;
  title: string;
  lat: number;
  lng: number;
  image: string;
  googlePlaceId?: string | null;
};

export type GooglePlaceDraft = {
  place: GooglePlaceComposerCandidate;
  title: string;
  script: string | null;
  status: GooglePlaceDraftStatus;
  error: string | null;
  scriptEditedByUser: boolean;
  generatedNarratorSignature: string | null;
  generatedRouteSignature: string | null;
};

export type SocialDraftLike = {
  id: string;
  source: {
    url: string;
    shortcode?: string;
    videoId?: string | null;
    ownerTitle: string | null;
    thumbnailUrl: string | null;
  };
  content: {
    finalTitle: string | null;
    generatedTitle: string | null;
    finalScript: string | null;
    generatedScript: string | null;
  };
  location: {
    suggestedPlace?: {
      label: string;
      lat: number;
      lng: number;
      imageUrl: string | null;
      googlePlaceId?: string | null;
    } | null;
    confirmedPlace: {
      label: string;
      lat: number;
      lng: number;
      imageUrl: string | null;
      googlePlaceId?: string | null;
    } | null;
  };
};

function normalizeCreatorUrl(provider: SocialSourceProvider, creatorName: string | null | undefined) {
  const normalized = toNullableTrimmed(creatorName)?.replace(/^@+/, "");
  if (!normalized) return null;
  if (provider === "instagram") {
    return `https://www.instagram.com/${encodeURIComponent(normalized)}/`;
  }
  return `https://www.tiktok.com/@${encodeURIComponent(normalized)}`;
}

export function createComposerStopId(provider: MixedSourceProvider, sourceId: string) {
  return `${provider}:${sourceId}`;
}

export function resolveGooglePlaceDraftPersona(
  narratorGuidance: string | null | undefined
) {
  return toNullableTrimmed(narratorGuidance) ? "custom" : "adult";
}

export function createGooglePlaceNarratorSignature(
  narratorGuidance: string | null | undefined
) {
  const normalized = toNullableTrimmed(narratorGuidance)
    ?.replace(/\s+/g, " ")
    .toLowerCase();
  return normalized ? `custom:${normalized}` : "adult";
}

export function createGooglePlaceRouteSignature(
  stopIndex: number,
  totalStops: number
) {
  const normalizedIndex = Math.max(0, Math.trunc(stopIndex));
  const normalizedTotal = Math.max(1, Math.trunc(totalStops));
  return `${normalizedIndex}:${normalizedTotal}`;
}

export function mapSocialDraftToComposerStop(
  provider: SocialSourceProvider,
  draft: SocialDraftLike
): ComposerStop | null {
  const confirmedPlace = draft.location.confirmedPlace || draft.location.suggestedPlace;
  if (!confirmedPlace) return null;

  const title =
    toNullableTrimmed(draft.content.finalTitle) ||
    toNullableTrimmed(draft.content.generatedTitle) ||
    toNullableTrimmed(confirmedPlace.label);
  const script =
    toNullableTrimmed(draft.content.finalScript) ||
    toNullableTrimmed(draft.content.generatedScript);
  if (!title || !script) return null;

  const sourceId =
    provider === "instagram"
      ? toNullableTrimmed(draft.source.shortcode)
      : toNullableTrimmed(draft.source.videoId);

  return {
    id: createComposerStopId(provider, draft.id),
    kind: "social_import",
    provider,
    title,
    lat: confirmedPlace.lat,
    lng: confirmedPlace.lng,
    image:
      confirmedPlace.imageUrl ||
      draft.source.thumbnailUrl ||
      cityPlaceholderImage("nearby"),
    googlePlaceId: confirmedPlace.googlePlaceId || null,
    sourceUrl: draft.source.url,
    sourceId: sourceId || draft.id,
    creatorName: draft.source.ownerTitle,
    creatorUrl: normalizeCreatorUrl(provider, draft.source.ownerTitle),
    creatorAvatarUrl: null,
    script,
    originalDraftId: draft.id,
  };
}

export function mapGooglePlaceCandidateToComposerStop(
  candidate: GooglePlaceComposerCandidate
) {
  return {
    id: createComposerStopId("google_places", candidate.id),
    kind: "place_search" as const,
    provider: "google_places" as const,
    title: candidate.title,
    lat: candidate.lat,
    lng: candidate.lng,
    image: candidate.image,
    googlePlaceId: candidate.googlePlaceId || null,
    sourceId: candidate.id,
  } satisfies ComposerStop;
}

export function createGooglePlaceDraft(
  candidate: GooglePlaceComposerCandidate,
  narratorSignature: string,
  routeSignature: string
): GooglePlaceDraft {
  return {
    place: {
      ...candidate,
      googlePlaceId: candidate.googlePlaceId || null,
    },
    title: candidate.title,
    script: null,
    status: "generating_script",
    error: null,
    scriptEditedByUser: false,
    generatedNarratorSignature: narratorSignature,
    generatedRouteSignature: routeSignature,
  };
}

export function mapGooglePlaceDraftToComposerStop(
  draft: GooglePlaceDraft
) {
  return {
    ...mapGooglePlaceCandidateToComposerStop(draft.place),
    title: toNullableTrimmed(draft.title) || draft.place.title,
    script: toNullableTrimmed(draft.script),
    scriptEditedByUser: draft.scriptEditedByUser,
    generatedNarratorSignature: draft.generatedNarratorSignature,
    generatedRouteSignature: draft.generatedRouteSignature,
  } satisfies ComposerStop;
}

export function mapComposerStopToGooglePlaceDraft(
  stop: ComposerStop
) {
  if (stop.provider !== "google_places") return null;
  return {
    place: {
      id: stop.sourceId || stop.id.replace(/^google_places:/, ""),
      title: stop.title,
      lat: stop.lat,
      lng: stop.lng,
      image: stop.image,
      googlePlaceId: stop.googlePlaceId || null,
    },
    title: stop.title,
    script: toNullableTrimmed(stop.script),
    status: "ready" as const,
    error: null,
    scriptEditedByUser: Boolean(stop.scriptEditedByUser),
    generatedNarratorSignature: toNullableTrimmed(stop.generatedNarratorSignature),
    generatedRouteSignature: toNullableTrimmed(stop.generatedRouteSignature),
  } satisfies GooglePlaceDraft;
}

export function mapGooglePlaceDraftOntoComposerStop(
  stop: ComposerStop,
  draft: GooglePlaceDraft
) {
  if (stop.provider !== "google_places") return null;
  const updated = mapGooglePlaceDraftToComposerStop(draft);
  return {
    ...updated,
    id: stop.id,
    sourceId: stop.sourceId || updated.sourceId,
  } satisfies ComposerStop;
}

export function isGooglePlaceStopScriptStale(
  stop: ComposerStop,
  narratorSignature: string,
  routeSignature: string
) {
  if (stop.provider !== "google_places") return false;
  if (stop.scriptEditedByUser) return false;
  if (!toNullableTrimmed(stop.script)) return true;

  return (
    toNullableTrimmed(stop.generatedNarratorSignature) !== narratorSignature ||
    toNullableTrimmed(stop.generatedRouteSignature) !== routeSignature
  );
}

export function deriveComposerRouteAttribution(stops: ComposerStop[]) {
  const socialStops = stops.filter(
    (stop): stop is ComposerStop & { provider: SocialSourceProvider } =>
      stop.provider === "instagram" || stop.provider === "tiktok"
  );
  if (socialStops.length === 0) {
    return {
      storyBy: null,
      storyByUrl: null,
      storyByAvatarUrl: null,
      storyBySource: null,
    };
  }

  const uniqueCreators = new Map<string, ComposerStop>();
  const uniqueProviders = new Set<SocialSourceProvider>();
  for (const stop of socialStops) {
    uniqueProviders.add(stop.provider);
    const label = toNullableTrimmed(stop.creatorName);
    if (!label) continue;
    const key = `${stop.provider}:${label.toLowerCase()}`;
    if (!uniqueCreators.has(key)) uniqueCreators.set(key, stop);
  }

  if (uniqueCreators.size === 1) {
    const [creator] = Array.from(uniqueCreators.values());
    return {
      storyBy: creator.creatorName || null,
      storyByUrl: creator.creatorUrl || null,
      storyByAvatarUrl: creator.creatorAvatarUrl || null,
      storyBySource: creator.provider,
    };
  }

  const storyBy = Array.from(uniqueCreators.values())
    .map((creator) => toNullableTrimmed(creator.creatorName))
    .filter((creatorName): creatorName is string => Boolean(creatorName))
    .join(", ");

  return {
    storyBy: storyBy || null,
    storyByUrl: null,
    storyByAvatarUrl: null,
    storyBySource: uniqueProviders.size > 1 || uniqueCreators.size > 1 ? "social" : socialStops[0]?.provider || null,
  };
}

export function moveComposerStop(items: ComposerStop[], from: number, to: number) {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (!moved) return items;
  next.splice(to, 0, moved);
  return next;
}
