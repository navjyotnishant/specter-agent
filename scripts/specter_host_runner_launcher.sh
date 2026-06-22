#!/bin/bash
# Launcher for specter-host-runner launchd service.
# Resolves the repo root from this script's location so the plist works
# regardless of where the repo is cloned. Future updates only need git pull.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LABEL="com.specter-agent.host-runner"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ "${1:-}" == "--install-service" ]]; then
    echo "Installing $LABEL..."
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$PLIST_DST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$SCRIPT_DIR/specter_host_runner_launcher.sh</string>
    </array>
    <key>StandardOutPath</key>
    <string>/tmp/specter-host-runner.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/specter-host-runner.log</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
</dict>
</plist>
PLIST
    launchctl load -w "$PLIST_DST"
    echo "Done. Host runner is now managed by launchd."
    exit 0
fi

exec /opt/homebrew/bin/python3 "$REPO_ROOT/scripts/specter_host_runner.py" "$@"
