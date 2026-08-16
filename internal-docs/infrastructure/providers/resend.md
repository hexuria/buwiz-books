# Resend Setup (Transactional Email)

We use [Resend](https://resend.com/) as the transactional email provider for Buwiz Books. This ensures that features like Magic Links, Invoice deliveries, and system invites are routed optimally without hitting spam traps.

## 1. Account Creation

1. Navigate to [Resend.com](https://resend.com) and click **Sign Up**.
2. Using GitHub or a dedicated business email works flawlessly.

## 2. API Key Generation

To grant Buwiz Books the ability to mechanically send emails on the platform's behalf, you require a specialized application key.

1. On the main dashboard sidebar, navigate to the **API Keys** section.
2. Click **Create API Key**.
3. Provide a clear namespace to describe the operational usage: e.g., `digits-production-engine`.
4. Leave the permission as **Full Access**.
5. Select **All Domains** unless you specifically intend to strictly isolate environments per single credential key.
6. Click **Add**.
7. Resend will output a singular string (typically prefixed with `re_xyz...`). You will only see this key once.
8. Map this directly to the `RESEND_API_KEY` assignment in your deployment `.env.cloudrun.yaml` configuration context.

## 3. Domain Verification

Resend mandates domain identity verification to establish DKIM/SPF credibility. Without completing this step, Resend forces constraints (limiting sends strictly to testing domains or enforcing harsh rate-limits) which heavily disrupts production pipelines.

1. From the Resend sidebar dashboard, select **Domains**.
2. Click **Add Domain**.
3. Enter your core domain base (e.g. `mvgreenland.com`).
4. Select a specific region or leave it auto assigned for closest S3 processing.
5. Click **Verify**.
6. Resend presents a suite of explicit DNS records involving `TXT` and `MX` tracking metrics.
7. Open a secondary tab and head back to your **Cloudflare Dashboard** -> **DNS** -> **Records**.
8. Manually recreate each respective DNS signature. **Important note:** Cloudflare normally enables Proxied grey clouds by default. Ensure they remain functionally DNS Only while handling explicit MX/TXT integrations if you face validation lags.
9. Back in Resend, hit the **Verify DNS records** button. Depending strictly on global DNS propagation constraints, verification spans anywhere from instantly, up to roughly seventy-two hours.

> **Final Step:** Your dependency infrastructure is fully provisioned! Navigate to the primary [Deployment Manual](../deployment) to push the application to the internet.
