import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  hashCreatorAccessCode,
  normalizeCreatorAccessCode,
  normalizeCreatorAccessEmail,
} from "@/lib/server/creatorAccess";

export type CreatorInviteSummary = {
  id: string;
  email: string;
  scope: "mixed";
  claimed: boolean;
  claimedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

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

function isDuplicateInviteError(message: string | null | undefined) {
  const normalized = (message || "").trim().toLowerCase();
  return (
    normalized.includes("idx_creator_access_invites_code_hash_email_scope") ||
    normalized.includes("duplicate key value violates unique constraint")
  );
}

function toDashboardInviteError(error: { message?: string | null } | null | undefined) {
  if (isMissingCreatorAccessInvitesSchemaError(error?.message)) {
    return new Error(
      "Creator access is not set up yet. Run the Supabase migrations for creator invites first."
    );
  }
  if (isDuplicateInviteError(error?.message)) {
    return new Error("That creator email and code combination already exists.");
  }
  return error ? new Error(error.message || "Failed to save creator invite.") : null;
}

export async function createCreatorCodeInvite(
  admin: SupabaseClient,
  args: {
    email: string | null | undefined;
    code: string | null | undefined;
  }
) {
  const email = normalizeCreatorAccessEmail(args.email);
  if (!email) {
    throw new Error("Enter the creator email.");
  }

  const normalizedCode = normalizeCreatorAccessCode(args.code);
  if (!normalizedCode) {
    throw new Error("Enter the creator code.");
  }

  const { data, error } = await admin
    .from("creator_access_invites")
    .insert({
      email,
      code_hash: hashCreatorAccessCode(normalizedCode),
      scope: "mixed",
    })
    .select("id,email")
    .single();

  const insertError = toDashboardInviteError(error);
  if (insertError) throw insertError;
  if (!data?.id) throw new Error("Failed to save creator invite.");

  return {
    id: data.id as string,
    email: normalizeCreatorAccessEmail((data as { email?: string | null }).email) || email,
  };
}

export async function listRecentCreatorCodeInvites(admin: SupabaseClient, limit = 25) {
  const { data, error } = await admin
    .from("creator_access_invites")
    .select("id,email,scope,claimed_user_id,claimed_at,revoked_at,created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  const listError = toDashboardInviteError(error);
  if (listError) throw listError;

  return ((data ?? []) as Array<{
    id: string;
    email: string | null;
    scope: string | null;
    claimed_user_id: string | null;
    claimed_at: string | null;
    revoked_at: string | null;
    created_at: string;
  }>).map((row) => ({
    id: row.id,
    email: normalizeCreatorAccessEmail(row.email) || "",
    scope: "mixed",
    claimed: Boolean(row.claimed_user_id),
    claimedAt: row.claimed_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  })) satisfies CreatorInviteSummary[];
}
