import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript route module by explicit extension here.
import { POST } from "../app/api/google-place-scripts/generate/route.ts";

test("google place script route uses custom narrator guidance when provided", async () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
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
    assert.match(requestBody.messages?.[1]?.content || "", /Narrator guidance: Young history guide/);
  } finally {
    global.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalApiKey;
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
    assert.match(String(body.error), /OpenAI script generation failed/);
  } finally {
    global.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalApiKey;
  }
});
