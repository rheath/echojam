import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGoogleMapsDirectionsUrl,
  buildRouteLookupPlan,
  buildRoutePathRequest,
  resolveVisibleRouteCoords,
} from "./routePath.ts";

test("buildRouteLookupPlan prefers provided route coords over a Google lookup", () => {
  const providedRouteCoords: [number, number][] = [
    [-71.06, 42.36],
    [-71.05, 42.37],
  ];

  const plan = buildRouteLookupPlan({
    providedRouteCoords,
    showRoutePath: true,
    routeTravelMode: "drive",
    stops: [
      { lat: 42.36, lng: -71.06 },
      { lat: 42.37, lng: -71.05 },
    ],
  });

  assert.deepEqual(plan, {
    kind: "provided",
    coords: providedRouteCoords,
  });
});

test("buildRoutePathRequest creates a walking request from stops", () => {
  const request = buildRoutePathRequest({
    stops: [
      { lat: 42.3601, lng: -71.0589 },
      { lat: 42.3615, lng: -71.055 },
    ],
    routeTravelMode: "walk",
  });

  assert.deepEqual(request, {
    origin: { lat: 42.3601, lng: -71.0589 },
    destination: { lat: 42.3615, lng: -71.055 },
    travelMode: "WALKING",
    fields: ["path"],
  });
});

test("buildRoutePathRequest creates a driving request from endpoints without stops", () => {
  const request = buildRoutePathRequest({
    stops: [],
    endpoints: {
      origin: { lat: 42.36, lng: -71.06 },
      destination: { lat: 42.37, lng: -71.04 },
    },
    routeTravelMode: "drive",
  });

  assert.deepEqual(request, {
    origin: { lat: 42.36, lng: -71.06 },
    destination: { lat: 42.37, lng: -71.04 },
    travelMode: "DRIVE",
    fields: ["path"],
  });
});

test("buildRoutePathRequest keeps interior stops as intermediates when endpoints are present", () => {
  const request = buildRoutePathRequest({
    stops: [
      { lat: 42.362, lng: -71.058 },
      { lat: 42.364, lng: -71.056 },
      { lat: 42.366, lng: -71.054 },
    ],
    endpoints: {
      origin: { lat: 42.36, lng: -71.06 },
      destination: { lat: 42.37, lng: -71.05 },
    },
    routeTravelMode: "drive",
  });

  assert.deepEqual(request, {
    origin: { lat: 42.36, lng: -71.06 },
    destination: { lat: 42.37, lng: -71.05 },
    intermediates: [
      { location: { lat: 42.362, lng: -71.058 } },
      { location: { lat: 42.364, lng: -71.056 } },
      { location: { lat: 42.366, lng: -71.054 } },
    ],
    travelMode: "DRIVE",
    fields: ["path"],
  });
});

test("buildRoutePathRequest removes duplicate boundary points before creating intermediates", () => {
  const request = buildRoutePathRequest({
    stops: [
      { lat: 42.36, lng: -71.06 },
      { lat: 42.365, lng: -71.055 },
      { lat: 42.37, lng: -71.05 },
    ],
    endpoints: {
      origin: { lat: 42.36, lng: -71.06 },
      destination: { lat: 42.37, lng: -71.05 },
    },
    routeTravelMode: "walk",
  });

  assert.deepEqual(request, {
    origin: { lat: 42.36, lng: -71.06 },
    destination: { lat: 42.37, lng: -71.05 },
    intermediates: [{ location: { lat: 42.365, lng: -71.055 } }],
    travelMode: "WALKING",
    fields: ["path"],
  });
});

test("buildGoogleMapsDirectionsUrl uses only interior stops as waypoints", () => {
  const url = new URL(
    buildGoogleMapsDirectionsUrl({
      stops: [
        { lat: 42.3601, lng: -71.0589 },
        { lat: 42.3615, lng: -71.055 },
        { lat: 42.363, lng: -71.052 },
      ],
      routeTravelMode: "walk",
    })
  );

  assert.equal(url.searchParams.get("origin"), "42.3601,-71.0589");
  assert.equal(url.searchParams.get("destination"), "42.363,-71.052");
  assert.equal(url.searchParams.get("waypoints"), "42.3615,-71.055");
  assert.equal(url.searchParams.get("travelmode"), "walking");
});

test("buildGoogleMapsDirectionsUrl omits duplicate endpoint waypoints when explicit endpoints match stops", () => {
  const url = new URL(
    buildGoogleMapsDirectionsUrl({
      stops: [
        { lat: 42.36, lng: -71.06 },
        { lat: 42.365, lng: -71.055 },
        { lat: 42.37, lng: -71.05 },
      ],
      endpoints: {
        origin: { lat: 42.36, lng: -71.06 },
        destination: { lat: 42.37, lng: -71.05 },
      },
      routeTravelMode: "drive",
    })
  );

  assert.equal(url.searchParams.get("origin"), "42.36,-71.06");
  assert.equal(url.searchParams.get("destination"), "42.37,-71.05");
  assert.equal(url.searchParams.get("waypoints"), "42.365,-71.055");
  assert.equal(url.searchParams.get("travelmode"), "driving");
});

test("buildGoogleMapsDirectionsUrl keeps an arrival stop as the destination instead of a waypoint", () => {
  const url = new URL(
    buildGoogleMapsDirectionsUrl({
      stops: [
        { lat: 42.36, lng: -71.06 },
        { lat: 42.365, lng: -71.055 },
        { lat: 42.37, lng: -71.05 },
      ],
      endpoints: {
        destination: { lat: 42.37, lng: -71.05 },
      },
      routeTravelMode: "walk",
    })
  );

  assert.equal(url.searchParams.get("origin"), "42.36,-71.06");
  assert.equal(url.searchParams.get("destination"), "42.37,-71.05");
  assert.equal(url.searchParams.get("waypoints"), "42.365,-71.055");
});

test("buildGoogleMapsDirectionsUrl falls back when there are not enough route points", () => {
  const url = buildGoogleMapsDirectionsUrl({
    stops: [{ lat: 42.36, lng: -71.06 }],
    routeTravelMode: "walk",
  });

  assert.equal(url, "#");
});

test("buildRouteLookupPlan falls back when routed paths cannot be requested", () => {
  const plan = buildRouteLookupPlan({
    showRoutePath: true,
    routeTravelMode: null,
    stops: [
      { lat: 42.36, lng: -71.06 },
      { lat: 42.37, lng: -71.05 },
    ],
  });

  assert.deepEqual(plan, { kind: "fallback" });
});

test("resolveVisibleRouteCoords falls back to straight stop lines after a route failure", () => {
  const coords = resolveVisibleRouteCoords(
    [
      { lat: 42.36, lng: -71.06 },
      { lat: 42.37, lng: -71.05 },
      { lat: 42.38, lng: -71.04 },
    ],
    null,
    "failed"
  );

  assert.deepEqual(coords, [
    [-71.06, 42.36],
    [-71.05, 42.37],
    [-71.04, 42.38],
  ]);
});
