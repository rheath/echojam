import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import {
  isCreatorCodeDashboardAdminEmail,
  parseCreatorCodeDashboardAdminEmails,
  validateCreatorCodeDashboardMagicLinkEmail,
} from "../lib/server/internalAdminAccess.ts";

const ORIGINAL_ADMIN_EMAILS = process.env.CREATOR_CODE_DASHBOARD_ADMIN_EMAILS;

test.afterEach(() => {
  process.env.CREATOR_CODE_DASHBOARD_ADMIN_EMAILS = ORIGINAL_ADMIN_EMAILS;
});

test("parseCreatorCodeDashboardAdminEmails normalizes and dedupes emails", () => {
  assert.deepEqual(
    parseCreatorCodeDashboardAdminEmails(" Admin@example.com,\nadmin@example.com,\nother@example.com "),
    ["admin@example.com", "other@example.com"]
  );
});

test("isCreatorCodeDashboardAdminEmail checks the normalized allowlist env var", () => {
  process.env.CREATOR_CODE_DASHBOARD_ADMIN_EMAILS = "owner@example.com, helper@example.com";

  assert.equal(isCreatorCodeDashboardAdminEmail("OWNER@example.com"), true);
  assert.equal(isCreatorCodeDashboardAdminEmail(" stranger@example.com "), false);
  assert.equal(isCreatorCodeDashboardAdminEmail(null), false);
});

test("validateCreatorCodeDashboardMagicLinkEmail rejects non-allowlisted emails before sending", () => {
  process.env.CREATOR_CODE_DASHBOARD_ADMIN_EMAILS = "owner@example.com";

  assert.deepEqual(validateCreatorCodeDashboardMagicLinkEmail(""), {
    ok: false,
    status: 400,
    error: "Enter your admin email.",
  });

  assert.deepEqual(validateCreatorCodeDashboardMagicLinkEmail("stranger@example.com"), {
    ok: false,
    status: 403,
    error: "That email is not allowed to access the creator-code dashboard.",
  });

  assert.deepEqual(validateCreatorCodeDashboardMagicLinkEmail(" OWNER@example.com "), {
    ok: true,
    normalizedEmail: "owner@example.com",
  });
});
