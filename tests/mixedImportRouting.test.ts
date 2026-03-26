import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import {
  buildLegacyInstagramRedirectPath,
  buildLegacyTikTokRedirectPath,
  buildMixedImportPath,
  normalizeMixedImportNextPath,
  resolveMixedImportRequiredProvider,
} from "../lib/mixedImportRouting.ts";

test("buildMixedImportPath encodes canonical mixed import params", () => {
  assert.equal(
    buildMixedImportPath({
      provider: "instagram",
      instagramDraftId: "draft-1",
    }),
    "/import/mixed?provider=instagram&instagramDraft=draft-1"
  );
  assert.equal(
    buildMixedImportPath({
      resumeJamId: "jam-1",
    }),
    "/import/mixed?resumeJam=jam-1"
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
    normalizeMixedImportNextPath("/import/mixed?session=session-1", "instagram"),
    "/import/mixed?session=session-1"
  );
  assert.equal(
    normalizeMixedImportNextPath("/import/instagram?draft=draft-1", "instagram"),
    "/import/mixed?provider=instagram"
  );
});

test("legacy social redirect helpers target canonical mixed URLs", () => {
  assert.equal(
    buildLegacyInstagramRedirectPath({
      mixedComposerSessionId: "session-1",
      draftId: "draft-1",
    }),
    "/import/mixed?session=session-1"
  );
  assert.equal(
    buildLegacyInstagramRedirectPath({
      draftId: "draft-1",
    }),
    "/import/mixed?provider=instagram&instagramDraft=draft-1"
  );
  assert.equal(
    buildLegacyTikTokRedirectPath(),
    "/import/mixed?provider=tiktok"
  );
});
