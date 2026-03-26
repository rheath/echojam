"use client";

import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from "react";
import {
  getSupabaseAuthHeaders,
  safeGetSupabaseUser,
  safeOnSupabaseAuthStateChange,
  signOutSupabaseClient,
} from "@/lib/supabaseClient";

type CreatorInviteSummary = {
  id: string;
  email: string;
  scope: "mixed";
  claimed: boolean;
  claimedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

type DashboardResponse = {
  ok?: boolean;
  email?: string | null;
  invites?: CreatorInviteSummary[];
  error?: string;
};

class RequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "RequestError";
    this.status = status;
  }
}

async function fetchDashboardJson<T>(input: RequestInfo, init?: RequestInit) {
  const headers = await getSupabaseAuthHeaders(init?.headers, undefined, {
    context: "internal dashboard fetch",
  });
  const response = await fetch(input, { ...init, headers });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new RequestError(body.error || "Request failed.", response.status);
  }
  return body;
}

function formatTimestamp(value: string | null) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export default function InternalCreatorCodesClient() {
  const [accessState, setAccessState] = useState<"loading" | "signed_out" | "forbidden" | "ready" | "error">(
    "loading"
  );
  const [currentEmail, setCurrentEmail] = useState<string | null>(null);
  const [magicLinkEmail, setMagicLinkEmail] = useState("");
  const [magicLinkMessage, setMagicLinkMessage] = useState<string | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [isSendingMagicLink, setIsSendingMagicLink] = useState(false);
  const [creatorEmail, setCreatorEmail] = useState("");
  const [creatorCode, setCreatorCode] = useState("");
  const [isSavingInvite, setIsSavingInvite] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [invites, setInvites] = useState<CreatorInviteSummary[]>([]);

  const loadDashboard = useCallback(async () => {
    const signedInUser = await safeGetSupabaseUser(undefined, {
      context: "internal dashboard load user",
    });
    const signedInEmail = signedInUser?.email?.trim().toLowerCase() || null;
    setCurrentEmail(signedInEmail);
    setMagicLinkEmail((current) => current || signedInEmail || "");
    setDashboardError(null);

    try {
      const response = await fetchDashboardJson<DashboardResponse>("/api/internal/admin-dashboard");
      setInvites(Array.isArray(response.invites) ? response.invites : []);
      setAccessState("ready");
    } catch (error) {
      if (error instanceof RequestError) {
        if (error.status === 401) {
          setAccessState("signed_out");
          return;
        }
        if (error.status === 403) {
          setAccessState("forbidden");
          setDashboardError(error.message);
          return;
        }
      }

      setAccessState("error");
      setDashboardError(error instanceof Error ? error.message : "Failed to load creator code dashboard.");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (cancelled) return;
      await loadDashboard();
    }

    void run();

    const subscription = safeOnSupabaseAuthStateChange(() => {
      void loadDashboard();
    }, undefined, {
      context: "internal dashboard auth subscription",
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [loadDashboard]);

  async function handleSendMagicLink() {
    const email = magicLinkEmail.trim().toLowerCase();
    if (!email) {
      setDashboardError("Enter your admin email.");
      return;
    }

    setDashboardError(null);
    setMagicLinkMessage(null);
    setIsSendingMagicLink(true);
    try {
      const response = await fetch("/api/internal/admin-dashboard/access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(body.error || "Failed to send magic link.");
      }
      setMagicLinkMessage("Check your inbox for the admin magic link.");
    } catch (error) {
      setDashboardError(error instanceof Error ? error.message : "Failed to send magic link.");
    } finally {
      setIsSendingMagicLink(false);
    }
  }

  async function handleCreateInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDashboardError(null);
    setSaveMessage(null);
    setIsSavingInvite(true);

    try {
      const response = await fetchDashboardJson<{ ok?: boolean; inviteId?: string; email?: string }>(
        "/api/internal/admin-dashboard",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: creatorEmail,
            code: creatorCode,
          }),
        }
      );
      setCreatorCode("");
      setCreatorEmail("");
      setSaveMessage(`Saved invite for ${response.email || "creator"}.`);
      await loadDashboard();
    } catch (error) {
      setDashboardError(error instanceof Error ? error.message : "Failed to create creator invite.");
    } finally {
      setIsSavingInvite(false);
    }
  }

  async function handleSignOut() {
    await signOutSupabaseClient();
    setInvites([]);
    setSaveMessage(null);
    setMagicLinkMessage(null);
    setDashboardError(null);
    setAccessState("signed_out");
    setCurrentEmail(null);
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#f3f0eb",
        color: "#1f1714",
        padding: "32px 16px 48px",
        fontFamily: "Georgia, serif",
      }}
    >
      <div
        style={{
          width: "min(760px, 100%)",
          margin: "0 auto",
          display: "grid",
          gap: 16,
        }}
      >
        <section
          style={{
            background: "rgba(255,255,255,0.95)",
            border: "1px solid rgba(31,23,20,0.1)",
            borderRadius: 16,
            padding: 20,
          }}
        >
          <p style={{ margin: 0, fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", color: "#6a625d" }}>
            Internal
          </p>
          <h1 style={{ margin: "8px 0 0", fontSize: 36, lineHeight: 1 }}>Creator Codes</h1>
          <p style={{ margin: "12px 0 0", fontSize: 16, lineHeight: 1.5 }}>
            Create a Mix invite code without hashing it by hand.
          </p>
        </section>

        {accessState === "loading" ? (
          <section style={cardStyle}>
            <p style={bodyStyle}>Checking your admin access...</p>
          </section>
        ) : null}

        {accessState === "signed_out" ? (
          <section style={cardStyle}>
            <h2 style={sectionTitleStyle}>Sign in</h2>
            <p style={bodyStyle}>Use your allowlisted admin email to open the internal dashboard.</p>
            <div style={rowStyle}>
              <input
                value={magicLinkEmail}
                onChange={(event) => setMagicLinkEmail(event.target.value)}
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                style={inputStyle}
              />
              <button type="button" onClick={() => void handleSendMagicLink()} disabled={isSendingMagicLink} style={buttonStyle}>
                {isSendingMagicLink ? "Sending..." : "Send magic link"}
              </button>
            </div>
            {magicLinkMessage ? <p style={successStyle}>{magicLinkMessage}</p> : null}
          </section>
        ) : null}

        {accessState === "forbidden" ? (
          <section style={cardStyle}>
            <h2 style={sectionTitleStyle}>No Access</h2>
            <p style={bodyStyle}>
              Signed in as {currentEmail || "an unknown account"}, but that email is not on the dashboard allowlist.
            </p>
            <div style={rowStyle}>
              <button type="button" onClick={() => void handleSignOut()} style={secondaryButtonStyle}>
                Sign out
              </button>
            </div>
          </section>
        ) : null}

        {accessState === "error" ? (
          <section style={cardStyle}>
            <h2 style={sectionTitleStyle}>Unavailable</h2>
            <p style={bodyStyle}>{dashboardError || "Failed to load the dashboard."}</p>
          </section>
        ) : null}

        {accessState === "ready" ? (
          <>
            <section style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <div>
                  <h2 style={sectionTitleStyle}>Create Invite</h2>
                  <p style={bodyStyle}>Signed in as {currentEmail || "admin"}.</p>
                </div>
                <button type="button" onClick={() => void handleSignOut()} style={secondaryButtonStyle}>
                  Sign out
                </button>
              </div>
              <form onSubmit={handleCreateInvite} style={{ display: "grid", gap: 12, marginTop: 16 }}>
                <input
                  value={creatorEmail}
                  onChange={(event) => setCreatorEmail(event.target.value)}
                  type="email"
                  autoComplete="email"
                  placeholder="Creator email"
                  style={inputStyle}
                />
                <input
                  value={creatorCode}
                  onChange={(event) => setCreatorCode(event.target.value)}
                  type="text"
                  autoComplete="off"
                  placeholder="Raw creator code"
                  style={inputStyle}
                />
                <div style={rowStyle}>
                  <button type="submit" disabled={isSavingInvite} style={buttonStyle}>
                    {isSavingInvite ? "Saving..." : "Create code"}
                  </button>
                </div>
              </form>
              {saveMessage ? <p style={successStyle}>{saveMessage}</p> : null}
            </section>

            <section style={cardStyle}>
              <h2 style={sectionTitleStyle}>Recent Invites</h2>
              {invites.length === 0 ? (
                <p style={bodyStyle}>No creator invites yet.</p>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 12 }}>
                    <thead>
                      <tr>
                        <th style={tableHeaderStyle}>Email</th>
                        <th style={tableHeaderStyle}>Scope</th>
                        <th style={tableHeaderStyle}>Status</th>
                        <th style={tableHeaderStyle}>Created</th>
                        <th style={tableHeaderStyle}>Revoked</th>
                      </tr>
                    </thead>
                    <tbody>
                      {invites.map((invite) => (
                        <tr key={invite.id}>
                          <td style={tableCellStyle}>{invite.email}</td>
                          <td style={tableCellStyle}>{invite.scope}</td>
                          <td style={tableCellStyle}>{invite.claimed ? "Claimed" : "Unclaimed"}</td>
                          <td style={tableCellStyle}>{formatTimestamp(invite.createdAt)}</td>
                          <td style={tableCellStyle}>{invite.revokedAt ? formatTimestamp(invite.revokedAt) : "Active"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        ) : null}

        {dashboardError && (accessState === "ready" || accessState === "signed_out") ? (
          <section style={errorCardStyle}>{dashboardError}</section>
        ) : null}
      </div>
    </main>
  );
}

const cardStyle: CSSProperties = {
  background: "rgba(255,255,255,0.95)",
  border: "1px solid rgba(31,23,20,0.1)",
  borderRadius: 16,
  padding: 20,
};

const errorCardStyle: CSSProperties = {
  ...cardStyle,
  color: "#8a1f11",
  background: "rgba(255,240,237,0.95)",
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 24,
};

const bodyStyle: CSSProperties = {
  margin: "8px 0 0",
  fontSize: 15,
  lineHeight: 1.5,
};

const rowStyle: CSSProperties = {
  display: "flex",
  gap: 12,
  flexWrap: "wrap",
  marginTop: 12,
};

const inputStyle: CSSProperties = {
  width: "100%",
  minHeight: 48,
  padding: "0 14px",
  borderRadius: 12,
  border: "1px solid rgba(31,23,20,0.2)",
  background: "#fff",
  color: "#1f1714",
  fontSize: 16,
};

const buttonStyle: CSSProperties = {
  minHeight: 44,
  padding: "0 16px",
  borderRadius: 999,
  border: "none",
  background: "#1f1714",
  color: "#fff",
  fontSize: 14,
  cursor: "pointer",
};

const secondaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "rgba(31,23,20,0.08)",
  color: "#1f1714",
};

const successStyle: CSSProperties = {
  margin: "12px 0 0",
  fontSize: 14,
  lineHeight: 1.5,
  color: "#255d27",
};

const tableHeaderStyle: CSSProperties = {
  textAlign: "left",
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "#6a625d",
  padding: "10px 8px",
  borderBottom: "1px solid rgba(31,23,20,0.1)",
};

const tableCellStyle: CSSProperties = {
  padding: "12px 8px",
  borderBottom: "1px solid rgba(31,23,20,0.08)",
  fontSize: 14,
  lineHeight: 1.4,
};
