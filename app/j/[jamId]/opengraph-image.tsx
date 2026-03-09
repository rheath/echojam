import { ImageResponse } from "next/og";
import { getJamSharePayload } from "@/lib/server/jamShare";
import { getSiteBaseUrl, toAbsoluteUrl } from "@/lib/server/siteUrl";

export const runtime = "nodejs";

export const size = {
  width: 1200,
  height: 630,
};

export const contentType = "image/png";

type OpenGraphImageProps = {
  params: Promise<{ jamId: string }>;
};

const FALLBACK_BG = "radial-gradient(circle at top left, #262631 0%, #171722 55%, #101019 100%)";
const TITLE_FONT = '"Georgia", "Times New Roman", serif';
const BODY_FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';

export default async function OpenGraphImage({ params }: OpenGraphImageProps) {
  const { jamId } = await params;
  const payload = await getJamSharePayload(jamId);
  const baseUrl = await getSiteBaseUrl();
  const backgroundUrl = payload.posterBackgroundImageUrl
    ? toAbsoluteUrl(payload.posterBackgroundImageUrl, baseUrl)
    : null;
  const logoUrl = toAbsoluteUrl("/images/marketing/Wandrful-logo-v2.svg", baseUrl);

  return new ImageResponse(
    (
      <div
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          display: "flex",
          overflow: "hidden",
          background: FALLBACK_BG,
          color: "#f4f4f6",
        }}
      >
        {backgroundUrl ? (
          <img
            src={backgroundUrl}
            alt=""
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />
        ) : null}

        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "linear-gradient(180deg, rgba(7, 8, 12, 0.22) 0%, rgba(7, 8, 12, 0.4) 30%, rgba(7, 8, 12, 0.72) 68%, rgba(7, 8, 12, 0.96) 100%)",
          }}
        />

        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "linear-gradient(90deg, rgba(7, 8, 12, 0.82) 0%, rgba(7, 8, 12, 0.42) 42%, rgba(7, 8, 12, 0.16) 68%, rgba(7, 8, 12, 0.18) 100%)",
          }}
        />

        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(circle at 18% 84%, rgba(7, 8, 12, 0.84) 0%, rgba(7, 8, 12, 0.68) 24%, rgba(7, 8, 12, 0.38) 46%, rgba(7, 8, 12, 0) 72%)",
          }}
        />

        <div
          style={{
            position: "absolute",
            top: 40,
            left: 48,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "14px 20px",
            borderRadius: 999,
            background: "rgba(7, 8, 12, 0.44)",
            border: "1px solid rgba(255, 255, 255, 0.14)",
            minWidth: 180,
          }}
        >
          <img
            src={logoUrl}
            alt="Wandrful"
            style={{
              width: 122,
              height: 28,
              objectFit: "contain",
            }}
          />
        </div>

        {!backgroundUrl ? (
          <div
            style={{
              position: "absolute",
              right: -140,
              top: -120,
              width: 520,
              height: 520,
              borderRadius: 999,
              background: "radial-gradient(circle, rgba(255, 95, 146, 0.26) 0%, rgba(255, 95, 146, 0.08) 42%, rgba(255, 95, 146, 0) 72%)",
            }}
          />
        ) : null}

        <div
          style={{
            position: "absolute",
            left: 56,
            right: 72,
            bottom: 54,
            display: "flex",
            flexDirection: "column",
            maxWidth: 760,
          }}
        >
          <div
            style={{
              width: 96,
              height: 6,
              borderRadius: 999,
              background: "#ff5f92",
              marginBottom: 26,
            }}
          />
          <div
            style={{
              fontFamily: TITLE_FONT,
              fontSize: payload.posterTitle.length > 32 ? 72 : 86,
              fontWeight: 700,
              lineHeight: 1.02,
              letterSpacing: "-0.03em",
              textWrap: "balance",
              textShadow: "0 16px 44px rgba(0, 0, 0, 0.62)",
            }}
          >
            {payload.posterTitle}
          </div>
          <div
            style={{
              marginTop: 20,
              fontFamily: BODY_FONT,
              fontSize: 30,
              lineHeight: 1.3,
              color: "rgba(244, 244, 246, 0.88)",
              textShadow: "0 12px 34px rgba(0, 0, 0, 0.58)",
            }}
          >
            {payload.posterSubtitle}
          </div>
        </div>
      </div>
    ),
    size
  );
}
