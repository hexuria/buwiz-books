# Google Cloud Platform (GCP) Setup

Google Cloud Platform serves as the core hosting provider for Buwiz Books. We use **Google Cloud Run** for serverless container hosting and **Google Cloud Build** for managed remote CI/CD pipelines.

## 1. Account Creation and Billing

1. Go to [Google Cloud](https://cloud.google.com/) and click **Get started for free**.
2. Sign in with your Google Account or create a new dedicated business email.
3. Accept the Terms of Service. Google provides $300 in free credits for new accounts over 90 days.
4. **Set up Billing Strategy:**
   - Go to the **Billing** section via the navigation menu.
   - Click **Manage billing accounts** -> **Create Account**.
   - Input your organizational details and a valid credit card. Cloud Run is generously tiered, but you must have an active billing instrument on file to deploy beyond basic quotas.

## 2. Project Creation

A GCP "Project" forms the boundary around your resources and API quotas.

1. Navigate to the **Cloud Console Dashboard**.
2. In the top navigation bar, click the project dropdown selector and click **New Project**.
3. Name your project (e.g., `Digits Production`).
4. **Important**: Note the **Project ID** generated below the name as the slug (e.g., `digits-prod-29f3`). This is your globally unique identifier used across all CLI deployment commands.
5. Click **Create**. Once provisioned, make sure the project is selected in the top dropdown.

## 3. Enable Required APIs

Google disables all APIs by default for security. You must explicitly activate them.

1. Open your terminal and ensure you have the [Google Cloud CLI (`gcloud`)](https://cloud.google.com/sdk/docs/install) installed.
2. Login and set your active project constraint:
   ```bash
   gcloud auth login
   gcloud config set project YOUR_PROJECT_ID
   ```
3. Enable the core services required for serverless execution and build pipelines:
   ```bash
   gcloud services enable \
     run.googleapis.com \
     artifactregistry.googleapis.com \
     cloudbuild.googleapis.com \
     iam.googleapis.com \
     --project=YOUR_PROJECT_ID
   ```

## 4. Service Account Provisioning

We use a dedicated service account (`digits-runner`) to isolate application permissions rather than sharing default global accounts.

1. Create the dedicated service account:
   ```bash
   gcloud iam service-accounts create digits-runner \
     --display-name="Digits Cloud Run Service Account" \
     --project=YOUR_PROJECT_ID
   ```
2. Grant deployment roles. The runner needs access to Cloud Run management, Artifact Registry (container storage), and Logging:

   ```bash
   for role in roles/run.admin roles/artifactregistry.reader roles/logging.logWriter; do
     gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
       --member="serviceAccount:digits-runner@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
       --role="$role" --quiet
   done
   ```

3. **Cloud Build Logistics:** Ensure the default compute service account can write logs. If this is skipped, `make deploy` logs will silently fail and timeout during remote execution:
   ```bash
   PROJECT_NUMBER=$(gcloud projects describe YOUR_PROJECT_ID --format='value(projectNumber)')
   gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
     --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
     --role="roles/logging.logWriter" --quiet
   ```

## 5. Local gcloud Configuration

To prevent accidentally deploying to the wrong project (e.g., mixing staging and production accounts), establish a named environment configuration locally.

```bash
gcloud config configurations create mvgreenland
gcloud config set account your-email@gmail.com
gcloud config set project YOUR_PROJECT_ID
gcloud config set run/region europe-north1
```

> **Next Step:** Once your Google Cloud baseline is established, proceed to configure the [Neon Database](./neon) and [Cloudflare R2 Storage](./cloudflare).
