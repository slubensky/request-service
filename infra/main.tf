# Root composition: wires the reviewable single-purpose modules together.
# Region is locked to us-east-1 (see variables.tf). All secret *values* are
# supplied out of band; nothing sensitive is hardcoded here.

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

module "network" {
  source = "./modules/network"

  name_prefix        = local.name_prefix
  vpc_cidr           = var.vpc_cidr
  availability_zones = var.availability_zones
  db_port            = var.db_port
}

module "cognito" {
  source = "./modules/cognito"

  name_prefix           = local.name_prefix
  domain_prefix         = var.cognito_domain_prefix
  managed_login_version = var.cognito_managed_login_version
  callback_urls         = var.cognito_callback_urls
  logout_urls           = var.cognito_logout_urls
  relying_party_id      = var.webauthn_relying_party_id
  user_verification     = var.webauthn_user_verification
  sms_external_id       = var.cognito_sms_external_id
}

module "database" {
  source = "./modules/database"

  name_prefix             = local.name_prefix
  engine_version          = var.aurora_engine_version
  database_name           = var.db_name
  master_username         = var.db_master_username
  db_port                 = var.db_port
  min_capacity            = var.aurora_min_acu
  max_capacity            = var.aurora_max_acu
  instance_count          = var.aurora_instance_count
  subnet_ids              = module.network.private_subnet_ids
  security_group_ids      = [module.network.aurora_security_group_id]
  backup_retention_period = var.aurora_backup_retention_days
  deletion_protection     = var.aurora_deletion_protection
  skip_final_snapshot     = var.aurora_skip_final_snapshot
}

module "secrets" {
  source = "./modules/secrets"

  name_prefix             = local.name_prefix
  recovery_window_in_days = var.secret_recovery_window_days
  cognito_client_secret   = module.cognito.user_pool_client_secret
  stripe_secret_key       = var.stripe_secret_key
  stripe_webhook_secret   = var.stripe_webhook_secret
}

module "app_runner" {
  source = "./modules/app_runner"

  name_prefix       = local.name_prefix
  image_identifier  = var.container_image_identifier
  container_port    = var.container_port
  health_check_path = var.health_check_path
  cpu               = var.app_runner_cpu
  memory            = var.app_runner_memory
  min_size          = var.app_runner_min_size
  max_size          = var.app_runner_max_size
  max_concurrency   = var.app_runner_max_concurrency

  subnet_ids         = module.network.private_subnet_ids
  security_group_ids = [module.network.app_security_group_id]

  # Least-privilege: the instance role may read only these secret ARNs.
  secret_arns = compact([
    module.database.master_user_secret_arn,
    module.secrets.cognito_client_secret_arn,
    module.secrets.stripe_secret_key_arn,
    module.secrets.stripe_webhook_secret_arn,
  ])

  runtime_environment_variables = {
    NODE_ENV             = "production"
    APP_AWS_REGION       = var.aws_region
    DB_HOST              = module.database.cluster_endpoint
    DB_PORT              = tostring(var.db_port)
    DB_NAME              = var.db_name
    COGNITO_USER_POOL_ID = module.cognito.user_pool_id
    COGNITO_CLIENT_ID    = module.cognito.user_pool_client_id
    COGNITO_DOMAIN       = module.cognito.hosted_ui_domain
  }

  # Injected at runtime from Secrets Manager (values never enter Terraform).
  runtime_environment_secrets = {
    DB_CREDENTIALS_ARN    = module.database.master_user_secret_arn
    COGNITO_CLIENT_SECRET = module.secrets.cognito_client_secret_arn
    STRIPE_SECRET_KEY     = module.secrets.stripe_secret_key_arn
    STRIPE_WEBHOOK_SECRET = module.secrets.stripe_webhook_secret_arn
  }
}

module "dns" {
  source = "./modules/dns"

  enable_custom_domain   = var.custom_domain != ""
  enable_acm_certificate = var.custom_domain != "" && var.create_acm_certificate
  custom_domain          = var.custom_domain
  route53_zone_id        = var.route53_zone_id
  app_runner_service_arn = module.app_runner.service_arn
}
