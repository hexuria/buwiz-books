# Domain Mapping: Google Cloud to Cloudflare

This is the most critical routing step. Once your domain is exclusively governed by Cloudflare Nameservers, you must map the active Google Cloud Run deployment container outward so that traffic hits it cleanly without SSL validation loops.

## 1. Establishing The Google Domain Mapping

You must explicitly tell Google Cloud Run to expect traffic on your proprietary domain.

### Via Google Cloud CLI (Recommended)

Open your designated deployment terminal containing your `gcloud` configuration bounds:

```bash
gcloud beta run domain-mappings create \
  --service=digits \
  --domain=digits.mvgreenland.com \
  --region=europe-north1 \
  --project=digits-prod-29f3
```

_(Ensure `--service`, `--domain`, and `--project` exactly correlate to your environment)._

### Via Google Cloud Console (Alternative)

1. Go to the [Cloud Run Console](https://console.cloud.google.com/run).
2. Click on your `digits` service.
3. Select the **Integrations** tab (or **Custom Domains** if accessible locally).
4. Click **Manage Custom Domains**, then **Add Mapping**.
5. Select your verified root domain, set the subdomain field, and continue.

Google will output a distinct, CNAME-compatible DNS destination string. This is typically **`ghs.googlehosted.com`**.

## 2. Pushing the Route to Cloudflare

You now have the active Google endpoint, so you need to configure Cloudflare to point user queries toward it.

1. In your [Cloudflare Dashboard](https://dash.cloudflare.com), retrieve your domain and navigate identically to **DNS > Records**.
2. Click **Add record**.
3. Format as follows:
   - **Type:** `CNAME`
   - **Name:** `digits` (If routing `digits.mvgreenland.com`) or `@` (If routing root `mvgreenland.com`).
   - **Target:** `ghs.googlehosted.com` (Extracted from Step 1).

## 3. The Proxy "Gray Cloud" Warning

> [!WARNING]
> By default, Cloudflare aggressively forces all newly acquired CNAME routing arrays behind its automated proxy edge (turning the status cloud **Orange ☁️**).
> **YOU MUST DISABLE THIS. TURN IT INTO A GRAY "DNS ONLY" CLOUD.**

### Why must Proxy be disabled?

Google Cloud Run provisions its own Let's Encrypt SSL certificates dynamically on instantiation. When Google launches its internal SSL checker ping, it expects to mathematically connect directly to the domain. If Cloudflare's orange proxy is enabled, Cloudflare intercepts the ping and feeds it their own SSL cert structure. Google inherently rejects this, the cert provisioning fails indefinitely, and your domain experiences an unbreakable redirect looping error.

## 4. Verification Check

Check the validity bounds back in Google Cloud:

```bash
gcloud beta run domain-mappings describe \
  --domain=digits.mvgreenland.com \
  --region=europe-north1 \
  --project=digits-prod-29f3 \
  --format='value(status.conditions[0].status,status.conditions[0].message)'
```

Wait 20 to 30 minutes. Once Google confirms SSL is attached natively, access your app live!
