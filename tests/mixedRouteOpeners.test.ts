import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import {
  buildMixedRouteBlockedLeadIns,
  buildMixedRouteOpenerContext,
  extractMixedRouteLeadIn,
  pickMixedRouteOpenerFamily,
} from "../lib/mixedRouteOpeners.ts";

test("mixed route opener planner rotates adult and custom opener families deterministically", () => {
  assert.deepEqual(
    [0, 1, 2, 3].map((index) => pickMixedRouteOpenerFamily("adult", index)),
    ["history-anchor", "surprising-detail", "present-day-contrast", "history-anchor"]
  );
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((index) => pickMixedRouteOpenerFamily("custom", index)),
    ["look-closer", "surprising-detail", "present-day-contrast", "history-anchor", "look-closer"]
  );
});

test("mixed route lead-in normalization collapses welcome-to variants", () => {
  assert.equal(extractMixedRouteLeadIn("Welcome to Salem Common, where history lingers."), "welcome to salem common");
  assert.equal(extractMixedRouteLeadIn("welcome to Salem Common. Look around."), "welcome to salem common");
  assert.equal(extractMixedRouteLeadIn("\"Welcome to\" Salem Common and its stories."), "welcome to salem common");

  const blocked = buildMixedRouteBlockedLeadIns([
    "Welcome to Salem Common, where history lingers.",
    "welcome to Salem Common. Look around.",
  ]);
  assert.deepEqual(blocked, ["welcome to", "welcome to salem common"]);
});

test("mixed route opener context seeds blocked lead-ins and uses prior scripts", () => {
  const context = buildMixedRouteOpenerContext("custom", 2, [
    "Welcome to Boston Public Garden, where the city softens.",
    "Look closer at the ironwork before you look up.",
  ]);

  assert.equal(context.openerFamily, "present-day-contrast");
  assert.deepEqual(context.blockedLeadIns, ["welcome to", "welcome to boston public", "look closer at the"]);
});
