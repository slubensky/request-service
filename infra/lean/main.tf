# Lean test composition: real Cognito (SMS OTP + SNS) against a single EC2
# instance running Postgres + the app via docker-compose -- no Aurora, no App
# Runner, no NAT/VPC connector, no Route53/ACM. See infra/README.md "Lean test
# deployment" for the full runbook. Not applied by CI; entirely separate from
# ../main.tf's production composition and state.

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = "lean-test"
      ManagedBy   = "terraform"
    }
  }
}

resource "random_password" "db" {
  length  = 24
  special = false
}

resource "random_id" "session_secret" {
  byte_length = 32
}

# Allocated independently of the instance and of Cognito so its address is
# known up front -- both modules below need it, and allocating it here avoids
# the two-phase apply a dynamically-assigned domain (e.g. App Runner's) would
# otherwise require.
resource "aws_eip" "app" {
  domain = "vpc"
  tags   = { Name = "${var.project_name}-eip" }
}

module "cognito" {
  source = "../modules/cognito"

  name_prefix   = var.project_name
  domain_prefix = var.cognito_domain_prefix
  # Must stay 2 ("Managed Login"): it's the only Hosted UI version that
  # supports choice-based sign-in (the SMS OTP picker screen this app relies
  # on) -- classic Hosted UI (1) only ever renders a username+password form.
  # modules/cognito's aws_cognito_managed_login_branding resource is what
  # actually makes version 2's pages serve (see its comment for why).
  managed_login_version = 2
  callback_urls         = ["https://${var.domain_name}/auth/callback"]
  logout_urls           = ["https://${var.domain_name}/"]
  # A real domain (not a bare IP) now backs this deployment, so WebAuthn/
  # passkey enrollment actually works here too, not just SMS OTP.
  relying_party_id  = var.domain_name
  user_verification = "preferred"
  sms_external_id   = "${var.project_name}-cognito-sms"
}

module "ec2_host" {
  source = "../modules/ec2_host"

  name_prefix      = var.project_name
  instance_type    = var.instance_type
  key_name         = var.key_name
  allowed_ssh_cidr = var.allowed_ssh_cidr
  app_port         = var.app_port
  domain_name      = var.domain_name
  repo_url         = var.repo_url
  repo_ref         = var.repo_ref

  eip_allocation_id = aws_eip.app.id

  db_password    = random_password.db.result
  session_secret = random_id.session_secret.hex

  cognito_domain        = "https://${module.cognito.hosted_ui_domain}.auth.${var.aws_region}.amazoncognito.com"
  cognito_issuer        = "https://cognito-idp.${var.aws_region}.amazonaws.com/${module.cognito.user_pool_id}"
  cognito_client_id     = module.cognito.user_pool_client_id
  cognito_client_secret = module.cognito.user_pool_client_secret
}
