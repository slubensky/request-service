# Secrets Manager containers for application secrets. DB credentials are NOT
# here -- they are managed by RDS (see the database module). Stripe values are
# optional: when a value is empty we create only the container so the real
# value can be set out of band, keeping Terraform state credential-free.

resource "aws_secretsmanager_secret" "cognito_client" {
  name                    = "${var.name_prefix}/cognito/app-client-secret"
  description             = "Cognito app client secret used by the SSR OAuth client"
  recovery_window_in_days = var.recovery_window_in_days
}

resource "aws_secretsmanager_secret_version" "cognito_client" {
  secret_id     = aws_secretsmanager_secret.cognito_client.id
  secret_string = var.cognito_client_secret
}

resource "aws_secretsmanager_secret" "stripe_secret_key" {
  name                    = "${var.name_prefix}/stripe/secret-key"
  description             = "Stripe secret API key"
  recovery_window_in_days = var.recovery_window_in_days
}

resource "aws_secretsmanager_secret_version" "stripe_secret_key" {
  count = var.stripe_secret_key == "" ? 0 : 1

  secret_id     = aws_secretsmanager_secret.stripe_secret_key.id
  secret_string = var.stripe_secret_key
}

resource "aws_secretsmanager_secret" "stripe_webhook_secret" {
  name                    = "${var.name_prefix}/stripe/webhook-secret"
  description             = "Stripe webhook signing secret"
  recovery_window_in_days = var.recovery_window_in_days
}

resource "aws_secretsmanager_secret_version" "stripe_webhook_secret" {
  count = var.stripe_webhook_secret == "" ? 0 : 1

  secret_id     = aws_secretsmanager_secret.stripe_webhook_secret.id
  secret_string = var.stripe_webhook_secret
}
