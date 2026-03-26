import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdminClient } from "@/lib/server/supabaseAdmin";
import { getRequestAuthUser, type RequestAuthUser } from "@/lib/server/requestAuth";

const COOKIE_VERSION = "v1";
const COOKIE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PENDING_COOKIE_TTL_MS = 15 * 60 * 1000;

export const MIXED_CREATOR_ACCESS_COOKIE_NAME = "mixed_creator_access";
export const CREATOR_ACCESS_PENDING_COOKIE_NAME = "creator_access_claim";

export type CreatorAccessScope = "mixed";
type LegacyCreatorAccessScope = "instagram" | "tiktok" | "all";
type StoredCreatorAccessScope = CreatorAccessScope | LegacyCreatorAccessScope;
export type CreatorAccessRequestedScope = CreatorAccessScope;

type CookieReader = {
  get(name: string): { value: string } | undefined;
};

type CreatorAccessInviteRow = {
  id: string;
  email: string;
  scope: StoredCreatorAccessScope;
  claimed_user_id: string | null;
  revoked_at: string | null;
};

type PendingCreatorAccessClaim = {
  inviteId: string;
  email: string;
  requestedScope: CreatorAccessRequestedScope;
  nextPath: string;
  expiresAt: number;
};

type CreatorAccessAuthorizationResult =
  | {
      ok: true;
      authUser: RequestAuthUser;
      inviteScopes: CreatorAccessScope[];
    }
  | {
      ok: false;
      status: number;
      error: string;
    };

type CreatorAccessStartValidationResult =
  | {
      ok: true;
      invite: CreatorAccessInviteRow;
      normalizedEmail: string;
      nextPath: string;
      requestedScope: CreatorAccessRequestedScope;
    }
  | {
      ok: false;
      status: number;
      error: string;
    };

const CREATOR_ACCESS_SETUP_MESSAGE =
  "Creator access is not set up yet. Run the Supabase migration `20260326_add_creator_access_invites.sql`.";
const CREATOR_ACCESS_COOKIE_SECRET_MESSAGE =
  "CREATOR_ACCESS_COOKIE_SECRET is required for creator access. Add it to your environment and restart the server.";

function getCookieSecret() {
  return (process.env.CREATOR_ACCESS_COOKIE_SECRET || "").trim();
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

function normalizeNextPath(value: string | null | undefined) {
  const candidate = (value || "").trim();
  if (!candidate.startsWith("/")) return "/";
  if (candidate.startsWith("//")) return "/";
  return candidate;
}

function isMissingCreatorAccessInvitesSchemaError(message: string | null | undefined) {
  const normalized = (message || "").trim().toLowerCase();
  return (
    normalized.includes("creator_access_invites") &&
    (normalized.includes("schema cache") ||
      normalized.includes("could not find the table") ||
      normalized.includes("relation \"public.creator_access_invites\" does not exist") ||
      normalized.includes("relation \"creator_access_invites\" does not exist"))
  );
}

function toCreatorAccessSetupError(error: { message?: string | null } | null | undefined) {
  if (isMissingCreatorAccessInvitesSchemaError(error?.message)) {
    return new Error(CREATOR_ACCESS_SETUP_MESSAGE);
  }
  return error ? new Error(error.message || "Creator access setup failed.") : null;
}

export function normalizeCreatorAccessEmail(value: string | null | undefined) {
  return (value || "").trim().toLowerCase();
}

export function normalizeCreatorAccessCode(value: string | null | undefined) {
  return (value || "").trim();
}

export function normalizeCreatorAccessRequestedScope(
  value: string | null | undefined
): CreatorAccessRequestedScope | null {
  const normalized = (value || "").trim().toLowerCase();
  if (
    normalized === "mixed" ||
    normalized === "instagram" ||
    normalized === "tiktok" ||
    normalized === "all"
  ) {
    return "mixed";
  }
  return null;
}

export function hashCreatorAccessCode(value: string | null | undefined) {
  const normalized = normalizeCreatorAccessCode(value);
  if (!normalized) return "";
  return createHash("sha256").update(normalized).digest("base64url");
}

function getCreatorAccessCookieName() {
  return MIXED_CREATOR_ACCESS_COOKIE_NAME;
}

function createSignedCookieValue(payload: string, now = Date.now()) {
  const secret = getCookieSecret();
  if (!secret) {
    throw new Error(CREATOR_ACCESS_COOKIE_SECRET_MESSAGE);
  }
  const expiresAt = now + COOKIE_TTL_MS;
  const signedPayload = `${COOKIE_VERSION}.${expiresAt}.${payload}`;
  const signature = signCookiePayload(signedPayload, secret);
  return `${signedPayload}.${signature}`;
}

function isSignedCookieAuthorized(value: string | null | undefined, expectedPayload: string, now = Date.now()) {
  const normalizedValue = (value || "").trim();
  const secret = getCookieSecret();
  if (!normalizedValue || !secret) return false;

  const [version, expiresAtRaw, payload, signature, ...rest] = normalizedValue.split(".");
  if (rest.length > 0 || version !== COOKIE_VERSION || !expiresAtRaw || !payload || !signature) return false;
  if (payload !== expectedPayload) return false;

  const expiresAt = Number.parseInt(expiresAtRaw, 10);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;

  const signedPayload = `${version}.${expiresAtRaw}.${payload}`;
  const expectedSignature = signCookiePayload(signedPayload, secret);
  return safeSignatureEquals(signature, expectedSignature);
}

export function createCreatorAccessCookieValue(scope: CreatorAccessRequestedScope, now = Date.now()) {
  return createSignedCookieValue(scope, now);
}

export function isCreatorAccessCookieAuthorized(
  cookieValue: string | null | undefined,
  scope: CreatorAccessRequestedScope,
  now = Date.now()
) {
  return isSignedCookieAuthorized(cookieValue, scope, now);
}

export function isCreatorAccessAuthorizedFromCookieStore(
  cookieStore: CookieReader,
  scope: CreatorAccessRequestedScope,
  now = Date.now()
) {
  return isCreatorAccessCookieAuthorized(
    cookieStore.get(getCreatorAccessCookieName())?.value,
    scope,
    now
  );
}

export function getCreatorAccessCookieOptions(now = Date.now()) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: process.env.NODE_ENV === "production",
    expires: new Date(now + COOKIE_TTL_MS),
  };
}

function createPendingClaimPayload(value: Omit<PendingCreatorAccessClaim, "expiresAt">, now = Date.now()) {
  const secret = getCookieSecret();
  if (!secret) {
    throw new Error(CREATOR_ACCESS_COOKIE_SECRET_MESSAGE);
  }
  const expiresAt = now + PENDING_COOKIE_TTL_MS;
  const encodedPayload = Buffer.from(
    JSON.stringify({
      inviteId: value.inviteId,
      email: value.email,
      requestedScope: value.requestedScope,
      nextPath: value.nextPath,
      expiresAt,
    }),
    "utf8"
  ).toString("base64url");
  const signedPayload = `${COOKIE_VERSION}.${encodedPayload}`;
  const signature = signCookiePayload(signedPayload, secret);
  return `${signedPayload}.${signature}`;
}

export function createPendingCreatorAccessClaimCookieValue(
  value: Omit<PendingCreatorAccessClaim, "expiresAt">,
  now = Date.now()
) {
  return createPendingClaimPayload(value, now);
}

export function parsePendingCreatorAccessClaimCookieValue(
  cookieValue: string | null | undefined,
  now = Date.now()
) {
  const normalizedValue = (cookieValue || "").trim();
  const secret = getCookieSecret();
  if (!normalizedValue || !secret) return null;

  const [version, encodedPayload, signature, ...rest] = normalizedValue.split(".");
  if (rest.length > 0 || version !== COOKIE_VERSION || !encodedPayload || !signature) return null;

  const signedPayload = `${version}.${encodedPayload}`;
  const expectedSignature = signCookiePayload(signedPayload, secret);
  if (!safeSignatureEquals(signature, expectedSignature)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Partial<PendingCreatorAccessClaim>;
    const expiresAt = Number(parsed.expiresAt);
    const inviteId = (parsed.inviteId || "").trim();
    const email = normalizeCreatorAccessEmail(parsed.email);
    const requestedScope = normalizeCreatorAccessRequestedScope(parsed.requestedScope);
    const nextPath = normalizeNextPath(parsed.nextPath);
    if (!inviteId || !email || !requestedScope || !Number.isFinite(expiresAt) || expiresAt <= now) {
      return null;
    }
    return {
      inviteId,
      email,
      requestedScope,
      nextPath,
      expiresAt,
    } satisfies PendingCreatorAccessClaim;
  } catch {
    return null;
  }
}

export function getPendingCreatorAccessCookieOptions(now = Date.now()) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: process.env.NODE_ENV === "production",
    expires: new Date(now + PENDING_COOKIE_TTL_MS),
  };
}

export function clearCreatorAccessPendingCookie(response: NextResponse) {
  response.cookies.set(CREATOR_ACCESS_PENDING_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    expires: new Date(0),
  });
}

function normalizeStoredCreatorAccessScope(
  value: StoredCreatorAccessScope | null | undefined
): CreatorAccessScope | null {
  if (!value) return null;
  if (value === "mixed" || value === "instagram" || value === "tiktok" || value === "all") {
    return "mixed";
  }
  return null;
}

function scopeAllows(inviteScope: StoredCreatorAccessScope, requestedScope: CreatorAccessRequestedScope) {
  return normalizeStoredCreatorAccessScope(inviteScope) === requestedScope;
}

export function expandCreatorAccessScopes(scopes: Array<StoredCreatorAccessScope | null | undefined>) {
  const granted = new Set<CreatorAccessRequestedScope>();
  for (const scope of scopes) {
    const normalized = normalizeStoredCreatorAccessScope(scope);
    if (normalized) granted.add(normalized);
  }
  return [...granted];
}

export function applyCreatorAccessCookies(response: NextResponse, scopes: Array<StoredCreatorAccessScope | null | undefined>) {
  const grantedScopes = expandCreatorAccessScopes(scopes);
  for (const scope of grantedScopes) {
    response.cookies.set(
      getCreatorAccessCookieName(),
      createCreatorAccessCookieValue(scope),
      getCreatorAccessCookieOptions()
    );
  }
}

export async function listClaimedCreatorAccessScopes(
  admin: SupabaseClient,
  claimedUserId: string
) {
  const { data, error } = await admin
    .from("creator_access_invites")
    .select("scope")
    .eq("claimed_user_id", claimedUserId)
    .is("revoked_at", null);
  const setupError = toCreatorAccessSetupError(error);
  if (setupError) throw setupError;
  return Array.from(
    new Set(
      ((data ?? []) as Array<{ scope: StoredCreatorAccessScope | null }>)
        .map((row) => normalizeStoredCreatorAccessScope(row.scope))
        .filter((scope): scope is CreatorAccessScope => Boolean(scope))
    )
  );
}

async function findCreatorAccessInviteById(admin: SupabaseClient, inviteId: string) {
  const { data, error } = await admin
    .from("creator_access_invites")
    .select("id,email,scope,claimed_user_id,revoked_at")
    .eq("id", inviteId)
    .maybeSingle();
  const setupError = toCreatorAccessSetupError(error);
  if (setupError) throw setupError;
  return (data ?? null) as CreatorAccessInviteRow | null;
}

export async function validateCreatorAccessStart(args: {
  admin?: SupabaseClient;
  code: string | null | undefined;
  email: string | null | undefined;
  next: string | null | undefined;
  requestedScope: string | null | undefined;
}): Promise<CreatorAccessStartValidationResult> {
  const admin = args.admin ?? getSupabaseAdminClient();
  const requestedScope = normalizeCreatorAccessRequestedScope(args.requestedScope);
  if (!requestedScope) {
    return {
      ok: false,
      status: 400,
      error: "Choose a valid creator access flow.",
    };
  }

  const normalizedCode = normalizeCreatorAccessCode(args.code);
  if (!normalizedCode) {
    return {
      ok: false,
      status: 400,
      error: "Enter your creator code.",
    };
  }

  const normalizedEmail = normalizeCreatorAccessEmail(args.email);
  if (!normalizedEmail) {
    return {
      ok: false,
      status: 400,
      error: "Enter your creator email.",
    };
  }

  const codeHash = hashCreatorAccessCode(normalizedCode);
  const { data, error } = await admin
    .from("creator_access_invites")
    .select("id,email,scope,claimed_user_id,revoked_at")
    .eq("code_hash", codeHash)
    .limit(5);
  const setupError = toCreatorAccessSetupError(error);
  if (setupError) {
    return {
      ok: false,
      status: 503,
      error: setupError.message,
    };
  }

  const invites = (data ?? []) as CreatorAccessInviteRow[];
  if (invites.length === 0) {
    return {
      ok: false,
      status: 401,
      error: "That creator code is invalid.",
    };
  }

  const matchingEmailInvite =
    invites.find((invite) => normalizeCreatorAccessEmail(invite.email) === normalizedEmail) ?? null;
  if (!matchingEmailInvite) {
    return {
      ok: false,
      status: 403,
      error: "That email does not match this creator code.",
    };
  }

  if (matchingEmailInvite.revoked_at) {
    return {
      ok: false,
      status: 403,
      error: "That creator access code has been revoked.",
    };
  }

  if (!scopeAllows(matchingEmailInvite.scope, requestedScope)) {
    return {
      ok: false,
      status: 403,
      error: "That creator code does not unlock this tool.",
    };
  }

  return {
    ok: true,
    invite: matchingEmailInvite,
    normalizedEmail,
    nextPath: normalizeNextPath(args.next),
    requestedScope,
  };
}

async function getMagicLinkClient() {
  const { createClient } = await import("@supabase/supabase-js");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function sendCreatorAccessMagicLink(args: { email: string; nextPath: string }) {
  const { getSiteBaseUrl } = await import("@/lib/server/siteUrl");
  const baseUrl = await getSiteBaseUrl();
  const redirectUrl = new URL("/auth/callback", baseUrl);
  redirectUrl.searchParams.set("next", normalizeNextPath(args.nextPath));

  const supabaseClient = await getMagicLinkClient();
  const { error } = await supabaseClient.auth.signInWithOtp({
    email: normalizeCreatorAccessEmail(args.email),
    options: {
      emailRedirectTo: redirectUrl.toString(),
    },
  });
  if (error) {
    throw new Error(error.message);
  }
}

export async function ensureCreatorAccess(
  request: Request,
  requestedScope: CreatorAccessRequestedScope
): Promise<CreatorAccessAuthorizationResult> {
  const authUser = await getRequestAuthUser(request);
  if (!authUser) {
    return {
      ok: false,
      status: 401,
      error: "Sign in with your creator email first.",
    };
  }

  const inviteScopes = await listClaimedCreatorAccessScopes(getSupabaseAdminClient(), authUser.id);
  if (!expandCreatorAccessScopes(inviteScopes).includes(requestedScope)) {
    return {
      ok: false,
      status: 403,
      error: "Creator access required. Enter your code and creator email first.",
    };
  }

  return {
    ok: true,
    authUser,
    inviteScopes,
  };
}

export async function getCreatorAccessStatus(
  request: Request,
  requestedScope: CreatorAccessRequestedScope
) {
  const authUser = await getRequestAuthUser(request);
  if (!authUser) {
    return {
      authUser: null,
      inviteScopes: [] as CreatorAccessScope[],
      authorized: false,
    };
  }

  const inviteScopes = await listClaimedCreatorAccessScopes(getSupabaseAdminClient(), authUser.id);
  return {
    authUser,
    inviteScopes,
    authorized: expandCreatorAccessScopes(inviteScopes).includes(requestedScope),
  };
}

export function readPendingCreatorAccessClaimFromRequest(request: Request) {
  return parsePendingCreatorAccessClaimCookieValue(
    getCookieValueFromHeader(request.headers.get("cookie"), CREATOR_ACCESS_PENDING_COOKIE_NAME)
  );
}

export async function completeCreatorAccessClaim(request: Request) {
  const authUser = await getRequestAuthUser(request);
  if (!authUser) {
    return {
      ok: false as const,
      status: 401,
      error: "Sign in with your creator email first.",
      scopes: [] as CreatorAccessScope[],
    };
  }

  const admin = getSupabaseAdminClient();
  const pendingClaim = readPendingCreatorAccessClaimFromRequest(request);
  if (pendingClaim) {
    const invite = await findCreatorAccessInviteById(admin, pendingClaim.inviteId);
    if (!invite || invite.revoked_at) {
      return {
        ok: false as const,
        status: 403,
        error: "That creator access claim has expired or been revoked.",
        scopes: [] as CreatorAccessScope[],
      };
    }
    if (normalizeCreatorAccessEmail(invite.email) !== normalizeCreatorAccessEmail(authUser.email)) {
      return {
        ok: false as const,
        status: 403,
        error: "The signed-in email does not match this creator invite.",
        scopes: [] as CreatorAccessScope[],
      };
    }
    if (invite.claimed_user_id && invite.claimed_user_id !== authUser.id) {
      return {
        ok: false as const,
        status: 403,
        error: "That creator invite is already claimed by another account.",
        scopes: [] as CreatorAccessScope[],
      };
    }

    if (!invite.claimed_user_id) {
      const { error } = await admin
        .from("creator_access_invites")
        .update({
          claimed_user_id: authUser.id,
          claimed_at: new Date().toISOString(),
        })
        .eq("id", invite.id)
        .is("claimed_user_id", null);
      const setupError = toCreatorAccessSetupError(error);
      if (setupError) throw setupError;
    }
  }

  const scopes = await listClaimedCreatorAccessScopes(admin, authUser.id);
  return {
    ok: true as const,
    authUser,
    scopes,
  };
}
