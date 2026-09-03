#!/bin/bash
# Create the Google Play upload key for Capture & Cook.
#
# Run this once. It generates the keystore, then writes the credentials to
# android/keystore.properties so Gradle can sign release builds.
#
#   bash scripts/make-keystore.sh
#
# TWO THINGS TO KNOW BEFORE YOU RUN IT
#
#   1. Save the password in your password manager immediately. If you lose the
#      keystore or the password, you cannot sign an update with the same key.
#      Google can reset an upload key through support, but it is a slow process
#      and worth avoiding entirely.
#
#   2. Back up the .jks file somewhere outside this Mac. It is deliberately
#      gitignored, so it is not in the repository and not on GitHub.

set -e

KEYSTORE="$HOME/capture-and-cook-upload.jks"
ALIAS="upload"
PROPS="$(cd "$(dirname "$0")/.." && pwd)/android/keystore.properties"

if [ -f "$KEYSTORE" ]; then
  echo "A keystore already exists at:"
  echo "  $KEYSTORE"
  echo "Refusing to overwrite it — that would make it impossible to update an"
  echo "app already published with the old key. Delete it deliberately if you"
  echo "are certain it was never used."
  exit 1
fi

export JAVA_HOME=/usr/local/opt/openjdk@21
KEYTOOL="$JAVA_HOME/bin/keytool"

echo "Creating the upload key."
echo "You will be asked for a password — choose one and save it now."
echo

read -r -s -p "Keystore password: " PW1; echo
read -r -s -p "Confirm password:  " PW2; echo
if [ "$PW1" != "$PW2" ]; then echo "Passwords did not match."; exit 1; fi
if [ ${#PW1} -lt 6 ]; then echo "Use at least 6 characters."; exit 1; fi

"$KEYTOOL" -genkeypair -v \
  -keystore "$KEYSTORE" \
  -alias "$ALIAS" \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass "$PW1" -keypass "$PW1" \
  -dname "CN=Capture and Cook, OU=Mobile, O=Capture and Cook LLC, L=Detroit, ST=Michigan, C=US" \
  >/dev/null

# Gradle reads these. The file is gitignored.
cat > "$PROPS" <<EOF
storeFile=$KEYSTORE
storePassword=$PW1
keyAlias=$ALIAS
keyPassword=$PW1
EOF
chmod 600 "$PROPS"

unset PW1 PW2

echo
echo "Done."
echo "  keystore : $KEYSTORE"
echo "  gradle   : android/keystore.properties (gitignored, chmod 600)"
echo
echo "Certificate fingerprints — the SHA-1 is what Google Sign-In needs:"
"$KEYTOOL" -list -v -keystore "$KEYSTORE" -alias "$ALIAS" \
  -storepass "$(grep '^storePassword=' "$PROPS" | cut -d= -f2-)" 2>/dev/null \
  | grep -E "SHA1:|SHA256:" | sed 's/^/  /'
echo
echo "Back up the .jks file somewhere off this machine."
