export type TransportMode = "walk" | "drive";

export const MIX_LIMITS: Record<TransportMode, Array<{ lengthMinutes: number; maxStops: number }>> = {
  walk: [
    { lengthMinutes: 15, maxStops: 3 },
    { lengthMinutes: 30, maxStops: 5 },
    { lengthMinutes: 60, maxStops: 8 },
  ],
  drive: [
    { lengthMinutes: 15, maxStops: 4 },
    { lengthMinutes: 30, maxStops: 7 },
    { lengthMinutes: 60, maxStops: 10 },
  ],
};

export function getMaxStops(lengthMinutes: number, transportMode: TransportMode) {
  const match = MIX_LIMITS[transportMode].find((row) => row.lengthMinutes === lengthMinutes);
  return match?.maxStops ?? 0;
}

export function validateMixSelection(lengthMinutes: number, transportMode: TransportMode, selectedStops: number) {
  const maxStops = getMaxStops(lengthMinutes, transportMode);
  if (!maxStops) {
    return { ok: false, message: "Invalid length/transport combination." };
  }
  if (selectedStops < 2) {
    return { ok: false, message: "Choose at least 2 stops." };
  }
  if (selectedStops > maxStops) {
    return { ok: false, message: `Select at most ${maxStops} stops for ${lengthMinutes} min ${transportMode} tours.` };
  }
  return { ok: true, message: "" };
}
