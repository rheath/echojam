export type GooglePlaceAddressComponent = {
  longText?: string;
  shortText?: string;
  types?: string[];
  languageCode?: string;
};

type PlaceLocationLabelInput = {
  addressComponents?: GooglePlaceAddressComponent[] | null;
  formattedAddress?: string | null;
};

function normalizeOptionalText(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function findAddressComponent(
  components: GooglePlaceAddressComponent[],
  types: string[]
) {
  return (
    components.find((component) =>
      (component.types ?? []).some((type) => types.includes(type))
    ) ?? null
  );
}

function stripPostalCode(value: string | null) {
  const normalized = normalizeOptionalText(value);
  if (!normalized) return null;

  const withoutPostalCode = normalized
    .replace(/\b\d{5}(?:-\d{4})?\b/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+,/g, ",")
    .trim();

  return withoutPostalCode || null;
}

function normalizeCountryName(value: string | null) {
  const normalized = normalizeOptionalText(value);
  if (!normalized) return null;
  if (/^(usa|u\.s\.a\.|united states|united states of america)$/i.test(normalized)) {
    return "USA";
  }
  return normalized;
}

function isUnitedStates(countryCode: string | null, countryName: string | null) {
  return (
    /^(us|usa)$/i.test(countryCode || "") ||
    /^(usa|u\.s\.a\.|united states|united states of america)$/i.test(countryName || "")
  );
}

function shortenFormattedAddress(formattedAddress: string | null) {
  const normalized = normalizeOptionalText(formattedAddress);
  if (!normalized) return null;

  const parts = normalized
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;

  const country = normalizeCountryName(parts.at(-1) ?? null);
  const penultimate = stripPostalCode(parts.at(-2) ?? null);
  const antepenultimate = stripPostalCode(parts.at(-3) ?? null);

  if (isUnitedStates(country, country)) {
    if (antepenultimate && penultimate) return `${antepenultimate}, ${penultimate}`;
    if (penultimate && country) return `${penultimate}, ${country}`;
  }

  if (antepenultimate && country) return `${antepenultimate}, ${country}`;
  if (penultimate && country) return `${penultimate}, ${country}`;
  return null;
}

export function buildPlaceLocationLabel(input: PlaceLocationLabelInput) {
  const components = Array.isArray(input.addressComponents) ? input.addressComponents : [];
  const city =
    normalizeOptionalText(findAddressComponent(components, ["locality"])?.longText) ||
    normalizeOptionalText(findAddressComponent(components, ["postal_town"])?.longText) ||
    normalizeOptionalText(
      findAddressComponent(components, ["administrative_area_level_2"])?.longText
    );
  const regionLong = normalizeOptionalText(
    findAddressComponent(components, ["administrative_area_level_1"])?.longText
  );
  const regionShort = normalizeOptionalText(
    findAddressComponent(components, ["administrative_area_level_1"])?.shortText
  );
  const countryLong = normalizeOptionalText(
    findAddressComponent(components, ["country"])?.longText
  );
  const countryShort = normalizeOptionalText(
    findAddressComponent(components, ["country"])?.shortText
  );
  const countryName = normalizeCountryName(countryLong);

  if (isUnitedStates(countryShort, countryLong)) {
    const region = regionShort || regionLong;
    if (city && region) return `${city}, ${region}`;
    if (city && countryName) return `${city}, ${countryName}`;
    if (region && countryName) return `${region}, ${countryName}`;
    if (city) return city;
  } else {
    if (city && countryName) return `${city}, ${countryName}`;
    if (city && regionLong) return `${city}, ${regionLong}`;
    if (regionLong && countryName) return `${regionLong}, ${countryName}`;
    if (city) return city;
  }

  return shortenFormattedAddress(input.formattedAddress ?? null);
}
