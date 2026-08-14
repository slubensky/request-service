output "cognito_client_secret_arn" {
  description = "ARN of the Cognito app client secret."
  value       = aws_secretsmanager_secret.cognito_client.arn
}

output "stripe_secret_key_arn" {
  description = "ARN of the Stripe secret key container."
  value       = aws_secretsmanager_secret.stripe_secret_key.arn
}

output "stripe_webhook_secret_arn" {
  description = "ARN of the Stripe webhook secret container."
  value       = aws_secretsmanager_secret.stripe_webhook_secret.arn
}
