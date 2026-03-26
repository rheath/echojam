import assert from "node:assert/strict";
import test from "node:test";
import { mergeCustomRouteStopAssets } from "@/lib/customRouteAssets";

test("custom route assets prefer route-specific adult script and audio over canonical assets", () => {
  const merged = mergeCustomRouteStopAssets({
    routeStop: {
      script_adult: "Route-specific script",
      audio_url_adult: "https://example.com/route-audio.mp3",
    },
    canonical: {
      script_adult: "Canonical script",
      audio_url_adult: "https://example.com/canonical-audio.mp3",
    },
  });

  assert.equal(merged.script_adult, "Route-specific script");
  assert.equal(merged.audio_url_adult, "https://example.com/route-audio.mp3");
});

test("custom route assets fall back to canonical values when route fields are blank", () => {
  const merged = mergeCustomRouteStopAssets({
    routeStop: {
      script_adult: "   ",
      audio_url_adult: "   ",
      script_preteen: null,
      audio_url_preteen: null,
    },
    canonical: {
      script_adult: "Canonical adult script",
      audio_url_adult: "https://example.com/canonical-adult.mp3",
      script_preteen: "Canonical preteen script",
      audio_url_preteen: "https://example.com/canonical-preteen.mp3",
    },
  });

  assert.equal(merged.script_adult, "Canonical adult script");
  assert.equal(merged.audio_url_adult, "https://example.com/canonical-adult.mp3");
  assert.equal(merged.script_preteen, "Canonical preteen script");
  assert.equal(merged.audio_url_preteen, "https://example.com/canonical-preteen.mp3");
});

test("custom route assets keep custom persona values on the route stop", () => {
  const merged = mergeCustomRouteStopAssets({
    routeStop: {
      script_custom: "Custom narrator route script",
      audio_url_custom: "https://example.com/custom-route.mp3",
    },
    canonical: {
      script_custom: "Ignored canonical custom script",
      audio_url_custom: "https://example.com/ignored-custom.mp3",
    },
  });

  assert.equal(merged.script_custom, "Custom narrator route script");
  assert.equal(merged.audio_url_custom, "https://example.com/custom-route.mp3");
});

test("custom route assets apply route-first precedence for preteen and ghost personas", () => {
  const merged = mergeCustomRouteStopAssets({
    routeStop: {
      script_preteen: "Route preteen script",
      audio_url_preteen: "https://example.com/route-preteen.mp3",
      script_ghost: "Route ghost script",
      audio_url_ghost: "https://example.com/route-ghost.mp3",
    },
    canonical: {
      script_preteen: "Canonical preteen script",
      audio_url_preteen: "https://example.com/canonical-preteen.mp3",
      script_ghost: "Canonical ghost script",
      audio_url_ghost: "https://example.com/canonical-ghost.mp3",
    },
  });

  assert.equal(merged.script_preteen, "Route preteen script");
  assert.equal(merged.audio_url_preteen, "https://example.com/route-preteen.mp3");
  assert.equal(merged.script_ghost, "Route ghost script");
  assert.equal(merged.audio_url_ghost, "https://example.com/route-ghost.mp3");
});
