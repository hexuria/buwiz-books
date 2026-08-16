# Historical Cloud Run domain-mapping contract

This application repository does not create or inspect production domain
mappings. The unattached canonical deployment repository must own the exact
provider command, target service, project, region, DNS change, certificate
verification, and rollback procedure.

The historical architecture used a Cloud Run custom-domain mapping and a
Cloudflare CNAME pointing at the provider-supplied destination. Cloudflare proxying
was kept off while Google validated and issued the certificate. Treat those facts
as design evidence only: the canonical runbook must retrieve the current mapping
target, approve the DNS record, verify certificate issuance, and confirm the
application and OAuth callback over HTTPS before routing production traffic.
