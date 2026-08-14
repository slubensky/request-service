variable "aws_region" {
  description = "AWS region for all resources. Locked to us-east-1 per the approved Blueprint (art_RUHUe0PF)."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = var.aws_region == "us-east-1"
    error_message = "This project is pinned to us-east-1; change the default deliberately and update the Blueprint if that ever needs to change."
  }
}

