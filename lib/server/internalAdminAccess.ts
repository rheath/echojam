import "server-only";

import { getRequestAuthUser, type RequestAuthUser } from "@/lib/server/requestAuth";
import { normalizeCreatorAccessEmail } from "@/lib/server/creatorAccess";

export type InternalAdminAccessResult =
  | {
      ok: true;
      authUser: RequestAuthUser;
      normalizedEmail: string;
    }
  | {
      ok: false;
      status: number;
      error: string;
    };

export type InternalAdminMagicLinkValidationResult =
  | {
      ok: true;
      normalizedEmail: string;
    }
  | {
      ok: false;
      status: number;
      error: string;
    };

export function parseCreatorCodeDashboardAdminEmails(value: string | undefined) {
  const deduped = new Set<string>();
  for (const part of (value || "").split(/[\n,]+/)) {
    const normalized = normalizeCreatorAccessEmail(part);
    if (normalized) deduped.add(normalized);
  }
  return [...deduped];
}

export function getCreatorCodeDashboardAdminEmails() {
  return parseCreatorCodeDashboardAdminEmails(process.env.CREATOR_CODE_DASHBOARD_ADMIN_EMAILS);
}

export function isCreatorCodeDashboardAdminEmail(email: string | null | undefined) {
  const normalized = normalizeCreatorAccessEmail(email);
  if (!normalized) return false;
  return getCreatorCodeDashboardAdminEmails().includes(normalized);
}

export function validateCreatorCodeDashboardMagicLinkEmail(
  email: string | null | undefined
): InternalAdminMagicLinkValidationResult {
  const normalizedEmail = normalizeCreatorAccessEmail(email);
  if (!normalizedEmail) {
    return {
      ok: false,
      status: 400,
      error: "Enter your admin email.",
    };
  }

  const adminEmails = getCreatorCodeDashboardAdminEmails();
  if (adminEmails.length === 0) {
    return {
      ok: false,
      status: 503,
      error: "CREATOR_CODE_DASHBOARD_ADMIN_EMAILS is not configured.",
    };
  }

  if (!adminEmails.includes(normalizedEmail)) {
    return {
      ok: false,
      status: 403,
      error: "That email is not allowed to access the creator-code dashboard.",
    };
  }

  return {
    ok: true,
    normalizedEmail,
  };
}

export async function ensureCreatorCodeDashboardAdminAccess(
  request: Request
): Promise<InternalAdminAccessResult> {
  const authUser = await getRequestAuthUser(request);
  if (!authUser) {
    return {
      ok: false,
      status: 401,
      error: "Sign in with your admin email first.",
    };
  }

  const normalizedEmail = normalizeCreatorAccessEmail(authUser.email);
  const adminEmails = getCreatorCodeDashboardAdminEmails();
  if (adminEmails.length === 0) {
    return {
      ok: false,
      status: 503,
      error: "CREATOR_CODE_DASHBOARD_ADMIN_EMAILS is not configured.",
    };
  }

  if (!normalizedEmail || !adminEmails.includes(normalizedEmail)) {
    return {
      ok: false,
      status: 403,
      error: "Only allowlisted admin emails can access this page.",
    };
  }

  return {
    ok: true,
    authUser,
    normalizedEmail,
  };
}
