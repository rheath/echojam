import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ensureCreatorAccess,
  isCreatorAccessAuthorizedFromCookieStore,
} from "@/lib/server/creatorAccess";

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const COOKIE_VERSION = "v1";
const COOKIE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
  return isCreatorAccessAuthorizedFromCookieStore(cookieStore, "mixed", now);
}

export async function getInstagramImportRequestAuthorizationState(
  request: Request
) {
  if (!isInstagramImportEnabled()) {
    return {
      enabled: false,
      authorized: false,
    };
  }

  const authorization = await ensureCreatorAccess(request, "mixed");
  if (!authorization.ok) {
    return {
      enabled: true,
      authorized: false,
      status: authorization.status,
      error: authorization.error,
    };
  }

  return {
    enabled: true,
    authorized: true,
    status: 200,
    error: null,
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
