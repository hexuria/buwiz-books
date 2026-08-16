# Hostinger Domain Delegation

If you purchased your primary domain through Hostinger, you must surrender DNS control to Cloudflare by replacing your default nameservers.

## 1. Retrieve Cloudflare Nameservers

1. Log into your [Cloudflare Dashboard](https://dash.cloudflare.com).
2. Click **Add Site** and input your root domain (e.g., `mvgreenland.com`).
3. Select the **Free Tier** configuration.
4. Cloudflare will scan your existing Hostinger records. Click **Continue**.
5. Cloudflare will instruct you to remove your current nameservers and assign two specific "Cloudflare Nameservers" (e.g., `hal.ns.cloudflare.com` and `vera.ns.cloudflare.com`). **Copy these down.**

## 2. Update Hostinger Settings

1. Log in to your Hostinger account and navigate to the **hPanel**.
2. From the top navigation menu, select **Domains**.
3. Under your list of domains, find the domain you want to route to Buwiz Books and click **Manage**.
4. In the left-hand sidebar, navigate to **DNS / Nameservers**.
5. Look for the section explicitly labeled **Nameservers** (it usually points to `ns1.dns-parking.com` by default).
6. Click the **Change Nameservers** button.
7. Select the **Change nameservers (recommended)** toggle instead of using Hostinger's default.
8. Delete the existing entries in Nameserver 1 and Nameserver 2.
9. Paste the exact **Cloudflare Nameservers** you copied earlier into the respective fields.
10. Click **Save**.

## 3. Verify Delegation

1. Go back to your Cloudflare Dashboard and click **Check nameservers**.
2. DNS propagation can take anywhere from 15 minutes to 24 hours globally. You will receive an email from Cloudflare once the domain is successfully verified and active under their shield.

> [!WARNING]
> Do not attempt to manage DNS records (such as TXT, CNAME, A records) inside Hostinger anymore. From this point forward, **all** DNS routing must occur exclusively via Cloudflare.
