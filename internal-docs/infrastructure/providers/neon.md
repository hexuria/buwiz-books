# Neon PostgreSQL Setup

Buwiz Books uses [Neon](https://neon.tech) for serverless PostgreSQL. It provides branching for staging/production parity and connection pooling natively, which is essential for serverless environments (like Google Cloud Run) to prevent connection starvation.

## 1. Account Creation and Organization Setup

1. Go to [Neon.tech](https://neon.tech/) and click **Sign Up**.
2. Authenticate using your GitHub, Google account, or a dedicated workspace email.
3. Upon signing up, you will be prompted to create an **Organization**. This is the billing and permission boundary for your databases. Name it according to your business (e.g. "MVGreenland").

## 2. Project Provisioning

A Neon "Project" operates as your production Postgres cluster.

1. From the Neon Console dashboard, click **New Project** (you may be prompted immediately on a fresh account).
2. Configure your cluster parameters precisely as follows:
   - **Name:** `digits-prod` (or similar)
   - **Postgres Version:** `16` (Mandatory: do not drift versions, our Drizzle ORM migration schemas assume PG16 behavior natively).
   - **Region:** **EU (Frankfurt) [aws-eu-central-1]**. _It is critical you select Frankfurt as this is the closest infrastructure hub to the Google Cloud Run server hosted in Finland. This explicitly minimizes network latency between the application environment and the database tier._
3. Click **Create Project**.

## 3. Extracting Connection Credentials

Because Cloud Run containers scale exponentially under load, connection bursts occur. You **must** utilize Neon's PgBouncer "pooled" connection string endpoint, otherwise, the application will exhaust raw database connections almost immediately.

1. Navigate to the **Dashboard** of your newly created Neon project.
2. Under the "Connection Details" widget, ensure the settings match:
   - **Branch:** `main`
   - **Role:** default `neondb_owner` (depending on what Neon generated)
   - **Database:** `neondb`
3. Toggle the **Pooled connection** checkbox/switch so that it is active (✅).
4. Click the "Copy" icon. The URI will look similar to:
   `postgresql://neondb_owner:PASSWORD@ep-xxx-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require`

## 4. Securing the URI

Paste this copied connection string directly into your `.env.cloudrun.yaml` configuration under the `DATABASE_URL` variable assignment.

> **Next Step:** You do **not** need to manually define schemas or tables right now. Our tools automatically deploy your database schema and Row-Level Security parameters. If you ever need to manually tweak them, please consult the independent [Database Operations Guide](../database). Proceed to configure [Cloudflare R2](./cloudflare) to handle your file uploads.
