import { NextResponse } from "next/server";

const CACHE_SECONDS = 60 * 60 * 24;

function isAllowedInstagramImageUrl(rawUrl: string) {
  try {
    const parsed = new URL(rawUrl);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname.toLowerCase().endsWith("cdninstagram.com")
    );
  } catch {
    return false;
  }
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
    source.get("cache-control") ||
      `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=86400`
  );
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const rawUrl = (searchParams.get("url") || "").trim();
  if (!rawUrl || !isAllowedInstagramImageUrl(rawUrl)) {
    return NextResponse.json({ error: "Invalid Instagram image URL" }, { status: 400 });
  }

  try {
    const upstream = await fetch(rawUrl, {
      redirect: "follow",
      headers: {
        Accept: "image/*",
      },
      cache: "no-store",
    });
    if (!upstream.ok) {
      return NextResponse.json({ error: "Failed to load Instagram image" }, { status: 502 });
    }

    const contentType = upstream.headers.get("content-type") || "";
    if (!contentType.toLowerCase().startsWith("image/")) {
      return NextResponse.json({ error: "Instagram image response was not an image" }, { status: 502 });
    }

    const headers = new Headers();
    copyCachingHeaders(upstream.headers, headers);
    return new Response(upstream.body, { status: 200, headers });
  } catch {
    return NextResponse.json({ error: "Failed to proxy Instagram image" }, { status: 502 });
  }
}
