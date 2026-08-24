# Cognito owns authentication only. Passwordless choice-based sign-in with
# SMS OTP + WebAuthn passkeys. The app client is confidential (has a secret)
# because the SSR server is the OAuth client. Authorization (SiteRole) lives
# entirely in our database, never in Cognito.

# IAM role that lets Cognito publish SMS OTP messages via SNS.
data "aws_iam_policy_document" "sms_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["cognito-idp.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "sts:ExternalId"
      values   = [var.sms_external_id]
    }
  }
}

resource "aws_iam_role" "sms" {
  name               = "${var.name_prefix}-cognito-sms"
  assume_role_policy = data.aws_iam_policy_document.sms_assume.json
}

data "aws_iam_policy_document" "sms_publish" {
  statement {
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "sms" {
  name   = "${var.name_prefix}-cognito-sms"
  role   = aws_iam_role.sms.id
  policy = data.aws_iam_policy_document.sms_publish.json
}

resource "aws_cognito_user_pool" "this" {
  name           = "${var.name_prefix}-users"
  user_pool_tier = "ESSENTIALS" # required for choice-based passwordless auth

  username_attributes      = ["phone_number"]
  auto_verified_attributes = ["phone_number"]
  # OPTIONAL, not OFF, even though this app never gives any user a way to opt
  # into Cognito's legacy second-factor MFA system. Cognito's SetUserPoolMfaConfig
  # rejects MfaConfiguration=OFF (the default when this argument is omitted --
  # confirmed by testing that against a real account, see SDD changelog #019/
  # #020) whenever ANY MFA-adjacent sub-config is present in the same call --
  # not just an SMS/software-token block explicitly enabled, but web_authn_
  # configuration below too (WebAuthn passkeys can satisfy MFA per Cognito's
  # own model, so its mere presence counts). We need both sms_configuration
  # and web_authn_configuration for the first-factor choices below, so OFF is
  # never compatible with this pool's shape. OPTIONAL is: it explicitly expects
  # sms_configuration/software-token config to be present, and since nothing in
  # this app ever lets a user set an MFA preference, Cognito never actually
  # prompts anyone for a second factor -- OPTIONAL is a no-op in practice, not
  # a real MFA requirement.
  mfa_configuration = "OPTIONAL"

  sms_configuration {
    external_id    = var.sms_external_id
    sns_caller_arn = aws_iam_role.sms.arn
  }

  # First-factor choices offered to users. Cognito's CreateUserPool API rejects
  # a pool that omits PASSWORD from this list at creation time ("Password
  # should be configured as one of the allowed first auth factors"), even
  # though the intent here is passwordless-only -- PASSWORD stays allowed so
  # `terraform apply` succeeds. No user of this app is ever given a password:
  # there is no self-service sign-up and the app's own auth routes only ever
  # redirect to Cognito's managed login, never construct a password-flow URL.
  sign_in_policy {
    allowed_first_auth_factors = ["PASSWORD", "SMS_OTP", "WEB_AUTHN"]
  }

  web_authn_configuration {
    relying_party_id  = var.relying_party_id
    user_verification = var.user_verification
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_phone_number"
      priority = 1
    }
  }
}

resource "aws_cognito_user_pool_client" "this" {
  name         = "${var.name_prefix}-web"
  user_pool_id = aws_cognito_user_pool.this.id

  generate_secret = true

  callback_urls = var.callback_urls
  logout_urls   = var.logout_urls

  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "phone", "profile"]
  supported_identity_providers         = ["COGNITO"]

  explicit_auth_flows = [
    "ALLOW_USER_AUTH", # choice-based passwordless (SMS OTP + passkeys)
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true
}

resource "aws_cognito_user_pool_domain" "this" {
  domain                = var.domain_prefix
  user_pool_id          = aws_cognito_user_pool.this.id
  managed_login_version = var.managed_login_version
}

# Managed login (managed_login_version = 2, required -- see its comment on
# var.managed_login_version's usage above) needs branding/style to exist
# before its pages serve anything; without it /login shows "Login pages
# unavailable. Please contact an administrator." (confirmed against a real
# deploy). Terraform can only manage this via aws_cognito_managed_login_branding,
# added in AWS provider v6.12+ -- this repo is pinned to ~> 5.0 across all of
# infra/, and bumping that major version is a separate decision with its own
# migration risk, not bundled into this fix. Until/unless that happens, run
# once per fresh pool, out of band (see infra/README.md):
#   aws cognito-idp create-managed-login-branding --user-pool-id <id> \
#     --client-id <id> --use-cognito-provided-values
