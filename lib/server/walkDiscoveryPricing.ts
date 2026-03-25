export type WalkDiscoveryPricingConfig = {
  includedStopCount: number;
  extraStopMode: "free" | "paid";
  extraStopAmountUsdCents: number | null;
};

export type WalkDiscoverySuggestionPricing = {
  isIncluded: boolean;
  isFree: boolean;
  amountUsdCents: number | null;
  priceLabel: string;
  purchaseKey: string;
};

function parsePositiveInt(raw: string | undefined, fallback: number) {
  const parsed = Number.parseInt((raw || "").trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function formatUsdCents(amountUsdCents: number | null | undefined) {
  if (typeof amountUsdCents !== "number" || !Number.isFinite(amountUsdCents)) return "Paid";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: amountUsdCents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amountUsdCents / 100);
}

export function getWalkDiscoveryPricingConfig(): WalkDiscoveryPricingConfig {
  const includedStopCount = Math.max(
    1,
    parsePositiveInt(process.env.WALK_DISCOVERY_INCLUDED_STOP_COUNT, 1)
  );
  const extraStopAmountUsdCents = parsePositiveInt(
    process.env.WALK_DISCOVERY_EXTRA_STOP_PRICE_USD_CENTS,
    0
  );

  if (extraStopAmountUsdCents <= 0) {
    return {
      includedStopCount,
      extraStopMode: "free",
      extraStopAmountUsdCents: null,
    };
  }

  return {
    includedStopCount,
    extraStopMode: "paid",
    extraStopAmountUsdCents,
  };
}

export function resolveWalkDiscoverySuggestionPricing(args: {
  acceptedStopCount: number;
  purchaseKey: string;
  config?: WalkDiscoveryPricingConfig;
}): WalkDiscoverySuggestionPricing {
  const config = args.config ?? getWalkDiscoveryPricingConfig();
  const isIncluded = args.acceptedStopCount < config.includedStopCount;
  const isFree = isIncluded || config.extraStopMode === "free";

  if (isIncluded) {
    return {
      isIncluded: true,
      isFree: true,
      amountUsdCents: null,
      priceLabel: "Included",
      purchaseKey: args.purchaseKey,
    };
  }

  if (isFree) {
    return {
      isIncluded: false,
      isFree: true,
      amountUsdCents: null,
      priceLabel: "Free",
      purchaseKey: args.purchaseKey,
    };
  }

  return {
    isIncluded: false,
    isFree: false,
    amountUsdCents: config.extraStopAmountUsdCents,
    priceLabel: formatUsdCents(config.extraStopAmountUsdCents),
    purchaseKey: args.purchaseKey,
  };
}
