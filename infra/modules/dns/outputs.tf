output "custom_domain_dns_target" {
  description = "App Runner DNS target for the custom domain (create a CNAME/ALIAS to this)."
  value       = var.enable_custom_domain ? aws_apprunner_custom_domain_association.this[0].dns_target : null
}

output "acm_certificate_arn" {
  description = "ARN of the optional standalone ACM certificate, if created."
  value       = var.enable_acm_certificate ? aws_acm_certificate.this[0].arn : null
}
