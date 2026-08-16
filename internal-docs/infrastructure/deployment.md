# Deployment ownership and application-repository fuse

This application repository is not the canonical production deployment source.
Its deployment and provisioning entry points fail closed, and no command in this
checkout is authorized for production. Generic database utilities still exist
for development; the later migration-runtime and safe-E2E-reset work will enforce
the migration-role and loopback disposable-database boundaries at those seams.

The checked-in workflow is continuous integration only. It runs for pull requests
and pushes to `main`, has read-only repository permissions, and contains no cloud
authentication or deployment job. The Makefile retains historical production
target names only as fail-closed fuses. The historical provisioning, client setup,
and restore scripts likewise exit before environment reads or external commands.
This protects developers who follow an old command or runbook while preserving
the familiar local commands:

```bash
make run
make build
make check
make test
```

## Production work is separately authorized

Production provisioning, migrations, secrets, image publication, scheduler and
domain changes, deployment, cutover, and rollback belong in the separate
canonical deployment repository. Its owner must attach that repository, audit
its current behavior, and approve an operator runbook before any production
work begins.

Historical files or commits in this application repository are evidence only.
They do not establish the current cloud target, database state, credential
boundary, backup readiness, maintenance mechanism, or release readiness. Do not
restore an old deployment command from Git history as an operational shortcut.

The canonical runbook must independently verify, at minimum:

- the exact project, region, service, registry, database, runtime roles, and
  deployment identity;
- backup/PITR and a successful restore rehearsal;
- a maintenance mode that fences all runtime writes and background work;
- the ordered, checksummed migration plan and its read-only preflight results;
- a no-traffic revision verification step before traffic changes; and
- the post-cutover health, authentication, tenant isolation, ledger, billing,
  storage, email, scheduler, and worker checks.

No application-repository CI success, build artifact, or local preview proves a
production deployment or migration is safe.
