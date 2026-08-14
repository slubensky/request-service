# Non-sensitive outputs for wiring the app and follow-up (human-gated) deploys.
# Secret *values* are never emitted; only ARNs/identifiers appear here.

output "vpc_id" {
  description = "ID of the VPC hosting Aurora and the App Runner VPC connector."
  value       = module.network.vpc_id
}

output "private_subnet_ids" {
  description = "Private subnet IDs used by Aurora and the App Runner egress connector."
  value       = module.network.private_subnet_ids
}

output "aurora_cluster_endpoint" {
  description = "Writer endpoint of the Aurora Serverless v2 cluster."
  value       = module.database.cluster_endpoint
}

output "aurora_reader_endpoint" {
  description = "Reader endpoint of the Aurora Serverless v2 cluster."
  value       = module.database.reader_endpoint
}

output "aurora_master_user_secret_arn" {
  description = "ARN of the RDS-managed Secrets Manager secret holding the DB master credentials."
  value       = module.database.master_user_secret_arn
}

output "cognito_user_pool_id" {
  description = "Cognito user pool ID."
  value       = module.cognito.user_pool_id
}

output "cognito_user_pool_client_id" {
  description = "Cognito app client ID for the SSR server."
  value       = module.cognito.user_pool_client_id
}

output "cognito_hosted_ui_domain" {
  description = "Cognito managed-login (Hosted UI) domain prefix."
  value       = module.cognito.hosted_ui_domain
}

output "cognito_hosted_ui_url" {
  description = "Full Cognito managed-login base URL."
  value       = "https://${module.cognito.hosted_ui_domain}.auth.${var.aws_region}.amazoncognito.com"
}

output "secret_arns" {
  description = "Map of application Secrets Manager ARNs (values managed out of band)."
  value = {
    db_credentials        = module.database.master_user_secret_arn
    cognito_client_secret = module.secrets.cognito_client_secret_arn
    stripe_secret_key     = module.secrets.stripe_secret_key_arn
    stripe_webhook_secret = module.secrets.stripe_webhook_secret_arn
  }
}

output "app_runner_service_arn" {
  description = "ARN of the App Runner service."
  value       = module.app_runner.service_arn
}

output "app_runner_service_url" {
  description = "Default App Runner service URL (before any custom domain)."
  value       = module.app_runner.service_url
}

output "custom_domain_dns_target" {
  description = "App Runner DNS target for the custom domain, if enabled (create a CNAME/ALIAS to this)."
  value       = module.dns.custom_domain_dns_target
}
