import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import {
  createInstagramCreatorAccessCookieValue,
  isInstagramCreatorAccessAuthorizedFromCookieStore,
  isInstagramCreatorAccessCookieAuthorized,
  parseInstagramCreatorAccessCodes,
  validateInstagramCreatorAccessCode,
} from "../lib/server/instagramCreatorAccess.ts";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import { createCreatorAccessCookieValue } from "../lib/server/creatorAccess.ts";

const ORIGINAL_ENABLE_INSTAGRAM_IMPORT = process.env.NEXT_PUBLIC_ENABLE_INSTAGRAM_IMPORT;
const ORIGINAL_CREATOR_CODES = process.env.INSTAGRAM_CREATOR_ACCESS_CODES;
const ORIGINAL_CREATOR_SECRET = process.env.INSTAGRAM_CREATOR_ACCESS_SECRET;
const ORIGINAL_CREATOR_ACCESS_COOKIE_SECRET = process.env.CREATOR_ACCESS_COOKIE_SECRET;

function restoreEnv() {
  process.env.NEXT_PUBLIC_ENABLE_INSTAGRAM_IMPORT = ORIGINAL_ENABLE_INSTAGRAM_IMPORT;
  process.env.INSTAGRAM_CREATOR_ACCESS_CODES = ORIGINAL_CREATOR_CODES;
  process.env.INSTAGRAM_CREATOR_ACCESS_SECRET = ORIGINAL_CREATOR_SECRET;
  process.env.CREATOR_ACCESS_COOKIE_SECRET = ORIGINAL_CREATOR_ACCESS_COOKIE_SECRET;
}

test.afterEach(() => {
  restoreEnv();
});

test("parseInstagramCreatorAccessCodes splits comma and newline separated codes", () => {
  assert.deepEqual(
    parseInstagramCreatorAccessCodes(" alpha,\n beta,\nalpha , gamma "),
    ["alpha", "beta", "gamma"]
  );
});

test("validateInstagramCreatorAccessCode enforces config and code matching", () => {
  process.env.INSTAGRAM_CREATOR_ACCESS_CODES = "alpha,beta";
  process.env.INSTAGRAM_CREATOR_ACCESS_SECRET = "test-secret";

  assert.deepEqual(validateInstagramCreatorAccessCode(""), {
    ok: false,
    error: "Enter your creator code.",
    status: 400,
  });

  assert.deepEqual(validateInstagramCreatorAccessCode("gamma"), {
    ok: false,
    error: "That creator code is invalid.",
    status: 401,
  });

  assert.deepEqual(validateInstagramCreatorAccessCode("beta"), {
    ok: true,
    normalizedCode: "beta",
  });
});

test("validateInstagramCreatorAccessCode fails when creator access is not configured", () => {
  delete process.env.INSTAGRAM_CREATOR_ACCESS_CODES;
  delete process.env.INSTAGRAM_CREATOR_ACCESS_SECRET;

  assert.deepEqual(validateInstagramCreatorAccessCode("alpha"), {
    ok: false,
    error: "Creator access is not configured yet.",
    status: 503,
  });
});

test("creator access cookies authorize until they expire", () => {
  process.env.INSTAGRAM_CREATOR_ACCESS_SECRET = "test-secret";

  const now = Date.UTC(2026, 2, 12, 12, 0, 0);
  const cookieValue = createInstagramCreatorAccessCookieValue(now);

  assert.equal(isInstagramCreatorAccessCookieAuthorized(cookieValue, now + 1_000), true);
  assert.equal(
    isInstagramCreatorAccessCookieAuthorized(cookieValue, now + (31 * 24 * 60 * 60 * 1000)),
    false
  );
  assert.equal(
    isInstagramCreatorAccessCookieAuthorized(`${cookieValue}tampered`, now + 1_000),
    false
  );
});

test("cookie store authorization accepts the signed creator cookie", () => {
  process.env.CREATOR_ACCESS_COOKIE_SECRET = "test-secret";

  const now = Date.UTC(2026, 2, 12, 12, 0, 0);
  const cookieValue = createCreatorAccessCookieValue("mixed", now);
  const cookieStore = {
    get(name: string) {
      if (name !== "mixed_creator_access") return undefined;
      return { value: cookieValue };
    },
  };

  assert.equal(isInstagramCreatorAccessAuthorizedFromCookieStore(cookieStore, now + 1_000), true);
  assert.equal(
    isInstagramCreatorAccessAuthorizedFromCookieStore(
      {
        get() {
          return undefined;
        },
      },
      now + 1_000
    ),
    false
  );
});
