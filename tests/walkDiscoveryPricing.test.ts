import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import { resolveWalkDiscoverySuggestionPricing } from "../lib/server/walkDiscoveryPricing.ts";

test("the first Wander stop stays included even when paid pricing is enabled", () => {
  const pricing = resolveWalkDiscoverySuggestionPricing({
    acceptedStopCount: 0,
    purchaseKey: "purchase-1",
    config: {
      includedStopCount: 1,
      extraStopMode: "paid",
      extraStopAmountUsdCents: 199,
    },
  });

  assert.deepEqual(pricing, {
    isIncluded: true,
    isFree: true,
    amountUsdCents: null,
    priceLabel: "Included",
    purchaseKey: "purchase-1",
  });
});

test("later Wander stops become paid when a global price is configured", () => {
  const pricing = resolveWalkDiscoverySuggestionPricing({
    acceptedStopCount: 1,
    purchaseKey: "purchase-2",
    config: {
      includedStopCount: 1,
      extraStopMode: "paid",
      extraStopAmountUsdCents: 199,
    },
  });

  assert.equal(pricing.isIncluded, false);
  assert.equal(pricing.isFree, false);
  assert.equal(pricing.amountUsdCents, 199);
  assert.equal(pricing.priceLabel, "$1.99");
  assert.equal(pricing.purchaseKey, "purchase-2");
});

test("later Wander stops can be globally switched back to free", () => {
  const pricing = resolveWalkDiscoverySuggestionPricing({
    acceptedStopCount: 3,
    purchaseKey: "purchase-3",
    config: {
      includedStopCount: 1,
      extraStopMode: "free",
      extraStopAmountUsdCents: null,
    },
  });

  assert.deepEqual(pricing, {
    isIncluded: false,
    isFree: true,
    amountUsdCents: null,
    priceLabel: "Free",
    purchaseKey: "purchase-3",
  });
});
