import { createHmac, timingSafeEqual } from "node:crypto";

export type StripeCheckoutSession = {
  id: string;
  url: string | null;
};

export type StripeCheckoutCompletedEvent = {
  id: string;
  type: "checkout.session.completed";
  data: {
    object: {
      id: string;
      customer_details?: {
        email?: string | null;
      } | null;
      payment_status?: string | null;
      metadata?: Record<string, string | undefined> | null;
    };
  };
};

type CreateCheckoutParams = {
  title: string;
  description: string | null;
  amountUsdCents: number;
  purchaserEmail: string | null;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
};

function getStripeSecretKey() {
  const secret = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!secret) throw new Error("STRIPE_SECRET_KEY is required.");
  return secret;
}

export function getStripeWebhookSecret() {
  const secret = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is required.");
  return secret;
}

function encodeStripeValue(value: string | number | boolean | null | undefined) {
  if (value == null) return "";
  return String(value);
}

function toFormBody(entries: Array<[string, string | number | boolean | null | undefined]>) {
  const body = new URLSearchParams();
  for (const [key, value] of entries) {
    if (value == null) continue;
    body.append(key, encodeStripeValue(value));
  }
  return body;
}

export async function createStripeCheckoutSession(params: CreateCheckoutParams): Promise<StripeCheckoutSession> {
  const secret = getStripeSecretKey();
  const metadataEntries: Array<[string, string]> = Object.entries(params.metadata).map(([key, value]) => [
    `metadata[${key}]`,
    value,
  ]);
  const formBody = toFormBody([
    ["mode", "payment"],
    ["success_url", params.successUrl],
    ["cancel_url", params.cancelUrl],
    ["billing_address_collection", "auto"],
    ["line_items[0][quantity]", 1],
    ["line_items[0][price_data][currency]", "usd"],
    ["line_items[0][price_data][unit_amount]", params.amountUsdCents],
    ["line_items[0][price_data][product_data][name]", params.title],
    ["line_items[0][price_data][product_data][description]", params.description],
    ["customer_email", params.purchaserEmail],
    ...metadataEntries,
  ]);

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formBody.toString(),
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => ({}))) as {
    id?: string;
    url?: string | null;
    error?: { message?: string };
  };
  if (!response.ok || !payload.id) {
    throw new Error(payload.error?.message || "Failed to create Stripe Checkout session.");
  }

  return {
    id: payload.id,
    url: payload.url ?? null,
  };
}

function safeEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyStripeWebhookSignature(rawBody: string, signatureHeader: string, secret: string) {
  const segments = signatureHeader.split(",").map((segment) => segment.trim()).filter(Boolean);
  const values = new Map<string, string[]>();
  for (const segment of segments) {
    const separatorIndex = segment.indexOf("=");
    if (separatorIndex < 0) continue;
    const key = segment.slice(0, separatorIndex).trim();
    const value = segment.slice(separatorIndex + 1).trim();
    if (!key || !value) continue;
    const next = values.get(key) ?? [];
    next.push(value);
    values.set(key, next);
  }

  const timestamp = values.get("t")?.[0];
  const signatures = values.get("v1") ?? [];
  if (!timestamp || signatures.length === 0) {
    throw new Error("Missing Stripe signature components.");
  }

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const isValid = signatures.some((signature) => safeEquals(signature, expected));
  if (!isValid) {
    throw new Error("Invalid Stripe signature.");
  }
}
