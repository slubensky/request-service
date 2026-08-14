variable "name_prefix" {
  description = "Prefix applied to every resource name."
  type        = string
}

variable "image_identifier" {
  description = "ECR image URI for the SSR container."
  type        = string
}

variable "container_port" {
  description = "Port the SSR server listens on."
  type        = number
}

variable "health_check_path" {
  description = "HTTP health check path (the app's /healthz)."
  type        = string
}

variable "cpu" {
  description = "vCPU allocation."
  type        = string
}

variable "memory" {
  description = "Memory allocation."
  type        = string
}

variable "min_size" {
  description = "Minimum provisioned instances."
  type        = number
}

variable "max_size" {
  description = "Maximum instances for autoscaling."
  type        = number
}

variable "max_concurrency" {
  description = "Max concurrent requests per instance before scaling out."
  type        = number
}

variable "subnet_ids" {
  description = "Private subnet IDs for the VPC connector."
  type        = list(string)
}

variable "security_group_ids" {
  description = "Security group IDs for the VPC connector."
  type        = list(string)
}

variable "secret_arns" {
  description = "Secret ARNs the instance role is granted read access to."
  type        = list(string)
}

variable "runtime_environment_variables" {
  description = "Non-secret environment variables injected into the container."
  type        = map(string)
  default     = {}
}

variable "runtime_environment_secrets" {
  description = "Map of env var name -> Secrets Manager ARN injected at runtime."
  type        = map(string)
  default     = {}
}
