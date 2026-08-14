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
  mfa_configuration        = "OFF"

  sms_configuration {
    external_id    = var.sms_external_id
    sns_caller_arn = aws_iam_role.sms.arn
  }

  # Passwordless first-factor choices offered to users.
  sign_in_policy {
    allowed_first_auth_factors = ["SMS_OTP", "WEB_AUTHN"]
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
