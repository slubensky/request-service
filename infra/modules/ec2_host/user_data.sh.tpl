#!/bin/bash
# Rendered by Terraform's templatefile() -- every substitution below is filled
# in at plan/apply time, not a shell variable. Runs once on first boot (cloud-init).
set -euo pipefail

dnf update -y
dnf install -y docker git

systemctl enable --now docker

curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64" \
  -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose

# AL2023's dnf docker package bundles a buildx plugin older than the floor
# the docker-compose binary above requires for `build` ("compose build
# requires buildx 0.17.0 or later"), so `docker-compose up --build` fails
# with the app image never built. Pin and install a known-good buildx
# release into the standard system-wide CLI plugin dir, overriding it.
mkdir -p /usr/libexec/docker/cli-plugins
curl -fsSL "https://github.com/docker/buildx/releases/download/v0.19.3/buildx-v0.19.3.linux-amd64" \
  -o /usr/libexec/docker/cli-plugins/docker-buildx
chmod +x /usr/libexec/docker/cli-plugins/docker-buildx

mkdir -p /opt/app
cd /opt/app
git clone --branch "${repo_ref}" --depth 1 "${repo_url}" .

mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout certs/key.pem -out certs/cert.pem \
  -subj "/CN=${public_ip}" \
  -addext "subjectAltName=IP:${public_ip}"

cat > .env <<ENV_EOF
DB_PASSWORD="${db_password}"
SESSION_SECRET="${session_secret}"
PUBLIC_IP="${public_ip}"
APP_PORT="${app_port}"
APP_AWS_REGION="${aws_region}"
COGNITO_DOMAIN="${cognito_domain}"
COGNITO_ISSUER="${cognito_issuer}"
COGNITO_CLIENT_ID="${cognito_client_id}"
COGNITO_CLIENT_SECRET="${cognito_client_secret}"
ENV_EOF
chmod 600 .env

docker-compose up -d --build
