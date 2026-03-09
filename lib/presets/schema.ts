import { z } from "zod";
type Persona = "adult" | "preteen" | "ghost";
type PresetCity = "salem" | "boston" | "concord" | "nyc";

const PERSONAS = ["adult", "preteen", "ghost"] as const satisfies readonly Persona[];
const CITIES = ["salem", "boston", "concord", "nyc"] as const satisfies readonly PresetCity[];

const PresetRouteSeedSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  durationMinutes: z.number().int().positive(),
  description: z.string().trim().min(1),
  defaultPersona: z.enum(PERSONAS),
  stopPlaceIds: z.array(z.string().trim().min(1)).min(1),
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

      const placeIds = new Set<string>();
      route.stopPlaceIds.forEach((placeId, stopIdx) => {
        const normalized = placeId.trim();
        if (normalized.toLowerCase().startsWith("pexels:")) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["routes", routeIdx, "stopPlaceIds", stopIdx],
            message: "Invalid Google Place ID (looks like legacy pexels value)",
          });
        }
        if (placeIds.has(normalized)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["routes", routeIdx, "stopPlaceIds", stopIdx],
            message: `Duplicate place id in route: ${normalized}`,
          });
        }
        placeIds.add(normalized);
      });
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
export type PresetCitySeed = z.infer<typeof PresetCitySeedSchema>;
export type PresetMeta = z.infer<typeof PresetMetaSchema>;
