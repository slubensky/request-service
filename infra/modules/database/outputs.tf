output "cluster_endpoint" {
  description = "Writer endpoint."
  value       = aws_rds_cluster.this.endpoint
}

output "reader_endpoint" {
  description = "Reader endpoint."
  value       = aws_rds_cluster.this.reader_endpoint
}

output "cluster_arn" {
  description = "Cluster ARN."
  value       = aws_rds_cluster.this.arn
}

output "master_user_secret_arn" {
  description = "ARN of the RDS-managed Secrets Manager secret holding master credentials."
  value       = aws_rds_cluster.this.master_user_secret[0].secret_arn
}
