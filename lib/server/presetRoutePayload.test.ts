import test from "node:test";
import assert from "node:assert/strict";
import { getRouteById } from "@/app/content/salemRoutes";
import { loadPresetRoutePayload } from "@/lib/server/presetRoutePayload";

test("loadPresetRoutePayload exposes google place ids for preset stops without admin access", async (t) => {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  t.after(() => {
    if (typeof originalUrl === "string") {
      process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    } else {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    }

    if (typeof originalKey === "string") {
      process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
    } else {
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    }
  });

  const routeId = "boston-revolutionary-secrets";
  const route = getRouteById(routeId);
  assert.ok(route);

  const expectedStop = route.stops.find((stop) => typeof stop.googlePlaceId === "string" && stop.googlePlaceId.trim());
  assert.ok(expectedStop);

  const payload = await loadPresetRoutePayload(routeId, route.city);
  assert.ok(payload);

  const payloadStop = payload.stops.find((stop) => stop.stop_id === expectedStop.id);
  assert.ok(payloadStop);
  assert.equal(payloadStop.google_place_id, expectedStop.googlePlaceId);
});
