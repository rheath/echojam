import type { Persona } from "@/app/content/routeTypes";

export type MixedRouteOpenerFamily =
  | "history-anchor"
  | "surprising-detail"
  | "present-day-contrast"
  | "action-start"
  | "secret-clue"
  | "look-closer"
  | "subtle-unease"
  | "documented-fact-first"
  | "watchful-detail";

const MIXED_ROUTE_OPENERS: Record<Persona, MixedRouteOpenerFamily[]> = {
  adult: ["history-anchor", "surprising-detail", "present-day-contrast"],
  preteen: ["action-start", "secret-clue", "look-closer"],
  ghost: ["subtle-unease", "documented-fact-first", "watchful-detail"],
  custom: ["look-closer", "surprising-detail", "present-day-contrast", "history-anchor"],
};

const DEFAULT_BLOCKED_LEAD_INS = ["welcome to"];

function pickRotatingValue<T>(values: readonly T[], index: number, fallback: T) {
  if (values.length === 0) return fallback;
  const normalizedIndex = Number.isFinite(index) ? Math.trunc(index) : 0;
  return values[((normalizedIndex % values.length) + values.length) % values.length] ?? fallback;
}

export function describeMixedRouteOpenerFamily(openerFamily: MixedRouteOpenerFamily) {
  if (openerFamily === "history-anchor") {
    return "Open with one concrete historical or cultural anchor before expanding outward.";
  }
  if (openerFamily === "surprising-detail") {
    return "Open with a surprising concrete detail that earns attention immediately.";
  }
  if (openerFamily === "present-day-contrast") {
    return "Open by contrasting the present-day scene with what this place has meant before.";
  }
  if (openerFamily === "action-start") {
    return "Open as if the listener has just stepped into an active scene or mission.";
  }
  if (openerFamily === "secret-clue") {
    return "Open with one clue-like detail that makes the listener want the explanation.";
  }
  if (openerFamily === "look-closer") {
    return "Open by directing attention to one concrete detail most people miss.";
  }
  if (openerFamily === "subtle-unease") {
    return "Open with a detail that feels slightly off without using horror cliches.";
  }
  if (openerFamily === "documented-fact-first") {
    return "Open with one verified fact, then let the atmosphere gather around it.";
  }
  return "Open with one architectural or sensory detail that feels quietly watchful.";
}

export function pickMixedRouteOpenerFamily(persona: Persona, stopIndex: number) {
  const families = MIXED_ROUTE_OPENERS[persona] ?? MIXED_ROUTE_OPENERS.adult;
  return pickRotatingValue(families, stopIndex, families[0] ?? "history-anchor");
}

export function normalizeMixedRouteLeadIn(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^[^a-z0-9]+/i, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || null;
}

export function extractMixedRouteLeadIn(
  script: string | null | undefined,
  minWords = 2,
  maxWords = 4
) {
  if (typeof script !== "string") return null;
  const words = script.match(/[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)*/g) ?? [];
  if (words.length < minWords) return null;
  return normalizeMixedRouteLeadIn(words.slice(0, Math.max(minWords, maxWords)).join(" "));
}

export function dedupeMixedRouteLeadIns(
  values: Array<string | null | undefined>,
  seed: Array<string | null | undefined> = DEFAULT_BLOCKED_LEAD_INS
) {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const value of [...seed, ...values]) {
    const nextValue = normalizeMixedRouteLeadIn(value);
    if (!nextValue || seen.has(nextValue)) continue;
    seen.add(nextValue);
    normalized.push(nextValue);
  }

  return normalized;
}

export function buildMixedRouteBlockedLeadIns(
  scripts: Array<string | null | undefined>,
  seed: Array<string | null | undefined> = DEFAULT_BLOCKED_LEAD_INS
) {
  return dedupeMixedRouteLeadIns(
    scripts.map((script) => extractMixedRouteLeadIn(script)),
    seed
  );
}

export function buildMixedRouteOpenerContext(
  persona: Persona,
  stopIndex: number,
  priorScripts: Array<string | null | undefined>
) {
  return {
    openerFamily: pickMixedRouteOpenerFamily(persona, stopIndex),
    blockedLeadIns: buildMixedRouteBlockedLeadIns(priorScripts),
  };
}
