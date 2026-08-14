variable "enable_custom_domain" {
  description = "Create the App Runner custom-domain association and its Route53 records."
  type        = bool
}

variable "enable_acm_certificate" {
  description = "Also create a standalone DNS-validated ACM certificate (for fronting App Runner with CloudFront/ALB). App Runner manages its own certificate for the association."
  type        = bool
}

variable "custom_domain" {
  description = "Custom domain name (e.g. app.example.com)."
  type        = string
}

variable "route53_zone_id" {
  description = "Route53 hosted zone ID that owns the custom domain."
  type        = string
}

variable "app_runner_service_arn" {
  description = "ARN of the App Runner service to associate the domain with."
  type        = string
}
