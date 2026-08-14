variable "name_prefix" {
  description = "Prefix applied to every resource name."
  type        = string
}

variable "domain_prefix" {
  description = "Managed-login (Hosted UI) domain prefix."
  type        = string
}

variable "managed_login_version" {
  description = "Managed login branding version (2 = new experience)."
  type        = number
}

variable "callback_urls" {
  description = "Allowed OAuth callback URLs."
  type        = list(string)
}

variable "logout_urls" {
  description = "Allowed logout URLs."
  type        = list(string)
}

variable "relying_party_id" {
  description = "WebAuthn relying party ID (registrable domain)."
  type        = string
}

variable "user_verification" {
  description = "WebAuthn user verification requirement (preferred or required)."
  type        = string
}

variable "sms_external_id" {
  description = "External ID for the Cognito -> SNS assume-role trust."
  type        = string
}
