import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import {
  buildMixedComposerCreateMixRequest,
  loadLatestMixedComposerPublishTarget,
  normalizeMixedComposerPublishTarget,
} from "../lib/mixedComposerPublish.ts";

function createFakeAdmin(rows: Array<{ id: string; jam_id: string }>) {
  class FakeQuery {
    table: string;
    orderedRows = rows.slice();

    constructor(table: string) {
      this.table = table;
    }

    select() {
      return this;
    }

    eq() {
      return this;
    }

    order(column?: unknown, options?: { ascending?: boolean }) {
      if (this.table === "custom_routes" && column === "updated_at") {
        const ascending = options?.ascending ?? true;
        this.orderedRows.sort((left, right) =>
          ascending ? left.id.localeCompare(right.id) : right.id.localeCompare(left.id)
        );
      }
      return this;
    }

    limit(count?: number) {
      if (typeof count === "number") {
        this.orderedRows = this.orderedRows.slice(0, count);
      }
      return this;
    }

    async maybeSingle() {
      return { data: this.orderedRows[0] ?? null, error: null };
    }
  }

  return {
    from(table: string) {
      return new FakeQuery(table);
    },
  } as unknown as SupabaseClient;
}

test("loadLatestMixedComposerPublishTarget returns the most recently updated route for a session", async () => {
  const admin = createFakeAdmin([
    { id: "route-a", jam_id: "jam-a" },
    { id: "route-z", jam_id: "jam-z" },
  ]);

  const target = await loadLatestMixedComposerPublishTarget(admin, "session-123");

  assert.deepEqual(target, { jamId: "jam-z", routeId: "route-z" });
});

test("buildMixedComposerCreateMixRequest includes the existing jam when republishing a mixed session", () => {
  const request = buildMixedComposerCreateMixRequest({
    mixedComposerSessionId: "session-123",
    publishTarget: { jamId: "jam-a", routeId: "route-a" },
    city: "nearby",
    transportMode: "walk",
    lengthMinutes: 30,
    persona: "adult",
    narratorGuidance: null,
    source: "manual",
    routeTitle: "North End Mix",
    routeAttribution: null,
    stops: [
      {
        id: "stop-1",
        title: "Paul Revere House",
        lat: 42.3637,
        lng: -71.0537,
        image: "/images/paul-revere.jpg",
      },
    ],
  });

  assert.equal(request.jamId, "jam-a");
  assert.equal(request.mixedComposerSessionId, "session-123");
  assert.equal(request.stops[0]?.id, "stop-1");
});

test("normalizeMixedComposerPublishTarget rejects incomplete publish results", () => {
  assert.equal(normalizeMixedComposerPublishTarget({ jamId: "jam-a", routeId: null }), null);
  assert.deepEqual(normalizeMixedComposerPublishTarget({ jamId: " jam-a ", routeId: " route-a " }), {
    jamId: "jam-a",
    routeId: "route-a",
  });
});
