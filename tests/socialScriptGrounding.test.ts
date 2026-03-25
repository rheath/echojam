import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import { generateGroundedSocialScriptWithOpenAI } from "../lib/server/socialScriptGrounding.ts";

test("generateGroundedSocialScriptWithOpenAI includes confirmed place context and bans raw coordinates", async () => {
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
                content: JSON.stringify({
                  title: "Cholula Deli and Grill",
                  script: "This Brooklyn spot feels intimate and full of neighborhood energy.",
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const result = await generateGroundedSocialScriptWithOpenAI(
      "test-key",
      "Instagram",
      {
        transcript: "The tacos here are packed with flavor.",
        caption: "Best deli in Bushwick.",
        cleanedText: "Neighborhood favorite with strong taco recommendations.",
      },
      "Cholula Deli and Grill",
      {
        placeId: "g-1",
        resolvedName: "Cholula Deli and Grill",
        formattedAddress: "222 Wyckoff Ave, Brooklyn, NY 11237, USA",
        venueCategory: "Restaurant",
        neighborhood: "Bushwick",
        city: "Brooklyn",
        region: "New York",
        country: "United States",
        localContext: "Restaurant in Bushwick, Brooklyn",
        source: "google_place_details",
        signature: "g-1|cholula deli and grill",
      }
    );

    assert.equal(result.title, "Cholula Deli and Grill");
    assert.match(result.script, /Brooklyn/);

    const requestBody = JSON.parse(String(capturedInit?.body || "{}")) as {
      messages?: Array<{ content?: string }>;
    };
    const prompt = requestBody.messages?.[1]?.content || "";
    assert.match(prompt, /Confirmed place: Cholula Deli and Grill/);
    assert.match(prompt, /Neighborhood or borough: Bushwick/);
    assert.match(prompt, /City: Brooklyn/);
    assert.match(prompt, /Do not mention latitude, longitude, raw coordinates, or map-like phrasing/);
    assert.match(prompt, /Do not mechanically recite the full street address/);
  } finally {
    global.fetch = originalFetch;
  }
});
