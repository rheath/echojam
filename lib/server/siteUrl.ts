import "server-only";

import { headers } from "next/headers";

function normalizeBaseUrl(raw: string | null | undefined) {
  const candidate = raw?.trim();
  if (!candidate) return null;
  try {
    return new URL(candidate).toString();
  } catch {
    return null;
  }
}

export async function getSiteBaseUrl() {
  const envBaseUrl = normalizeBaseUrl(process.env.NEXT_PUBLIC_SITE_URL);
  if (envBaseUrl) return envBaseUrl;

  if (process.env.NODE_ENV === "development") {
    console.warn("share metadata: NEXT_PUBLIC_SITE_URL is missing or invalid; deriving from request headers");
  }

  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host");
  const protocol = h.get("x-forwarded-proto") || "https";
  if (host) return `${protocol}://${host}`;
  return "http://localhost:3000";
}

export function toAbsoluteUrl(urlOrPath: string, baseUrl: string) {
  if (/^https?:\/\//i.test(urlOrPath)) return urlOrPath;
  return new URL(urlOrPath, baseUrl).toString();
}
