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
  # No explicit mfa_configuration: this app never uses Cognito's legacy
  # second-factor MFA system (SMS_OTP here is a first factor via
  # sign_in_policy below, functionally separate). Explicitly setting
  # mfa_configuration = "OFF" alongside the sms_configuration block below
  # makes the AWS provider issue a follow-up SetUserPoolMfaConfig call that
  # includes SMS-MFA details derived from sms_configuration while also saying
  # MFA is off -- Cognito's API rejects that combination ("can't turn off MFA
  # and configure an MFA together"). Omitting the argument leaves Cognito's
  # own create-time default (already off) in place without triggering that
  # call at all.

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
