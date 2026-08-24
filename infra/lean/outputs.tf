output "app_url" {
  description = "Visit this, click through the self-signed-cert warning once, and sign in."
  value       = "https://${aws_eip.app.public_ip}:${var.app_port}"
}

output "public_ip" {
  description = "The instance's Elastic IP."
  value       = aws_eip.app.public_ip
}

output "ssh_command" {
  description = "SSH in for troubleshooting (docker-compose logs, etc.)."
  value       = "ssh ec2-user@${aws_eip.app.public_ip}"
}

output "cognito_user_pool_id" {
  description = "Cognito user pool ID, for seeding a Company Admin directly if needed."
  value       = module.cognito.user_pool_id
}

output "cognito_user_pool_client_id" {
  description = "Cognito app client ID, needed for the one-time create-managed-login-branding CLI step (see infra/README.md)."
  value       = module.cognito.user_pool_client_id
}
