# Buwiz Books — Accounting Platform

A modern, AI-native accounting platform built with Bun, TanStack Start, and Drizzle ORM.

## Quick Start

```bash
# Install dependencies
bun install

# Set up environment variables
cp .env.example .env
# Edit .env with your credentials (see comments in .env.example)

# Set up database and seed initial admin
bun fresh

# Start development server
bun dev
```

The app will be available at http://localhost:3000

## Commands

### Development

```bash
bun dev              # Start dev server on port 3000
bun preview          # Preview production build locally
```

### Database

```bash
bun fresh            # Reset database + seed superuser (clean slate)
bun reset            # Drop all tables and re-push schema
bun db:push          # Push schema changes (no migration files)
bun db:generate      # Generate migration from schema diff
bun db:migrate       # Apply pending migration files
bun db:studio        # Open Drizzle Studio GUI
bun seed             # Seed superuser account
```

**Review agents.** The rule catalog (`review_rule_definitions`) is a global table seeded from
`src/lib/inbox/review-rule-catalog.ts`. It is wired into the local `db:fresh` and
`db:test:fresh` rebuilds. Production seeding belongs to the unattached canonical deployment
repository. If `/review-agents` ever renders "No review agents are set up yet", this is the first
thing to check:

```bash
bun db:review-rules:status      # read-only: catalog state, drift, unresolved findings
bun db:seed:review-rules        # idempotent, additive; never updates an existing row
```

Both print the database they connected to before doing anything else. Always read that line
first — an unset `DATABASE_URL` makes `psql` silently fall back to the database named after your
OS user, where every one of these tables is genuinely missing.

For non-local status inspection, use the canonical deployment repository's
read-only diagnostic path. Do not extract or pass a production URL from this
checkout.

See [internal-docs/infrastructure/database.md](./internal-docs/infrastructure/database.md) for
the local database commands and production ownership contract.

> **⚠️ Schema changes that touch exported entities?** The export/import system is versioned — any column add/remove/rename on an exported table requires updating the export API, Zod validation schemas, import logic, and potentially bumping `EXPORT_VERSION` with a migration function. See [`.agent/rules/schema-export-import.md`](./.agent/rules/schema-export-import.md) for the full protocol and debugging guide.

### Code Quality

```bash
bun check            # Run all checks (lint + format + typecheck)
bun fix              # Auto-fix linting errors
bun fmt              # Auto-format all files
```

### Testing

```bash
bun test             # Run all tests
bun test:watch       # Watch mode
bun test:coverage    # Generate coverage report
bun test:e2e         # End-to-end tests (Playwright)
```

See [TESTING.md](./TESTING.md) for the full testing guide.

### Deployment boundary

This application repository does not deploy or operate production. Its historical production
Make targets and shell entry points fail closed. Provisioning, secrets, migrations, deployment,
observability, and cutover require the unattached canonical deployment repository and an approved
operator runbook. No database command documented here is authorized for production.

See [internal-docs/infrastructure/deployment.md](./internal-docs/infrastructure/deployment.md)
for the ownership boundary.

## Tech Stack

| Category  | Technology                       |
| --------- | -------------------------------- |
| Runtime   | Bun                              |
| Framework | TanStack Start (SSR)             |
| Database  | PostgreSQL + Drizzle ORM         |
| Auth      | Better Auth (Google OAuth, ABAC) |
| Styling   | Tailwind CSS v4                  |
| UI        | Shadcn/ui                        |
| Testing   | Vitest + Playwright              |
| Quality   | Oxlint + Oxfmt + TypeScript      |

## Access Control & Registration

The platform supports two registration modes controlled by environment variables:

| Variable      | Default | Description                                     |
| ------------- | ------- | ----------------------------------------------- |
| `INVITE_ONLY` | `false` | When `true`, only pre-invited users can sign in |
| `ADMIN_EMAIL` | —       | Platform operator — see the warning below       |

> **`ADMIN_EMAIL` is the platform operator, not just a sign-in exception.** It is the only
> identity that may enter an organization it does not belong to: `adminSwitchOrg` in
> [src/routes/api/-org-settings.ts](src/routes/api/-org-settings.ts) creates a membership row for
> it, and `listAllOrganizations` discloses every tenant's id, name and slug to it alone. Holding
> `admin` or `owner` in an organization grants neither — that predicate is self-assignable, since
> whoever creates a workspace owns it. Point this at a mailbox you control; unset means nobody
> qualifies, which is the safe default. The canonical deployment repository must wire this value
> from its approved secret source; this application's CI workflow does not deploy it.

### Public Mode (`INVITE_ONLY=false`)

- Anyone can sign in via Google OAuth or email OTP
- New users are redirected to onboarding to create or join an organization
- **Only owners** can create new organizations (members cannot)

### Invite-Only Mode (`INVITE_ONLY=true`)

- Only users who already exist in the database (invited by an admin/owner) can sign in
- Uninvited users are blocked at the auth layer with an "Access restricted" error
- The `ADMIN_EMAIL` acts as a bootstrap "break-glass" account that always has access
- Users removed from **all** organizations are automatically signed out on their next navigation

### Organization Creation Rules

Organization creation is restricted to **owners only** regardless of mode:

| Role   | Can Create Org? |
| ------ | --------------- |
| Owner  | ✅ Yes          |
| Admin  | ❌ No           |
| Member | ❌ No           |

The `ADMIN_EMAIL` can always create organizations (bootstrap exception).

### Member Revocation

- Removing a user from one org does **not** block their access if they're still a member of another org
- Only when a user has **zero** memberships across all orgs are they signed out (invite-only) or redirected to onboarding (public)
- The membership check runs on every route navigation — removed users are caught within one click

### Production configuration

`INVITE_ONLY` and `ADMIN_EMAIL` must be set by the canonical deployment repository. This
application repository documents their behavior but contains no authorized production secret or
environment mutation path. Do not set them ad hoc from this checkout.

## Payment Gateway Configuration

The platform supports online invoice payments via **Stripe** and **PayPal**. Credentials are configured per-organization in **Settings → Payments**.

### Stripe Setup

1. Create a [Stripe account](https://dashboard.stripe.com/register)
2. Navigate to **Developers → API keys** in the Stripe Dashboard
3. Copy your **Publishable key** (`pk_live_...` or `pk_test_...`)
4. Copy your **Secret key** (`sk_live_...` or `sk_test_...`)
5. In Buwiz Books, go to **Organization Settings → Payments → Stripe**
6. Paste both keys, toggle **Enabled**, and save

### PayPal Setup

1. Create a [PayPal Developer account](https://developer.paypal.com/)
2. Navigate to **Apps & Credentials** and create a new REST API app
3. Copy the **Client ID** and **Secret**
4. In Buwiz Books, go to **Organization Settings → Payments → PayPal**
5. Paste both values, toggle **Enabled**, and save
6. Set **Mode** to `sandbox` for testing or `live` for production

### Public Payment Page

Once a gateway is configured, invoices include a public payment link at:

```
https://your-domain.com/invoices/pay/<invoiceId>
```

This page is unauthenticated — customers can view the invoice summary and pay via the configured gateway. The link is also embedded in invoice emails sent from the platform.

## Documentation

| Doc                                                                            | Contents                                              |
| ------------------------------------------------------------------------------ | ----------------------------------------------------- |
| [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)                                     | GCP, Neon, R2, OAuth, custom domain setup             |
| [docs/DATABASE.md](./docs/DATABASE.md)                                         | Schema changes, production migrations, backup/restore |
| [docs/inbox-workflow.md](./docs/inbox-workflow.md)                             | Inbox review, rules, inbound email, and worker setup  |
| [TESTING.md](./TESTING.md)                                                     | Unit, integration, component, E2E testing             |
| [docs/README.md](./docs/README.md)                                             | SSR patterns, architecture, data fetching             |
| [.agent/rules/schema-export-import.md](./.agent/rules/schema-export-import.md) | Export/import versioning, migrations, debugging       |
