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

# AL2023 has no dnf-packaged certbot; install it into an isolated venv, the
# method AWS itself documents for this OS.
dnf install -y python3 augeas-libs
python3 -m venv /opt/certbot
/opt/certbot/bin/pip install --upgrade pip
/opt/certbot/bin/pip install certbot
ln -sf /opt/certbot/bin/certbot /usr/bin/certbot

# Runs after every successful issuance AND every future renewal (certbot's
# own convention -- a --deploy-hook given at issuance time is persisted into
# the renewal config and reused automatically, so the cron job below never
# needs to repeat it). Copies the fresh cert where docker-compose's bind
# mount (./certs:/certs:ro) expects it, then restarts just the app container
# so Node -- which reads the cert file once at startup, no hot-reload --
# actually picks up the new one.
cat > /opt/app/deploy-cert-hook.sh <<'HOOK_EOF'
#!/bin/bash
set -euo pipefail
cp "/etc/letsencrypt/live/${domain_name}/fullchain.pem" /opt/app/certs/cert.pem
cp "/etc/letsencrypt/live/${domain_name}/privkey.pem" /opt/app/certs/key.pem
chmod 644 /opt/app/certs/cert.pem /opt/app/certs/key.pem
cd /opt/app && docker-compose restart app
HOOK_EOF
chmod +x /opt/app/deploy-cert-hook.sh

# Standalone binds port 80 itself for the HTTP-01 challenge -- nothing else
# ever listens there (the app is only ever reached on 443), so this is safe
# both now and on every future renewal. Requires domain_name to already
# resolve to this instance's Elastic IP (see infra/README.md): Let's
# Encrypt's own servers, not this instance, perform that DNS lookup.
certbot certonly --standalone --non-interactive --agree-tos \
  --register-unsafely-without-email \
  --deploy-hook /opt/app/deploy-cert-hook.sh \
  -d "${domain_name}"

# Certbot's own recommended cadence: renewal only actually happens within
# ~30 days of expiry, so running this twice a day is a safe no-op the rest
# of the time. `crontab -l` exits non-zero when root has no crontab yet --
# true on every fresh instance -- which under this script's `set -e
# -o pipefail` aborted the whole script right here, before .env or
# docker-compose ever ran. `|| true` absorbs that expected failure.
(crontab -l 2>/dev/null || true; echo "0 3,15 * * * /usr/bin/certbot renew --quiet") | crontab -

cat > .env <<ENV_EOF
DB_PASSWORD="${db_password}"
SESSION_SECRET="${session_secret}"
DOMAIN_NAME="${domain_name}"
APP_PORT="${app_port}"
APP_AWS_REGION="${aws_region}"
COGNITO_DOMAIN="${cognito_domain}"
COGNITO_ISSUER="${cognito_issuer}"
COGNITO_CLIENT_ID="${cognito_client_id}"
COGNITO_CLIENT_SECRET="${cognito_client_secret}"
ENV_EOF
chmod 600 .env

docker-compose up -d --build
