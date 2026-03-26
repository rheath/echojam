import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPlaceLocationLabel,
  type GooglePlaceAddressComponent,
} from "@/lib/server/placeLocationLabel";

function makeComponent(
  types: string[],
  longText: string,
  shortText?: string
): GooglePlaceAddressComponent {
  return {
    types,
    longText,
    shortText,
  };
}

test("buildPlaceLocationLabel renders city and state for US places", () => {
  const label = buildPlaceLocationLabel({
    addressComponents: [
      makeComponent(["locality"], "Boston"),
      makeComponent(["administrative_area_level_1"], "Massachusetts", "MA"),
      makeComponent(["country"], "United States", "US"),
    ],
    formattedAddress: "1 Main St, Boston, MA 02108, USA",
  });

  assert.equal(label, "Boston, MA");
});

test("buildPlaceLocationLabel renders city and country for international places", () => {
  const label = buildPlaceLocationLabel({
    addressComponents: [
      makeComponent(["locality"], "Paris"),
      makeComponent(["country"], "France", "FR"),
    ],
    formattedAddress: "10 Rue de Rivoli, 75001 Paris, France",
  });

  assert.equal(label, "Paris, France");
});

test("buildPlaceLocationLabel falls back to region and country when city is missing", () => {
  const label = buildPlaceLocationLabel({
    addressComponents: [
      makeComponent(["administrative_area_level_1"], "Ile-de-France", "IDF"),
      makeComponent(["country"], "France", "FR"),
    ],
    formattedAddress: "France",
  });

  assert.equal(label, "Ile-de-France, France");
});

test("buildPlaceLocationLabel shortens formattedAddress when components are missing", () => {
  const label = buildPlaceLocationLabel({
    formattedAddress: "1 Main St, Boston, MA 02108, USA",
  });

  assert.equal(label, "Boston, MA");
});

test("buildPlaceLocationLabel returns null for empty input", () => {
  const label = buildPlaceLocationLabel({
    addressComponents: null,
    formattedAddress: null,
  });

  assert.equal(label, null);
});
