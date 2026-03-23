import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node test runner resolves the local TypeScript module by explicit extension here.
import { verifyStripeWebhookSignature } from "../lib/server/stripe.ts";

test("verifyStripeWebhookSignature accepts a valid signature", () => {
  const secret = "whsec_test_secret";
  const rawBody = JSON.stringify({
    id: "evt_123",
    type: "checkout.session.completed",
  });
  const timestamp = "1710000000";
  const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");

  assert.doesNotThrow(() => {
    verifyStripeWebhookSignature(rawBody, `t=${timestamp},v1=${signature}`, secret);
  });
});

test("verifyStripeWebhookSignature rejects an invalid signature", () => {
  assert.throws(() => {
    verifyStripeWebhookSignature("{}", "t=1710000000,v1=invalid", "whsec_test_secret");
  }, /Invalid Stripe signature/);
});
