#!/bin/bash
#
# This script recovers access to a sandcats.io subdomain by generating
# new keys and using the email-based recovery flow.
#
# Usage: ./recover-sandcats.sh [sandstorm-dir]
#
# If sandstorm-dir is not provided, defaults to /opt/sandstorm

set -euo pipefail

SANDSTORM_DIR="${1:-/opt/sandstorm}"
# Parse values as data, never source sandstorm.conf as shell code.
read_setting() {
  [ -f "$SANDSTORM_DIR/sandstorm.conf" ] || return 0
  awk -F= -v key="$1" '$1 ~ "^[[:space:]]*" key "[[:space:]]*$" {
    sub(/^[^=]*=/, ""); gsub(/^[[:space:]]+|[[:space:]]+$/, ""); print; exit
  }' "$SANDSTORM_DIR/sandstorm.conf"
}
SANDCATS_BACKEND="${SANDCATS_BACKEND:-$(read_setting SANDCATS_BACKEND)}"
SANDCATS_BACKEND="${SANDCATS_BACKEND:-legacy}"
SANDCATS_BASE_DOMAIN="${SANDCATS_BASE_DOMAIN:-$(read_setting SANDCATS_BASE_DOMAIN)}"
if [ "$SANDCATS_BACKEND" = sandhost ]; then
  SANDCATS_BASE_DOMAIN="${SANDCATS_BASE_DOMAIN:-sandcats.org}"
else
  SANDCATS_BASE_DOMAIN="${SANDCATS_BASE_DOMAIN:-sandcats.io}"
fi
BIND_IP="${BIND_IP:-$(read_setting BIND_IP)}"
SANDCATS_API_BASE="${SANDCATS_API_BASE:-https://sandcats.io}"
CURL_USER_AGENT="${CURL_USER_AGENT:-sandstorm-recover-script}"

error() {
  if [ $# != 0 ]; then
    echo -en '\e[0;31m' >&2
    echo "$@" | (fold -s || cat) >&2
    echo -en '\e[0m' >&2
  fi
}

fail() {
  local error_code="$1"
  shift
  echo "*** RECOVERY FAILED ***" >&2
  echo ""
  error "$@"
  echo "" >&2
  exit 1
}

prompt() {
  local VALUE
  echo -en '\e[1m' >&3
  echo -n "$1 [$2]" >&3
  echo -en '\e[0m ' >&3
  read -u 3 VALUE
  if [ -z "$VALUE" ]; then
    VALUE=$2
  fi
  echo "$VALUE"
}

prompt-yesno() {
  while true; do
    local VALUE=$(prompt "$@")
    case $VALUE in
      y | Y | yes | YES | Yes )
        return 0
        ;;
      n | N | no | NO | No )
        return 1
        ;;
    esac
    echo "*** Please answer \"yes\" or \"no\"."
  done
}

dotdotdot_curl() {
  echo -n '...' >&2
  curl "$@"
  echo -ne '\r' >&2
}

sandcats_generate_keys() {
  local SANDCATS_DIR="$SANDSTORM_DIR/var/sandcats"

  if [ -f "$SANDCATS_DIR/id_rsa.private_combined" ]; then
    echo "Existing keys found in $SANDCATS_DIR"
    if ! prompt-yesno "Generate new keys? (required for recovery)" "yes"; then
      fail "E_NEED_NEW_KEYS" "Recovery requires generating new keys."
    fi
    # Back up existing keys
    local BACKUP_DIR="$SANDCATS_DIR/backup.$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$BACKUP_DIR"
    mv "$SANDCATS_DIR/id_rsa" "$BACKUP_DIR/" 2>/dev/null || true
    mv "$SANDCATS_DIR/id_rsa.pub" "$BACKUP_DIR/" 2>/dev/null || true
    mv "$SANDCATS_DIR/id_rsa.private_combined" "$BACKUP_DIR/" 2>/dev/null || true
    echo "Backed up existing keys to $BACKUP_DIR"
  fi

  echo -n 'Generating new keys...'

  mkdir -p -m 0700 "$SANDCATS_DIR"
  chmod 0700 "$SANDCATS_DIR"

  openssl \
    req \
    -new \
    -newkey rsa:4096 \
    -days 3650 \
    -nodes \
    -x509 \
    -subj "/C=AU/ST=Some-State/O=Internet Widgits Pty Ltd" \
    -keyout "$SANDCATS_DIR/id_rsa" \
    -out "$SANDCATS_DIR/id_rsa.pub" \
    2>/dev/null

  cat "$SANDCATS_DIR/id_rsa" "$SANDCATS_DIR/id_rsa.pub" > "$SANDCATS_DIR/id_rsa.private_combined"

  chmod 0640 "$SANDCATS_DIR/id_rsa" "$SANDCATS_DIR/id_rsa.pub" "$SANDCATS_DIR/id_rsa.private_combined"

  echo " done."
}

sandcats_recover_domain() {
  local SANDCATS_DIR="$SANDSTORM_DIR/var/sandcats"

  DESIRED_SANDCATS_NAME=$(prompt "What Sandcats subdomain do you want to recover?" "")

  if [ -z "$DESIRED_SANDCATS_NAME" ]; then
    fail "E_NO_SUBDOMAIN" "You must provide a subdomain to recover."
  fi

  # Strip the base domain if provided
  if [[ $DESIRED_SANDCATS_NAME =~ [.] ]]; then
    echo ""
    echo "You entered: $DESIRED_SANDCATS_NAME"
    echo ""
    echo "Please enter just the subdomain part, without any dots."
    echo "For example, if your domain is 'myserver.sandcats.io', just enter 'myserver'."
    echo ""
    sandcats_recover_domain
    return
  fi

  echo "OK. We will send a recovery token to the email address on file."
  if ! prompt-yesno "OK to continue?" "yes"; then
    echo "Aborted."
    exit 0
  fi

  # Send recovery token request
  local LOG_PATH="$SANDCATS_DIR/sendrecoverytoken-log"
  mkdir -p "$SANDCATS_DIR"
  touch "$LOG_PATH"
  chmod 0640 "$LOG_PATH"

  echo "Requesting recovery token..."
  HTTP_STATUS=$(
    dotdotdot_curl \
      --silent \
      --max-time 20 \
      -A "$CURL_USER_AGENT" \
      -X POST \
      --data-urlencode "rawHostname=$DESIRED_SANDCATS_NAME" \
      --output "$LOG_PATH" \
      -w '%{http_code}' \
      -H 'X-Sand: cats' \
      -H "Accept: text/plain" \
      "${SANDCATS_API_BASE}/sendrecoverytoken")

  if [ "200" != "$HTTP_STATUS" ]; then
    error "$(cat "$LOG_PATH")"
    fail "E_SEND_TOKEN_FAILED" "Failed to request recovery token."
  fi

  cat "$LOG_PATH"
  echo ''

  TOKEN=$(prompt "Please enter the token that we sent to you by email." '')

  if [ -z "$TOKEN" ]; then
    fail "E_EMPTY_TOKEN" "Empty tokens are not valid."
  fi

  # Submit recovery token
  LOG_PATH="$SANDCATS_DIR/recover-log"
  touch "$LOG_PATH"
  chmod 0640 "$LOG_PATH"

  echo "Submitting recovery token..."
  HTTP_STATUS=$(
    dotdotdot_curl \
      --silent \
      --max-time 20 \
      -A "$CURL_USER_AGENT" \
      -X POST \
      --data-urlencode "rawHostname=$DESIRED_SANDCATS_NAME" \
      --data-urlencode "recoveryToken=$TOKEN" \
      --output "$LOG_PATH" \
      -w '%{http_code}' \
      -H 'X-Sand: cats' \
      -H "Accept: text/plain" \
      --cert "$SANDCATS_DIR/id_rsa.private_combined" \
      "${SANDCATS_API_BASE}/recover")

  if [ "200" != "$HTTP_STATUS" ]; then
    error "$(cat "$LOG_PATH")"
    fail "E_RECOVER_FAILED" "Failed to recover domain."
  fi

  cat "$LOG_PATH"
  echo ''

  # Update DNS
  LOG_PATH="$SANDCATS_DIR/update-log"
  touch "$LOG_PATH"
  chmod 0640 "$LOG_PATH"

  echo "Updating DNS..."
  HTTP_STATUS=$(
    dotdotdot_curl \
      --silent \
      --max-time 20 \
      -A "$CURL_USER_AGENT" \
      -X POST \
      --data-urlencode "rawHostname=$DESIRED_SANDCATS_NAME" \
      --output "$LOG_PATH" \
      -w '%{http_code}' \
      -H 'X-Sand: cats' \
      -H "Accept: text/plain" \
      --cert "$SANDCATS_DIR/id_rsa.private_combined" \
      "${SANDCATS_API_BASE}/update")

  if [ "200" != "$HTTP_STATUS" ]; then
    error "$(cat "$LOG_PATH")"
    fail "E_UPDATE_FAILED" "Failed to update DNS."
  fi

  cat "$LOG_PATH"
  echo ''

  echo ""
  echo "Congratulations! You have recovered ${DESIRED_SANDCATS_NAME}.${SANDCATS_BASE_DOMAIN}."
  echo "Your credentials are in $SANDCATS_DIR; consider making a backup."
  echo ""
  echo "You may need to restart Sandstorm and/or renew your TLS certificate:"
  echo "  sudo sandstorm restart"
  echo "  sudo sandstorm renew-certificate"
}

sandhost_recover_interactive() {
  set +x
  SANDHOST_BUNDLE=$(cd -- "$(dirname -- "$0")" && pwd)
  [ -f "$SANDHOST_BUNDLE/sandcats-setup.sh" ] ||
    fail E_HELPER 'Run recover-sandcats.sh from an installed bundle with Sandhost setup support.'
  SANDHOST_DIR="$SANDSTORM_DIR/var/sandcats"
  sandhost_client validate-webkey || fail E_WEBKEY 'A valid var/sandcats/api-webkey file is required.'
  DESIRED_SANDCATS_NAME=$(prompt "Name to recover under $SANDCATS_BASE_DOMAIN (without dots):" '')
  [[ "$DESIRED_SANDCATS_NAME" =~ ^[a-z0-9]([a-z0-9-]{0,18}[a-z0-9])?$ ]] ||
    fail E_NAME 'Invalid Sandcats name.'
  sandhost_client request-recovery ||
    fail E_RECOVER 'Could not request recovery email.'
  echo 'Recovery token from your email (input hidden):' >&3
  local token token_file
  IFS= read -r -s -u 3 token
  echo >&3
  token_file=$(mktemp "$SANDHOST_DIR/recovery-token.XXXXXXXX")
  printf '%s' "$token" > "$token_file"
  unset token
  if ! sandhost_client confirm-recovery "$token_file"; then
    rm -f "$token_file"
    fail E_RECOVER 'Recovery failed. The active key is unchanged; id_rsa.recovery is retained for retry.'
  fi
  rm -f "$token_file"
  echo "Recovered $DESIRED_SANDCATS_NAME.$SANDCATS_BASE_DOMAIN. Restart Sandstorm to load the new key and update DNS."
}

# Settings come from the installer or recovery script, never from a config file in the helper.
sandhost_client() {
  SANDHOST_DIR="$SANDHOST_DIR" \
  SANDCATS_BASE_DOMAIN="$SANDCATS_BASE_DOMAIN" \
  DESIRED_SANDCATS_NAME="${DESIRED_SANDCATS_NAME:-}" \
  SANDCATS_REGISTRATION_EMAIL="${SANDCATS_REGISTRATION_EMAIL:-}" \
  SANDCATS_ADDRESS_MODE="${SANDCATS_ADDRESS_MODE:-observed}" \
  SANDCATS_IP_ADDRESS="${SANDCATS_IP_ADDRESS:-}" BIND_IP="${BIND_IP:-}" \
    bash "$SANDHOST_BUNDLE/sandcats-setup.sh" "$@"
}


main() {
  if [ ! -t 1 ]; then
    fail "E_NO_TTY" "This script is interactive. Please run it on a terminal."
  fi

  # Set up FD 3 for interactive input
  exec 3<&1

  if [ ! -d "$SANDSTORM_DIR" ]; then
    fail "E_NO_DIR" "Sandstorm directory not found: $SANDSTORM_DIR"
  fi

  if [ "$SANDCATS_BACKEND" = sandhost ]; then
    sandhost_recover_interactive
    return
  elif [ "$SANDCATS_BACKEND" != legacy ]; then
    fail E_BACKEND 'SANDCATS_BACKEND must be legacy or sandhost.'
  fi

  echo "Sandcats.io Domain Recovery"
  echo "============================"
  echo ""
  echo "This script will help you recover access to a sandcats.io subdomain"
  echo "that you previously registered. You will need access to the email"
  echo "address you used when you registered the domain."
  echo ""

  sandcats_generate_keys
  sandcats_recover_domain
}

main "$@"
