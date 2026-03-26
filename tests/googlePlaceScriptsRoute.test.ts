import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript route module by explicit extension here.
import { POST } from "../app/api/google-place-scripts/generate/route.ts";

test("google place script route uses custom narrator guidance when provided", async () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalPlacesKey = process.env.GOOGLE_PLACES_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.GOOGLE_PLACES_API_KEY = "places-key";
  const originalFetch = global.fetch;
  let capturedInit: RequestInit | undefined;

  try {
    global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("places.googleapis.com/v1/places/")) {
        return new Response(
          JSON.stringify({
            displayName: { text: "Boston Public Garden" },
            formattedAddress: "4 Charles St, Boston, MA 02116, USA",
            location: { latitude: 42.354, longitude: -71.07 },
            types: ["park", "tourist_attraction"],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      if (url.includes("maps.googleapis.com/maps/api/geocode/json")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                address_components: [
                  { long_name: "Back Bay", types: ["neighborhood"] },
                  { long_name: "Boston", types: ["locality"] },
                  { long_name: "Massachusetts", types: ["administrative_area_level_1"] },
                  { long_name: "United States", types: ["country"] },
                ],
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      capturedInit = init;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "Boston Public Garden makes old Boston feel young again.",
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

    const response = await POST(
      new Request("http://localhost/api/google-place-scripts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          city: "boston",
          transportMode: "walk",
          lengthMinutes: 30,
          narratorGuidance: "Young history guide",
          openerFamily: "look-closer",
          blockedLeadIns: ["welcome to boston public", "look closer at the"],
          stop: {
            id: "place-1",
            title: "Boston Public Garden",
            lat: 42.354,
            lng: -71.07,
            image: "/placeholder.jpg",
            googlePlaceId: "g-1",
          },
          stopIndex: 0,
          totalStops: 1,
        }),
      })
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as { script?: string; persona?: string };
    assert.equal(body.persona, "custom");
    assert.match(String(body.script), /Boston Public Garden/);

    const requestBody = JSON.parse(String(capturedInit?.body || "{}")) as {
      messages?: Array<{ content?: string }>;
    };
    const prompt = requestBody.messages?.[1]?.content || "";
    assert.match(prompt, /Narrator guidance: Young history guide/);
    assert.match(prompt, /Opener family: look-closer/);
    assert.match(prompt, /Do not begin with 'Welcome to'/);
    assert.match(prompt, /welcome to boston public/);
    assert.match(prompt, /End with a reflective close tied to this place/);
    assert.match(prompt, /Do not mention the next stop, continuing onward, keeping moving, or what comes next/);
    assert.match(prompt, /Confirmed place grounding:/);
    assert.match(prompt, /Neighborhood or borough: Back Bay/);
    assert.match(prompt, /City: Boston/);
    assert.match(prompt, /Venue type: Park/);
    assert.doesNotMatch(prompt, /42\.354|-71\.07/);
  } finally {
    global.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalApiKey;
    process.env.GOOGLE_PLACES_API_KEY = originalPlacesKey;
  }
});

test("google place script route falls back to adult narrator when guidance is blank", async () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  const originalFetch = global.fetch;

  try {
    global.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "TD Garden sits on layers of Boston history.",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );

    const response = await POST(
      new Request("http://localhost/api/google-place-scripts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          narratorGuidance: "   ",
          stop: {
            id: "place-2",
            title: "TD Garden",
            lat: 42.3662,
            lng: -71.0621,
            image: "/placeholder.jpg",
          },
        }),
      })
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as { persona?: string };
    assert.equal(body.persona, "adult");
  } finally {
    global.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalApiKey;
  }
});

test("google place script route returns a usable error when generation fails", async () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  const originalFetch = global.fetch;

  try {
    global.fetch = async () =>
      new Response("upstream error", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });

    const response = await POST(
      new Request("http://localhost/api/google-place-scripts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          narratorGuidance: "History guide",
          stop: {
            id: "place-3",
            title: "Boston Common",
            lat: 42.355,
            lng: -71.0656,
            image: "/placeholder.jpg",
          },
        }),
      })
    );

    assert.equal(response.status, 500);
    const body = (await response.json()) as { error?: string };
    assert.match(String(body.error), /OpenAI script generation failed \(500: upstream error\)/);
  } finally {
    global.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalApiKey;
  }
});
