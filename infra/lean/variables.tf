variable "aws_region" {
  description = "AWS region. Locked to us-east-1 to match the project's Blueprint."
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Resource name prefix for this test deployment."
  type        = string
  default     = "request-service-lean"
}

variable "cognito_domain_prefix" {
  description = "Prefix for the Cognito managed-login domain: <prefix>.auth.<region>.amazoncognito.com. Must be globally unique."
  type        = string
}

variable "key_name" {
  description = "Existing EC2 key pair name for SSH access (create/import it in the AWS console first)."
  type        = string
}

variable "allowed_ssh_cidr" {
  description = "CIDR allowed to SSH into the instance -- your IP, e.g. 1.2.3.4/32."
  type        = string
}

variable "instance_type" {
  description = "EC2 instance type."
  type        = string
  default     = "t3.micro"
}

variable "app_port" {
  description = "Port the app listens on and that is opened to the internet."
  type        = number
  default     = 3000
}

variable "repo_url" {
  description = "Git URL the instance clones on first boot."
  type        = string
  default     = "https://github.com/slubensky/request-service.git"
}

variable "repo_ref" {
  description = "Branch or tag to check out."
  type        = string
  default     = "main"
}
