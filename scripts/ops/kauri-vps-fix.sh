#!/bin/bash
# =============================================================================
# kauri-vps-fix.sh — durcissement & remise à niveau du VPS Kauri (Debian 12)
#
# Corrige, de façon idempotente et réversible, les constats de l'audit
# pré-production d'octobre 2026. Touche UNIQUEMENT aux ressources Kauri
# (ports 15000-15020 / 16000-16014 / 9093, /var/www/kauri/api, conteneurs kauri-*)
# et aux services système nécessaires (fail2ban, logrotate).
#
# USAGE
#   sudo ./kauri-vps-fix.sh                 # SIMULATION : n'écrit rien, affiche le plan
#   sudo ./kauri-vps-fix.sh --apply         # applique les étapes réseau + fail2ban + .env
#   sudo ./kauri-vps-fix.sh --apply --restart-api      # + recrée le conteneur API (≈10 s de coupure)
#   sudo ./kauri-vps-fix.sh --apply --stop-old-mongo   # + arrête api-mongodb-1 (volume conservé)
#   sudo ./kauri-vps-fix.sh --apply --logrotate        # + rotation des logs Docker (tous conteneurs)
#
# Chaque modification est précédée d'une sauvegarde dans /root/kauri-hardening-<date>/.
# Retour arrière : voir la section ROLLBACK en bas de fichier.
# =============================================================================
set -uo pipefail

APPLY=0; RESTART_API=0; STOP_OLD_MONGO=0; LOGROTATE=0
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    --restart-api) RESTART_API=1 ;;
    --stop-old-mongo) STOP_OLD_MONGO=1 ;;
    --logrotate) LOGROTATE=1 ;;
    -h|--help) sed -n 2,20p "$0"; exit 0 ;;
    *) echo "option inconnue: $a"; exit 2 ;;
  esac
done

API_DIR="${API_DIR:-/var/www/kauri/api}"
ENV_FILE="$API_DIR/.env"
COMPOSE_FILE="$API_DIR/docker-compose.prod.yml"
EXT_IF="${EXT_IF:-eth0}"
BACKUP_DIR="/root/kauri-hardening-$(date +%Y%m%d-%H%M%S)"
ADMIN_URL_VALUE="${ADMIN_URL_VALUE:-https://admin.kauri-app.com}"

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
warn() { printf '   \033[33m! %s\033[0m\n' "$*"; }
run()  { if [ "$APPLY" = 1 ]; then "$@"; else info "[simulation] $*"; fi; }

# --------------------------------------------------------------------------- #
# .env normalisation (pure awk, testable sans serveur)                         #
#  - FIREBASE_PRIVATE_KEY multi-ligne  -> une seule ligne avec des \n littéraux #
#  - JWT_ACCESS_EXPIRATION             -> 15m                                  #
#  - JWT_REFRESH_EXPIRATION            -> 7d                                   #
#  - ADMIN_URL absent                  -> ajouté                               #
# Lit $1, écrit le résultat sur stdout.                                        #
# --------------------------------------------------------------------------- #
normalize_env() {
  awk -v admin_url="$ADMIN_URL_VALUE" '
    BEGIN { collecting = 0; have_admin = 0 }
    function emit_key(buf) { print buf }
    {
      line = $0
      sub(/\r$/, "", line)
      if (collecting) {
        buf = buf "\\n" line
        if (line ~ /"[[:space:]]*$/) { collecting = 0; emit_key(buf) }
        next
      }
      if (line ~ /^FIREBASE_PRIVATE_KEY=/) {
        # value starts with a double quote but does not close on the same line
        v = substr(line, index(line, "=") + 1)
        if (v ~ /^"/ && v !~ /^".*"[[:space:]]*$/) { collecting = 1; buf = line; next }
      }
      if (line ~ /^JWT_ACCESS_EXPIRATION=/)  { print "JWT_ACCESS_EXPIRATION=15m";  next }
      if (line ~ /^JWT_REFRESH_EXPIRATION=/) { print "JWT_REFRESH_EXPIRATION=7d"; next }
      if (line ~ /^ADMIN_URL=/) have_admin = 1
      print line
    }
    END {
      if (collecting) emit_key(buf)       # unterminated: keep what we read
      if (!have_admin) print "ADMIN_URL=" admin_url
    }
  ' "$1"
}

env_has_key() { grep -qE "^$2=" "$1"; }

if [ "${KAURI_FIX_SOURCE_ONLY:-0}" = 1 ]; then return 0 2>/dev/null || exit 0; fi

[ "$(id -u)" = 0 ] || { echo "à lancer en root"; exit 1; }
[ "$APPLY" = 1 ] && echo "MODE : APPLICATION" || echo "MODE : SIMULATION (ajoutez --apply pour appliquer)"
run mkdir -p "$BACKUP_DIR"

# --------------------------------------------------------------------------- #
say "0. Sauvegarde de l'état actuel -> $BACKUP_DIR"
run bash -c "iptables-save > '$BACKUP_DIR/iptables.before' 2>/dev/null; cp -a '$ENV_FILE' '$BACKUP_DIR/env.api.before'; chmod 600 '$BACKUP_DIR/env.api.before'; cp -a '$COMPOSE_FILE' '$BACKUP_DIR/compose.prod.before'; cp -a /etc/apache2/sites-enabled/*kauri* '$BACKUP_DIR/' 2>/dev/null; true"

# --------------------------------------------------------------------------- #
say "1. Pare-feu : bloquer depuis Internet les ports Docker publiés de Kauri"
info "Cause du constat : les règles 'INPUT --dport 15001/15002 DROP' bloquaient l'hôte lui-même"
info "(Apache -> MinIO => storage.kauri-app.com HS) sans protéger de l'extérieur."
FW_SCRIPT=/usr/local/sbin/kauri-docker-firewall.sh
FW_UNIT=/etc/systemd/system/kauri-docker-firewall.service
if [ "$APPLY" = 1 ]; then
  cat > "$FW_SCRIPT" <<'FWEOF'
#!/bin/bash
# Kauri: block the Docker-published ports of the Kauri stacks from the Internet.
# Match on the ORIGINAL destination port (conntrack): Docker DNATs published ports, so
# ufw / INPUT rules never see them and --dport in DOCKER-USER sees the container port.
# Apache on the host reaches services via localhost -> docker-proxy (not forwarded): unaffected.
set -u
EXT_IF="${EXT_IF:-eth0}"
RANGES=("15000:15020" "16000:16014" "9093")
for r in "${RANGES[@]}"; do
  for proto in tcp udp; do
    rule=(-i "$EXT_IF" -p "$proto" -m conntrack --ctstate DNAT --ctorigdstport "$r" -j DROP)
    iptables -C DOCKER-USER "${rule[@]}" 2>/dev/null || iptables -I DOCKER-USER 1 "${rule[@]}"
  done
done
for p in 15001 15002; do
  while iptables -D INPUT -p tcp -m tcp --dport "$p" -j DROP 2>/dev/null; do :; done
  while iptables -D DOCKER-USER -p tcp -m tcp --dport "$p" -j DROP 2>/dev/null; do :; done
done
exit 0
FWEOF
  chmod 750 "$FW_SCRIPT"
  sed -i "s/^EXT_IF=.*/EXT_IF=\"\${EXT_IF:-$EXT_IF}\"/" "$FW_SCRIPT"
  cat > "$FW_UNIT" <<'UNITEOF'
[Unit]
Description=Kauri - block Docker-published ports from the Internet
After=docker.service network-online.target
Wants=network-online.target
PartOf=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/kauri-docker-firewall.sh

[Install]
WantedBy=multi-user.target
UNITEOF
  systemctl daemon-reload
  systemctl enable kauri-docker-firewall.service >/dev/null 2>&1
  systemctl restart kauri-docker-firewall.service
  systemctl is-active kauri-docker-firewall.service
else
  info "[simulation] écrire $FW_SCRIPT + $FW_UNIT, activer le service (persistant au reboot)"
fi

info "Vérification locale (Apache -> MinIO doit répondre 200 après correction) :"
curl -s -m 6 -o /dev/null -w "   http://127.0.0.1:15002/minio/health/live -> %{http_code}\n" http://127.0.0.1:15002/minio/health/live || true

# --------------------------------------------------------------------------- #
say "2. fail2ban (arrêté depuis le 04/08 : jail sshd sans /var/log/auth.log)"
JAIL=/etc/fail2ban/jail.local
if [ "$APPLY" = 1 ]; then
  [ -f "$JAIL" ] && cp -a "$JAIL" "$BACKUP_DIR/jail.local.before"
  cat > "$JAIL" <<'JEOF'
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
ignoreip = 127.0.0.1/8 ::1

[sshd]
enabled = true
backend = systemd
port    = ssh
JEOF
  systemctl reset-failed fail2ban 2>/dev/null
  systemctl enable fail2ban >/dev/null 2>&1
  systemctl restart fail2ban
  sleep 2
  systemctl is-active fail2ban
  fail2ban-client status sshd 2>&1 | sed 's/^/   /' | head -6
else
  info "[simulation] écrire $JAIL (backend=systemd) et redémarrer fail2ban"
fi

# --------------------------------------------------------------------------- #
say "3. .env de production : JWT, ADMIN_URL, clé Firebase multi-ligne"
TMP_ENV="$(mktemp)"
normalize_env "$ENV_FILE" > "$TMP_ENV"
info "Changements prévus (valeurs sensibles masquées) :"
diff <(sed -E 's/^([A-Z_]+)=.*/\1=…/' "$ENV_FILE") <(sed -E 's/^([A-Z_]+)=.*/\1=…/' "$TMP_ENV") | sed 's/^/   /' || true
for k in JWT_ACCESS_EXPIRATION JWT_REFRESH_EXPIRATION; do
  info "$k : $(grep -E "^$k=" "$ENV_FILE" | head -1) -> $(grep -E "^$k=" "$TMP_ENV" | head -1)"
done
if ! env_has_key "$TMP_ENV" MOBILE_CLIENT_API_KEY; then
  NEWKEY="$(openssl rand -hex 32)"
  echo "MOBILE_CLIENT_API_KEY=$NEWKEY" >> "$TMP_ENV"
  if [ "$APPLY" = 1 ]; then ( umask 077; echo "$NEWKEY" > "$BACKUP_DIR/new-mobile-key.txt" ); fi
  warn "MOBILE_CLIENT_API_KEY généré (valeur dans $BACKUP_DIR/new-mobile-key.txt) — à reporter dans Codemagic : LOGS_CLIENT_KEY"
fi
for k in STRIPE_WEBHOOK_SECRET NOTCHPAY_WEBHOOK_SECRET; do
  env_has_key "$TMP_ENV" "$k" || warn "$k ABSENT : à copier depuis le tableau de bord Stripe/NotchPay (non inventable). Sans lui, les webhooks de paiement sont rejetés."
done
if [ "$APPLY" = 1 ]; then
  install -m 600 "$TMP_ENV" "$ENV_FILE"
  info ".env mis à jour (sauvegarde : $BACKUP_DIR/env.api.before)"
fi
rm -f "$TMP_ENV"

# --------------------------------------------------------------------------- #
if [ "$RESTART_API" = 1 ]; then
  say "4. Recréation du conteneur API (prise en compte du .env)"
  if [ "$APPLY" = 1 ]; then
    ( cd "$API_DIR" && docker compose -f docker-compose.prod.yml up -d --no-deps api )
    ok=0
    for i in $(seq 1 30); do
      code=$(curl -s -m 4 -o /dev/null -w '%{http_code}' http://127.0.0.1:15000/api/health || true)
      [ "$code" = 200 ] && { ok=1; break; }
      sleep 2
    done
    if [ "$ok" = 1 ]; then info "API healthy (200)"; else
      warn "API NON saine : retour arrière automatique du .env"
      install -m 600 "$BACKUP_DIR/env.api.before" "$ENV_FILE"
      ( cd "$API_DIR" && docker compose -f docker-compose.prod.yml up -d --no-deps api )
      exit 1
    fi
  else
    info "[simulation] docker compose -f docker-compose.prod.yml up -d --no-deps api + attente /api/health"
  fi
else
  say "4. Recréation de l'API : ignorée (ajouter --restart-api). Le .env n'est lu qu'au prochain recreate."
fi

# --------------------------------------------------------------------------- #
say "5. Ancien MongoDB 'api-mongodb-1' (projet compose 'api', plus utilisé ?)"
PROD_DB_IP=$(docker exec kauri-prod-api-1 getent hosts mongodb 2>/dev/null | awk '{print $1}')
NEW_DB_IP=$(docker inspect kauri-prod-mongodb-1 --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' 2>/dev/null | awk '{print $1}')
OLD_DB_IP=$(docker inspect api-mongodb-1 --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' 2>/dev/null | awk '{print $1}')
info "hôte 'mongodb' vu par l'API prod : ${PROD_DB_IP:-?} | kauri-prod-mongodb-1 : ${NEW_DB_IP:-?} | api-mongodb-1 : ${OLD_DB_IP:-?}"
if [ -n "$PROD_DB_IP" ] && [ "$PROD_DB_IP" = "$NEW_DB_IP" ] && [ "$PROD_DB_IP" != "$OLD_DB_IP" ]; then
  info "L'API prod n'utilise PAS api-mongodb-1 (arrêt sûr ; volume 'api_mongodb_data' conservé)."
  if [ "$STOP_OLD_MONGO" = 1 ]; then run docker stop api-mongodb-1; else info "ignoré (ajouter --stop-old-mongo)"; fi
else
  warn "Impossible de prouver que api-mongodb-1 est inutilisé : AUCUN arrêt effectué."
fi

# --------------------------------------------------------------------------- #
if [ "$LOGROTATE" = 1 ]; then
  say "6. Rotation des logs Docker (copytruncate, sans redémarrer le démon)"
  if [ "$APPLY" = 1 ]; then
    cat > /etc/logrotate.d/docker-containers <<'LREOF'
/var/lib/docker/containers/*/*-json.log {
    daily
    rotate 7
    maxsize 100M
    missingok
    notifempty
    compress
    delaycompress
    copytruncate
}
LREOF
    info "écrit /etc/logrotate.d/docker-containers"
  else
    info "[simulation] écrire /etc/logrotate.d/docker-containers"
  fi
fi

say "Terminé. Vérifications externes recommandées (depuis un autre poste) :"
info "ports 15000-15012, 15020, 16000-16014, 9093 -> doivent être fermés/filtrés"
info "https://storage.kauri-app.com/minio/health/live -> 200 ; https://api.kauri-app.com/api/health -> 200"

# ROLLBACK
#   iptables : systemctl disable --now kauri-docker-firewall ; iptables -F DOCKER-USER (règles ajoutées uniquement)
#   .env     : install -m 600 /root/kauri-hardening-<date>/env.api.before /var/www/kauri/api/.env
#   fail2ban : rm /etc/fail2ban/jail.local && systemctl restart fail2ban
#   mongo    : docker start api-mongodb-1
