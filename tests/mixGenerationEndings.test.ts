import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import { fallbackScript, generateScriptWithOpenAI } from "../lib/mixGeneration.ts";

test("shared narration generation defaults to a reflective close", async () => {
  const originalFetch = global.fetch;
  let capturedInit: RequestInit | undefined;

  try {
    global.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "Old State House still holds the weight of decisions made in public.",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    };

    const script = await generateScriptWithOpenAI(
      "test-key",
      "boston",
      "walk",
      30,
      "adult",
      {
        id: "stop-1",
        title: "Old State House",
        lat: 42.3588,
        lng: -71.0579,
        image: "/placeholder.jpg",
      },
      0,
      3,
      undefined,
      {
        placeGrounding: {
          placeId: "g-1",
          resolvedName: "Old State House",
          formattedAddress: "206 Washington St, Boston, MA 02109, USA",
          venueCategory: "Historical Landmark",
          neighborhood: "Downtown Boston",
          city: "Boston",
          region: "Massachusetts",
          country: "United States",
          localContext: "Historical Landmark in Downtown Boston, Boston",
          source: "google_place_details",
          signature: "g-1|old state house",
        },
      }
    );

    assert.match(script, /Old State House/);
    const requestBody = JSON.parse(String(capturedInit?.body || "{}")) as {
      messages?: Array<{ content?: string }>;
    };
    const prompt = requestBody.messages?.[1]?.content || "";
    assert.match(prompt, /Confirmed place grounding:/);
    assert.match(prompt, /Neighborhood or borough: Downtown Boston/);
    assert.match(prompt, /Venue type: Historical Landmark/);
    assert.match(prompt, /End with a reflective close tied to this place/);
    assert.match(prompt, /Do not mention the next stop, continuing onward, keeping moving, or what comes next/);
    assert.match(prompt, /Do not mention raw coordinates, latitude\/longitude, or map-style phrasing/);
    assert.doesNotMatch(prompt, /End with a transition to keep moving/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("shared fallback scripts avoid next-stop teasers across personas", () => {
  const stop = {
    id: "stop-1",
    title: "Old State House",
    lat: 42.3588,
    lng: -71.0579,
    image: "/placeholder.jpg",
  };

  const adult = fallbackScript("boston", "adult", stop, 0);
  const preteen = fallbackScript("boston", "preteen", stop, 0);
  const ghost = fallbackScript("boston", "ghost", stop, 0);
  const custom = fallbackScript("boston", "custom", stop, 0);

  for (const script of [adult, preteen, ghost, custom]) {
    assert.doesNotMatch(script, /\b(next stop|continue(?:\s+to)?|keep moving|what comes next)\b/i);
  }
});
