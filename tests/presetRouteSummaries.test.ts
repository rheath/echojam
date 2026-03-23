import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import { getPresetRouteSummaryById, getPresetRouteSummaryStopCount } from "../app/content/presetRouteSummaries.ts";

test("paid preset summary exposes purchase metadata without full route payload", () => {
  const route = getPresetRouteSummaryById("boston-old-taverns");
  assert.ok(route);
  assert.equal(route.requiresPurchase, true);
  assert.equal(route.pricing?.amountUsdCents, 99);
  assert.equal(route.firstStopTitle, "Bell in Hand");
  assert.equal(getPresetRouteSummaryStopCount(route), 8);
});
