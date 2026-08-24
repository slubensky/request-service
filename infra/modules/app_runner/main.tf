# App Runner service running the SSR container. Two IAM roles: an access role
# (pull from private ECR) and an instance role (read only the specific runtime
# secrets). Egress is routed through a VPC connector so the app reaches Aurora
# privately; ingress is public (TLS terminated by App Runner).

# --- Access role: pull the image from private ECR ---
data "aws_iam_policy_document" "access_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["build.apprunner.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "access" {
  name               = "${var.name_prefix}-apprunner-access"
  assume_role_policy = data.aws_iam_policy_document.access_assume.json
}

resource "aws_iam_role_policy_attachment" "access_ecr" {
  role       = aws_iam_role.access.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess"
}

# --- Instance role: least-privilege read of the runtime secrets ---
data "aws_iam_policy_document" "instance_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["tasks.apprunner.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "instance" {
  name               = "${var.name_prefix}-apprunner-instance"
  assume_role_policy = data.aws_iam_policy_document.instance_assume.json
}

data "aws_iam_policy_document" "instance_secrets" {
  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = var.secret_arns
  }
}

resource "aws_iam_role_policy" "instance_secrets" {
  name   = "${var.name_prefix}-apprunner-secrets"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.instance_secrets.json
}

# Lets the app send invite SMS via SNS (src/sms/sns-gateway.ts) using this same
# instance role -- no access key ever enters runtime_environment_variables/secrets.
data "aws_iam_policy_document" "instance_sns" {
  statement {
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = ["*"] # SMS publish has no per-number resource ARN to scope to.
  }
}

resource "aws_iam_role_policy" "instance_sns" {
  name   = "${var.name_prefix}-apprunner-sns"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.instance_sns.json
}

resource "aws_apprunner_vpc_connector" "this" {
  vpc_connector_name = "${var.name_prefix}-connector"
  subnets            = var.subnet_ids
  security_groups    = var.security_group_ids
}

resource "aws_apprunner_auto_scaling_configuration_version" "this" {
  auto_scaling_configuration_name = "${var.name_prefix}-asc"
  max_concurrency                 = var.max_concurrency
  min_size                        = var.min_size
  max_size                        = var.max_size
}

resource "aws_apprunner_service" "this" {
  service_name                   = "${var.name_prefix}-ssr"
  auto_scaling_configuration_arn = aws_apprunner_auto_scaling_configuration_version.this.arn

  source_configuration {
    auto_deployments_enabled = false

    authentication_configuration {
      access_role_arn = aws_iam_role.access.arn
    }

    image_repository {
      image_identifier      = var.image_identifier
      image_repository_type = "ECR"

      image_configuration {
        port                          = tostring(var.container_port)
        runtime_environment_variables = var.runtime_environment_variables
        runtime_environment_secrets   = var.runtime_environment_secrets
      }
    }
  }

  instance_configuration {
    cpu               = var.cpu
    memory            = var.memory
    instance_role_arn = aws_iam_role.instance.arn
  }

  health_check_configuration {
    protocol            = "HTTP"
    path                = var.health_check_path
    interval            = 10
    timeout             = 5
    healthy_threshold   = 1
    unhealthy_threshold = 5
  }

  network_configuration {
    ingress_configuration {
      is_publicly_accessible = true
    }

    egress_configuration {
      egress_type       = "VPC"
      vpc_connector_arn = aws_apprunner_vpc_connector.this.arn
    }
  }
}
