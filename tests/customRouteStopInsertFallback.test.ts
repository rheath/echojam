import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import { insertPreparedCustomRouteStops } from "../lib/customRouteGeneration.ts";

type InsertCall = {
  table: string;
  payload: Array<Record<string, unknown>>;
};

function createFakeAdmin(options?: {
  stopInsertErrors?: Array<{ message: string } | null>;
}) {
  const insertCalls: InsertCall[] = [];
  let stopInsertAttempt = 0;

  class FakeQuery {
    table: string;

    constructor(table: string) {
      this.table = table;
    }

    insert(payload: unknown) {
      if (this.table === "custom_route_stops") {
        insertCalls.push({
          table: this.table,
          payload: payload as Array<Record<string, unknown>>,
        });
        const error = options?.stopInsertErrors?.[stopInsertAttempt] ?? null;
        stopInsertAttempt += 1;
        return Promise.resolve({ error });
      }

      return Promise.resolve({ error: null });
    }
  }

  return {
    admin: {
      from(table: string) {
        return new FakeQuery(table);
      },
    } as unknown as SupabaseClient,
    insertCalls,
  };
}

const TEST_STOPS = [
  {
    id: "stop-1",
    title: "Yvonne's",
    lat: 42.3577,
    lng: -71.0614,
    image: "https://example.com/place-image.jpg",
    sourceProvider: "instagram" as const,
    sourceKind: "social_import" as const,
    sourceUrl: "https://www.instagram.com/p/abc123/",
    sourceId: "abc123",
    sourcePreviewImageUrl: "https://example.com/instagram-image.jpg",
    sourceCreatorName: "Local Guide",
    sourceCreatorUrl: "https://www.instagram.com/localguide/",
    sourceCreatorAvatarUrl: "https://example.com/avatar.jpg",
  },
];

test("insertPreparedCustomRouteStops keeps source_preview_image_url when the column exists", async () => {
  const { admin, insertCalls } = createFakeAdmin();

  await insertPreparedCustomRouteStops({
    admin,
    routeId: "route-1",
    stops: TEST_STOPS,
  });

  assert.equal(insertCalls.length, 1);
  assert.equal(
    insertCalls[0]?.payload[0]?.source_preview_image_url,
    "https://example.com/instagram-image.jpg"
  );
  assert.equal(
    insertCalls[0]?.payload[0]?.source_creator_name,
    "Local Guide"
  );
});

test("insertPreparedCustomRouteStops retries without source_preview_image_url when schema cache is stale", async () => {
  const { admin, insertCalls } = createFakeAdmin({
    stopInsertErrors: [
      { message: "Could not find the 'source_preview_image_url' column of 'custom_route_stops' in the schema cache" },
      null,
    ],
  });

  await insertPreparedCustomRouteStops({
    admin,
    routeId: "route-1",
    stops: TEST_STOPS,
  });

  assert.equal(insertCalls.length, 2);
  assert.equal(
    insertCalls[0]?.payload[0]?.source_preview_image_url,
    "https://example.com/instagram-image.jpg"
  );
  assert.equal("source_preview_image_url" in (insertCalls[1]?.payload[0] ?? {}), false);
  assert.equal(
    insertCalls[1]?.payload[0]?.source_creator_name,
    "Local Guide"
  );
});

test("insertPreparedCustomRouteStops does not retry unrelated source column failures", async () => {
  const { admin, insertCalls } = createFakeAdmin({
    stopInsertErrors: [
      { message: "Could not find the 'source_creator_name' column of 'custom_route_stops' in the schema cache" },
    ],
  });

  await assert.rejects(
    insertPreparedCustomRouteStops({
      admin,
      routeId: "route-1",
      stops: TEST_STOPS,
    }),
    /source_creator_name/
  );

  assert.equal(insertCalls.length, 1);
});
