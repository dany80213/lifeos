#!/bin/bash
# Re-signs and reinstalls LifeOS on the iPhone before its 7-day free-account profile expires.
#
#   refresh-device.sh                  one check: rebuild + reinstall only if it expires within 48 h
#                                      AND the phone is reachable (same network / cable) right now
#   refresh-device.sh --force          rebuild + reinstall now
#   refresh-device.sh --install-agent  schedule a check every 30 min (macOS LaunchAgent)
#   refresh-device.sh --uninstall-agent
#
# Config lives outside the repo, in ~/.config/lifeos-refresh.env:
#   DEVICE_ID=<CoreDevice id, from `xcrun devicectl list devices`>
#   TEAM_ID=<Apple developer team id>
#
# Reinstalling over the same bundle id keeps the app's data, login and notification settings.
# launchd, not cron: codesign needs the logged-in user's keychain, which cron has no access to.
set -u
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONF="$HOME/.config/lifeos-refresh.env"
STATE="$HOME/.local/state/lifeos-refresh"
LOG="$HOME/Library/Logs/lifeos-refresh.log"
LABEL="it.danieleporcaro.lifeos.refresh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BUNDLE="it.danieleporcaro.lifeos"
THRESHOLD_HOURS=48
# Background jobs cannot read ~/Documents (macOS privacy), so the agent builds from a clone kept here
# and runs the copy of this script inside it.
CLONE="$HOME/.local/share/lifeos-ios"
REPO_URL="https://github.com/dany80213/lifeos.git"

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }
notify() { osascript -e "display notification \"$1\" with title \"LifeOS\"" >/dev/null 2>&1; }

case "${1:-}" in
  --install-agent)
    mkdir -p "$(dirname "$PLIST")" "$STATE" "$(dirname "$CLONE")"
    [ -d "$CLONE/.git" ] || git clone -q "$REPO_URL" "$CLONE" || { echo "clone fallito"; exit 1; }
    RUN="$CLONE/ios/LifeOS/scripts/refresh-device.sh"
    cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$RUN</string></array>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>/tmp/lifeos-refresh.err</string>
  <key>StandardOutPath</key><string>/tmp/lifeos-refresh.out</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
</dict></plist>
PL
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
    launchctl bootstrap "gui/$(id -u)" "$PLIST" && echo "Agent installato: controllo ogni 30 minuti. Log: $LOG"
    exit 0 ;;
  --uninstall-agent)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null; rm -f "$PLIST"; echo "Agent rimosso."; exit 0 ;;
esac

[ -f "$CONF" ] || { log "manca $CONF"; exit 1; }
# shellcheck disable=SC1090
. "$CONF"
: "${DEVICE_ID:?}" "${TEAM_ID:?}"
mkdir -p "$STATE"

# One run at a time (a build can outlast the 30-minute tick).
exec 9>"$STATE/lock"; /usr/bin/lockf -t 0 9 2>/dev/null || true
[ -d "$STATE/running" ] && [ -n "$(find "$STATE/running" -mmin -60 2>/dev/null)" ] && exit 0
mkdir -p "$STATE/running"; trap 'rmdir "$STATE/running" 2>/dev/null' EXIT

now=$(date +%s)
expires=$(cat "$STATE/expires" 2>/dev/null || echo 0)
left=$(( (expires - now) / 3600 ))
if [ "${1:-}" != "--force" ] && [ "$expires" -gt 0 ] && [ "$left" -gt "$THRESHOLD_HOURS" ]; then
  exit 0   # plenty of time left: stay quiet
fi

# Reachable right now? (cable or the same Wi-Fi with network debugging on)
if ! xcrun devicectl list devices 2>/dev/null | grep "$DEVICE_ID" | grep -q "available"; then
  [ "$left" -le 12 ] && notify "Il telefono non è raggiungibile e LifeOS scade tra ${left} h: collegalo o mettilo sulla stessa rete."
  log "telefono non raggiungibile (scade tra ${left} h)"; exit 0
fi

log "rinnovo: scade tra ${left} h, rebuild e reinstallo"
# Running from the clone: take what is published before building.
case "$ROOT" in "$CLONE"/*) git -C "$CLONE" pull --ff-only -q >> "$LOG" 2>&1 || log "git pull fallito, uso la copia che ho" ;; esac
APP="$ROOT/build-device/Build/Products/Debug-iphoneos/LifeOS.app"
cd "$ROOT" || exit 1
# The Xcode project is generated (not in git), so a fresh clone has none.
[ -d LifeOS.xcodeproj ] || xcodegen generate >> "$LOG" 2>&1
# Xcode reuses a still-valid profile, which would leave the expiry exactly where it was. Drop this
# app's cached profiles so -allowProvisioningUpdates asks Apple for a fresh 7-day one.
for f in "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles/"*.mobileprovision "$HOME/Library/MobileDevice/Provisioning Profiles/"*.mobileprovision; do
  [ -f "$f" ] && security cms -D -i "$f" 2>/dev/null | grep -q "$BUNDLE" && rm -f "$f"
done
if ! xcodebuild -project LifeOS.xcodeproj -scheme LifeOS -configuration Debug -destination 'generic/platform=iOS' \
      -derivedDataPath build-device DEVELOPMENT_TEAM="$TEAM_ID" -allowProvisioningUpdates build >> "$LOG" 2>&1; then
  log "build fallita"; notify "Rinnovo di LifeOS fallito (build). Vedi $LOG"; exit 1
fi
if ! xcrun devicectl device install app --device "$DEVICE_ID" "$APP" >> "$LOG" 2>&1; then
  log "installazione fallita"; notify "Rinnovo di LifeOS fallito (installazione). Il telefono è sbloccato?"; exit 1
fi
exp=$(security cms -D -i "$APP/embedded.mobileprovision" 2>/dev/null | plutil -extract ExpirationDate raw -o - - 2>/dev/null)
exp_epoch=$(date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$exp" +%s 2>/dev/null || echo $((now + 7*86400)))
[ "$exp_epoch" -le "$expires" ] && { log "ATTENZIONE: la scadenza non si è spostata ($exp)"; notify "LifeOS reinstallato ma la scadenza non è cambiata."; }
echo "$exp_epoch" > "$STATE/expires"
log "ok: nuova scadenza $exp"
notify "LifeOS rinnovato sul telefono fino al $(date -r "$exp_epoch" '+%d/%m %H:%M')."
