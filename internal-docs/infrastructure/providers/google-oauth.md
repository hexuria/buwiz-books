# Google OAuth Identity Setup

Buwiz Books utilizes a Google OAuth connection through the Better Auth SDK to handle SSO (Single Sign-On). You must provision a formal OAuth application within Google Cloud to issue sign-in tokens safely.

## 1. Navigating to the Verification APIs

Sign in to the [Google Cloud Console](https://console.cloud.google.com/) using the project owner's Google account (Ideally, the same account used to structure the GCP architecture previously).

1. Ensure your specific `Digits Production` project is selected from the top drop-down menu.
2. In the navigation drawer, navigate to **APIs & Services** -> **Credentials**.

## 2. Architecting the OAuth Consent Screen

If this is a brand new Google Cloud Project, Google forces you to define a "Consent Screen" before you can actually generate any client IDs. This dictates what the user sees when Google asks "Buwiz Books wants access to your Google Account."

1. Inside the APIs & Services sidebar, click **OAuth consent screen**.
2. **User Type:** Select **External**. This means the application handles consumers with standard `@gmail.com` accounts, not just `@your-workspace.com` users inside a strict enterprise policy. Click **Create**.
3. Under App Information:
   - **App name:** `Buwiz Books` (or your formal client-facing company name).
   - **User support email:** Choose your admin email from the dropdown context.
4. Under App domain:
   - You can leave these blank for now, or point them to your privacy policy and terms of service domains explicitly.
   - **Authorized domains:** Do ensure your primary custom domain (e.g. `mvgreenland.com`) is explicitly whitelisted here.
5. Under Developer contact info, add your development email. Click **Save and Continue**.
6. **Scopes:** For basic SSO, skip adding extra scopes (it defaults to `openid`, `profile`, `email`, which is sufficient). Click **Save and Continue**.
7. **Test Users:** Because the app forces "Unpublished" status initially, only explicit emails added here can sign in. Add your own email, your co-founder's email, or test emails right now to trial it. Let everything else skip.

### 2.1 Publishing the Application

Until the application is literally published in the Consent Screen menu, ordinary users will see an "Access Blocked / Unverified App" error.

- Return to the **OAuth consent screen** summary page.
- Under Testing status, click the **Publish App** button and push it to production status.

## 3. Creating the Web App Client Credentials

With the consent screen established, you must issue the API keys that map the backend to this Google portal.

1. Navigate back to **APIs & Services** -> **Credentials** in the left sidebar.
2. Click the top button **Create Credentials** -> **OAuth client ID**.
3. For Application type, select **Web application**. Name it `Buwiz Books Production Web Client`.
4. **Authorized JavaScript origins:**
   - Click "Add URI"
   - Enter your absolute domain explicitly used to serve the site: `https://digits.mvgreenland.com`.
5. **Authorized redirect URIs (EXTREMELY IMPORTANT):**
   - Click "Add URI"
   - You must specifically define where Google routes the user payload after login. For our application, this is definitively: `https://digits.mvgreenland.com/api/auth/callback/google`
   - **Warning:** A trailing slash or a missing `https://` prefix here will result in fatal OAuth redirect validation loops.
6. Click **Create**.

## 4. Environment Variables Storage

Upon creation, a modal will popup holding your credentials.

1. Copy the **Client ID** mapping it to the `GOOGLE_CLIENT_ID` inside your `.env.cloudrun.yaml`.
2. Copy the **Client Secret** mapping it to the `GOOGLE_CLIENT_SECRET` inside your `.env.cloudrun.yaml`.

> **Next Step:** You will proceed to configure your transactional email engine through [Resend](./resend) next.
