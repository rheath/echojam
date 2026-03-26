import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import {
  formatWalkStopSourceLabel,
  hasMultipleWalkSourceCredits,
} from "../lib/walkSourceMeta.ts";

test("walk source meta stays hidden when one creator repeats across the journey", () => {
  const stops = [
    { sourceCreatorName: "@alice" },
    { sourceCreatorName: " @alice " },
    { sourceCreatorName: null },
  ];

  assert.equal(hasMultipleWalkSourceCredits(stops), false);
  assert.equal(formatWalkStopSourceLabel(stops[0], false), null);
});

test("walk source meta shows only creator names when multiple creators exist", () => {
  const stops = [
    { sourceCreatorName: "@alice" },
    { sourceCreatorName: "@bob" },
  ];

  assert.equal(hasMultipleWalkSourceCredits(stops), true);
  assert.equal(formatWalkStopSourceLabel(stops[0], true), "@alice");
  assert.equal(formatWalkStopSourceLabel(stops[1], true), "@bob");
});

test("walk source meta ignores google places and other uncredited stops in single-credit journeys", () => {
  const stops = [
    { sourceCreatorName: "@alice" },
    { sourceCreatorName: null },
    { sourceCreatorName: "   " },
  ];

  assert.equal(hasMultipleWalkSourceCredits(stops), false);
  assert.equal(formatWalkStopSourceLabel(stops[1], false), null);
});

test("walk source meta shows nothing for uncredited stops even in multi-credit journeys", () => {
  const stops = [
    { sourceCreatorName: "@alice" },
    { sourceCreatorName: "@bob" },
    { sourceCreatorName: null },
  ];

  assert.equal(hasMultipleWalkSourceCredits(stops), true);
  assert.equal(formatWalkStopSourceLabel(stops[2], true), null);
});

test("walk source meta ignores empty creator names when counting distinct credits", () => {
  const stops = [
    { sourceCreatorName: "   " },
    { sourceCreatorName: "@alice" },
    { sourceCreatorName: "" },
    { sourceCreatorName: "@alice" },
  ];

  assert.equal(hasMultipleWalkSourceCredits(stops), false);
});
