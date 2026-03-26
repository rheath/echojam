import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import {
  createCreatorCodeInvite,
  listRecentCreatorCodeInvites,
} from "../lib/server/creatorCodeDashboard.ts";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import { hashCreatorAccessCode } from "../lib/server/creatorAccess.ts";

test("createCreatorCodeInvite hashes the raw code and stores mixed scope", async () => {
  const inserts: unknown[] = [];
  const admin = {
    from(table: string) {
      assert.equal(table, "creator_access_invites");
      return {
        insert(value: unknown) {
          inserts.push(value);
          return {
            select() {
              return {
                async single() {
                  return {
                    data: { id: "invite-1", email: "creator@example.com" },
                    error: null,
                  };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  const result = await createCreatorCodeInvite(admin, {
    email: " Creator@example.com ",
    code: " SUMMER-ALPHA ",
  });

  assert.deepEqual(result, { id: "invite-1", email: "creator@example.com" });
  assert.deepEqual(inserts[0], {
    email: "creator@example.com",
    code_hash: hashCreatorAccessCode("SUMMER-ALPHA"),
    scope: "mixed",
  });
});

test("createCreatorCodeInvite returns a friendly duplicate error", async () => {
  const admin = {
    from() {
      return {
        insert() {
          return {
            select() {
              return {
                async single() {
                  return {
                    data: null,
                    error: {
                      message:
                        "duplicate key value violates unique constraint \"idx_creator_access_invites_code_hash_email_scope\"",
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  await assert.rejects(
    () =>
      createCreatorCodeInvite(admin, {
        email: "creator@example.com",
        code: "ALPHA",
      }),
    /already exists/i
  );
});

test("listRecentCreatorCodeInvites normalizes recent rows", async () => {
  const admin = {
    from(table: string) {
      assert.equal(table, "creator_access_invites");
      return {
        select() {
          return {
            order() {
              return {
                async limit() {
                  return {
                    data: [
                      {
                        id: "invite-1",
                        email: "Creator@example.com",
                        scope: "mixed",
                        claimed_user_id: "user-1",
                        claimed_at: "2026-03-27T12:00:00.000Z",
                        revoked_at: null,
                        created_at: "2026-03-26T12:00:00.000Z",
                      },
                    ],
                    error: null,
                  };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  const invites = await listRecentCreatorCodeInvites(admin, 10);

  assert.deepEqual(invites, [
    {
      id: "invite-1",
      email: "creator@example.com",
      scope: "mixed",
      claimed: true,
      claimedAt: "2026-03-27T12:00:00.000Z",
      revokedAt: null,
      createdAt: "2026-03-26T12:00:00.000Z",
    },
  ]);
});
