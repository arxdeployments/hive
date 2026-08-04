#!/usr/bin/env bash
#
# Build, install and launch RxHive on a USB-connected iPhone, pointed at the API
# running on this Mac.
#
# The team id is taken from the signing certificate's **OU**, not from the name in
# brackets. `Apple Development: 917358288966 (48DA4FQ3HY)` has OU=Y7RVWF858V, and
# Y7RVWF858V is the team; 48DA4FQ3HY is the certificate's own id. Passing the
# bracketed value as DEVELOPMENT_TEAM fails with a confidently misleading
# "No Account for Team 48DA4FQ3HY. Add a new account in Accounts settings" — which
# reads as "you must sign in to Xcode" when in fact the profile was on disk and
# usable all along.
#
# No Apple ID in Xcode is needed while a valid Xcode-managed profile for this
# bundle id and this device already exists in
# ~/Library/Developer/Xcode/UserData/Provisioning Profiles. Automatic signing
# reuses it offline. `-allowProvisioningUpdates` is deliberately NOT passed: it is
# what drags the build into contacting Apple and demanding an account.
#
# Signing is left Automatic on purpose. Forcing CODE_SIGN_STYLE=Manual with a
# PROVISIONING_PROFILE_SPECIFIER fails twice over: an Xcode-managed profile is
# rejected as "Xcode managed, but signing settings require a manually managed
# profile", and a profile set on the command line applies to every target in the
# build — including the LiveKit and SwiftProtobuf SPM targets, which do not support
# provisioning profiles at all.
#
# Usage:
#   scripts/run-on-device.sh                 # auto-detect device, team and LAN IP
#   API_PORT=8000 scripts/run-on-device.sh   # a bare uvicorn instead of compose
#   API_URL=https://chat.example.com scripts/run-on-device.sh
#   LAN_IP=192.168.1.5 scripts/run-on-device.sh
#   DEVICE_ID=00008110-... scripts/run-on-device.sh
set -euo pipefail

cd "$(dirname "$0")/.."
IOS_DIR="$PWD/ios"
BUNDLE_ID="ai.rhythmrx.rxhive"
DERIVED="$IOS_DIR/build-device"

# --- device -----------------------------------------------------------------
DEVICE_ID="${DEVICE_ID:-$(xcrun xctrace list devices 2>/dev/null \
  | sed -n '/^== Devices ==/,/^== Simulators/p' \
  | grep -oE '\(0000[0-9A-F]{4}-[0-9A-F]{16}\)' | head -1 | tr -d '()')}"
if [[ -z "$DEVICE_ID" ]]; then
  echo "No USB-connected iPhone found. Plug it in, unlock it, and trust this Mac." >&2
  exit 1
fi

# --- the address the phone will use to reach this Mac ------------------------
# `localhost` would be the PHONE, not this machine, so the LAN address is the
# only value that works for a device build. Info.plist already allows plain HTTP
# to RFC1918 addresses via NSAllowsLocalNetworking.
LAN_IP="${LAN_IP:-$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)}"
if [[ -z "$LAN_IP" ]]; then
  echo "Could not determine this Mac's LAN IP. Pass it explicitly: LAN_IP=192.168.x.y $0" >&2
  exit 1
fi

# Which backend the phone talks to.
#
# Port 80 by default — the compose stack behind Caddy. That is the one to want: it is
# what the web app on http://localhost is served by, so the phone and the browser
# share a backend AND a database. Pointing the phone somewhere else is how a whole
# afternoon goes into "the phone can't log in", when the account simply lives in the
# other stack's Postgres.
#
# Override for a bare `uvicorn --port 8000` run outside compose:
#   API_PORT=8000 scripts/run-on-device.sh
# or give the whole origin, which is also how you reach a real deployment:
#   API_URL=https://chat.example.com scripts/run-on-device.sh
API_PORT="${API_PORT:-80}"
if [[ "$API_PORT" == "80" ]]; then
  API_URL="${API_URL:-http://$LAN_IP}"
else
  API_URL="${API_URL:-http://$LAN_IP:$API_PORT}"
fi

# Team = the certificate's OU. See the note at the top of this file for why the
# bracketed id in the certificate's common name is the wrong thing to use.
TEAM="${DEVELOPMENT_TEAM:-$(security find-certificate -a -c 'Apple Development' -p 2>/dev/null \
  | openssl x509 -noout -subject 2>/dev/null \
  | grep -oE 'OU ?= ?[A-Z0-9]{10}' | head -1 | grep -oE '[A-Z0-9]{10}')}"
if [[ -z "$TEAM" ]]; then
  echo "No Apple Development certificate found in the keychain." >&2
  echo "Sign in to Xcode -> Settings -> Accounts to create one." >&2
  exit 1
fi

echo "device : $DEVICE_ID"
echo "api    : $API_URL"
echo "team   : $TEAM"

# --- is the API actually reachable on that address? -------------------------
# Checked before the build, not after: a 5-minute compile that ends in a phone
# showing a spinner is a slow way to discover the backend is bound to loopback.
if ! curl -sf --max-time 5 "$API_URL/api/health" >/dev/null; then
  cat >&2 <<EOF

The API is not answering on $API_URL.

If that is the compose stack (the default, port 80):
  cd infra && docker compose up -d

If you meant a bare uvicorn, it must bind 0.0.0.0 — not localhost, or the phone
cannot see it — and you need to say so:
  cd backend && .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
  API_PORT=8000 scripts/run-on-device.sh

And the phone needs to be on the same Wi-Fi as this Mac.
EOF
  exit 1
fi
echo "api    : healthy"

# --- build ------------------------------------------------------------------
xcodebuild -project "$IOS_DIR/RxHive.xcodeproj" -scheme RxHive \
  -destination "id=$DEVICE_ID" \
  -configuration Debug \
  -derivedDataPath "$DERIVED" \
  DEVELOPMENT_TEAM="$TEAM" \
  RXHIVE_API_URL="$API_URL" \
  build

APP="$(find "$DERIVED/Build/Products" -maxdepth 2 -name 'RxHive.app' -type d | head -1)"
[[ -n "$APP" ]] || { echo "Build produced no RxHive.app" >&2; exit 1; }

# --- install + launch -------------------------------------------------------
xcrun devicectl device install app --device "$DEVICE_ID" "$APP"
xcrun devicectl device process launch --device "$DEVICE_ID" "$BUNDLE_ID"

cat <<EOF

Launched on the device.

Logs:
  xcrun devicectl device console --device $DEVICE_ID | grep -i rxhive

If calls connect but carry no audio or video, it is the SFU's advertised address:
LiveKit is configured with rtc.use_external_ip: true, so it STUNs out and tells
clients this Mac's PUBLIC IP — which a phone on the same LAN cannot reach. For
LAN testing set the LAN address explicitly in infra/livekit.yaml:

  rtc:
    node_ip: $LAN_IP
    use_external_ip: false

then: docker compose -f infra/docker-compose.yml restart livekit
EOF
