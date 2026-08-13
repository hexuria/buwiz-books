# Historical white-label deployment outline

This file preserves the architectural outline of the former white-label process.
It is not an executable runbook. The application repository's `new-client.sh`,
`provision-gcp.sh`, restore script, deployment Make targets, and cloud workflow
all fail closed or are CI-only.

New-client provisioning must be designed and reviewed in the unattached
canonical deployment repository. Its owner must provide the exact project and
service boundary, least-privilege identities, secret lifecycle, migration
orchestration, backup/restore rehearsal, maintenance mode, no-traffic revision
verification, DNS procedure, rollback policy, and accountable operator.

## Historical capability checklist

The canonical implementation will need to replace, rather than invoke, the old
application-repository helpers. It must cover:

1. Client identity, domain, branding, and non-secret runtime configuration.
2. An isolated cloud project, registry, database, runtime identities, and secrets.
3. Ordered, checksummed schema and policy migration under a migration-only role.
4. Image publication and a no-traffic serving revision.
5. Authentication, tenant isolation, storage, email, billing, and worker checks.
6. Scheduler and domain setup only after the new revision passes verification.
7. Traffic routing and background-work reopening under the approved cutover.

The former commands (`make provision`, `make migrate`, `make deploy`,
`make scheduler`, `make env`, `make domain`, and the shell helpers) remain named
only so old automation fails with a clear error. Do not restore their historical
implementations from Git or use the provider notes in this repository as live
commands.

For the current ownership and approval boundary, see
`internal-docs/infrastructure/deployment.md`.
