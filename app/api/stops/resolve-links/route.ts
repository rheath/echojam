import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { buildGooglePlacePhotoUrl } from "@/lib/placesImages";

type Body = {
  city?: string;
  links?: string[];
};

type ResolvedStop = {
  input: string;
  id: string;
  title: string;
  lat: number;
  lng: number;
  image: string;
};

type FailedStop = {
  input: string;
  reason: string;
};

const MAX_LINKS = 30;
const PLACEHOLDER_BY_CITY: Record<string, string> = {
  salem: "/images/salem/placeholder.png",
  boston: "/images/salem/placeholder.png",
  concord: "/images/salem/placeholder.png",
  nyc: "/images/salem/placeholder.png",
};
const PLACEHOLDER_ROTATION = [
  "/images/salem/placeholder.png",
];
const GOOGLE_PLACES_NEW_SEARCH_ENDPOINT = "https://places.googleapis.com/v1/places:searchText";

function isAllowedGoogleMapsHost(hostname: string) {
  const h = hostname.toLowerCase();
  return (
    h === "maps.app.goo.gl" ||
    h === "maps.google.com" ||
    h === "google.com" ||
    h.endsWith(".google.com")
  );
}

function parseLatLng(text: string): { lat: number; lng: number } | null {
  const atMatch = text.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (atMatch) return { lat: Number(atMatch[1]), lng: Number(atMatch[2]) };

  const dMatch = text.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (dMatch) return { lat: Number(dMatch[1]), lng: Number(dMatch[2]) };

  const llMatch = text.match(/[?&]ll=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (llMatch) return { lat: Number(llMatch[1]), lng: Number(llMatch[2]) };

  const qMatch = text.match(/[?&]q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (qMatch) return { lat: Number(qMatch[1]), lng: Number(qMatch[2]) };

  return null;
}

function validLatLng(lat: number, lng: number) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function cleanSegment(seg: string) {
  return decodeURIComponent(seg).replace(/\+/g, " ").trim();
}

function isGenericMapsLabel(value: string) {
  const v = value.trim().toLowerCase();
  return v === "google maps" || v === "maps" || v === "google";
}

function isSerializedMapsPayload(value: string) {
  const v = value.trim().toLowerCase();
  if (!v) return false;
  return (
    v.startsWith("data=") ||
    v.includes("!1m") ||
    v.includes("!2m") ||
    v.includes("!3m") ||
    v.includes("!4m") ||
    (v.includes("0x") && v.includes("!"))
  );
}

function maybePlaceLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = cleanSegment(raw);
  if (!cleaned || isGenericMapsLabel(cleaned)) return null;
  if (isSerializedMapsPayload(cleaned)) return null;
  if (cleaned.length > 120) return null;
  if (parseLatLng(cleaned)) return null;
  return cleaned;
}

function deriveTitle(finalUrl: URL) {
  const queryCandidates = [
    finalUrl.searchParams.get("q"),
    finalUrl.searchParams.get("query"),
    finalUrl.searchParams.get("destination"),
    finalUrl.searchParams.get("daddr"),
  ];
  for (const candidate of queryCandidates) {
    const label = maybePlaceLabel(candidate);
    if (label) return label;
  }

  const pathSegs = finalUrl.pathname.split("/").map(cleanSegment).filter(Boolean);
  const placeIdx = pathSegs.findIndex((s) => s.toLowerCase() === "place");
  if (placeIdx >= 0 && pathSegs[placeIdx + 1]) {
    const label = maybePlaceLabel(pathSegs[placeIdx + 1]);
    if (label) return label;
  }
  const last = pathSegs[pathSegs.length - 1];
  const lastLabel = maybePlaceLabel(last);
  if (lastLabel) return lastLabel;
  return "Pinned stop";
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripGoogleMapsSuffix(text: string) {
  return text.replace(/\s*-\s*Google\s*Maps\s*$/i, "").trim();
}

function extractMetaContent(html: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const propertyPattern = new RegExp(
    `<meta[^>]+property=["']${escaped}["'][^>]*content=["']([^"']+)["'][^>]*>`,
    "i"
  );
  const namePattern = new RegExp(
    `<meta[^>]+name=["']${escaped}["'][^>]*content=["']([^"']+)["'][^>]*>`,
    "i"
  );
  const propertyMatch = html.match(propertyPattern);
  if (propertyMatch?.[1]) return decodeHtmlEntities(propertyMatch[1]).trim();
  const nameMatch = html.match(namePattern);
  if (nameMatch?.[1]) return decodeHtmlEntities(nameMatch[1]).trim();
  return null;
}

function normalizeImageUrl(urlText: string, finalUrl: URL): string | null {
  const value = urlText.trim();
  if (!value) return null;
  try {
    if (value.startsWith("//")) return `https:${value}`;
    const resolved = new URL(value, finalUrl).toString();
    if (!resolved.startsWith("http://") && !resolved.startsWith("https://")) return null;
    return resolved;
  } catch {
    return null;
  }
}

function extractPreviewImage(html: string, finalUrl: URL): string | null {
  const ogImage = extractMetaContent(html, "og:image");
  if (ogImage) {
    const normalized = normalizeImageUrl(ogImage, finalUrl);
    if (normalized) return normalized;
  }
  const twitterImage = extractMetaContent(html, "twitter:image");
  if (twitterImage) {
    const normalized = normalizeImageUrl(twitterImage, finalUrl);
    if (normalized) return normalized;
  }

  // Fallback: Google often embeds image links in JSON blobs.
  const rawMatch = html.match(/https:\/\/lh\d+\.googleusercontent\.com\/[^\s"'<\\]+/i);
  if (rawMatch?.[0]) {
    const normalized = normalizeImageUrl(rawMatch[0], finalUrl);
    if (normalized) return normalized;
  }
  return null;
}

function fallbackPlaceholderFor(city: string, index: number) {
  const cityDefault = PLACEHOLDER_BY_CITY[city] || PLACEHOLDER_BY_CITY.salem;
  if (!cityDefault) return PLACEHOLDER_ROTATION[0];
  if (index < 0) return cityDefault;
  return PLACEHOLDER_ROTATION[index % PLACEHOLDER_ROTATION.length] || cityDefault;
}

type GooglePlacesNewSearchResponse = {
  places?: Array<{ photos?: Array<{ name?: string }> }>;
  error?: {
    message?: string;
  };
};

async function fetchGooglePlacePhotoByText(
  title: string,
  lat: number,
  lng: number,
  apiKey: string
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const res = await fetch(GOOGLE_PLACES_NEW_SEARCH_ENDPOINT, {
      method: "POST",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        // Request only fields needed for photo URL construction.
        "X-Goog-FieldMask": "places.photos.name",
      },
      body: JSON.stringify({
        textQuery: title,
        maxResultCount: 5,
        locationBias: {
          circle: {
            center: {
              latitude: lat,
              longitude: lng,
            },
            radius: 2500,
          },
        },
      }),
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as GooglePlacesNewSearchResponse;
    if (payload.error?.message) return null;
    if (!Array.isArray(payload.places) || payload.places.length === 0) return null;
    for (const place of payload.places) {
      const ref = place.photos?.[0]?.name?.trim();
      if (ref) return buildGooglePlacePhotoUrl(ref);
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGoogleMapsPreviewByQuery(title: string, lat: number, lng: number): Promise<string | null> {
  const searchUrl = new URL("https://www.google.com/maps/search/");
  searchUrl.searchParams.set("api", "1");
  searchUrl.searchParams.set("query", `${title} ${lat},${lng}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const res = await fetch(searchUrl.toString(), {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const finalUrl = new URL(res.url || searchUrl.toString());
    const html = await res.text();
    return extractPreviewImage(html, finalUrl);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractBetterTitle(html: string, finalUrl: URL): string {
  const ogTitle = extractMetaContent(html, "og:title");
  if (ogTitle) {
    const cleaned = stripGoogleMapsSuffix(ogTitle);
    if (!isGenericMapsLabel(cleaned)) return cleaned;
  }
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch?.[1]) {
    const cleaned = stripGoogleMapsSuffix(decodeHtmlEntities(titleMatch[1]).trim());
    if (!isGenericMapsLabel(cleaned)) return cleaned;
  }
  return deriveTitle(finalUrl);
}

function stableStopId(lat: number, lng: number, title: string) {
  const payload = `${lat.toFixed(6)}|${lng.toFixed(6)}|${title.toLowerCase()}`;
  return `ext-${createHash("sha1").update(payload).digest("hex").slice(0, 12)}`;
}

function extractRouteLabels(finalUrl: URL): string[] {
  const path = finalUrl.pathname;
  const dirIdx = path.toLowerCase().indexOf("/dir/");
  if (dirIdx < 0) return [];
  const tail = path.slice(dirIdx + "/dir/".length);
  const segs = tail.split("/").map(cleanSegment).filter(Boolean);
  const labels: string[] = [];
  for (const seg of segs) {
    const lower = seg.toLowerCase();
    if (lower.startsWith("@") || lower.startsWith("data=")) break;
    const label = maybePlaceLabel(seg);
    if (!label) continue;
    labels.push(label);
  }
  return labels;
}

function extractRouteCoords(text: string): Array<{ lat: number; lng: number }> {
  const coords: Array<{ lat: number; lng: number }> = [];

  // Common in Maps direction payload: !1d{lng}!2d{lat}
  const lngLatPattern = /!1d(-?\d+(?:\.\d+)?)!2d(-?\d+(?:\.\d+)?)/g;
  for (const match of text.matchAll(lngLatPattern)) {
    const lng = Number(match[1]);
    const lat = Number(match[2]);
    if (!validLatLng(lat, lng)) continue;
    coords.push({ lat, lng });
  }

  // Common in place payload: !2d{lat}!3d{lng}
  const latLngPattern = /!2d(-?\d+(?:\.\d+)?)!3d(-?\d+(?:\.\d+)?)/g;
  for (const match of text.matchAll(latLngPattern)) {
    const lat = Number(match[1]);
    const lng = Number(match[2]);
    if (!validLatLng(lat, lng)) continue;
    coords.push({ lat, lng });
  }

  const deduped: Array<{ lat: number; lng: number }> = [];
  const seen = new Set<string>();
  for (const coord of coords) {
    const key = `${coord.lat.toFixed(6)},${coord.lng.toFixed(6)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(coord);
  }
  return deduped;
}

async function resolveSingleLink(input: string, city: string): Promise<{ resolved: ResolvedStop[] } | FailedStop> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { input, reason: "Invalid URL" };
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    return { input, reason: "Unsupported URL protocol" };
  }

  if (!isAllowedGoogleMapsHost(url.hostname)) {
    return { input, reason: "Only Google Maps links are supported" };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { Accept: "text/html,application/xhtml+xml" },
      cache: "no-store",
    });
    const finalUrl = new URL(res.url || url.toString());
    let html = "";
    try {
      html = await res.text();
    } catch {
      html = "";
    }
    const previewImage = html ? extractPreviewImage(html, finalUrl) : null;
    const googlePlacesApiKey = process.env.GOOGLE_PLACES_API_KEY?.trim() || "";

    const routeLabels = extractRouteLabels(finalUrl);
    const routeCoords = extractRouteCoords(finalUrl.toString());
    if (routeCoords.length > 1) {
      const resolved = await Promise.all(routeCoords.map(async (coord, index) => {
        const title = routeLabels[index] || `Route stop ${index + 1}`;
        const placeImage = googlePlacesApiKey
          ? await fetchGooglePlacePhotoByText(title, coord.lat, coord.lng, googlePlacesApiKey)
          : null;
        const mapsPreviewImage = placeImage ? null : await fetchGoogleMapsPreviewByQuery(title, coord.lat, coord.lng);
        return {
          input,
          id: stableStopId(coord.lat, coord.lng, title),
          title,
          lat: coord.lat,
          lng: coord.lng,
          image: placeImage || mapsPreviewImage || previewImage || fallbackPlaceholderFor(city, index),
        };
      }));
      return { resolved };
    }

    const coords = parseLatLng(finalUrl.toString()) || parseLatLng(decodeURIComponent(finalUrl.toString()));
    if (!coords || !validLatLng(coords.lat, coords.lng)) {
      return { input, reason: "Could not extract coordinates from link" };
    }
    const title = html ? extractBetterTitle(html, finalUrl) : deriveTitle(finalUrl);

    return {
      resolved: [
        {
          input,
          id: stableStopId(coords.lat, coords.lng, title),
          title,
          lat: coords.lat,
          lng: coords.lng,
          image:
            previewImage ||
            (googlePlacesApiKey
              ? (await fetchGooglePlacePhotoByText(title, coords.lat, coords.lng, googlePlacesApiKey))
              : null) ||
            (await fetchGoogleMapsPreviewByQuery(title, coords.lat, coords.lng)) ||
            fallbackPlaceholderFor(city, 0),
        },
      ],
    };
  } catch {
    return { input, reason: "Failed to resolve redirect" };
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const linksRaw = Array.isArray(body.links) ? body.links : [];
    const links = linksRaw
      .map((l) => (typeof l === "string" ? l.trim() : ""))
      .filter(Boolean)
      .slice(0, MAX_LINKS);

    if (!links.length) {
      return NextResponse.json({ error: "No links provided" }, { status: 400 });
    }

    const city = typeof body.city === "string" && body.city ? body.city : "salem";
    const resolved: ResolvedStop[] = [];
    const failed: FailedStop[] = [];
    const seenIds = new Set<string>();
    let duplicatesSkipped = 0;

    for (const link of links) {
      const result = await resolveSingleLink(link, city);
      if ("reason" in result) {
        failed.push(result);
        continue;
      }
      for (const stop of result.resolved) {
        if (seenIds.has(stop.id)) {
          duplicatesSkipped += 1;
          continue;
        }
        seenIds.add(stop.id);
        resolved.push(stop);
      }
    }

    return NextResponse.json({ resolved, failed, duplicatesSkipped });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to resolve links" },
      { status: 500 }
    );
  }
}
