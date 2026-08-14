# ---------------------------------------------------------------------------
# Global
# ---------------------------------------------------------------------------

variable "aws_region" {
  description = "AWS region for all resources. Locked to us-east-1 per the approved Blueprint (art_RUHUe0PF)."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = var.aws_region == "us-east-1"
    error_message = "This project is pinned to us-east-1; change the default deliberately and update the Blueprint if that ever needs to change."
  }
}

variable "project_name" {
  description = "Short project slug used as the resource name prefix."
  type        = string
  default     = "request-service"
}

variable "environment" {
  description = "Deployment environment (e.g. prod, staging). Part of every resource name and tag."
  type        = string
  default     = "prod"
}

# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------

variable "vpc_cidr" {
  description = "CIDR block for the VPC that hosts Aurora and the App Runner VPC connector."
  type        = string
  default     = "10.20.0.0/16"
}

variable "availability_zones" {
  description = "AZs to spread public/private subnets across (>= 2 required for Aurora)."
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]

  validation {
    condition     = length(var.availability_zones) >= 2
    error_message = "Aurora requires a DB subnet group spanning at least two Availability Zones."
  }
}

# ---------------------------------------------------------------------------
# Database (Aurora Serverless v2 PostgreSQL)
# ---------------------------------------------------------------------------

variable "db_name" {
  description = "Initial database name created in the Aurora cluster."
  type        = string
  default     = "request_service"
}

variable "db_master_username" {
  description = "Master username for the Aurora cluster. The password is generated and stored by RDS in Secrets Manager (manage_master_user_password)."
  type        = string
  default     = "app_admin"
}

variable "db_port" {
  description = "PostgreSQL port."
  type        = number
  default     = 5432
}

variable "aurora_engine_version" {
  description = "Aurora PostgreSQL engine version."
  type        = string
  default     = "16.6"
}

variable "aurora_min_acu" {
  description = "Serverless v2 minimum capacity in ACUs. Kept low for cost per the Blueprint."
  type        = number
  default     = 0.5
}

variable "aurora_max_acu" {
  description = "Serverless v2 maximum capacity in ACUs."
  type        = number
  default     = 4
}

variable "aurora_instance_count" {
  description = "Number of Serverless v2 instances in the cluster (1 = writer only)."
  type        = number
  default     = 1
}

variable "aurora_backup_retention_days" {
  description = "Automated backup retention in days."
  type        = number
  default     = 7
}

variable "aurora_deletion_protection" {
  description = "Protect the cluster from accidental deletion."
  type        = bool
  default     = true
}

variable "aurora_skip_final_snapshot" {
  description = "Skip the final snapshot on destroy. Set false for production data safety."
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# Cognito (passwordless: SMS OTP + WebAuthn passkeys)
# ---------------------------------------------------------------------------

variable "cognito_domain_prefix" {
  description = "Prefix for the Cognito managed-login (Hosted UI) domain: <prefix>.auth.<region>.amazoncognito.com."
  type        = string
  default     = "request-service-auth"
}

variable "cognito_managed_login_version" {
  description = "Managed login branding version (2 = new managed login experience)."
  type        = number
  default     = 2
}

variable "cognito_callback_urls" {
  description = "Allowed OAuth callback URLs for the app client."
  type        = list(string)
  default     = []
}

variable "cognito_logout_urls" {
  description = "Allowed logout URLs for the app client."
  type        = list(string)
  default     = []
}

variable "webauthn_relying_party_id" {
  description = "WebAuthn relying party ID (the registrable domain the passkeys are bound to, e.g. app.example.com)."
  type        = string
  default     = "localhost"
}

variable "webauthn_user_verification" {
  description = "WebAuthn user verification requirement (preferred or required)."
  type        = string
  default     = "preferred"
}

variable "cognito_sms_external_id" {
  description = "External ID used in the Cognito -> SNS assume-role trust for SMS OTP delivery."
  type        = string
  default     = "request-service-cognito-sms"
}

# ---------------------------------------------------------------------------
# Secrets Manager (values supplied out of band; never committed)
# ---------------------------------------------------------------------------

variable "secret_recovery_window_days" {
  description = "Recovery window before a deleted secret is permanently removed."
  type        = number
  default     = 7
}

variable "stripe_secret_key" {
  description = "Stripe secret API key. Leave empty to create the secret container only and set the value out of band."
  type        = string
  default     = ""
  sensitive   = true
}

variable "stripe_webhook_secret" {
  description = "Stripe webhook signing secret. Leave empty to create the secret container only and set the value out of band."
  type        = string
  default     = ""
  sensitive   = true
}

# ---------------------------------------------------------------------------
# App Runner (SSR container)
# ---------------------------------------------------------------------------

variable "container_image_identifier" {
  description = "ECR image URI for the SSR container, e.g. <acct>.dkr.ecr.us-east-1.amazonaws.com/request-service:latest."
  type        = string
  default     = ""
}

variable "container_port" {
  description = "Port the SSR server listens on inside the container."
  type        = number
  default     = 8080
}

variable "health_check_path" {
  description = "HTTP path App Runner polls for health. Matches the app's /healthz endpoint."
  type        = string
  default     = "/healthz"
}

variable "app_runner_cpu" {
  description = "App Runner vCPU allocation (e.g. 0.25 vCPU, 0.5 vCPU, 1 vCPU)."
  type        = string
  default     = "0.5 vCPU"
}

variable "app_runner_memory" {
  description = "App Runner memory allocation (e.g. 0.5 GB, 1 GB, 2 GB)."
  type        = string
  default     = "1 GB"
}

variable "app_runner_min_size" {
  description = "Minimum number of provisioned instances."
  type        = number
  default     = 1
}

variable "app_runner_max_size" {
  description = "Maximum number of instances for autoscaling."
  type        = number
  default     = 5
}

variable "app_runner_max_concurrency" {
  description = "Max concurrent requests per instance before scaling out."
  type        = number
  default     = 100
}

# ---------------------------------------------------------------------------
# DNS / TLS (optional custom domain)
# ---------------------------------------------------------------------------

variable "custom_domain" {
  description = "Optional custom domain for the App Runner service. Empty disables all DNS/ACM wiring."
  type        = string
  default     = ""
}

variable "route53_zone_id" {
  description = "Route53 hosted zone ID for the custom domain. Required only when custom_domain is set."
  type        = string
  default     = ""
}

variable "create_acm_certificate" {
  description = "Also create a standalone DNS-validated ACM certificate (for fronting App Runner with CloudFront/ALB). App Runner's own custom-domain association manages its certificate automatically."
  type        = bool
  default     = false
}
