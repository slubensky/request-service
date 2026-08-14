# Aurora Serverless v2 PostgreSQL. Credentials are managed by RDS in Secrets
# Manager (manage_master_user_password) so no password ever enters Terraform.

resource "aws_db_subnet_group" "this" {
  name       = "${var.name_prefix}-db-subnets"
  subnet_ids = var.subnet_ids

  tags = { Name = "${var.name_prefix}-db-subnets" }
}

resource "aws_rds_cluster" "this" {
  cluster_identifier = "${var.name_prefix}-aurora"
  engine             = "aurora-postgresql"
  engine_mode        = "provisioned"
  engine_version     = var.engine_version
  database_name      = var.database_name
  port               = var.db_port

  master_username             = var.master_username
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = var.security_group_ids

  storage_encrypted       = true
  backup_retention_period = var.backup_retention_period
  deletion_protection     = var.deletion_protection

  skip_final_snapshot       = var.skip_final_snapshot
  final_snapshot_identifier = var.skip_final_snapshot ? null : "${var.name_prefix}-aurora-final"

  serverlessv2_scaling_configuration {
    min_capacity = var.min_capacity
    max_capacity = var.max_capacity
  }
}

resource "aws_rds_cluster_instance" "this" {
  count = var.instance_count

  identifier           = "${var.name_prefix}-aurora-${count.index}"
  cluster_identifier   = aws_rds_cluster.this.id
  engine               = aws_rds_cluster.this.engine
  engine_version       = aws_rds_cluster.this.engine_version
  instance_class       = "db.serverless"
  db_subnet_group_name = aws_db_subnet_group.this.name
}
