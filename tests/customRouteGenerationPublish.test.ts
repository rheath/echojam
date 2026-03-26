import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import {
  runCustomRouteGeneration,
  shouldReuseCanonicalAudioForRouteScript,
  shouldTreatPrefilledScriptAsFinal,
} from "../lib/customRouteGeneration.ts";

type CanonicalAssetRow = {
  script: string | null;
  audio_url: string | null;
  status?: string | null;
  error?: string | null;
};

type FakeState = {
  canonicalStops: Array<Record<string, unknown>>;
  canonicalAssets: Map<string, CanonicalAssetRow>;
  customRouteStops: Map<string, Record<string, unknown>>;
  mixJobUpdates: Array<Record<string, unknown>>;
  customRouteUpdates: Array<Record<string, unknown>>;
  routeStopMappings: Array<Record<string, unknown>>;
  canonicalAssetUpserts: Array<Record<string, unknown>>;
  customRouteStopUpdates: Array<{ key: string; payload: Record<string, unknown> }>;
};

function createCanonicalStopId(city: string, stop: { title: string; lat: number; lng: number }) {
  const key = `${city}|${stop.title.toLowerCase()}|${stop.lat.toFixed(6)}|${stop.lng.toFixed(6)}`;
  return `canon-custom-${createHash("sha1").update(key).digest("hex").slice(0, 20)}`;
}

function createAssetKey(canonicalStopId: string, persona: string) {
  return `${canonicalStopId}:${persona}`;
}

function createRouteStopKey(routeId: string, stopId: string) {
  return `${routeId}:${stopId}`;
}

function createFakeState(): FakeState {
  return {
    canonicalStops: [],
    canonicalAssets: new Map(),
    customRouteStops: new Map(),
    mixJobUpdates: [],
    customRouteUpdates: [],
    routeStopMappings: [],
    canonicalAssetUpserts: [],
    customRouteStopUpdates: [],
  };
}

function createFakeAdmin(state: FakeState) {
  class FakeQuery {
    action: "select" | "insert" | "update" | "delete" | "upsert" | null = null;
    payload: unknown = null;
    filters = new Map<string, unknown>();
    table: string;

    constructor(table: string) {
      this.table = table;
    }

    select() {
      if (this.action === null) this.action = "select";
      return this;
    }

    insert(payload: unknown) {
      this.action = "insert";
      this.payload = payload;
      return this;
    }

    update(payload: unknown) {
      this.action = "update";
      this.payload = payload;
      return this;
    }

    upsert(payload: unknown) {
      this.action = "upsert";
      this.payload = payload;
      return this;
    }

    delete() {
      this.action = "delete";
      return this;
    }

    eq(column?: unknown, value?: unknown) {
      if (typeof column === "string") {
        this.filters.set(column, value);
      }
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

    maybeSingle() {
      return this.execute(true);
    }

    single() {
      return this.execute(true);
    }

    then(
      resolve: (value: { data: unknown; error: null }) => unknown,
      reject?: (reason: unknown) => unknown
    ) {
      return this.execute(false).then(resolve, reject);
    }

    private async execute(expectSingle: boolean) {
      if (this.table === "canonical_stops") {
        if (this.action === "select") {
          const id = this.filters.get("id");
          const city = this.filters.get("city");
          const googlePlaceId = this.filters.get("google_place_id");
          let rows = state.canonicalStops.slice();
          if (typeof id === "string") rows = rows.filter((row) => row.id === id);
          if (typeof city === "string") rows = rows.filter((row) => row.city === city);
          if (typeof googlePlaceId === "string") {
            rows = rows.filter((row) => row.google_place_id === googlePlaceId);
          }
          return { data: expectSingle ? (rows[0] ?? null) : rows, error: null };
        }

        if (this.action === "insert" && this.payload && !Array.isArray(this.payload)) {
          const row = { ...(this.payload as Record<string, unknown>) };
          state.canonicalStops.push(row);
          return { data: row, error: null };
        }
      }

      if (this.table === "canonical_stop_assets") {
        const key = createAssetKey(
          String(this.filters.get("canonical_stop_id") ?? ""),
          String(this.filters.get("persona") ?? "")
        );

        if (this.action === "select") {
          return {
            data: state.canonicalAssets.get(key) ?? null,
            error: null,
          };
        }

        if ((this.action === "upsert" || this.action === "insert") && this.payload && !Array.isArray(this.payload)) {
          const row = this.payload as Record<string, unknown>;
          const nextKey = createAssetKey(
            String(row.canonical_stop_id ?? ""),
            String(row.persona ?? "")
          );
          state.canonicalAssets.set(nextKey, {
            script: (row.script as string | null | undefined) ?? null,
            audio_url: (row.audio_url as string | null | undefined) ?? null,
            status: (row.status as string | null | undefined) ?? null,
            error: (row.error as string | null | undefined) ?? null,
          });
          state.canonicalAssetUpserts.push(row);
          return { data: null, error: null };
        }
      }

      if (this.table === "custom_route_stops" && this.action === "update" && this.payload && !Array.isArray(this.payload)) {
        const routeId = String(this.filters.get("route_id") ?? "");
        const stopId = String(this.filters.get("stop_id") ?? "");
        const key = createRouteStopKey(routeId, stopId);
        const current = state.customRouteStops.get(key) ?? { route_id: routeId, stop_id: stopId };
        const next = { ...current, ...(this.payload as Record<string, unknown>) };
        state.customRouteStops.set(key, next);
        state.customRouteStopUpdates.push({
          key,
          payload: this.payload as Record<string, unknown>,
        });
        return { data: null, error: null };
      }

      if (this.table === "mix_generation_jobs" && this.action === "update" && this.payload && !Array.isArray(this.payload)) {
        state.mixJobUpdates.push(this.payload as Record<string, unknown>);
        return { data: null, error: null };
      }

      if (this.table === "custom_routes" && this.action === "update" && this.payload && !Array.isArray(this.payload)) {
        state.customRouteUpdates.push(this.payload as Record<string, unknown>);
        return { data: null, error: null };
      }

      if (this.table === "route_stop_mappings" && this.action === "upsert" && this.payload && !Array.isArray(this.payload)) {
        state.routeStopMappings.push(this.payload as Record<string, unknown>);
        return { data: null, error: null };
      }

      return { data: expectSingle ? null : [], error: null };
    }
  }

  return {
    from(table: string) {
      return new FakeQuery(table);
    },
  } as unknown as SupabaseClient;
}

test("prefilled mix scripts are treated as final publish input", () => {
  assert.equal(shouldTreatPrefilledScriptAsFinal("mix", "Imported final script"), true);
  assert.equal(shouldTreatPrefilledScriptAsFinal("mix", "   "), false);
  assert.equal(shouldTreatPrefilledScriptAsFinal("follow_along", "Imported final script"), false);
});

test("canonical audio is reused only when the route script still matches the canonical script", () => {
  assert.equal(
    shouldReuseCanonicalAudioForRouteScript({
      experienceKind: "mix",
      isCustomNarrator: false,
      forceAudio: false,
      currentScript: "Imported final script",
      canonicalScript: "Imported final script",
    }),
    true
  );

  assert.equal(
    shouldReuseCanonicalAudioForRouteScript({
      experienceKind: "mix",
      isCustomNarrator: false,
      forceAudio: false,
      currentScript: "Imported final script",
      canonicalScript: "Different canonical script",
    }),
    false
  );
});

test("runCustomRouteGeneration persists prefilled mix scripts directly and skips publish-time OpenAI calls when canonical audio matches", async () => {
  const state = createFakeState();
  const stop = {
    id: "stop-1",
    title: "Old State House",
    lat: 42.3588,
    lng: -71.0579,
    image: "/images/state-house.jpg",
    prefilledScript: "Imported final script",
    scriptEditedByUser: false,
  };
  const canonicalStopId = createCanonicalStopId("nearby", stop);
  const routeStopKey = createRouteStopKey("route-1", stop.id);
  state.customRouteStops.set(routeStopKey, {
    route_id: "route-1",
    stop_id: stop.id,
    script_adult: null,
    audio_url_adult: null,
  });
  state.canonicalAssets.set(createAssetKey(canonicalStopId, "adult"), {
    script: "Imported final script",
    audio_url: "https://example.com/canonical-audio.mp3",
    status: "ready",
    error: null,
  });

  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  let fetchCalls = 0;

  try {
    global.fetch = async () => {
      fetchCalls += 1;
      throw new Error("Unexpected publish-time network call");
    };

    await runCustomRouteGeneration(
      createFakeAdmin(state),
      "job-1",
      "route-1",
      "nearby",
      "walk",
      30,
      "mix",
      "adult",
      [stop],
      null
    );

    assert.equal(fetchCalls, 0);
    assert.equal(state.routeStopMappings.length, 1);
    assert.deepEqual(state.customRouteStopUpdates[0]?.payload, {
      script_adult: "Imported final script",
    });
    assert.equal(
      state.customRouteStops.get(routeStopKey)?.script_adult,
      "Imported final script"
    );
    assert.equal(
      state.customRouteStops.get(routeStopKey)?.audio_url_adult,
      "https://example.com/canonical-audio.mp3"
    );
    assert.equal(state.canonicalAssetUpserts.length, 1);
    assert.equal(
      state.canonicalAssetUpserts[0]?.audio_url,
      "https://example.com/canonical-audio.mp3"
    );
    assert.deepEqual(state.customRouteUpdates.at(-1), { status: "ready" });
    assert.deepEqual(state.mixJobUpdates.at(-1), {
      status: "ready",
      progress: 100,
      message: "Tour ready",
      error: null,
    });
  } finally {
    global.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalApiKey;
  }
});
