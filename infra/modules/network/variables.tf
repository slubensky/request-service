variable "name_prefix" {
  description = "Prefix applied to every resource name and Name tag."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
}

variable "availability_zones" {
  description = "AZs to spread subnets across (one public + one private subnet per AZ)."
  type        = list(string)
}

variable "db_port" {
  description = "Database port allowed from the app security group into the Aurora security group."
  type        = number
}
