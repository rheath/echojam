export const UTM_PARAM_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
] as const;

export type UtmParamKey = (typeof UTM_PARAM_KEYS)[number];
export type UtmParams = Partial<Record<UtmParamKey, string>>;

type SearchParamsLike = {
  get(name: string): string | null;
};

function normalizeUtmValue(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 200);
}

function reduceUtmValues(getValue: (key: UtmParamKey) => unknown): UtmParams {
  const next: UtmParams = {};
  for (const key of UTM_PARAM_KEYS) {
    const value = normalizeUtmValue(getValue(key));
    if (value) {
      next[key] = value;
    }
  }
  return next;
}

export function pickUtmParamsFromSearchParams(searchParams: SearchParamsLike | null | undefined): UtmParams {
  if (!searchParams) return {};
  return reduceUtmValues((key) => searchParams.get(key));
}

export function pickUtmParamsFromRecord(record: Record<string, unknown> | null | undefined): UtmParams {
  if (!record) return {};
  return reduceUtmValues((key) => record[key]);
}

export function appendUtmParams(searchParams: URLSearchParams, utmParams: UtmParams) {
  for (const key of UTM_PARAM_KEYS) {
    const value = utmParams[key];
    if (value) {
      searchParams.set(key, value);
    }
  }
}

export function buildPathWithUtm(pathname: string, utmParams: UtmParams) {
  const searchParams = new URLSearchParams();
  appendUtmParams(searchParams, utmParams);
  const queryString = searchParams.toString();
  return queryString ? `${pathname}?${queryString}` : pathname;
}

export function utmParamsToMetadata(utmParams: UtmParams): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const key of UTM_PARAM_KEYS) {
    const value = utmParams[key];
    if (value) {
      metadata[key] = value;
    }
  }
  return metadata;
}
