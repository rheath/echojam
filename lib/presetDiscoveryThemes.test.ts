import test from "node:test";
import assert from "node:assert/strict";
import { getPresetRouteSummaryById } from "@/app/content/presetRouteSummaries";
import { getRouteById } from "@/app/content/salemRoutes";

test("preset route summaries expose configured discovery themes", () => {
  const summary = getPresetRouteSummaryById("nyc-superhero-city");
  assert.deepEqual(summary?.discoveryThemes, ["comics", "history"]);
});

test("preset route payload mapping exposes discovery themes on route definitions", () => {
  const route = getRouteById("salem-after-dark");
  assert.deepEqual(route?.discoveryThemes, ["ghosts_folklore"]);
});
