# Paid Journeys Launch Checklist

This checklist is for the current paid preset launch path. The paid route wired in the app today is `boston-old-taverns`.

## 1. Apply the Supabase migration

Run the migration in Supabase:

- [`20260322_add_journey_offerings_and_entitlements.sql`](/Users/robertheath/echojam/supabase/migrations/20260322_add_journey_offerings_and_entitlements.sql)

This creates:

- `journey_offerings`
- `journey_entitlements`
- `stripe_webhook_events`

Quick verification in Supabase SQL editor:

```sql
select to_regclass('public.journey_offerings');
select to_regclass('public.journey_entitlements');
select to_regclass('public.stripe_webhook_events');
```

## 2. Configure Supabase Auth for magic links

In Supabase Auth settings:

- Set `Site URL` to your production app URL
- Add redirect URL: `https://your-domain.com/auth/callback`
- Add preview or staging callback URLs if you use them
- Configure custom SMTP for production delivery
- Set sender name to `Wandrful Support`
- Set from address to `support@wandrful.app`
- Set email OTP / magic link expiry to `300` seconds (`5 minutes`)
- Update the Magic Link email subject to `Your Wandrful sign-in link`
- Paste the branded HTML from [`magic-link.html`](/Users/robertheath/echojam/supabase/templates/magic-link.html)
- Keep the plain-text fallback copy in [`magic-link.txt`](/Users/robertheath/echojam/supabase/templates/magic-link.txt)
- Disable provider link tracking if your SMTP provider rewrites email links

The app sends magic links from:

- [`route.ts`](/Users/robertheath/echojam/app/api/auth/magic-link/route.ts)

The callback page is:

- [`page.tsx`](/Users/robertheath/echojam/app/auth/callback/page.tsx)

Detailed branding notes live in:

- [`supabase-magic-link-email.md`](/Users/robertheath/echojam/docs/supabase-magic-link-email.md)

## 3. Add production env vars

Set these on your production app host:

```bash
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
NEXT_PUBLIC_SITE_URL=https://your-domain.com
STRIPE_SECRET_KEY=...
STRIPE_WEBHOOK_SECRET=...
OPENAI_API_KEY=...
```

Template file:

- [`.env.production`](/Users/robertheath/echojam/.env.production)

Runtime check endpoint:

- `GET /api/env-check`

Expected for this launch:

- `NEXT_PUBLIC_SITE_URL: true`
- `STRIPE_SECRET_KEY: true`
- `STRIPE_WEBHOOK_SECRET: true`

## 4. Create the Stripe webhook

In Stripe, create a webhook endpoint:

- `https://your-domain.com/api/stripe/webhooks`

Subscribe to:

- `checkout.session.completed`

Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

Webhook handler:

- [`route.ts`](/Users/robertheath/echojam/app/api/stripe/webhooks/route.ts)

## 5. Deploy the app

Use your normal Next deployment flow.

Core files for the live paid-journey path:

- [`JourneyAccessClient.tsx`](/Users/robertheath/echojam/app/journeys/[slug]/JourneyAccessClient.tsx)
- [`route.ts`](/Users/robertheath/echojam/app/api/journey-offerings/[slug]/route.ts)
- [`route.ts`](/Users/robertheath/echojam/app/api/journey-offerings/[slug]/checkout/route.ts)

After deploy, confirm this page loads:

- `/journeys/boston-old-taverns`

## 6. Smoke test the launch

### Signed out

Open:

- `/journeys/boston-old-taverns`

Expected:

- teaser content only
- no full route content
- magic-link form appears

### Signed in but not purchased

Expected:

- teaser content only
- checkout button appears

### After payment

Complete a Stripe test payment.

Expected:

- one row in `journey_entitlements`
- one row in `stripe_webhook_events`
- journey page shows unlocked state

Quick verification query:

```sql
select id, offering_id, user_id, purchaser_email, status, stripe_checkout_session_id
from public.journey_entitlements
order by created_at desc
limit 10;

select stripe_event_id, event_type, created_at
from public.stripe_webhook_events
order by created_at desc
limit 10;
```

### Open in app

From the unlocked journey page, click `Open in EchoJam`.

Expected:

- app opens with `?startPresetRoute=boston-old-taverns`
- preset generation can start
- full route loads

### Share behavior

Share a paid jam link after unlocking.

Expected:

- canonical/share resolution lands on the journey page
- friends without entitlement stay locked

Share logic lives in:

- [`jamShare.ts`](/Users/robertheath/echojam/lib/server/jamShare.ts)

## 7. API checks

Non-entitled request:

```bash
curl -i https://your-domain.com/api/preset-routes/boston-old-taverns
```

Expected:

- `402` with `access: "locked"`

Entitled request:

- repeat with a valid Supabase bearer token

Expected:

- `200` with `access: "granted"`

Protected route handler:

- [`route.ts`](/Users/robertheath/echojam/app/api/preset-routes/[routeId]/route.ts)

Protected job creation:

- [`route.ts`](/Users/robertheath/echojam/app/api/preset-jobs/create/route.ts)
