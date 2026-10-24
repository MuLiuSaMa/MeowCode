#!/usr/bin/env bash
# pages-deploy: New user onboarding utilities
# Commands: open-browser, save-credentials, subscribe-cdn

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
    cat <<EOF
Usage: bash onboard.sh <command> [args...]

Commands:
  open-browser <url>                    Open URL in user's default browser
  save-credentials <access_key> <secret_key>   Configure nest CLI with AK/SK
  subscribe-cdn <access_key> <secret_key>      Activate BytePlus CDN service via OpenAPI
EOF
    exit 0
}

[[ $# -eq 0 ]] && usage

CMD="$1"; shift

# ========== open-browser ==========
open_browser() {
    local url="$1"
    echo "[INFO] Opening: $url"

    if [[ "$(uname)" == "Darwin" ]]; then
        open "$url" 2>/dev/null && echo "[OK] Opened in browser" && return
    elif command -v xdg-open &>/dev/null; then
        xdg-open "$url" 2>/dev/null && echo "[OK] Opened in browser" && return
    elif command -v wslview &>/dev/null; then
        wslview "$url" 2>/dev/null && echo "[OK] Opened in browser" && return
    fi

    # Fallback: no browser available (e.g., remote/Cowork environment)
    echo "[WARN] Could not open browser automatically."
    echo "[INFO] Please open this URL manually:"
    echo ""
    echo "  $url"
    echo ""
}

# ========== save-credentials ==========
save_credentials() {
    local ak="$1"
    local sk="$2"

    echo "[INFO] Configuring nest CLI credentials..."

    # Find or install nest CLI
    local nest=""
    if command -v nest &>/dev/null; then
        nest="nest"
    elif [[ -x "$HOME/.nest-cli/node_modules/.bin/nest" ]]; then
        nest="$HOME/.nest-cli/node_modules/.bin/nest"
    elif [[ -x "/home/gem/tmp/nest-cli/node_modules/.bin/nest" ]]; then
        nest="/home/gem/tmp/nest-cli/node_modules/.bin/nest"
    else
        echo "[INFO] Installing @byteplus/nest CLI first..."
        local install_dir="$HOME/.nest-cli"
        npm install @byteplus/nest --prefix "$install_dir" 2>/dev/null
        nest="$install_dir/node_modules/.bin/nest"
    fi

    $nest config set -g cloud.access_key "$ak"
    $nest config set -g cloud.secret_key "$sk"

    # Verify
    if $nest pages list &>/dev/null 2>&1; then
        echo "[OK] Credentials configured and verified successfully"
    else
        echo "[OK] Credentials saved (CDN service may not be activated yet)"
    fi
}

# ========== subscribe-cdn ==========
subscribe_cdn() {
    local ak="$1"
    local sk="$2"

    echo "[INFO] Activating BytePlus CDN service..."
    echo "[INFO] Region: overseas, PayType: pay-as-you-go"

    python3 "$SCRIPT_DIR/subscribe_cdn.py" "$ak" "$sk"
    local exit_code=$?

    if [[ $exit_code -eq 0 ]]; then
        echo "[OK] BytePlus CDN service activated successfully!"
        echo "[INFO] Pages platform is now ready for deployment."
    else
        echo "[ERROR] Failed to activate CDN service."
        echo "[INFO] Please try manually at: https://console.byteplus.com/cdn"
        exit 1
    fi
}

# ========== Main dispatch ==========
case "$CMD" in
    open-browser)
        [[ $# -lt 1 ]] && { echo "Error: URL required"; exit 1; }
        open_browser "$1"
        ;;
    save-credentials)
        [[ $# -lt 2 ]] && { echo "Error: access_key and secret_key required"; exit 1; }
        save_credentials "$1" "$2"
        ;;
    subscribe-cdn)
        [[ $# -lt 2 ]] && { echo "Error: access_key and secret_key required"; exit 1; }
        subscribe_cdn "$1" "$2"
        ;;
    -h|--help)
        usage
        ;;
    *)
        echo "Unknown command: $CMD"
        usage
        ;;
esac
