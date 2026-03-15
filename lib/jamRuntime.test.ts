import test from "node:test";
import assert from "node:assert/strict";
import {
  createJamPerfTracker,
  shouldCommitGeoUpdate,
  shouldRunJamGeoTracking,
  shouldRunWalkDiscoveryWork,
} from "@/lib/jamRuntime";

test("hidden tabs suspend active geo and walk discovery work", () => {
  assert.equal(shouldRunJamGeoTracking("walk", "hidden"), false);
  assert.equal(shouldRunJamGeoTracking("followAlongDrive", "hidden"), false);
  assert.equal(shouldRunWalkDiscoveryWork("hidden", true), false);
});

test("visible tabs re-enable active geo and discovery work", () => {
  assert.equal(shouldRunJamGeoTracking("walk", "visible"), true);
  assert.equal(shouldRunJamGeoTracking("followAlongDrive", "visible"), true);
  assert.equal(shouldRunJamGeoTracking("idle", "visible"), false);
  assert.equal(shouldRunWalkDiscoveryWork("visible", true), true);
});

test("geo commits are skipped when movement and elapsed time stay below thresholds", () => {
  const decision = shouldCommitGeoUpdate(
    { lat: 42.36, lng: -71.05, timestamp: 1_000 },
    { lat: 42.36002, lng: -71.05002, timestamp: 2_000 }
  );

  assert.equal(decision.shouldCommit, false);
  assert.ok(decision.elapsedMs < 4_000);
  assert.ok(decision.distanceMeters < 15);
});

test("geo commits happen when elapsed time or movement crosses thresholds", () => {
  const moved = shouldCommitGeoUpdate(
    { lat: 42.36, lng: -71.05, timestamp: 1_000 },
    { lat: 42.3603, lng: -71.05, timestamp: 2_000 }
  );
  const delayed = shouldCommitGeoUpdate(
    { lat: 42.36, lng: -71.05, timestamp: 1_000 },
    { lat: 42.36001, lng: -71.05001, timestamp: 5_500 }
  );

  assert.equal(moved.shouldCommit, true);
  assert.ok(moved.distanceMeters >= 15);
  assert.equal(delayed.shouldCommit, true);
  assert.ok(delayed.elapsedMs >= 4_000);
});

test("perf tracker aggregates counters and timings only when enabled", () => {
  const logs: unknown[] = [];
  let nowValue = 0;
  const tracker = createJamPerfTracker({
    enabled: true,
    now: () => nowValue,
    logger: (...args) => logs.push(args),
  });

  tracker.count("walk_geo_ticks");
  nowValue = 12;
  tracker.timing("route_reload_ms", 12);
  tracker.flush("test");

  assert.equal(logs.length, 1);
  const [, payload] = logs[0] as [string, { counters: Record<string, number> }];
  assert.equal(payload.counters.walk_geo_ticks, 1);
});
