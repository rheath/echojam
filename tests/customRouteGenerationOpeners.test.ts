import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import { harmonizeMixedRouteStopScripts } from "../lib/customRouteGeneration.ts";

test("mixed-route opener harmonization preserves edited scripts and rewrites untouched stops in sequence", async () => {
  const calls: Array<{
    title: string;
    openerFamily: string;
    blockedLeadIns: string[];
  }> = [];

  const result = await harmonizeMixedRouteStopScripts({
    experienceKind: "mix",
    persona: "adult",
    narratorGuidance: null,
    stops: [
      {
        id: "stop-1",
        title: "Old State House",
        lat: 1,
        lng: 1,
        image: "a",
        scriptEditedByUser: false,
      },
      {
        id: "stop-2",
        title: "Faneuil Hall",
        lat: 2,
        lng: 2,
        image: "b",
        scriptEditedByUser: true,
      },
      {
        id: "stop-3",
        title: "North End",
        lat: 3,
        lng: 3,
        image: "c",
        scriptEditedByUser: false,
      },
    ],
    scripts: [
      "Welcome to Old State House. This is the oldest public building in Boston.",
      "Welcome to Faneuil Hall. This opener was edited by a person.",
      "Welcome to North End. The story starts with the street grid.",
    ],
    rewriteScriptOpener: async ({ stop, openerFamily, blockedLeadIns, script }) => {
      calls.push({ title: stop.title, openerFamily, blockedLeadIns });
      if (stop.id === "stop-1") {
        return `A charter once shifted this block. ${script.split(". ").slice(1).join(". ")}`;
      }
      return `Right now the street feels tighter than the map suggests. ${script
        .split(". ")
        .slice(1)
        .join(". ")}`;
    },
  });

  assert.equal(result.warningCount, 0);
  assert.equal(result.lastWarning, "");
  assert.deepEqual(
    result.scripts,
    [
      "A charter once shifted this block. This is the oldest public building in Boston.",
      "Welcome to Faneuil Hall. This opener was edited by a person.",
      "Right now the street feels tighter than the map suggests. The story starts with the street grid.",
    ]
  );
  assert.deepEqual(calls, [
    {
      title: "Old State House",
      openerFamily: "history-anchor",
      blockedLeadIns: ["welcome to"],
    },
    {
      title: "North End",
      openerFamily: "present-day-contrast",
      blockedLeadIns: ["welcome to", "a charter once shifted", "welcome to faneuil hall"],
    },
  ]);
});

test("mixed-route opener harmonization is skipped outside mix routes", async () => {
  let rewriteCalled = false;

  const result = await harmonizeMixedRouteStopScripts({
    experienceKind: "follow_along",
    persona: "adult",
    narratorGuidance: null,
    stops: [
      {
        id: "stop-1",
        title: "Old State House",
        lat: 1,
        lng: 1,
        image: "a",
      },
    ],
    scripts: ["Welcome to Old State House. This is the oldest public building in Boston."],
    rewriteScriptOpener: async ({ script }) => {
      rewriteCalled = true;
      return script;
    },
  });

  assert.equal(rewriteCalled, false);
  assert.deepEqual(result.scripts, [
    "Welcome to Old State House. This is the oldest public building in Boston.",
  ]);
});
