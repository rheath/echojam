import { z } from "zod";
type Persona = "adult" | "preteen" | "ghost";
type PresetCity = "salem" | "boston" | "concord" | "nyc";
type PresetRoutePricingStatus = "free" | "paid" | "tbd";
type PresetContentPriority = "default" | "history_first";

const PERSONAS = ["adult", "preteen", "ghost"] as const satisfies readonly Persona[];
const CITIES = ["salem", "boston", "concord", "nyc"] as const satisfies readonly PresetCity[];
const PRICING_STATUSES = ["free", "paid", "tbd"] as const satisfies readonly PresetRoutePricingStatus[];
const CONTENT_PRIORITIES = ["default", "history_first"] as const satisfies readonly PresetContentPriority[];

const NonEmptyTrimmedStringArraySchema = z.array(z.string().trim().min(1)).min(1);

const PresetRoutePricingSchema = z
  .object({
    status: z.enum(PRICING_STATUSES),
    displayLabel: z.string().trim().min(1).optional(),
    amountUsdCents: z.number().int().nonnegative().nullable().optional(),
  })
  .superRefine((pricing, ctx) => {
    if (pricing.status !== "paid" && pricing.amountUsdCents != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amountUsdCents"],
        message: "amountUsdCents is only allowed when status is paid",
      });
    }

    if (pricing.status === "paid" && pricing.amountUsdCents == null && !pricing.displayLabel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["displayLabel"],
        message: "Paid pricing requires amountUsdCents or displayLabel",
      });
    }
  });

const PresetStopSeedSchema = z.object({
  placeId: z.string().trim().min(1),
  title: z.string().trim().min(1).optional(),
  narratorGuidance: z.string().trim().min(1).optional(),
  mustMention: NonEmptyTrimmedStringArraySchema.optional(),
  factBullets: NonEmptyTrimmedStringArraySchema.optional(),
});

const PresetRouteSeedSchema = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    durationMinutes: z.number().int().positive(),
    description: z.string().trim().min(1),
    defaultPersona: z.enum(PERSONAS),
    storyBy: z.string().trim().min(1).optional(),
    narratorGuidance: z.string().trim().min(1).optional(),
    contentPriority: z.enum(CONTENT_PRIORITIES).optional(),
    pricing: PresetRoutePricingSchema.optional(),
    stopPlaceIds: z.array(z.string().trim().min(1)).min(1).optional(),
    stops: z.array(PresetStopSeedSchema).min(1).optional(),
  })
  .superRefine((route, ctx) => {
    const hasLegacyStopPlaceIds = Array.isArray(route.stopPlaceIds);
    const hasStops = Array.isArray(route.stops);
    if (hasLegacyStopPlaceIds === hasStops) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stops"],
        message: "Provide exactly one of stops or stopPlaceIds",
      });
      return;
    }

    const seenStopSeeds = new Set<string>();
    const normalizedStops =
      route.stops?.map((stop) => ({
        placeId: stop.placeId.trim(),
        title: stop.title?.trim() || "",
        pathRoot: "stops" as const,
      })) ??
      route.stopPlaceIds?.map((placeId) => ({
        placeId: placeId.trim(),
        title: "",
        pathRoot: "stopPlaceIds" as const,
      })) ??
      [];

    normalizedStops.forEach((stop, stopIdx) => {
      if (stop.placeId.toLowerCase().startsWith("pexels:")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [stop.pathRoot, stopIdx],
          message: "Invalid Google Place ID (looks like legacy pexels value)",
        });
      }

      const dedupeKey = `${stop.placeId.toLowerCase()}|${stop.title.toLowerCase()}`;
      if (seenStopSeeds.has(dedupeKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [stop.pathRoot, stopIdx],
          message: `Duplicate stop seed in route: ${stop.placeId}${stop.title ? ` (${stop.title})` : ""}`,
        });
      }
      seenStopSeeds.add(dedupeKey);
    });
  });

export const PresetCitySeedSchema = z
  .object({
    city: z.enum(CITIES),
    routes: z.array(PresetRouteSeedSchema).min(1),
  })
  .superRefine((seed, ctx) => {
    const routeIds = new Set<string>();
    seed.routes.forEach((route, routeIdx) => {
      if (routeIds.has(route.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["routes", routeIdx, "id"],
          message: `Duplicate route id in city file: ${route.id}`,
        });
      }
      routeIds.add(route.id);

    });
  });

export const PresetMetaSchema = z.object({
  city: z.enum(CITIES),
  overview: z.object({
    label: z.string().trim().min(1),
    lat: z.number().finite(),
    lng: z.number().finite(),
    fallbackImage: z.string().trim().min(1),
  }),
});

export type PresetRouteSeed = z.infer<typeof PresetRouteSeedSchema>;
export type PresetRoutePricingSeed = z.infer<typeof PresetRoutePricingSchema>;
export type PresetStopSeed = z.infer<typeof PresetStopSeedSchema>;
export type PresetCitySeed = z.infer<typeof PresetCitySeedSchema>;
export type PresetMeta = z.infer<typeof PresetMetaSchema>;
