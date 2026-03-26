import {
  createClient,
  type AuthChangeEvent,
  type Session,
  type User,
} from "@supabase/supabase-js";

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type BrowserSupabaseClient = typeof supabase;

type AuthSubscription = {
  unsubscribe: () => void;
};

type SafeAuthOptions = {
  context?: string;
  retries?: number;
  retryDelayMs?: number;
};

const DEFAULT_SAFE_AUTH_RETRIES = 1;
const DEFAULT_SAFE_AUTH_RETRY_DELAY_MS = 150;
const AUTH_LOCK_TIMEOUT_PATTERN =
  /(navigator(?:\s+lockmanager)?\s+lock|lock:sb-[^"]*auth-token|lock acquisition timed out|timed out waiting \d+ms)/i;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown) {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return "";
}

export function isSupabaseLockAcquireTimeoutError(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "isAcquireTimeout" in error &&
    (error as { isAcquireTimeout?: unknown }).isAcquireTimeout === true
  ) {
    return true;
  }

  const message = getErrorMessage(error).trim();
  if (!message) return false;
  if (!AUTH_LOCK_TIMEOUT_PATTERN.test(message)) return false;
  return /supabase|lock:sb-|navigator/i.test(message);
}

function logSuppressedAuthLockTimeout(context: string, error: unknown) {
  console.warn(`[supabase-auth] suppressed lock timeout (${context})`, error);
}

export async function retrySupabaseAuthOperation<T>(
  operation: () => Promise<T>,
  options?: SafeAuthOptions
): Promise<T> {
  const context = options?.context?.trim() || "auth";
  const retries = Math.max(0, options?.retries ?? 0);
  const retryDelayMs = Math.max(0, options?.retryDelayMs ?? DEFAULT_SAFE_AUTH_RETRY_DELAY_MS);
  let attempt = 0;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!isSupabaseLockAcquireTimeoutError(error) || attempt >= retries) {
        throw error;
      }
      console.warn(
        `[supabase-auth] retrying lock timeout (${context}) attempt=${attempt + 1}/${retries + 1}`,
        error
      );
      attempt += 1;
      if (retryDelayMs > 0) {
        await sleep(retryDelayMs);
      }
    }
  }
}

export async function safeGetSupabaseSession(
  client: BrowserSupabaseClient = supabase,
  options?: SafeAuthOptions
): Promise<Session | null> {
  const context = options?.context?.trim() || "getSession";

  try {
    return await retrySupabaseAuthOperation(async () => {
      const { data } = await client.auth.getSession();
      return data.session ?? null;
    }, {
      context,
      retries: options?.retries ?? DEFAULT_SAFE_AUTH_RETRIES,
      retryDelayMs: options?.retryDelayMs,
    });
  } catch (error) {
    if (!isSupabaseLockAcquireTimeoutError(error)) throw error;
    logSuppressedAuthLockTimeout(context, error);
    return null;
  }
}

export async function safeGetSupabaseUser(
  client: BrowserSupabaseClient = supabase,
  options?: SafeAuthOptions
): Promise<User | null> {
  const context = options?.context?.trim() || "getUser";

  try {
    return await retrySupabaseAuthOperation(async () => {
      const { data } = await client.auth.getUser();
      return data.user ?? null;
    }, {
      context,
      retries: options?.retries ?? DEFAULT_SAFE_AUTH_RETRIES,
      retryDelayMs: options?.retryDelayMs,
    });
  } catch (error) {
    if (!isSupabaseLockAcquireTimeoutError(error)) throw error;
    logSuppressedAuthLockTimeout(context, error);
    return null;
  }
}

export async function getSupabaseAuthHeaders(
  headersInit?: HeadersInit,
  client: BrowserSupabaseClient = supabase,
  options?: SafeAuthOptions
) {
  const headers = new Headers(headersInit);
  const session = await safeGetSupabaseSession(client, {
    context: options?.context || "auth headers",
    retries: options?.retries,
    retryDelayMs: options?.retryDelayMs,
  });
  const accessToken = session?.access_token?.trim();
  if (accessToken && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${accessToken}`);
  }
  return headers;
}

export function safeOnSupabaseAuthStateChange(
  callback: (event: AuthChangeEvent, session: Session | null) => void,
  client: BrowserSupabaseClient = supabase,
  options?: { context?: string }
): AuthSubscription {
  const context = options?.context?.trim() || "onAuthStateChange";

  try {
    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((event, session) => {
      callback(event, session);
    });
    return subscription;
  } catch (error) {
    if (!isSupabaseLockAcquireTimeoutError(error)) throw error;
    logSuppressedAuthLockTimeout(context, error);
    return {
      unsubscribe() {
        // noop
      },
    };
  }
}

export async function signOutSupabaseClient(client: BrowserSupabaseClient = supabase) {
  await client.auth.signOut();
}

export async function exchangeSupabaseCodeForSession(
  code: string,
  client: BrowserSupabaseClient = supabase,
  options?: SafeAuthOptions
) {
  return await retrySupabaseAuthOperation(
    async () => {
      return await client.auth.exchangeCodeForSession(code);
    },
    {
      context: options?.context || "exchangeCodeForSession",
      retries: options?.retries ?? 2,
      retryDelayMs: options?.retryDelayMs ?? 250,
    }
  );
}
