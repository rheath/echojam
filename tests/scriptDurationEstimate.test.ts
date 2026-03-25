import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import {
  estimateScriptDurationSeconds,
  formatEstimatedScriptDuration,
} from "../lib/scriptDurationEstimate.ts";

test("script duration estimate returns null for blank scripts", () => {
  assert.equal(formatEstimatedScriptDuration("   "), null);
  assert.equal(estimateScriptDurationSeconds("\n\n"), null);
});

test("script duration estimate formats short scripts as m:ss", () => {
  assert.equal(formatEstimatedScriptDuration("one two three four"), "0:02");
  assert.equal(estimateScriptDurationSeconds("one two three four"), 2);
});

test("script duration estimate formats longer scripts as m:ss", () => {
  const script = Array.from({ length: 150 }, (_, index) => `word${index + 1}`).join(" ");
  assert.equal(formatEstimatedScriptDuration(script), "1:15");
});

test("script duration estimate ignores repeated whitespace and newlines", () => {
  const script = "one   two\n\nthree\r\nfour five six";
  assert.equal(formatEstimatedScriptDuration(script), "0:03");
});
