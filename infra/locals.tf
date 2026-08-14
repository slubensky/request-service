locals {
  # Stable prefix for every resource name and tag, e.g. "request-service-prod".
  name_prefix = "${var.project_name}-${var.environment}"
}
