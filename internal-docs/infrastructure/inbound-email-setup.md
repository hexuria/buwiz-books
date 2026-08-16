# Inbound Email Setup (Inbox by Email)

This wires up the **inbox-by-email** feature: users forward or email receipts,
bills, and statements to a per-organization address, and they land in the Inbox
for review. It relies on **Resend inbound receiving** delivering mail to the app
webhook at `POST /api/inbound-email/resend`.

> ⚠️ **The golden rule: receiving goes on a dedicated _subdomain_, never the
> apex domain.** `mvgreenland.com`'s real mailboxes (e.g. `annmarie@…`) are
> served by Hostinger MX (`mx1.hostinger.com` / `mx2.hostinger.com`). Adding a
> receiving MX to the **apex** collides with those and can silently break all
> incoming mail. Use `inbox.mvgreenland.com`.

## Facts for this domain (verified)

| Thing                 | Value                                                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Registrar             | Hostinger                                                                                                                                |
| **Authoritative DNS** | **Cloudflare** (nameservers `ezra.ns.cloudflare.com` / `nena.ns.cloudflare.com`) — **all DNS edits happen in Cloudflare**, not Hostinger |
| Current mail (apex)   | Hostinger (`mx1`/`mx2.hostinger.com`) — **do not touch**                                                                                 |
| Resend region         | Ireland (`eu-west-1`)                                                                                                                    |
| App URL               | `https://digits.mvgreenland.com`                                                                                                         |
| Inbound subdomain     | `inbox.mvgreenland.com`                                                                                                                  |

Because DNS is on Cloudflare, records added at Hostinger's DNS panel are ignored.
Edit records **only in the Cloudflare dashboard** for `mvgreenland.com`.

## Steps

### 1. Add the subdomain in Resend

1. Resend → **Domains** → **Add Domain** → `inbox.mvgreenland.com` (region: Ireland).
2. Resend shows a set of DNS records for the subdomain (DKIM `TXT`, SPF, and — once
   you enable receiving — an **MX**). Keep this tab open; you'll copy these into
   Cloudflare.
3. On the new `inbox.mvgreenland.com` domain, turn **Enable Receiving** ON. Its MX
   `Name` will be the subdomain (e.g. `inbox`), **not `@`** — so there is no apex
   conflict and no red warning. The MX target is Resend's inbound host, e.g.
   `inbound-smtp.eu-west-1.amazonaws.com` (copy the exact value Resend shows).

### 2. Add the records in Cloudflare

In the Cloudflare dashboard for `mvgreenland.com` → **DNS** → add each record
Resend listed for the subdomain **exactly as shown**:

- DKIM: `TXT` on `resend._domainkey.inbox` → the `p=…` value.
- SPF: as shown (usually `TXT`/`MX` on `send.inbox` or `inbox`).
- **Receiving MX:** `MX` on `inbox` → `inbound-smtp.eu-west-1.amazonaws.com` (priority as shown).

Set these DNS-only (grey cloud, not proxied). Cloudflare's "Auto configure" from
Resend can add them for you — just confirm the `Name` column targets the
**subdomain**, never `@`. Wait for Resend to mark the subdomain **Verified** /
receiving green.

### 3. Add the inbound webhook in Resend

1. Resend → **Webhooks** → **Add Webhook**.
2. Endpoint: `https://digits.mvgreenland.com/api/inbound-email/resend`
3. Subscribe to the inbound **`email.received`** event.
4. Copy the webhook **Signing Secret** — it becomes `RESEND_WEBHOOK_SECRET`.

### 4. Set environment variables (production)

Add to `.env.cloudrun.yaml` (or the Cloud Run service env) and redeploy:

```
INBOUND_EMAIL_DOMAIN=inbox.mvgreenland.com
RESEND_WEBHOOK_SECRET=<signing secret from step 3>
SECRETS_ENCRYPTION_KEY=<openssl rand -base64 32>   # 32-byte base64, keep it safe
```

`SECRETS_ENCRYPTION_KEY` also powers at-rest encryption of all org credentials
and statement passwords — required in production regardless of inbound email.

### 5. Backfill existing secrets (once, after setting the key)

```bash
bun run scripts/encrypt-org-secrets.ts            # encrypts plaintext org secrets
# bun run scripts/encrypt-org-secrets.ts --dry-run  # preview only
```

## Verify end-to-end

1. In the app (Inbox sidebar, as an admin) click **Generate** — you should get an
   address like `inbox-mvgreenland-k3f9q2@inbox.mvgreenland.com`. **Save** it.
2. From any mailbox, send an email with a PDF/receipt attached to that address.
3. Within a minute or two the item appears in the **Inbox** for review. If not,
   check Resend → **Logs** (was the webhook delivered?) and the app logs for
   `api.inbound-email.resend`.

## Rotating the encryption key (reference)

1. Put the **new** key in `SECRETS_ENCRYPTION_KEY`, move the **old** key to
   `SECRETS_ENCRYPTION_KEY_PREVIOUS`.
2. `bun run scripts/encrypt-org-secrets.ts --rotate`
3. Once complete, unset `SECRETS_ENCRYPTION_KEY_PREVIOUS`.

## Troubleshooting

- **Red "Conflicting MX records" in Resend** → you're on the apex. Stop; use the
  subdomain instead.
- **Records "Not Started" / not verifying** → they were added at Hostinger, not
  Cloudflare. Cloudflare is authoritative here.
- **Mail sent but nothing in the Inbox** → the recipient address must exactly
  match an organization's saved inbound address (generated in the Inbox sidebar),
  lowercased. Unmatched recipients are logged and dropped by design.
