export type TransportMode = "walk" | "drive";

export const MIX_STOP_LIMITS = {
  minStops: 2,
  maxStops: 9,
} as const;

export function getMaxStops(lengthMinutes?: number, transportMode?: TransportMode) {
  void lengthMinutes;
  void transportMode;
  return MIX_STOP_LIMITS.maxStops;
}

export function validateMixSelection(lengthMinutes: number, transportMode: TransportMode, selectedStops: number) {
  void lengthMinutes;
  void transportMode;
  if (selectedStops < MIX_STOP_LIMITS.minStops) {
    return { ok: false, message: "Choose at least 2 stops." };
  }
  if (selectedStops > MIX_STOP_LIMITS.maxStops) {
    return { ok: false, message: `Select at most ${MIX_STOP_LIMITS.maxStops} stops.` };
  }
  return { ok: true, message: "" };
}
