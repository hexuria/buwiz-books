# GoDaddy Domain Delegation

If your domain is parked at GoDaddy, you must redirect DNS management authority entirely over to Cloudflare to facilitate our custom integrations.

## 1. Retrieve Cloudflare Nameservers

1. Access your [Cloudflare Dashboard](https://dash.cloudflare.com) and click **Add Site**.
2. Input your domain (e.g., `mvgreenland.com`) and choose the **Free Tier**.
3. Cloudflare automatically imports GoDaddy's preexisting records. Next.
4. Cloudflare provides two unique nameservers (e.g., `bob.ns.cloudflare.com`). **Copy these.**

## 2. Overriding GoDaddy Nameservers

GoDaddy heavily incentivizes utilizing their premium DNS products, meaning nameserver modifications are often buried.

1. Sign in to your [GoDaddy Account Manager](https://account.godaddy.com).
2. Go to your **My Products** page.
3. Locate the specific domain you intend to use and click the **DNS** button (or select "Manage DNS" from the three-dot dropdown menu).
4. Scroll down past the primary DNS records table to the section labeled **Nameservers**.
5. Click **Change**.
6. GoDaddy will try to convince you to use their Connect wizard. Look for the subtle link that says: **"Enter my own nameservers (advanced)"**.
7. Delete the default GoDaddy nameservers (typically `domaincontrol.com`).
8. Enter the two Cloudflare nameservers into the **Nameserver 1** and **Nameserver 2** fields.
9. Click **Save** or **Add**.
10. A consent modal will likely appear warning you about DNS downtime. Check the acknowledgment box and click **Continue**.

## 3. Propagation Limits

Return to Cloudflare and click **Check nameservers**. GoDaddy usually processes nameserver swaps rapidly (within an hour), but global propagation latency still applies.

> [!CAUTION]
> If you have existing GoDaddy email addresses (e.g., Office 365) attached to this domain, executing this swap _might_ disrupt email momentarily until Cloudflare's dashboard fully imports the MX records. Always verify your MX records successfully ported to Cloudflare before finalizing.
