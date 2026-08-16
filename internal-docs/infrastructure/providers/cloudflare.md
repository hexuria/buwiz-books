# Cloudflare Configuration

Cloudflare handles two critical components for Buwiz Books: DNS/Domain routing and Object Storage (R2) for document uploads.

## 1. Domain and DNS Management

Cloudflare manages your top-level domain traffic, ensuring that users connect to Google Cloud Run efficiently.

### 1.1 Acquiring or Transferring a Domain

1. If you don't already own a domain, go to your Cloudflare Dashboard and navigate to **Domain Registration** > **Register Domain**. You can purchase your `.com` or `.net` domain explicitly here.
2. If you bought your domain elsewhere (e.g. GoDaddy, Hostinger), navigate to the **Websites** tab, click **Add a Site**, enter your domain name, and follow Cloudflare's instructions to update your nameservers at your registrar.

### 1.2 DNS Routing to Google Cloud Run

In order to point your custom domain (e.g., `digits.mvgreenland.com`) to your Google Cloud Run instance:

1. First, inside GCP, map your Cloud Run instance to the domain via the gcloud CLI (documented inside the actual deployment workflow parameters). Google will provide a host target, typically `ghs.googlehosted.com`.
2. Inside your Cloudflare dashboard, go to the **DNS > Records** tab.
3. Click **Add record**:
   - **Type:** `CNAME`
   - **Name:** `digits` (for the subdomain map) or `@` (for root).
   - **Target:** `ghs.googlehosted.com`
4. **PROXY STATUS CRITICAL WARNING:** You must ensure the proxy toggle is set to **DNS Only** (a grey cloud icon ☁️) instead of Proxied (orange cloud icon). Google handles its own Let's Encrypt SSL generation; if Cloudflare's proxy is enabled during setup, Google is unable to verify the domain and SSL certificates will fail to issue.

## 2. R2 Object Storage

Buwiz Books uses Cloudflare R2 strictly as a zero-egress fee blob storage host to handle user invoice images, documents, and profile pictures independently from the main database.

### 2.1 Bucket Provisioning

1. Inside the Cloudflare Dashboard sidebar, click **R2 Object Storage**.
2. If you have not initialized R2 and put a payment card on file, it will require you to do so (the Free tier is extremely generous).
3. Click **Create bucket**.
4. Name your bucket: `digits-assets` (or a similar explicit name).
5. Location hint: Select **Europe** (again, optimizing latency to Cloud Run in Finland / Postgres in Frankfurt).
6. Click **Create bucket**.

### 2.2 Generating Access Tokens

The application needs programmatic S3-compatible permissions to push and pull files from the bucket you just established.

1. On the main R2 Overview page sidebar, click **Manage R2 API Tokens**.
2. Click **Create API token** in the top right.
3. Provide a descriptive Name: `digits-production-key`.
4. Permissions setting: Choose **Object Read & Write**.
5. Specify bucket(s): Select "Apply to specific buckets only" and choose the `digits-assets` bucket you created.
6. Click **Create API Token**.
7. **SECURE THESE CREDENTIALS:** You will only be shown these once. Copy them directly into your local `.env.cloudrun.yaml`. Note down:
   - **Access Key ID** -> Translates to `R2_ACCESS_KEY_ID`
   - **Secret Access Key** -> Translates to `R2_SECRET_ACCESS_KEY`

### 2.3 Acquiring the Endpoint

Finally, you need the absolute URL for the R2 API connection string.

1. Navigate to the general **R2 Object Storage** dashboard page.
2. Your Account ID is listed under the "Account ID" section on the right side of the screen.
3. Your Endpoint URL string equates to: `https://<YOUR_ACCOUNT_ID>.r2.cloudflarestorage.com`.
4. Store this URL as `R2_ENDPOINT` inside your Cloud Run environment configuration file. Do NOT append the bucket name to this URL; the API client resolves the designated bucket automatically based on configuration variables.

> **Next Step:** To enable user authentication, proceed to map your integration with [Google OAuth](./google-oauth).
