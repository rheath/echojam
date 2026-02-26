import { NextResponse } from "next/server";

const REQUIRED_ENV_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

const OPTIONAL_ENV_KEYS = ["OPENAI_API_KEY"] as const;

function hasNonEmptyEnv(key: string) {
  const value = process.env[key];
  return typeof value === "string" && value.trim().length > 0;
}

export async function GET() {
  const required = Object.fromEntries(
    REQUIRED_ENV_KEYS.map((key) => [key, hasNonEmptyEnv(key)])
  ) as Record<(typeof REQUIRED_ENV_KEYS)[number], boolean>;

  const optional = Object.fromEntries(
    OPTIONAL_ENV_KEYS.map((key) => [key, hasNonEmptyEnv(key)])
  ) as Record<(typeof OPTIONAL_ENV_KEYS)[number], boolean>;

  const missingRequired = REQUIRED_ENV_KEYS.filter((key) => !required[key]);
  const ok = missingRequired.length === 0;

  return NextResponse.json(
    {
      ok,
      required,
      optional,
      missingRequired,
      ts: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 }
  );
}
