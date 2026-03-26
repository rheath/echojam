import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import {
  fallbackScript,
  generateScriptWithOpenAI,
  rewriteScriptOpenerWithOpenAI,
  uploadNarrationAudio,
} from "../lib/mixGeneration.ts";

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

test("shared narration generation surfaces upstream status details on failure", async () => {
  const originalFetch = global.fetch;

  try {
    global.fetch = async () =>
      new Response("upstream error", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });

    await assert.rejects(
      () =>
        generateScriptWithOpenAI(
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
          1
        ),
      /OpenAI script generation failed \(500: upstream error\)/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("opener rewrites surface upstream status details on failure", async () => {
  const originalFetch = global.fetch;

  try {
    global.fetch = async () =>
      new Response("rewrite exploded", {
        status: 502,
        headers: { "Content-Type": "text/plain" },
      });

    await assert.rejects(
      () =>
        rewriteScriptOpenerWithOpenAI(
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
          "Welcome to Old State House. This is the oldest public building in Boston."
        ),
      /OpenAI opener rewrite failed \(502: rewrite exploded\)/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("narration uploads retry after creating a missing bucket", async () => {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalServiceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalBucket = process.env.SUPABASE_AUDIO_BUCKET;

  let uploadAttempts = 0;
  let createBucketCalls = 0;

  try {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    process.env.SUPABASE_AUDIO_BUCKET = "narrations";

    const publicUrl = await uploadNarrationAudio(
      new Uint8Array([1, 2, 3]),
      "route-1",
      "adult",
      "stop-1",
      {
        storage: {
          async createBucket(bucket, options) {
            createBucketCalls += 1;
            assert.equal(bucket, "narrations");
            assert.deepEqual(options, { public: true });
            return { error: null };
          },
          from(bucket) {
            assert.equal(bucket, "narrations");
            return {
              async upload(path, fileBody, options) {
                uploadAttempts += 1;
                assert.equal(path, "mixes/route-1/adult/stop-1.mp3");
                assert.deepEqual(Array.from(fileBody), [1, 2, 3]);
                assert.deepEqual(options, {
                  contentType: "audio/mpeg",
                  cacheControl: "31536000",
                  upsert: true,
                });
                if (uploadAttempts === 1) {
                  return { error: { message: "Bucket not found" } };
                }
                return { error: null };
              },
              getPublicUrl(path) {
                assert.equal(path, "mixes/route-1/adult/stop-1.mp3");
                return {
                  data: {
                    publicUrl: "https://example.supabase.co/storage/v1/object/public/narrations/mixes/route-1/adult/stop-1.mp3",
                  },
                };
              },
            };
          },
        },
      }
    );

    assert.equal(createBucketCalls, 1);
    assert.equal(uploadAttempts, 2);
    assert.match(publicUrl, /^https:\/\/example\.supabase\.co\/storage\/v1\/object\/public\/narrations\/mixes\/route-1\/adult\/stop-1\.mp3\?v=/);
  } finally {
    if (originalUrl === undefined) {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    } else {
      process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    }
    if (originalServiceRole === undefined) {
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    } else {
      process.env.SUPABASE_SERVICE_ROLE_KEY = originalServiceRole;
    }
    if (originalBucket === undefined) {
      delete process.env.SUPABASE_AUDIO_BUCKET;
    } else {
      process.env.SUPABASE_AUDIO_BUCKET = originalBucket;
    }
  }
});
