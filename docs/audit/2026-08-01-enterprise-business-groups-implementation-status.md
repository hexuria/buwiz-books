# Enterprise Business Groups implementation status

Date: 2026-08-01

Implementation tree: `166eed22ba7908d249af0607ee43d7282c2ad110`

Merged application baseline: `5de27710bbbe6d7d8eb3d6eba7238d8bef0f23ae` (PR #31)

## Status

The reviewed Enterprise Business Groups application-code backlog is implemented and locally gated, including authenticated self-service Stripe Checkout and hosted billing-portal access.

No remaining reviewed backlog gap prevents the scoped claim **planned application-code backlog implemented**. This does not mean production-ready or deployed: the separate canonical deployment repository, its secrets, and the live environment were not inspected or verified.

## Merged slices

| Pull request | Capability                                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| #23          | Enterprise account and flat Business Group foundation, tenant isolation, roles, linking, and initial performance/readiness rollout |
| #24          | Current/prior-period comparison control and URL state                                                                              |
| #25          | Portfolio Profit and Loss with authorization, deduplication, readiness, and mixed-currency withholding                             |
| #26          | Per-business projection freshness and recovery visibility                                                                          |
| #27          | P&L drill-down and scoped export                                                                                                   |
| #28 and #29  | Business Group administration lifecycle, permissions, audit/recovery, and exact runtime helper ACL correction                      |
| #30          | Stripe subscription mirror, signed webhook reconciliation, ordering, idempotency, and quarantine evidence                          |
| #31          | Self-service Checkout, hosted billing portal, reservation recovery, and Checkout ACL hardening                                     |

## Implementation anchors

| Capability                                                                                                       | Primary source                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enterprise accounts, flat Business Groups, tenant isolation, linked-business exclusivity, and composed roles     | `src/lib/business-groups/service.ts`; `drizzle/0028_enterprise_business_groups.sql`; `drizzle/0029_business_group_entity_exclusivity.sql`; `drizzle/0034_business_group_admin_guards.sql`; `drizzle/rls_hardening.sql` |
| Multi-group selection, comparison, deduplicated portfolio metrics, and partial-access warnings                   | `src/routes/business-groups.tsx`; `src/routes/api/-business-groups.ts`; `src/lib/business-groups/performance.ts`; `src/lib/business-groups/projected-performance.ts`                                                   |
| Portfolio Profit and Loss, drill-down, and export                                                                | `src/lib/business-groups/portfolio-profit-loss.ts`; `src/lib/business-groups/drilldown.ts`; `src/lib/business-groups/portfolio-profit-loss-export.ts`; `src/routes/api/-reports.ts`                                    |
| Projection readiness, backfill, worker queue, shadow reconciliation, and rollback modes                          | `src/lib/business-groups/entity-readiness.ts`; `src/components/business-groups/EntityReadinessPanel.tsx`; `drizzle/0032_reporting_projections.sql`; `drizzle/0033_projection_reconciliation.sql`                       |
| Group creation, rename, archive/restore, entity links, member roles, final-owner protection, audit, and recovery | `src/lib/business-groups/service.ts`; `src/routes/api/-business-groups.ts`; `src/components/business-groups/BusinessGroupAdminModal.tsx`; `drizzle/0034_business_group_admin_guards.sql`                               |
| Stripe entitlement lifecycle                                                                                     | `server/routes/api/enterprise/stripe-webhook.post.ts`; `src/lib/enterprise/stripe-entitlements.ts`; `drizzle/0035_enterprise_stripe_billing.sql`; `scripts/business-group-entitlement.ts`                              |
| Self-service Checkout and hosted portal                                                                          | `src/lib/enterprise/billing.ts`; `src/routes/api/-enterprise-billing.ts`; `src/routes/business-groups.tsx`; `drizzle/0036_enterprise_checkout.sql`                                                                     |

Checkout is server-authorized, role-checked, allowance-locked, account-idempotent, and provider-reconcilable. Browser input is limited to the Enterprise account and requested allowance; price, customer, metadata, and return URLs are derived server-side. Portal sessions require the controlled configuration identified by `STRIPE_ENTERPRISE_PORTAL_CONFIGURATION_ID`.

## Local verification

At the reviewed implementation tree:

- All nine checksum-fenced Enterprise migrations, `0028` through `0036`, passed a fresh disposable-database chain and checksum replay.
- Focused Checkout integration: 20/20 passed.
- Focused Stripe reconciliation integration: 13/13 passed.
- Focused unit gates: 37/37 passed.
- Full unit suite: 1,175/1,175 passed.
- Component suite: 43/43 passed.
- Full integration suite: 336 passed, 4 skipped.
- Checkout ACL matrix confirmed no table privileges for `PUBLIC`, `app_runtime`, or `buwiz_app`.
- `bun run check`, diff-check, and the production build passed.
- Both exact disposable test databases were removed and their absence verified.
- An independent read-only review found the exact tree safe to merge.

## Reporting boundary

The only formal group financial statement implemented is Portfolio Profit and Loss. The Performance Center also exposes operating and cash KPIs, but those are not a group Cash Flow statement.

Explicitly deferred:

- Group Balance Sheet.
- Group Cash Flow statement.
- Group Trial Balance.
- AR/AP aging and multi-report packs.
- Legal or statutory consolidation.
- Governed FX translation.
- Ownership percentages and effective dates.
- Group chart-of-accounts mapping.
- Intercompany matching and eliminations.
- Minority-interest accounting.
- Consolidation journals, locks, approvals, and audit packs.
- Automated quoting, custom invoicing, and dunning workflows.

Mixed functional currencies are withheld rather than translated. Same-currency arithmetic totals must not be described as GAAP or IFRS consolidated statements.

## Remaining evidence and production status

No committed desktop/mobile comparison screenshots were found for the Business Groups experience. Automated behavior is covered, but rendered comparison evidence remains an acceptance-evidence gap.

The application has not been verified as deployed. This repository and its failing deployment action are non-authoritative for production deployment. The separate canonical deployment repository, its secrets, and its live resources were deliberately not inspected.

## Production operational gates

Before enabling a pilot:

1. Reconcile the exact application revision and environment contract into the canonical deployment repository.
2. Build the new revision, enter maintenance mode, and quiesce every old web and job writer before applying migration `0034`.
3. Apply migrations `0028` through `0036` in order, followed by the integrity migration, RLS policies, and final runtime grants. Verify all nine checksums and the complete runtime ACL matrix.
4. Verify non-owner runtime access, audit-history read-only access, reconciliation append-only access, subscription-mirror SELECT-only access, and denial of transfer context, dangerous helpers, webhook evidence, and Checkout reservations.
5. Bind fresh `STRIPE_ENTERPRISE_SECRET_KEY`, `STRIPE_ENTERPRISE_WEBHOOK_SECRET`, `STRIPE_ENTERPRISE_PRICE_ID`, `STRIPE_ENTERPRISE_PORTAL_CONFIGURATION_ID`, `DATABASE_URL`, and `DATABASE_URL_ADMIN` values. Verify the approved Product/Price, signed webhook endpoint, and required event set.
6. Confirm the dedicated Stripe portal configuration disables subscription quantity changes and unauthorized price switching.
7. Start and verify the projection worker/scheduler, run a scoped backfill, and require every pilot entity to be ready with matching requested/applied versions and no active or failed jobs.
8. Run shadow mode with an empty allowlist across current, prior, no-activity, void, duplicate, restoration, and mixed-currency scenarios. Investigate every material mismatch before allowlisting a pilot.
9. Validate tenant isolation, direct-membership omission behavior, and mixed-currency withholding against representative customer access.
10. Monitor projection lag, overdue or failed jobs, reconciliation mismatches, Stripe delivery failures and quarantines, entitlement versions, and Checkout reservations. Assign alert and rollback ownership.
11. Preserve rollback controls: remove individual pilot UUIDs or return the fleet to live-source reads while retaining diagnostic evidence.
12. Verify the canonical live revision and isolated database, identities, secrets, storage, email, and scheduler resources. Then verify health, authentication, tenant boundaries, DNS, HTTPS, Stripe webhook/return URLs, and OAuth callbacks.

This audit establishes application implementation and local automated evidence only. It does not establish production readiness or deployment.
