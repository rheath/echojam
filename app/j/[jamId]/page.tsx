import type { Metadata } from "next";
import Link from "next/link";
import RedirectToJam from "./RedirectToJam";
import { getJamSharePayload } from "@/lib/server/jamShare";
import { getSiteBaseUrl, toAbsoluteUrl } from "@/lib/server/siteUrl";

type SharePageProps = {
  params: Promise<{ jamId: string }>;
};

export async function generateMetadata({ params }: SharePageProps): Promise<Metadata> {
  const { jamId } = await params;
  const payload = await getJamSharePayload(jamId);
  const baseUrl = await getSiteBaseUrl();
  const canonicalUrl = toAbsoluteUrl(payload.canonicalPath, baseUrl);
  const imageUrl = toAbsoluteUrl(`/j/${encodeURIComponent(jamId)}/opengraph-image`, baseUrl);

  return {
    metadataBase: new URL(baseUrl),
    title: payload.posterTitle,
    description: payload.posterSubtitle,
    alternates: {
      canonical: canonicalUrl,
    },
    robots: {
      index: false,
      follow: true,
    },
    openGraph: {
      title: payload.posterTitle,
      description: payload.posterSubtitle,
      url: canonicalUrl,
      siteName: "EchoJam",
      type: "website",
      images: [{ url: imageUrl }],
    },
    twitter: {
      card: "summary_large_image",
      title: payload.posterTitle,
      description: payload.posterSubtitle,
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
