import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import { prepareCustomRouteJob } from "../lib/customRouteGeneration.ts";

type TableState = {
  jamInsertPersona: string | null;
  jamUpdatePersona: string | null;
  customRouteInsert: Record<string, unknown> | null;
  customRouteUpdate: Record<string, unknown> | null;
  customRouteStopsInsert: Array<Record<string, unknown>> | null;
  mixJobInsert: Record<string, unknown> | null;
  existingRouteIdByJamId: string | null;
  jamInsertCount: number;
};

function createFakeAdmin(state: TableState) {
  class FakeQuery {
    action: "select" | "insert" | "update" | "delete" | null = null;
    payload: unknown = null;
    table: string;

    constructor(table: string) {
      this.table = table;
    }

    select() {
      if (this.action === null) {
        this.action = "select";
      }
      return this;
    }

    insert(payload: unknown) {
      this.action = "insert";
      this.payload = payload;
      if (this.table === "jams" && !Array.isArray(payload)) {
        state.jamInsertPersona = String((payload as { persona?: string }).persona ?? null);
      }
      if (this.table === "custom_routes" && !Array.isArray(payload)) {
        state.customRouteInsert = payload as Record<string, unknown>;
      }
      if (this.table === "custom_route_stops" && Array.isArray(payload)) {
        state.customRouteStopsInsert = payload as Array<Record<string, unknown>>;
      }
      if (this.table === "mix_generation_jobs" && !Array.isArray(payload)) {
        state.mixJobInsert = payload as Record<string, unknown>;
      }
      return this;
    }

    update(payload: unknown) {
      this.action = "update";
      this.payload = payload;
      if (this.table === "jams" && !Array.isArray(payload)) {
        state.jamUpdatePersona = String((payload as { persona?: string }).persona ?? null);
      }
      if (this.table === "custom_routes" && !Array.isArray(payload)) {
        state.customRouteUpdate = payload as Record<string, unknown>;
      }
      return this;
    }

    delete() {
      this.action = "delete";
      return this;
    }

    eq() {
      return this;
    }

    in() {
      return this;
    }

    order() {
      return this;
    }

    limit() {
      return this;
    }

    async maybeSingle() {
      if (this.table === "mix_generation_jobs" && this.action === "select") {
        return { data: null, error: null };
      }
      if (this.table === "jams" && this.action === "select") {
        return {
          data: {
            route_id: state.existingRouteIdByJamId
              ? `custom:${state.existingRouteIdByJamId}`
              : null,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    }

    async single() {
      if (this.table === "jams" && this.action === "insert") {
        state.jamInsertCount += 1;
        return { data: { id: "jam-1" }, error: null };
      }
      if (this.table === "custom_routes" && this.action === "insert") {
        return { data: { id: "route-1" }, error: null };
      }
      if (this.table === "mix_generation_jobs" && this.action === "insert") {
        return { data: { id: "job-1" }, error: null };
      }
      return { data: null, error: null };
    }

    then(resolve: (value: { data: null; error: null }) => unknown) {
      return Promise.resolve({ data: null, error: null }).then(resolve);
    }
  }

  return {
    from(table: string) {
      return new FakeQuery(table);
    },
  } as unknown as SupabaseClient;
}

function createBaseState(): TableState {
  return {
    jamInsertPersona: null,
    jamUpdatePersona: null,
    customRouteInsert: null,
    customRouteUpdate: null,
    customRouteStopsInsert: null,
    mixJobInsert: null,
    existingRouteIdByJamId: null,
    jamInsertCount: 0,
  };
}

const TEST_STOPS = [
  {
    id: "stop-1",
    title: "Old State House",
    lat: 42.3588,
    lng: -71.0579,
    image: "/images/state-house.jpg",
  },
  {
    id: "stop-2",
    title: "Faneuil Hall",
    lat: 42.3600,
    lng: -71.0568,
    image: "/images/faneuil.jpg",
  },
];

test("prepareCustomRouteJob falls back to AI Historian when custom guidance is blank", async () => {
  const state = createBaseState();
  const prepared = await prepareCustomRouteJob({
    admin: createFakeAdmin(state),
    city: "boston",
    transportMode: "walk",
    lengthMinutes: 30,
    persona: "custom",
    narratorGuidance: "   ",
    stops: TEST_STOPS,
  });

  assert.equal(prepared.persona, "adult");
  assert.equal(prepared.narratorGuidance, null);
  assert.equal(state.jamInsertPersona, "adult");
  assert.equal(state.jamUpdatePersona, "adult");
  assert.equal(state.customRouteInsert?.narrator_default, "adult");
  assert.equal(state.customRouteInsert?.narrator_guidance, null);
  assert.equal(state.customRouteInsert?.narrator_voice, null);
});

test("prepareCustomRouteJob keeps custom narrator when guidance is provided", async () => {
  const state = createBaseState();
  const prepared = await prepareCustomRouteJob({
    admin: createFakeAdmin(state),
    mixedComposerSessionId: "session-123",
    city: "boston",
    transportMode: "walk",
    lengthMinutes: 30,
    persona: "custom",
    narratorGuidance: "Warm storyteller for architecture-loving adults.",
    stops: TEST_STOPS,
  });

  assert.equal(prepared.persona, "custom");
  assert.equal(prepared.narratorGuidance, "Warm storyteller for architecture-loving adults.");
  assert.equal(state.jamInsertPersona, "custom");
  assert.equal(state.jamUpdatePersona, "custom");
  assert.equal(state.customRouteInsert?.narrator_default, "custom");
  assert.equal(
    state.customRouteInsert?.narrator_guidance,
    "Warm storyteller for architecture-loving adults."
  );
  assert.equal(state.customRouteInsert?.mixed_composer_session_id, "session-123");
  assert.match(String(state.customRouteInsert?.narrator_voice), /^(alloy|nova|shimmer|onyx)$/);
});

test("prepareCustomRouteJob reuses the existing route when jamId is provided", async () => {
  const state = createBaseState();
  state.existingRouteIdByJamId = "route-existing";

  const prepared = await prepareCustomRouteJob({
    admin: createFakeAdmin(state),
    jamId: "jam-1",
    mixedComposerSessionId: "session-123",
    city: "boston",
    transportMode: "walk",
    lengthMinutes: 30,
    persona: "adult",
    stops: TEST_STOPS,
  });

  assert.equal(prepared.jamId, "jam-1");
  assert.equal(prepared.routeId, "route-existing");
  assert.equal(state.jamInsertCount, 0);
  assert.equal(state.customRouteInsert, null);
  assert.equal(state.customRouteUpdate?.mixed_composer_session_id, "session-123");
  assert.equal(state.mixJobInsert?.jam_id, "jam-1");
  assert.equal(state.mixJobInsert?.route_id, "route-existing");
});

test("prepareCustomRouteJob creates a new revision when requested for an existing jam", async () => {
  const state = createBaseState();
  state.existingRouteIdByJamId = "route-live";

  const prepared = await prepareCustomRouteJob({
    admin: createFakeAdmin(state),
    jamId: "jam-1",
    mixedComposerSessionId: "session-123",
    ownerUserId: "user-123",
    createRouteRevision: true,
    city: "boston",
    transportMode: "walk",
    lengthMinutes: 30,
    persona: "adult",
    stops: TEST_STOPS,
  });

  assert.equal(prepared.jamId, "jam-1");
  assert.equal(prepared.routeId, "route-1");
  assert.equal(state.customRouteInsert?.base_route_id, "route-live");
  assert.equal(state.customRouteInsert?.is_live, false);
  assert.equal(state.customRouteInsert?.owner_user_id, "user-123");
  assert.equal(state.jamUpdatePersona, "adult");
});
