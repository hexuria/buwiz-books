# Historical Google Cloud architecture

This page records the provider shape formerly used for Buwiz Books. It is not an
operator runbook. Do not create projects, enable APIs, grant IAM roles, or change
provider configuration from this application checkout.

The unattached canonical deployment repository must own current Google Cloud
commands and independently verify the target before authentication or mutation.
At minimum, its reviewed configuration must define:

- a billing-enabled, installation-specific project and region;
- container hosting, build, registry, database, secret, scheduler, and identity
  APIs required by the chosen deployment design;
- separate least-privilege build, migration, runtime, and operator identities;
- an immutable image publication path and a no-traffic revision verification
  step;
- backup/PITR, restore rehearsal, write fencing, and migration ownership; and
- audited domain, scheduler, observability, rollback, and cutover procedures.

Historical project, service-account, and IAM examples in Git history are evidence
only. They may be stale and must not be copied into a shell or used as proof that
the current production boundary is safe.
