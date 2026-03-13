import { createHmac, timingSafeEqual } from "node:crypto";

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const COOKIE_VERSION = "v1";
const COOKIE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const INSTAGRAM_CREATOR_ACCESS_COOKIE_NAME = "instagram_creator_access";

type CookieReader = {
  get(name: string): { value: string } | undefined;
};

type CreatorCodeValidationResult =
  | {
      ok: true;
      normalizedCode: string;
    }
  | {
      ok: false;
      error: string;
      status: number;
    };

function isEnabled(value: string | undefined) {
  return ENABLED_VALUES.has((value || "").trim().toLowerCase());
}

function normalizeCreatorCode(value: string | null | undefined) {
  return (value || "").trim();
}

function getCookieSecret() {
  return (process.env.INSTAGRAM_CREATOR_ACCESS_SECRET || "").trim();
}

function signCookiePayload(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeSignatureEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function getCookieValueFromHeader(header: string | null, name: string) {
  if (!header) return null;
  const segments = header.split(";");
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex < 0) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    if (key !== name) continue;
    return decodeURIComponent(trimmed.slice(separatorIndex + 1));
  }
  return null;
}

export function parseInstagramCreatorAccessCodes(value: string | undefined) {
  const deduped = new Set<string>();
  for (const part of (value || "").split(/[\n,]+/)) {
    const normalized = normalizeCreatorCode(part);
    if (normalized) deduped.add(normalized);
  }
  return [...deduped];
}

export function isInstagramImportEnabled() {
  return isEnabled(process.env.NEXT_PUBLIC_ENABLE_INSTAGRAM_IMPORT);
}

export function getInstagramCreatorAccessCodes() {
  return parseInstagramCreatorAccessCodes(process.env.INSTAGRAM_CREATOR_ACCESS_CODES);
}

export function validateInstagramCreatorAccessCode(code: string | null | undefined): CreatorCodeValidationResult {
  const normalizedCode = normalizeCreatorCode(code);
  if (!normalizedCode) {
    return {
      ok: false,
      error: "Enter your creator code.",
      status: 400,
    };
  }

  const configuredCodes = getInstagramCreatorAccessCodes();
  const secret = getCookieSecret();
  if (configuredCodes.length === 0 || !secret) {
    return {
      ok: false,
      error: "Creator access is not configured yet.",
      status: 503,
    };
  }

  if (!configuredCodes.includes(normalizedCode)) {
    return {
      ok: false,
      error: "That creator code is invalid.",
      status: 401,
    };
  }

  return {
    ok: true,
    normalizedCode,
  };
}

export function createInstagramCreatorAccessCookieValue(now = Date.now()) {
  const secret = getCookieSecret();
  if (!secret) {
    throw new Error("INSTAGRAM_CREATOR_ACCESS_SECRET is required to mint Instagram creator access.");
  }
  const expiresAt = now + COOKIE_TTL_MS;
  const payload = `${COOKIE_VERSION}.${expiresAt}`;
  const signature = signCookiePayload(payload, secret);
  return `${payload}.${signature}`;
}

export function isInstagramCreatorAccessCookieAuthorized(
  cookieValue: string | null | undefined,
  now = Date.now()
) {
  const normalizedValue = normalizeCreatorCode(cookieValue);
  const secret = getCookieSecret();
  if (!normalizedValue || !secret) return false;

  const [version, expiresAtRaw, signature, ...rest] = normalizedValue.split(".");
  if (rest.length > 0 || version !== COOKIE_VERSION || !expiresAtRaw || !signature) return false;

  const expiresAt = Number.parseInt(expiresAtRaw, 10);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;

  const expectedSignature = signCookiePayload(`${version}.${expiresAtRaw}`, secret);
  return safeSignatureEquals(signature, expectedSignature);
}

export function isInstagramCreatorAccessAuthorizedFromCookieStore(
  cookieStore: CookieReader,
  now = Date.now()
) {
  return isInstagramCreatorAccessCookieAuthorized(
    cookieStore.get(INSTAGRAM_CREATOR_ACCESS_COOKIE_NAME)?.value,
    now
  );
}

export function getInstagramImportRequestAuthorizationState(
  request: Request,
  now = Date.now()
) {
  if (!isInstagramImportEnabled()) {
    return {
      enabled: false,
      authorized: false,
    };
  }

  const cookieValue = getCookieValueFromHeader(
    request.headers.get("cookie"),
    INSTAGRAM_CREATOR_ACCESS_COOKIE_NAME
  );

  return {
    enabled: true,
    authorized: isInstagramCreatorAccessCookieAuthorized(cookieValue, now),
  };
}

export function getInstagramCreatorAccessCookieOptions(now = Date.now()) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: process.env.NODE_ENV === "production",
    expires: new Date(now + COOKIE_TTL_MS),
  };
}
