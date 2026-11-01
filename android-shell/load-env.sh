# Sourced by build.sh and publish.sh. Loads build settings from the first of:
#   $MINT_ANDROID_ENV, ./shell.env, ~/.config/mint/android.env
# (see shell.env.example). Exports every key it defines.
_here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [ -n "${MINT_ANDROID_ENV:-}" ]; then
  [ -f "$MINT_ANDROID_ENV" ] || { echo "MINT_ANDROID_ENV is set but $MINT_ANDROID_ENV does not exist" >&2; exit 1; }
  _envfile=$MINT_ANDROID_ENV
elif [ -f "$_here/shell.env" ]; then
  _envfile=$_here/shell.env
elif [ -f "$HOME/.config/mint/android.env" ]; then
  _envfile=$HOME/.config/mint/android.env
else
  echo "No build settings found. Copy shell.env.example to shell.env (or ~/.config/mint/android.env) and fill it in." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
. "$_envfile"
set +a
echo "settings: $_envfile"
