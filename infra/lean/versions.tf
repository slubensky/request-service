# Separate, throwaway composition for a low-cost real-OTP test deployment --
# not part of the production composition in ../main.tf and not validated by
# CI (see infra/README.md "Lean test deployment"). Local state is deliberate:
# this is meant to be stood up and torn down freely, never shared.

terraform {
  required_version = ">= 1.9.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
