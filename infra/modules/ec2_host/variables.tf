variable "name_prefix" {
  description = "Prefix applied to every resource name."
  type        = string
}

variable "instance_type" {
  description = "EC2 instance type."
  type        = string
  default     = "t3.micro"
}

variable "key_name" {
  description = "Existing EC2 key pair name for SSH access."
  type        = string
}

variable "allowed_ssh_cidr" {
  description = "CIDR allowed to SSH into the instance (your IP, e.g. 1.2.3.4/32)."
  type        = string
}

variable "app_port" {
  description = "Port the app listens on inside the container. The internet-facing port is always 443 (mapped to this one)."
  type        = number
  default     = 3000
}

variable "domain_name" {
  description = "Real domain/subdomain pointing at this instance's Elastic IP, used for the Let's Encrypt certificate, Cognito's relying party ID, and every callback/base URL."
  type        = string
}

variable "repo_url" {
  description = "Git URL the instance clones on first boot."
  type        = string
}

variable "repo_ref" {
  description = "Branch or tag to check out."
  type        = string
}

variable "eip_allocation_id" {
  description = "Allocation ID of a pre-allocated Elastic IP to associate with this instance."
  type        = string
}

variable "db_password" {
  description = "Password for the Postgres container the app connects to."
  type        = string
  sensitive   = true
}

variable "session_secret" {
  description = "Session-signing secret for the app."
  type        = string
  sensitive   = true
}

variable "cognito_domain" {
  description = "Full Cognito managed-login (Hosted UI) base URL."
  type        = string
}

variable "cognito_issuer" {
  description = "Cognito user pool token issuer URL."
  type        = string
}

variable "cognito_client_id" {
  description = "Cognito app client ID."
  type        = string
}

variable "cognito_client_secret" {
  description = "Cognito app client secret."
  type        = string
  sensitive   = true
}
