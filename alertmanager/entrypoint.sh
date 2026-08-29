#!/bin/sh
# alertmanager.yml.template contains ${VAR:-default} placeholders in Docker
# Compose's own interpolation syntax — Alertmanager's YAML parser doesn't
# understand that syntax at all (it expects literal values), so the file has
# to be substituted before being handed to the real alertmanager binary.
# This script does that substitution using the container's own runtime
# environment (set via docker-compose's `environment:` block), then execs
# alertmanager against the resulting concrete config.
set -e

sed \
  -e "s#\${ALERTMANAGER_SMTP_HOST:-smtp.gmail.com:587}#${ALERTMANAGER_SMTP_HOST:-smtp.gmail.com:587}#g" \
  -e "s#\${ALERTMANAGER_SMTP_FROM:-alerts@kauri-app.com}#${ALERTMANAGER_SMTP_FROM:-alerts@kauri-app.com}#g" \
  -e "s#\${ALERTMANAGER_SMTP_USER:-alerts@kauri-app.com}#${ALERTMANAGER_SMTP_USER:-alerts@kauri-app.com}#g" \
  -e "s#\${ALERTMANAGER_SMTP_PASSWORD:-changeme}#${ALERTMANAGER_SMTP_PASSWORD:-changeme}#g" \
  -e "s#\${ALERTMANAGER_SLACK_WEBHOOK_URL:-https://hooks.slack.com/services/CHANGE/ME}#${ALERTMANAGER_SLACK_WEBHOOK_URL:-https://hooks.slack.com/services/CHANGE/ME}#g" \
  -e "s#\${ALERTMANAGER_EMAIL_TO:-ops@kauri-app.com}#${ALERTMANAGER_EMAIL_TO:-ops@kauri-app.com}#g" \
  -e "s#\${ALERTMANAGER_FINTECH_EMAIL:-fintech@kauri-app.com}#${ALERTMANAGER_FINTECH_EMAIL:-fintech@kauri-app.com}#g" \
  -e "s#\${ALERTMANAGER_SECURITY_EMAIL:-security@kauri-app.com}#${ALERTMANAGER_SECURITY_EMAIL:-security@kauri-app.com}#g" \
  /etc/alertmanager/alertmanager.yml.template > /etc/alertmanager/alertmanager.yml

exec /bin/alertmanager \
  --config.file=/etc/alertmanager/alertmanager.yml \
  --storage.path=/alertmanager \
  --web.external-url="http://localhost:${ALERTMANAGER_PORT:-9093}"
