variable "name_prefix" {
  description = "Prefix applied to every resource name."
  type        = string
}

variable "engine_version" {
  description = "Aurora PostgreSQL engine version."
  type        = string
}

variable "database_name" {
  description = "Initial database name."
  type        = string
}

variable "master_username" {
  description = "Master username. Password is RDS-managed in Secrets Manager."
  type        = string
}

variable "db_port" {
  description = "PostgreSQL port."
  type        = number
}

variable "min_capacity" {
  description = "Serverless v2 minimum ACUs."
  type        = number
}

variable "max_capacity" {
  description = "Serverless v2 maximum ACUs."
  type        = number
}

variable "instance_count" {
  description = "Number of cluster instances (1 = writer only)."
  type        = number
}

variable "subnet_ids" {
  description = "Private subnet IDs for the DB subnet group."
  type        = list(string)
}

variable "security_group_ids" {
  description = "Security group IDs attached to the cluster."
  type        = list(string)
}

variable "backup_retention_period" {
  description = "Automated backup retention in days."
  type        = number
}

variable "deletion_protection" {
  description = "Protect the cluster from deletion."
  type        = bool
}

variable "skip_final_snapshot" {
  description = "Skip the final snapshot on destroy."
  type        = bool
}
