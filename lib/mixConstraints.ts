export type TransportMode = "walk" | "drive";

export const MIX_STOP_LIMITS = {
  minStops: 1,
  maxStops: 10,
} as const;

export function getMaxStops(lengthMinutes?: number, transportMode?: TransportMode) {
  void lengthMinutes;
  void transportMode;
  return MIX_STOP_LIMITS.maxStops;
}

export function validateMixSelection(
  lengthMinutes: number,
  transportMode: TransportMode,
  selectedStops: number,
  opts?: { minStops?: number }
) {
  void lengthMinutes;
  void transportMode;
  const minStops = Math.max(1, Math.trunc(Number(opts?.minStops ?? MIX_STOP_LIMITS.minStops)));
  if (selectedStops < minStops) {
    return { ok: false, message: `Choose at least ${minStops} stop${minStops === 1 ? "" : "s"}.` };
  }
  if (selectedStops > MIX_STOP_LIMITS.maxStops) {
    return { ok: false, message: `Select at most ${MIX_STOP_LIMITS.maxStops} stops.` };
  }
  return { ok: true, message: "" };
}
