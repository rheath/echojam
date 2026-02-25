const PLACEHOLDER_BY_CITY: Record<string, string> = {
  salem: "/images/salem/placeholder-01.png",
  boston: "/images/salem/placeholder-01.png",
  concord: "/images/salem/placeholder-01.png",
};

export function cityPlaceholderImage(city: string | null | undefined) {
  const key = (city || "").toLowerCase();
  return PLACEHOLDER_BY_CITY[key] || PLACEHOLDER_BY_CITY.salem;
}

type ResolveInput = {
  title: string;
  lat: number;
  lng: number;
  city: string;
};

export type PlaceImageResult = {
  imageUrl: string;
  placeId: string;
};

type GoogleTextSearchResponse = {
  status?: string;
  error_message?: string;
  results?: Array<{
    place_id?: string;
    photos?: Array<{
      photo_reference?: string;
    }>;
  }>;
};

type GooglePlaceDetailsResponse = {
  status?: string;
  error_message?: string;
  result?: {
    photos?: Array<{
      photo_reference?: string;
    }>;
  };
};

function isRetryableStatus(code: number) {
  return code === 429 || (code >= 500 && code < 600);
}

async function fetchJsonWithRetry<T>(url: string, retries = 2): Promise<T> {
  let attempt = 0;
  let lastError: Error | null = null;

  while (attempt <= retries) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        if (isRetryableStatus(res.status) && attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
          attempt += 1;
          continue;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      return (await res.json()) as T;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error("Unknown Places request error");
      if (attempt >= retries) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      attempt += 1;
    }
  }

  throw lastError || new Error("Places request failed");
}

function buildPhotoUrl(photoReference: string, apiKey: string) {
  const params = new URLSearchParams({
    maxwidth: "1200",
    photoreference: photoReference,
    key: apiKey,
  });
  return `https://maps.googleapis.com/maps/api/place/photo?${params.toString()}`;
}

async function fetchPhotoReferenceByPlaceId(placeId: string, apiKey: string): Promise<string | null> {
  const params = new URLSearchParams({
    place_id: placeId,
    fields: "photos",
    key: apiKey,
  });
  const url = `https://maps.googleapis.com/maps/api/place/details/json?${params.toString()}`;
  const data = await fetchJsonWithRetry<GooglePlaceDetailsResponse>(url);
  if (data.status && data.status !== "OK") return null;
  return data.result?.photos?.[0]?.photo_reference || null;
}

export async function resolvePlaceImage(input: ResolveInput): Promise<PlaceImageResult | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_MAPS_API_KEY is required.");

  const query = `${input.title}, ${input.city}`;
  const params = new URLSearchParams({
    query,
    location: `${input.lat},${input.lng}`,
    radius: "750",
    key: apiKey,
  });
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?${params.toString()}`;
  const data = await fetchJsonWithRetry<GoogleTextSearchResponse>(url);

  if (data.status && !["OK", "ZERO_RESULTS"].includes(data.status)) {
    throw new Error(data.error_message || `Places text search failed: ${data.status}`);
  }

  const first = data.results?.[0];
  const placeId = first?.place_id;
  if (!placeId) return null;

  let photoReference = first?.photos?.[0]?.photo_reference || null;
  if (!photoReference) {
    photoReference = await fetchPhotoReferenceByPlaceId(placeId, apiKey);
  }
  if (!photoReference) return null;

  return {
    imageUrl: buildPhotoUrl(photoReference, apiKey),
    placeId,
  };
}
