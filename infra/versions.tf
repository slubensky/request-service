terraform {
  required_version = ">= 1.9.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Partial backend configuration: intentionally empty so `terraform init`
  # requires -backend-config (bucket, key, region, etc.) supplied out of
  # band at deploy time. CI validates the config with `-backend=false`,
  # which never needs these values and never touches AWS credentials.
  backend "s3" {}
}

