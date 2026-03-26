import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import {
  buildMixedImportEntryPath,
  buildMixedImportJourneysPath,
  buildLegacyInstagramRedirectPath,
  buildLegacyTikTokRedirectPath,
  buildMixedImportPath,
  normalizeMixedImportNextPath,
  resolveMixedImportRequiredProvider,
} from "../lib/mixedImportRouting.ts";

test("mixed import builders encode entry, journeys, and composer paths", () => {
  assert.equal(buildMixedImportEntryPath(), "/import/mixed");
  assert.equal(buildMixedImportJourneysPath(), "/import/mixed/journeys");
  assert.equal(buildMixedImportPath(), "/import/mixed/create");
  assert.equal(
    buildMixedImportPath({
      provider: "instagram",
      instagramDraftId: "draft-1",
    }),
    "/import/mixed/create?provider=instagram&instagramDraft=draft-1"
  );
  assert.equal(
    buildMixedImportPath({
      resumeJamId: "jam-1",
    }),
    "/import/mixed/create?resumeJam=jam-1"
  );
});

test("resolveMixedImportRequiredProvider reopens social sessions based on stored drafts", () => {
  assert.equal(
    resolveMixedImportRequiredProvider({
      sessionSnapshot: {
        activeProvider: "instagram",
        instagramDraftIds: ["draft-1", "draft-2"],
      },
    }),
    "instagram"
  );
  assert.equal(
    resolveMixedImportRequiredProvider({
      sessionSnapshot: {
        activeImportJob: {
          provider: "tiktok",
          draftId: "draft-9",
          jobId: "job-9",
        },
      },
    }),
    "tiktok"
  );
});

test("normalizeMixedImportNextPath keeps mixed URLs and falls back to canonical mixed entrypoints", () => {
  assert.equal(
    normalizeMixedImportNextPath("/import/mixed/create?session=session-1", "instagram"),
    "/import/mixed/create?session=session-1"
  );
  assert.equal(
    normalizeMixedImportNextPath("/import/mixed/journeys", "instagram"),
    "/import/mixed/journeys"
  );
  assert.equal(
    normalizeMixedImportNextPath("/import/instagram?draft=draft-1", "instagram"),
    "/import/mixed/create?provider=instagram"
  );
});

test("legacy social redirect helpers target canonical mixed URLs", () => {
  assert.equal(
    buildLegacyInstagramRedirectPath({
      mixedComposerSessionId: "session-1",
      draftId: "draft-1",
    }),
    "/import/mixed/create?session=session-1"
  );
  assert.equal(
    buildLegacyInstagramRedirectPath({
      draftId: "draft-1",
    }),
    "/import/mixed/create?provider=instagram&instagramDraft=draft-1"
  );
  assert.equal(
    buildLegacyTikTokRedirectPath(),
    "/import/mixed/create?provider=tiktok"
  );
});
