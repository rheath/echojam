import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import {
  createCreatorAccessCookieValue,
  createPendingCreatorAccessClaimCookieValue,
  expandCreatorAccessScopes,
  hashCreatorAccessCode,
  isCreatorAccessCookieAuthorized,
  parsePendingCreatorAccessClaimCookieValue,
  validateCreatorAccessStart,
} from "../lib/server/creatorAccess.ts";

const ORIGINAL_COOKIE_SECRET = process.env.CREATOR_ACCESS_COOKIE_SECRET;

test.afterEach(() => {
  process.env.CREATOR_ACCESS_COOKIE_SECRET = ORIGINAL_COOKIE_SECRET;
});

test("creator access code hashing trims the code and is stable", () => {
  assert.equal(hashCreatorAccessCode(" alpha "), hashCreatorAccessCode("alpha"));
  assert.notEqual(hashCreatorAccessCode("alpha"), hashCreatorAccessCode("beta"));
});

test("creator access cookies authorize the requested scope until expiry", () => {
  process.env.CREATOR_ACCESS_COOKIE_SECRET = "test-secret";

  const now = Date.UTC(2026, 2, 26, 15, 0, 0);
  const cookieValue = createCreatorAccessCookieValue("mixed", now);

  assert.equal(isCreatorAccessCookieAuthorized(cookieValue, "mixed", now + 1_000), true);
  assert.equal(isCreatorAccessCookieAuthorized(cookieValue, "mixed", now + (31 * 24 * 60 * 60 * 1000)), false);
});

test("pending creator access claim cookies round-trip the invite claim payload", () => {
  process.env.CREATOR_ACCESS_COOKIE_SECRET = "test-secret";

  const now = Date.UTC(2026, 2, 26, 15, 0, 0);
  const cookieValue = createPendingCreatorAccessClaimCookieValue(
    {
      inviteId: "invite-123",
      email: "creator@example.com",
      requestedScope: "mixed",
      nextPath: "/import/mixed",
    },
    now
  );

  assert.deepEqual(parsePendingCreatorAccessClaimCookieValue(cookieValue, now + 1_000), {
    inviteId: "invite-123",
    email: "creator@example.com",
    requestedScope: "mixed",
    nextPath: "/import/mixed",
    expiresAt: now + (15 * 60 * 1000),
  });
  assert.equal(parsePendingCreatorAccessClaimCookieValue(cookieValue, now + (16 * 60 * 1000)), null);
});

test("legacy invite scopes normalize to mixed creator access", () => {
  assert.deepEqual(expandCreatorAccessScopes(["all"]), ["mixed"]);
  assert.deepEqual(expandCreatorAccessScopes(["mixed", "instagram", "tiktok"]), ["mixed"]);
});

test("validateCreatorAccessStart returns a setup error when the invites table is missing", async () => {
  const fakeAdmin = {
    from() {
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        limit() {
          return Promise.resolve({
            data: null,
            error: {
              message:
                "Could not find the table 'public.creator_access_invites' in the schema cache",
            },
          });
        },
      };
    },
  };

  const result = await validateCreatorAccessStart({
    admin: fakeAdmin as never,
    code: "alpha",
    email: "creator@example.com",
    next: "/import/mixed",
    requestedScope: "mixed",
  });

  assert.deepEqual(result, {
    ok: false,
    status: 503,
    error:
      "Creator access is not set up yet. Run the Supabase migration `20260326_add_creator_access_invites.sql`.",
  });
});
