# Historical documentation-domain mapping

This page records a former architecture in which documentation ran as an
independent Cloud Run service behind a Cloudflare CNAME. It is not an executable
runbook, and this application repository does not create, inspect, or verify that
production mapping.

The unattached canonical deployment repository must own the exact service,
project, region, mapping, DNS record, certificate verification, and rollback.
Historically, Cloudflare proxying remained disabled during Google's certificate
validation. The canonical runbook must revalidate that provider behavior, use the
actual provider-supplied DNS destination, and prove HTTPS health before exposing
the documentation hostname.
