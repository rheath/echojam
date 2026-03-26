import assert from "node:assert/strict";
import test from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "anon-key";

const {
  getSupabaseAuthHeaders,
  isSupabaseLockAcquireTimeoutError,
  retrySupabaseAuthOperation,
  safeGetSupabaseSession,
  safeGetSupabaseUser,
  safeOnSupabaseAuthStateChange,
} = await import("./supabaseClient.ts");

function createLockTimeoutError(message?: string) {
  return Object.assign(
    new Error(
      message ||
        'Acquiring an exclusive Navigator LockManager lock "lock:sb-test-auth-token" timed out waiting 10000ms'
    ),
    { isAcquireTimeout: true }
  );
}

test("isSupabaseLockAcquireTimeoutError detects documented and current timeout shapes", () => {
  assert.equal(isSupabaseLockAcquireTimeoutError(createLockTimeoutError()), true);
  assert.equal(
    isSupabaseLockAcquireTimeoutError(
      new Error(
        'Acquiring an exclusive Navigator LockManager lock "lock:sb-test-auth-token" timed out waiting 10000ms'
      )
    ),
    true
  );
  assert.equal(isSupabaseLockAcquireTimeoutError(new Error("totally unrelated")), false);
});

test("safeGetSupabaseSession and auth headers fall back to anonymous state on lock timeout", async () => {
  const fakeClient = {
    auth: {
      async getSession() {
        throw createLockTimeoutError();
      },
    },
  };

  const session = await safeGetSupabaseSession(fakeClient as never, {
    context: "test session fallback",
    retries: 0,
  });
  const headers = await getSupabaseAuthHeaders(
    { "X-Test": "1" },
    fakeClient as never,
    {
      context: "test auth headers fallback",
      retries: 0,
    }
  );

  assert.equal(session, null);
  assert.equal(headers.get("Authorization"), null);
  assert.equal(headers.get("X-Test"), "1");
});

test("safeGetSupabaseUser falls back to null on lock timeout", async () => {
  const fakeClient = {
    auth: {
      async getUser() {
        throw createLockTimeoutError();
      },
    },
  };

  const user = await safeGetSupabaseUser(fakeClient as never, {
    context: "test user fallback",
    retries: 0,
  });

  assert.equal(user, null);
});

test("retrySupabaseAuthOperation retries lock timeouts and eventually succeeds", async () => {
  let attempts = 0;

  const value = await retrySupabaseAuthOperation(async () => {
    attempts += 1;
    if (attempts < 3) {
      throw createLockTimeoutError();
    }
    return "ok";
  }, {
    context: "test retry success",
    retries: 2,
    retryDelayMs: 0,
  });

  assert.equal(value, "ok");
  assert.equal(attempts, 3);
});

test("retrySupabaseAuthOperation surfaces lock timeout after retries are exhausted", async () => {
  await assert.rejects(
    retrySupabaseAuthOperation(async () => {
      throw createLockTimeoutError();
    }, {
      context: "test retry exhausted",
      retries: 1,
      retryDelayMs: 0,
    }),
    (error: unknown) => isSupabaseLockAcquireTimeoutError(error)
  );
});

test("safeOnSupabaseAuthStateChange returns a noop subscription when registration hits a lock timeout", () => {
  const fakeClient = {
    auth: {
      onAuthStateChange() {
        throw createLockTimeoutError();
      },
    },
  };

  const subscription = safeOnSupabaseAuthStateChange(
    () => {
      throw new Error("callback should not run");
    },
    fakeClient as never,
    { context: "test auth subscription" }
  );

  assert.equal(typeof subscription.unsubscribe, "function");
  subscription.unsubscribe();
});
