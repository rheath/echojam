export const NEARBY_REUSE_RADIUS_METERS = 35;

const NEARBY_TITLE_STOPWORDS = new Set(["a", "an", "and", "at", "in", "of", "on", "the"]);

function normalizeNearbyTitleTokens(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token && !NEARBY_TITLE_STOPWORDS.has(token));
}

export function titlesMatchClosely(a: string, b: string) {
  const aTokens = normalizeNearbyTitleTokens(a);
  const bTokens = normalizeNearbyTitleTokens(b);
  if (aTokens.length === 0 || bTokens.length === 0) return false;

  const aJoined = aTokens.join(" ");
  const bJoined = bTokens.join(" ");
  if (aJoined === bJoined) return true;

  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  const smaller = aSet.size <= bSet.size ? aSet : bSet;
  const larger = aSet.size <= bSet.size ? bSet : aSet;

  let overlap = 0;
  for (const token of smaller) {
    if (larger.has(token)) overlap += 1;
  }

  if (smaller.size >= 2 && overlap === smaller.size) return true;
  return overlap >= 2 && overlap / Math.max(aSet.size, bSet.size) >= 0.75;
}
