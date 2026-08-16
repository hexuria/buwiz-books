# Documentation Domain Mapping

This guide explains how to map the custom subdomain for our overarching documentation (e.g., `digits.docs.mvgreenland.com`) to its isolated Google Cloud Run deployment instance.

We do not use third-party managed hosting for our documents. The documentation runs as an independent Google Cloud Run service (e.g., `digits-docs`), and we route traffic to it natively via Cloudflare.

## 1. Establishing The Google Domain Mapping

You must explicitly tell Google Cloud Run to expect traffic on your chosen documentation subdomain.

### Via Google Cloud CLI

Open your deployment terminal and attach the subdomain specifically to the documentation service:

```bash
gcloud beta run domain-mappings create \
  --service=digits-docs \
  --domain=digits.docs.mvgreenland.com \
  --region=europe-north1 \
  --project=digits-prod-29f3
```

_(Ensure `--service` targets the docs container, not the main app container)._

### Via Google Cloud Console

1. Go to the [Cloud Run Console](https://console.cloud.google.com/run).
2. Click on your `digits-docs` service.
3. Select the **Integrations** tab (or **Custom Domains**).
4. Click **Manage Custom Domains**, then **Add Mapping**.
5. Select your verified root domain, set the subdomain field to `digits.docs`, and continue.

Google will output a distinct, CNAME-compatible DNS destination string (typically **`ghs.googlehosted.com`**).

## 2. Pushing the Route to Cloudflare

You now need to configure Cloudflare to point user queries on the docs subdomain toward Google's endpoint.

1. In your [Cloudflare Dashboard](https://dash.cloudflare.com), retrieve your domain and navigate to **DNS > Records**.
2. Click **Add record**.
3. Format as follows:
   - **Type:** `CNAME`
   - **Name:** `digits.docs`
   - **Target:** `ghs.googlehosted.com` (Extracted from Step 1).

## 3. The Proxy "Gray Cloud" Warning

> [!CAUTION]
> Cloudflare aggressively forces all newly acquired CNAME routing arrays behind its automated proxy edge (turning the status cloud **Orange ☁️**).
> **YOU MUST DISABLE THIS. TURN IT INTO A GRAY "DNS ONLY" CLOUD.**

### Why must the Proxy be disabled?

Google Cloud Run provisions its own Let's Encrypt SSL certificates dynamically. When Google launches its internal SSL checker ping, it must connect directly to the domain. If Cloudflare's orange proxy is enabled, Cloudflare intercepts the ping. Google rejects this, the cert provisioning fails indefinitely, and your documentation endpoint will lock into a redirect loop error.

## 4. Verification Check

Check the validity bounds back in Google Cloud:

```bash
gcloud beta run domain-mappings describe \
  --domain=digits.docs.mvgreenland.com \
  --region=europe-north1 \
  --project=digits-prod-29f3 \
  --format='value(status.conditions[0].status,status.conditions[0].message)'
```

Wait 20 to 30 minutes. Once Google confirms SSL is attached natively, your documentation endpoint will render live cleanly!
