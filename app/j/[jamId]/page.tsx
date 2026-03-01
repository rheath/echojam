import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import RedirectToJam from "./RedirectToJam";
import { getJamSharePayload } from "@/lib/server/jamShare";

type SharePageProps = {
  params: Promise<{ jamId: string }>;
};

function toAbsoluteUrl(urlOrPath: string, baseUrl: string) {
  if (/^https?:\/\//i.test(urlOrPath)) return urlOrPath;
  return new URL(urlOrPath, baseUrl).toString();
}

function normalizeBaseUrl(raw: string | null | undefined) {
  const candidate = raw?.trim();
  if (!candidate) return null;
  try {
    return new URL(candidate).toString();
  } catch {
    return null;
  }
}

async function getSiteBaseUrl() {
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

export async function generateMetadata({ params }: SharePageProps): Promise<Metadata> {
  const { jamId } = await params;
  const payload = await getJamSharePayload(jamId);
  const baseUrl = await getSiteBaseUrl();
  const canonicalUrl = toAbsoluteUrl(payload.canonicalPath, baseUrl);
  const imageUrl = toAbsoluteUrl(payload.imageUrl, baseUrl);

  return {
    metadataBase: new URL(baseUrl),
    title: payload.title,
    description: payload.description,
    alternates: {
      canonical: canonicalUrl,
    },
    robots: {
      index: false,
      follow: true,
    },
    openGraph: {
      title: payload.title,
      description: payload.description,
      url: canonicalUrl,
      siteName: "EchoJam",
      type: "website",
      images: [{ url: imageUrl }],
    },
    twitter: {
      card: "summary_large_image",
      title: payload.title,
      description: payload.description,
      images: [imageUrl],
    },
  };
}

export default async function JamSharePage({ params }: SharePageProps) {
  const { jamId } = await params;
  const payload = await getJamSharePayload(jamId);
  const deepLinkPath = payload.deepLinkPath;

  return (
    <main style={{ padding: "24px", fontFamily: "sans-serif", lineHeight: 1.45 }}>
      {payload.jamFound ? <RedirectToJam deepLinkPath={deepLinkPath} /> : null}

      <h1 style={{ fontSize: "1.25rem", margin: "0 0 8px" }}>{payload.title}</h1>
      <p style={{ margin: "0 0 12px" }}>{payload.description}</p>

      {payload.jamFound ? (
        <p style={{ margin: "0 0 12px" }}>Opening your tour...</p>
      ) : (
        <p style={{ margin: "0 0 12px" }}>This share link is unavailable. You can still start a new tour.</p>
      )}

      <p style={{ margin: 0 }}>
        {payload.jamFound ? (
          <Link href={deepLinkPath}>Open tour</Link>
        ) : (
          <Link href="/">Go to EchoJam home</Link>
        )}
      </p>

      {payload.jamFound ? (
        <noscript>
          <p style={{ marginTop: "12px" }}>
            JavaScript is disabled. Open the tour here: <a href={deepLinkPath}>Open tour</a>
          </p>
        </noscript>
      ) : null}
    </main>
  );
}
