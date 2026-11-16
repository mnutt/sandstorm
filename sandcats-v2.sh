# Bash/OpenSSL client for the Sandhost v1 protocol. No Node or jq required.
# Embedded in install.sh and recover-sandcats.sh to keep both scripts self-contained.
# After editing, run tests/sync-sandcats-installer.py and the protocol tests.

sandhost_base64url() {
  openssl base64 -A | tr '+/' '-_' | tr -d '='
}

sandhost_urlencode() {
  local LC_ALL=C value="$1" i char
  for ((i=0; i<${#value}; i++)); do
    char="${value:i:1}"
    case "$char" in
      [a-zA-Z0-9.~_-]) printf '%s' "$char" ;;
      *) printf '%%%02X' "'$char" ;;
    esac
  done
}

sandhost_validate_address() {
  case "${SANDCATS_ADDRESS_MODE:-observed}" in
    observed) [ -z "${SANDCATS_IP_ADDRESS:-}" ] ;;
    explicit)
      local a b c d
      [[ ${SANDCATS_IP_ADDRESS:-} =~ ^100\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
      IFS=. read -r a b c d <<< "$SANDCATS_IP_ADDRESS"
      [[ "$b" != 0* && "$c" != 0[0-9]* && "$d" != 0[0-9]* ]] || return 1
      ((b >= 64 && b <= 127 && c <= 255 && d <= 255)) ;;
    *) return 1 ;;
  esac
}

sandhost_validate_webkey() {
  # Accept the exported webkey, not a grain UI URL.
  local webkey
  [ -f "$SANDHOST_DIR/api-webkey" ] && [ ! -L "$SANDHOST_DIR/api-webkey" ] || return 1
  [ "$(stat -c %s "$SANDHOST_DIR/api-webkey")" -le 8192 ] || return 1
  webkey=$(cat "$SANDHOST_DIR/api-webkey")
  [[ "$webkey" =~ ^https://([a-zA-Z0-9][a-zA-Z0-9.-]*)(:([0-9]+))?/?#([a-zA-Z0-9_-]+)$ ]] || return 1
  SANDHOST_ORIGIN="https://${BASH_REMATCH[1],,}"
  if [ -n "${BASH_REMATCH[3]}" ] && [ "${BASH_REMATCH[3]}" != 443 ]; then
    SANDHOST_ORIGIN+=":${BASH_REMATCH[3]}"
  fi
  SANDHOST_TOKEN="${BASH_REMATCH[4]}"
}

sandhost_request() (
  set +x
  set -euo pipefail
  umask 077
  local path="$1" key="$2"
  shift 2
  sandhost_validate_webkey || { echo 'Invalid Sandcats API webkey file.' >&2; exit 1; }
  local work body timestamp nonce digest signature status name value
  work=$(mktemp -d "$SANDHOST_DIR/request.XXXXXXXX") || exit 1
  chmod 700 "$work"
  trap 'rm -rf "$work"' EXIT
  trap 'exit 1' HUP INT TERM
  body="$work/body"
  : > "$body"
  chmod 600 "$body"
  while [ "$#" -gt 0 ]; do
    name="$1"; value="$2"; shift 2
    [ ! -s "$body" ] || printf '&' >> "$body"
    sandhost_urlencode "$name" >> "$body"
    printf '=' >> "$body"
    sandhost_urlencode "$value" >> "$body"
  done
  {
    printf 'Authorization: Bearer %s\n' "$SANDHOST_TOKEN"
    printf '%s\n' 'X-Sandstorm-Passthrough: address' 'X-Sandstorm-App-Sandhost: cats'
    printf '%s\n' 'Content-Type: application/x-www-form-urlencoded' 'Accept: application/json'
  } > "$work/headers"
  chmod 600 "$work/headers"
  if [ -n "$key" ]; then
    timestamp=$(date +%s%3N) || exit 1
    nonce=$(openssl rand 24 | sandhost_base64url) || exit 1
    digest=$(openssl dgst -sha256 -binary "$body" | sandhost_base64url) || exit 1
    signature=$(printf 'sandhost-v1\n%s\nPOST\n%s\n%s\n%s\n%s' \
      "$SANDHOST_ORIGIN" "$path" "$timestamp" "$nonce" "$digest" |
      openssl dgst -sha256 -sign "$key" | sandhost_base64url) || exit 1
    printf 'X-Sandstorm-App-Sandhost-Timestamp: %s\nX-Sandstorm-App-Sandhost-Nonce: %s\nX-Sandstorm-App-Sandhost-Signature: %s\n' \
      "$timestamp" "$nonce" "$signature" >> "$work/headers"
  fi
  local bind=()
  case "${BIND_IP:-}" in
    ''|127.*|0.0.0.0|::1) ;;
    *) bind=(--interface "$BIND_IP") ;;
  esac
  # No redirects, curlrc, raw response logging, or credentials in argv. IPv4 on every request.
  # Use curl's config format for compatibility with versions predating --header @file.
  sed 's/^/header = "/; s/$/"/' "$work/headers" > "$work/curl-config"
  if ! status=$(curl -q --config "$work/curl-config" --silent --max-time 20 --max-filesize 65536 \
      --proto '=https' --ipv4 "${bind[@]}" --request POST --data-binary "@$body" \
      --output "$work/response" --write-out '%{http_code}' "$SANDHOST_ORIGIN$path"); then
    echo 'Sandcats API connection failed. Check the endpoint and connectivity.' >&2
    exit 1
  fi
  case "$status" in
    200|201|202) ;;
    *) echo "Sandcats API request failed (HTTP $status)." >&2; exit 1 ;;
  esac
  if [ -n "${SANDCATS_BASE_DOMAIN:-}" ] && [ "$path" != /recover ]; then
    local hostname
    hostname=$(sed -n 's/.*"hostname"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$work/response")
    if [ "$hostname" != "$DESIRED_SANDCATS_NAME.$SANDCATS_BASE_DOMAIN" ]; then
      echo 'Sandcats API returned a different hostname; check SANDCATS_BASE_DOMAIN and the webkey.' >&2
      exit 1
    fi
  fi
)

sandhost_register() {
  local key="$SANDHOST_DIR/id_rsa" public_key
  sandhost_validate_address || { echo 'Invalid Sandcats address configuration.' >&2; return 1; }
  public_key=$(openssl pkey -in "$key" -pubout -outform DER | sandhost_base64url) || return 1
  local address=()
  [ "${SANDCATS_ADDRESS_MODE:-observed}" != explicit ] || address=(ipAddress "$SANDCATS_IP_ADDRESS")
  sandhost_request /register "$key" rawHostname "$DESIRED_SANDCATS_NAME" \
    publicKey "$public_key" email "$SANDCATS_REGISTRATION_EMAIL" \
    addressMode "${SANDCATS_ADDRESS_MODE:-observed}" "${address[@]}"
}

sandhost_confirm_recovery() (
  set +x
  set -euo pipefail
  # Keep the old active key until the server accepts the replacement. Retain the candidate
  # on failure, including ambiguous network failures, so ownership can always be recovered.
  local candidate="$SANDHOST_DIR/id_rsa.recovery" public_key token
  if [ ! -e "$candidate" ]; then
    (umask 077; openssl genrsa -out "$candidate" 4096 2>/dev/null) || exit 1
    if [ -e "$SANDHOST_DIR/id_rsa" ]; then
      chown --reference="$SANDHOST_DIR/id_rsa" "$candidate" || exit 1
    fi
  fi
  public_key=$(openssl pkey -in "$candidate" -pubout -outform DER | sandhost_base64url) || exit 1
  token=$(cat "$1") || exit 1
  sandhost_request /recover/confirm "$candidate" rawHostname "$DESIRED_SANDCATS_NAME" \
    publicKey "$public_key" token "$token" || exit 1
  if [ -e "$SANDHOST_DIR/id_rsa" ]; then
    cp -p "$SANDHOST_DIR/id_rsa" "$SANDHOST_DIR/id_rsa.before-recovery" || exit 1
  fi
  mv -f "$candidate" "$SANDHOST_DIR/id_rsa"
)
