# Infra — AWS Terraform (request-service)

Terraform for the QR Bathroom Cleaning Service Request App, per `ARCHITECTURE.md`
and the approved Blueprint (art_RUHUe0PF). Everything runs in **us-east-1**.

The only composition is `infra/lean/`: one EC2 instance running Postgres + the
app via docker-compose, plus a real Amazon Cognito user pool
(`modules/cognito`) for authentication. An earlier App Runner + Aurora
Serverless "production" composition was authored but never `terraform
apply`'d against real AWS, and was removed (SDD.md changelog #036) once
`infra/lean/` became the one actually deployed, tested, and fixed against
real AWS -- carrying an unverified second composition in sync added cost
with no corresponding confidence. If a larger-scale target is needed again
later, it's recoverable from git history.

## Layout

| Path               | Purpose                                                                        |
| ------------------ | ------------------------------------------------------------------------------ |
| `lean/`            | The deployment: provider config, EC2 host, Elastic IP, Cognito module wiring.  |
| `modules/cognito`  | User pool, managed-login domain, app client, SMS/passkey config, SMS IAM role. |
| `modules/ec2_host` | The EC2 instance, security group, IAM instance role, first-boot user-data.     |

## Local validation

```sh
cd infra
terraform fmt -check -recursive
cd lean
terraform init -backend=false
terraform validate
```

Validation needs no variable values and no AWS credentials.

## Deploy

Uses **local state** (no shared backend) since this is meant to be stood up
and torn down freely.

### Prerequisites

- **Check SNS SMS sandbox status first**: `aws sns get-sms-sandbox-account-status
--region us-east-1`. If `IsInSandbox` is `true`, SNS/Cognito only delivers to
  phone numbers you've pre-verified (`aws sns create-sms-sandbox-phone-number` /
  `verify-sms-sandbox-phone-number`) — otherwise the OTP silently never arrives.
- **Even with `IsInSandbox: false`, US destinations still need a registered
  origination identity** (confirmed against a real deploy) — AWS requires this
  for all A2P SMS to US numbers, sandboxed or not. Check for an existing one:
  `aws pinpoint-sms-voice-v2 describe-phone-numbers --region us-east-1` and
  `describe-sender-ids`. If both are empty, request a toll-free number
  (`aws pinpoint-sms-voice-v2 request-phone-number --iso-country-code US
--message-type TRANSACTIONAL --number-capabilities SMS --number-type
TOLL_FREE`) and complete its registration via the AWS Console (End User
  Messaging → Phone numbers → Register, use case "One-time passwords") — the
  registration form needs a guided submission, not raw CLI, to avoid a
  rejection. **Budget up to 15 business days for approval**; this is not a
  same-day unblock, so start it well before you plan to demo SMS OTP.
- Create or import an EC2 key pair in the AWS console (for optional SSH access;
  the deployment itself doesn't need you to SSH in — user-data does everything).
- **A domain or subdomain you control**, with its DNS hosted somewhere you can add
  an `A` record manually (this repo doesn't manage third-party DNS with
  Terraform). You'll point it at this deployment's Elastic IP — see "Deploy
  steps" below for the exact sequencing; it must already resolve there
  **before** you apply, or Let's Encrypt's domain-ownership check at first
  boot fails.

**Test with a real mobile carrier number, not Google Voice** (confirmed against a
real deploy): this app's own invite SMS (a plain informational text) delivers to
a Google Voice number fine, but Cognito's own sign-in OTP does not -- many
providers, AWS included, deliberately restrict OTP/verification-code delivery to
VoIP numbers like Google Voice as an anti-fraud policy, since they can't be tied
to verified phone-ownership history the way a carrier SIM can. This fails the
same way for any Cognito deployment, not just this one -- there is no Terraform/
Cognito config that fixes it.

### Deploy steps

Elastic IPs in this composition are allocated independently of the instance
(`aws_eip.app`), so you can get a stable IP to point DNS at **before** creating
anything else, in two applies:

```sh
cd infra/lean
terraform init
# First apply: just enough to get a stable Elastic IP. Everything else in this
# composition needs domain_name to already resolve, which needs this IP first.
terraform apply -target=aws_eip.app \
  -var="cognito_domain_prefix=<pick-a-globally-unique-prefix>" \
  -var="key_name=<your-ec2-key-pair-name>" \
  -var="allowed_ssh_cidr=<your-ip>/32" \
  -var="domain_name=<your-domain>"
terraform output public_ip
```

Add an `A` record for `<your-domain>` pointing at that IP with your DNS
provider, then confirm it's actually resolving (propagation can take anywhere
from seconds to a few minutes depending on provider/TTL) before continuing:

```sh
dig +short <your-domain>    # should print the same IP
```

Once that matches, apply the rest:

```sh
terraform apply \
  -var="cognito_domain_prefix=<pick-a-globally-unique-prefix>" \
  -var="key_name=<your-ec2-key-pair-name>" \
  -var="allowed_ssh_cidr=<your-ip>/32" \
  -var="domain_name=<your-domain>"
```

Wait a minute or two after apply for the instance's user-data to finish (installs
Docker, installs Certbot and obtains a real certificate for `domain_name`,
clones this repo, builds the image, runs migrations, and starts the app).

**Required one-time step, every fresh pool:** Terraform creates the user pool
domain but cannot yet create its managed-login branding (the
`aws_cognito_managed_login_branding` resource needs AWS provider v6.12+; this
repo is pinned to `~> 5.0`). Without it, `/login` shows "Login pages
unavailable. Please contact an administrator." instead of the sign-in page —
confirmed against a real deploy. Run once, out of band:

```sh
aws cognito-idp create-managed-login-branding \
  --region us-east-1 \
  --user-pool-id "$(terraform output -raw cognito_user_pool_id)" \
  --client-id "$(terraform output -raw cognito_user_pool_client_id)" \
  --use-cognito-provided-values
```

Then:

```sh
terraform output app_url    # https://<your-domain>
```

Visit that URL and walk the real Cognito Hosted UI → SMS OTP → callback flow —
no certificate warning this time. `terraform output ssh_command` gets you in
for troubleshooting (`docker-compose logs` in `/opt/app`) if needed; Certbot's
own renewal runs twice daily via cron and only actually renews within ~30 days
of expiry (`sudo certbot certificates` shows current status/expiry).

### Tear down

```sh
terraform destroy
```

No `deletion_protection` or similar blocks this — everything here is disposable.

## Secrets — never committed

No secret value is ever hardcoded or stored in Terraform: `db_password` and
`session_secret` are Terraform-generated (`random_password`/`random_id`) and
written directly into the instance's `.env` file by user-data at first boot,
never into state as a separate secret store. The Cognito app client secret
is generated by Cognito and passed the same way. No access key ever enters
the instance: SNS publish (invite SMS) and Cognito's own SMS OTP both use the
instance/Cognito service role's credentials via the default AWS SDK provider
chain.

## Invite SMS delivery

Inviting a manager or authorized user (SDD §11.1, §11.4) sends a real text via
Amazon SNS (`src/sms/sns-gateway.ts`) -- the same account/region mechanism
Cognito's own SMS OTP already sends through. `modules/ec2_host`'s instance
role and `modules/cognito`'s SMS role both grant `sns:Publish` -- no access
key ever enters an env file for this. See "Prerequisites" above for the SNS
sandbox / origination-identity requirements this needs.

A send failure never blocks or rolls back the invite itself (it's still
created, and the console/log surfaces the failure) -- see `src/sms/gateway.ts`.
