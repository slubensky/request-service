# Infra skeleton (Phase 0)

This directory holds the Terraform scaffold for the architecture decided in
`ARCHITECTURE.md` and the approved Blueprint (art_RUHUe0PF): AWS App Runner
(SSR container), RDS/Aurora Serverless v2 PostgreSQL, Amazon Cognito, and
Secrets Manager, all in `us-east-1`.

**Scope of this PR:** validatable skeleton only -- provider, version pins,
and a partial S3 backend block. No AWS resources are defined yet, so there
is nothing here that requires credentials or that `terraform apply` would
change. Full resource definitions land in a later PR per the sandbox-first
build plan.

## Local validation

```sh
cd infra
terraform init -backend=false
terraform validate
```

`-backend=false` skips backend initialization (the `s3` backend block is
intentionally left as an empty partial configuration), so this never
contacts AWS and never needs credentials or a real state bucket.
