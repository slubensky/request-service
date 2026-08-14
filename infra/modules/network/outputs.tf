output "vpc_id" {
  description = "VPC ID."
  value       = aws_vpc.this.id
}

output "public_subnet_ids" {
  description = "Public subnet IDs."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "Private subnet IDs."
  value       = aws_subnet.private[*].id
}

output "app_security_group_id" {
  description = "Security group for the App Runner VPC connector."
  value       = aws_security_group.app.id
}

output "aurora_security_group_id" {
  description = "Security group for the Aurora cluster."
  value       = aws_security_group.aurora.id
}
