# Single EC2 instance running the whole app (Postgres + the SSR container) via
# docker-compose, for a low-cost test deployment against real Cognito (see
# infra/lean/ -- this module is not used by the production composition in
# infra/main.tf). Uses the account's default VPC so no network/NAT resources
# are created here at all.

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-*-x86_64"]
  }
}

resource "aws_security_group" "this" {
  name_prefix = "${var.name_prefix}-"
  description = "Lean test host: SSH from one IP, the app port from anywhere."
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.allowed_ssh_cidr]
  }

  ingress {
    description = "App (self-signed HTTPS)"
    from_port   = var.app_port
    to_port     = var.app_port
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.name_prefix}-host" }
}

resource "aws_instance" "this" {
  ami                    = data.aws_ami.al2023.id
  instance_type          = var.instance_type
  key_name               = var.key_name
  subnet_id              = data.aws_subnets.default.ids[0]
  vpc_security_group_ids = [aws_security_group.this.id]

  user_data = templatefile("${path.module}/user_data.sh.tpl", {
    public_ip             = var.public_ip
    app_port              = var.app_port
    repo_url              = var.repo_url
    repo_ref              = var.repo_ref
    db_password           = var.db_password
    session_secret        = var.session_secret
    cognito_domain        = var.cognito_domain
    cognito_issuer        = var.cognito_issuer
    cognito_client_id     = var.cognito_client_id
    cognito_client_secret = var.cognito_client_secret
  })

  tags = { Name = "${var.name_prefix}-host" }
}

resource "aws_eip_association" "this" {
  instance_id   = aws_instance.this.id
  allocation_id = var.eip_allocation_id
}
