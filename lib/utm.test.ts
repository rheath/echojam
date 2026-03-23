import assert from "node:assert/strict";
import test from "node:test";
import {
  appendUtmParams,
  buildPathWithUtm,
  pickUtmParamsFromRecord,
  pickUtmParamsFromSearchParams,
  utmParamsToMetadata,
} from "./utm.ts";

test("pickUtmParamsFromSearchParams keeps only standard non-empty utm params", () => {
  const params = new URLSearchParams({
    utm_source: "instagram",
    utm_medium: "social",
    utm_campaign: " launch ",
    utm_content: "",
    not_utm: "ignored",
  });

  assert.deepEqual(pickUtmParamsFromSearchParams(params), {
    utm_source: "instagram",
    utm_medium: "social",
    utm_campaign: "launch",
  });
});

test("pickUtmParamsFromRecord trims values and ignores non-strings", () => {
  assert.deepEqual(
    pickUtmParamsFromRecord({
      utm_source: " instagram ",
      utm_medium: 42,
      utm_campaign: "spring-drop",
      utm_term: null,
    }),
    {
      utm_source: "instagram",
      utm_campaign: "spring-drop",
    }
  );
});

test("buildPathWithUtm appends standard utm params to a path", () => {
  assert.equal(
    buildPathWithUtm("/journeys/boston-old-taverns", {
      utm_source: "instagram",
      utm_campaign: "old-taverns-launch",
    }),
    "/journeys/boston-old-taverns?utm_source=instagram&utm_campaign=old-taverns-launch"
  );
});

test("appendUtmParams and utmParamsToMetadata preserve only populated standard utm keys", () => {
  const searchParams = new URLSearchParams("checkout=success");
  const utmParams = {
    utm_source: "instagram",
    utm_medium: "social",
    utm_content: "reel_a",
  } as const;

  appendUtmParams(searchParams, utmParams);

  assert.equal(
    searchParams.toString(),
    "checkout=success&utm_source=instagram&utm_medium=social&utm_content=reel_a"
  );
  assert.deepEqual(utmParamsToMetadata(utmParams), {
    utm_source: "instagram",
    utm_medium: "social",
    utm_content: "reel_a",
  });
});
