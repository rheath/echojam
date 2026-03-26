import { getSupabaseAuthHeaders } from "@/lib/supabaseClient";

export type OwnedMixedJourneySummary = {
  jamId: string;
  routeId: string;
  sessionId: string | null;
  title: string;
  updatedAt: string;
  hasDraft: boolean;
};

export type OwnedMixedJourneysResponse = {
  journeys: OwnedMixedJourneySummary[];
};

export type CreatorAccessStatusResponse = {
  authorized?: boolean;
  email?: string | null;
  scopes?: string[];
  error?: string;
};

export type ResumeMixedJourneyResponse = {
  sessionId?: string;
  reused?: boolean;
  error?: string;
};

export async function fetchJson<T>(input: RequestInfo, init?: RequestInit) {
  const headers = await getSupabaseAuthHeaders(init?.headers, undefined, {
    context: "mixed fetchJson",
  });
  const response = await fetch(input, { ...init, headers });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}
