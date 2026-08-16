# Squarespace (Google Domains) Delegation

Since Google Domains was acquired and transitioned entirely to Squarespace, domain administration routing must now occur within the Squarespace ecosystem.

## 1. Prepare Cloudflare Payload

1. Ensure your domain is listed within your [Cloudflare account](https://dash.cloudflare.com) via the "Add Site" workflow.
2. Complete the initial wizard to acquire your two designated Cloudflare Nameservers.

## 2. Update Squarespace DNS

1. Log in to your [Squarespace Account Dashboard](https://account.squarespace.com).
2. Look for the **Domains** tab in the main navigation.
3. Click on the target domain you wish to map.
4. In the detailed top navigation panel, click **DNS** (or "Advanced DNS" depending on your dashboard tier).
5. Locate the **Nameservers** tab located within the upper submenu of the DNS management screen.
6. By default, it operates on "Use Squarespace nameservers". Click the toggle/radio button to **Use custom nameservers**.
7. Input the two Cloudflare addresses generated earlier into the custom fields.
8. Click **Save** in the top right corner.

> [!NOTE]
> If your domain was recently purchased via Squarespace or recently migrated out of Google, there may be a 60-day ICANN lockout preventing transferring the domain technically to another provider, but this **does not** impact your ability to delegate nameservers dynamically to Cloudflare.
