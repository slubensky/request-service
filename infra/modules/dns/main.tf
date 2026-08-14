# Optional custom-domain wiring. App Runner provisions and renews the TLS
# certificate for its own custom-domain association automatically; we only
# publish the validation and target records into Route53. A standalone ACM
# certificate is available (enable_acm_certificate) for teams that additionally
# front the service with CloudFront/ALB.

resource "aws_apprunner_custom_domain_association" "this" {
  count = var.enable_custom_domain ? 1 : 0

  domain_name          = var.custom_domain
  service_arn          = var.app_runner_service_arn
  enable_www_subdomain = false
}

# Certificate validation CNAMEs App Runner asks us to publish.
resource "aws_route53_record" "cert_validation" {
  for_each = var.enable_custom_domain ? {
    for record in aws_apprunner_custom_domain_association.this[0].certificate_validation_records :
    record.name => record
  } : {}

  zone_id         = var.route53_zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.value]
  ttl             = 300
  allow_overwrite = true
}

# Point the custom domain at the App Runner DNS target.
resource "aws_route53_record" "alias" {
  count = var.enable_custom_domain ? 1 : 0

  zone_id = var.route53_zone_id
  name    = var.custom_domain
  type    = "CNAME"
  ttl     = 300
  records = [aws_apprunner_custom_domain_association.this[0].dns_target]
}

# --- Optional standalone ACM certificate (edge/CDN fronting) ---
resource "aws_acm_certificate" "this" {
  count = var.enable_acm_certificate ? 1 : 0

  domain_name       = var.custom_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "acm_validation" {
  for_each = var.enable_acm_certificate ? {
    for dvo in aws_acm_certificate.this[0].domain_validation_options :
    dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  } : {}

  zone_id         = var.route53_zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "this" {
  count = var.enable_acm_certificate ? 1 : 0

  certificate_arn         = aws_acm_certificate.this[0].arn
  validation_record_fqdns = [for r in aws_route53_record.acm_validation : r.fqdn]
}
