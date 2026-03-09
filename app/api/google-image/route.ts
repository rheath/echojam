import { NextResponse } from "next/server";

const GOOGLE_PLACE_PHOTO_ENDPOINT = "https://places.googleapis.com/v1";
const GOOGLE_STREETVIEW_ENDPOINT = "https://maps.googleapis.com/maps/api/streetview";
const DEFAULT_PLACEHOLDER_IMAGE = "/images/salem/placeholder.png";
const DEFAULT_STREETVIEW_SIZE = "1200x675";
const CACHE_SECONDS = 60 * 60 * 24;
const GOOGLE_PLACE_DETAILS_ENDPOINT = "https://places.googleapis.com/v1/places";

type PlaceDetailsResponse = {
  photos?: Array<{ name?: string }>;
};

function redirectToPlaceholder(request: Request) {
  return NextResponse.redirect(new URL(DEFAULT_PLACEHOLDER_IMAGE, request.url), 307);
}

function parsePositiveInt(value: string | null, fallback: number) {
  const parsed = Number.parseInt((value || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function buildPlacePhotoUrl(name: string, maxWidthPx: number, apiKey: string) {
  const params = new URLSearchParams({
    key: apiKey,
    maxWidthPx: String(maxWidthPx),
  });
  return `${GOOGLE_PLACE_PHOTO_ENDPOINT}/${name}/media?${params.toString()}`;
}

async function resolvePhotoNameFromPlaceId(placeId: string, apiKey: string) {
  const res = await fetch(`${GOOGLE_PLACE_DETAILS_ENDPOINT}/${encodeURIComponent(placeId)}`, {
    method: "GET",
    cache: "no-store",
    headers: {
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "photos.name",
    },
  });
  if (!res.ok) return "";

  const body = (await res.json()) as PlaceDetailsResponse;
  return (body.photos?.[0]?.name || "").trim();
}

function buildStreetViewUrl(location: string, size: string, apiKey: string) {
  const params = new URLSearchParams({
    key: apiKey,
    location,
    size: size || DEFAULT_STREETVIEW_SIZE,
    return_error_code: "true",
  });
  return `${GOOGLE_STREETVIEW_ENDPOINT}?${params.toString()}`;
}

function copyCachingHeaders(source: Headers, target: Headers) {
  const contentType = source.get("content-type");
  if (contentType) target.set("Content-Type", contentType);

  const contentLength = source.get("content-length");
  if (contentLength) target.set("Content-Length", contentLength);

  const etag = source.get("etag");
  if (etag) target.set("ETag", etag);

  const lastModified = source.get("last-modified");
  if (lastModified) target.set("Last-Modified", lastModified);

  target.set(
    "Cache-Control",
    source.get("cache-control") || `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=86400`
  );
}

export async function GET(request: Request) {
  const apiKey = (process.env.GOOGLE_PLACES_API_KEY || "").trim();
  if (!apiKey) return redirectToPlaceholder(request);

  const { searchParams } = new URL(request.url);
  const kind = (searchParams.get("kind") || "").trim().toLowerCase();

  let upstreamUrl = "";
  if (kind === "place-photo") {
    const name = (searchParams.get("name") || "").trim();
    if (!name) return redirectToPlaceholder(request);
    const maxWidthPx = parsePositiveInt(searchParams.get("maxWidthPx"), 1400);
    upstreamUrl = buildPlacePhotoUrl(name, maxWidthPx, apiKey);
  } else if (kind === "place-id-photo") {
    const placeId = (searchParams.get("placeId") || "").trim();
    if (!placeId) return redirectToPlaceholder(request);
    const photoName = await resolvePhotoNameFromPlaceId(placeId, apiKey);
    if (!photoName) return redirectToPlaceholder(request);
    const maxWidthPx = parsePositiveInt(searchParams.get("maxWidthPx"), 1400);
    upstreamUrl = buildPlacePhotoUrl(photoName, maxWidthPx, apiKey);
  } else if (kind === "streetview") {
    const location = (searchParams.get("location") || "").trim();
    if (!location) return redirectToPlaceholder(request);
    const size = (searchParams.get("size") || "").trim() || DEFAULT_STREETVIEW_SIZE;
    upstreamUrl = buildStreetViewUrl(location, size, apiKey);
  } else {
    return redirectToPlaceholder(request);
  }

  try {
    const upstream = await fetch(upstreamUrl, {
      redirect: "follow",
      headers: {
        Accept: "image/*",
      },
    });

    if (!upstream.ok) return redirectToPlaceholder(request);

    const contentType = upstream.headers.get("content-type") || "";
    if (!contentType.toLowerCase().startsWith("image/")) {
      return redirectToPlaceholder(request);
    }

    const headers = new Headers();
    copyCachingHeaders(upstream.headers, headers);
    return new Response(upstream.body, { status: 200, headers });
  } catch {
    return redirectToPlaceholder(request);
  }
}
