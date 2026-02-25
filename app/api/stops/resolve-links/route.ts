import { createHash } from "node:crypto";
import { NextResponse } from "next/server";

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
  salem: "/images/salem/placeholder-01.png",
  boston: "/images/salem/placeholder-01.png",
  concord: "/images/salem/placeholder-01.png",
};

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

function maybePlaceLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = cleanSegment(raw);
  if (!cleaned || isGenericMapsLabel(cleaned)) return null;
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

async function resolveSingleLink(input: string, city: string): Promise<ResolvedStop | FailedStop> {
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
    const coords = parseLatLng(finalUrl.toString()) || parseLatLng(decodeURIComponent(finalUrl.toString()));
    if (!coords || !validLatLng(coords.lat, coords.lng)) {
      return { input, reason: "Could not extract coordinates from link" };
    }
    let html = "";
    try {
      html = await res.text();
    } catch {
      html = "";
    }
    const title = html ? extractBetterTitle(html, finalUrl) : deriveTitle(finalUrl);
    const previewImage = html ? extractPreviewImage(html, finalUrl) : null;

    return {
      input,
      id: stableStopId(coords.lat, coords.lng, title),
      title,
      lat: coords.lat,
      lng: coords.lng,
      image: previewImage || PLACEHOLDER_BY_CITY[city] || PLACEHOLDER_BY_CITY.salem,
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
      if (seenIds.has(result.id)) {
        duplicatesSkipped += 1;
        continue;
      }
      seenIds.add(result.id);
      resolved.push(result);
    }

    return NextResponse.json({ resolved, failed, duplicatesSkipped });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to resolve links" },
      { status: 500 }
    );
  }
}
