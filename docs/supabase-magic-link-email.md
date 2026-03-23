# Supabase Magic-Link Email Branding

This project keeps Supabase Auth in charge of generating and sending magic links. The branded sender and template live in Supabase Auth settings, while the source-of-truth copy and HTML live in this repo for repeatable updates.

## Files

- HTML template: [`supabase/templates/magic-link.html`](/Users/robertheath/echojam/supabase/templates/magic-link.html)
- Plain-text template: [`supabase/templates/magic-link.txt`](/Users/robertheath/echojam/supabase/templates/magic-link.txt)
- App entry point that triggers the email: [`app/api/auth/magic-link/route.ts`](/Users/robertheath/echojam/app/api/auth/magic-link/route.ts)
- Callback page after the user clicks the link: [`app/auth/callback/page.tsx`](/Users/robertheath/echojam/app/auth/callback/page.tsx)

## Supabase Dashboard Settings

In Supabase, open `Authentication -> Email Templates -> Magic Link` and apply:

- Subject: `Your Wandrful sign-in link`
- HTML content: paste [`supabase/templates/magic-link.html`](/Users/robertheath/echojam/supabase/templates/magic-link.html)

Supabase does not expose a separate plain-text field in the hosted dashboard. Keep [`supabase/templates/magic-link.txt`](/Users/robertheath/echojam/supabase/templates/magic-link.txt) as the fallback copy reference for providers or workflows that support multipart text bodies outside the dashboard UI.

In Supabase, open `Authentication -> SMTP Settings` and configure:

- Sender name: `Wandrful Support`
- From address: `support@wandrful.app`
- SMTP host, port, username, and password from the production mail provider
- Link tracking disabled if the provider rewrites URLs

Supabase's shared SMTP service is only suitable for limited testing. Production delivery should use your own authenticated SMTP provider.

## Required Template Variables

The template depends on Supabase Auth variables documented by Supabase:

- `{{ .ConfirmationURL }}` for the CTA and fallback link
- `{{ .Email }}` for the destination mailbox copy

Do not replace `{{ .ConfirmationURL }}` with a hard-coded app URL. The current sign-in flow depends on the Supabase-generated verification link preserving the `redirect_to` value from [`app/api/auth/magic-link/route.ts`](/Users/robertheath/echojam/app/api/auth/magic-link/route.ts).

## Smoke Test

1. Request a magic link from a signed-out paid journey page.
2. Confirm the email arrives from `Wandrful Support <support@wandrful.app>`.
3. Confirm the subject is `Your Wandrful sign-in link`.
4. Open the email in desktop and mobile clients to verify the button and fallback link are readable.
5. Click the CTA and confirm the user lands on `/auth/callback`, is signed in, and returns to the intended journey page.
6. Repeat with an expired or already-used link and confirm the callback page shows a clear failure message.
7. Verify entitlement and checkout behavior still match the paid-journey flow after sign-in.

## Notes

- If the sender or template is updated in Supabase, update the template source files in this repo in the same change.
- If the app later needs fully custom email delivery, keep the existing `/api/auth/magic-link` entry point and replace only the sending mechanism behind it.
