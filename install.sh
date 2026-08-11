#!/bin/sh
# Author: Navjyot Nishant
# Created: 2026-08-10
# Last updated: 2026-08-10
# Description: install the specter binary for this platform, checksum-verified.
#
# WHY THIS IS /bin/sh AND NOT BASH
# It runs on a machine that has nothing installed yet — that is the entire point
# of a single-binary install. macOS ships bash 3.2, some containers ship no bash
# at all, so this stays POSIX: no arrays, no [[ ]], no local -n.
#
# WHAT THIS DOES NOT DO
# It installs one binary and verifies its checksum. It does not install git, gh,
# or any agent CLI: those carry the user's own credentials, and a curl|sh script
# that starts installing other people's tools is doing more than it was asked.
# `specter status` reports what is missing and what each one enables.

set -eu

REPO="navjyotnishant/specter-agent"
BIN="specter"

# Honour the usual overrides. A user piping a script from the internet into sh
# should still be able to say where the result lands.
VERSION="${SPECTER_VERSION:-latest}"
INSTALL_DIR="${SPECTER_INSTALL_DIR:-}"

say()  { printf '  %s\n' "$*"; }
die()  { printf '\n  %s\n\n' "$*" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required to run this installer, and is not on PATH."
}

# ── Platform ────────────────────────────────────────────────────────────────
# The names must match what the release workflow publishes. A mismatch here
# fails as a 404 partway through, so it is worth being explicit rather than
# clever with `uname` output.
detect_platform() {
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    *)      die "Unsupported operating system: $os. Build from source with: go install github.com/$REPO/cmd/specter@latest" ;;
  esac

  case "$arch" in
    x86_64|amd64)  arch="amd64" ;;
    arm64|aarch64) arch="arm64" ;;
    *)             die "Unsupported architecture: $arch. Build from source with: go install github.com/$REPO/cmd/specter@latest" ;;
  esac

  PLATFORM="${os}_${arch}"
}

# ── Where to put it ─────────────────────────────────────────────────────────
# Preference order is deliberate: a directory already on PATH that we can write
# to beats one we would have to sudo into, which beats one the user then has to
# add to PATH themselves.
choose_install_dir() {
  if [ -n "$INSTALL_DIR" ]; then
    return
  fi

  for candidate in "$HOME/.local/bin" "/usr/local/bin"; do
    if [ -d "$candidate" ] && [ -w "$candidate" ]; then
      INSTALL_DIR="$candidate"
      return
    fi
  done

  # Nothing writable exists yet. ~/.local/bin is the one we can create without
  # asking for a password.
  INSTALL_DIR="$HOME/.local/bin"
}

# ── Download ────────────────────────────────────────────────────────────────
fetch() {
  # -f so a 404 is an error rather than a saved HTML page that later fails to
  # execute with a confusing message.
  curl -fsSL "$1" -o "$2"
}

main() {
  need curl
  need uname

  detect_platform
  choose_install_dir

  if [ "$VERSION" = "latest" ]; then
    base="https://github.com/$REPO/releases/latest/download"
  else
    base="https://github.com/$REPO/releases/download/$VERSION"
  fi

  archive="${BIN}_${PLATFORM}.tar.gz"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT INT TERM

  printf '\n  specter installer\n\n'
  say "platform    $PLATFORM"
  say "version     $VERSION"
  say "install to  $INSTALL_DIR"
  printf '\n'

  say "downloading $archive"
  fetch "$base/$archive" "$tmp/$archive" \
    || die "Could not download $base/$archive — check that a release exists for this platform."

  # ── Checksum ──────────────────────────────────────────────────────────────
  # Verified, not optional. A binary fetched over the network and put on PATH
  # without a check is exactly the supply-chain step worth getting right, and
  # the manifest is published alongside the archive by the same workflow.
  say "verifying checksum"
  fetch "$base/checksums.txt" "$tmp/checksums.txt" \
    || die "Could not download the checksum manifest. Refusing to install an unverified binary."

  expected="$(grep " $archive\$" "$tmp/checksums.txt" | awk '{print $1}')"
  [ -n "$expected" ] || die "No checksum published for $archive. Refusing to install an unverified binary."

  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp/$archive" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$tmp/$archive" | awk '{print $1}')"
  else
    die "Neither sha256sum nor shasum is available. Refusing to install an unverified binary."
  fi

  [ "$actual" = "$expected" ] || die "Checksum mismatch for $archive.
    expected  $expected
    got       $actual
  Refusing to install. This is worth reporting."

  # ── Install ───────────────────────────────────────────────────────────────
  tar -xzf "$tmp/$archive" -C "$tmp" || die "Could not unpack $archive."
  [ -f "$tmp/$BIN" ] || die "The archive did not contain a $BIN binary."

  mkdir -p "$INSTALL_DIR"
  chmod +x "$tmp/$BIN"

  # Install to a temporary name in the target directory, then rename: mv within
  # one filesystem is atomic, so a half-copied binary is never on PATH — and
  # replacing a running binary this way does not disturb the running process.
  if ! mv "$tmp/$BIN" "$INSTALL_DIR/.$BIN.new" 2>/dev/null; then
    die "Cannot write to $INSTALL_DIR.
  Re-run with a writable location:  SPECTER_INSTALL_DIR=\$HOME/.local/bin sh install.sh"
  fi
  mv "$INSTALL_DIR/.$BIN.new" "$INSTALL_DIR/$BIN"

  printf '\n'
  say "installed   $INSTALL_DIR/$BIN"

  # ── PATH ──────────────────────────────────────────────────────────────────
  # Say it plainly rather than editing a shell profile. Silently appending to
  # someone's .zshrc from a piped script is not ours to do.
  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *)
      printf '\n'
      say "$INSTALL_DIR is not on your PATH. Add it:"
      say "  export PATH=\"$INSTALL_DIR:\$PATH\""
      ;;
  esac

  printf '\n  Run `%s` to see what this machine can do.\n\n' "$BIN"
}

main "$@"
