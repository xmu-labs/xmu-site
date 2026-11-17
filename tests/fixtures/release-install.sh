#!/bin/sh
# xmu installer (XMU-725, XMU-792): `curl -fsSL <base>/install.sh | XMU_DOWNLOAD_BASE=<base> bash`
#
# Detects the platform and installs two programs from a release into one folder:
#   xmu     the Rust xmu (xmu chat, xmu version)
#   xmu-ts  the TS single binary (Bun product layer with the Rust event-log addon embedded);
#           xmu hands `run` and `demo` to it
# and the agents and skills (xmu-agents.tar.gz, XMU-882) into xmu's data folder,
# $XDG_DATA_HOME/xmu (when absolute) or ~/.local/share/xmu, so `xmu --agent <name>` finds them
# in any project. Everything is checked against its sha256, and both programs must start and
# report the same version, before anything replaces an older install. XMU_DOWNLOAD_BASE is a
# release URL, or a folder holding the release files (a private repo's release: `gh release download vX.Y.Z -D <folder>`).
# Platform → artifact names must match packages/cli/src/targets.ts (tested).
#
# Everything runs from `main`, called on the last line: a download cut short runs nothing.
set -eu

say() { printf '%s\n' "$*"; }
fail() { printf 'xmu install: %s\n' "$*" >&2; exit 1; }

# The unpacked agents and skills in $astage take the place of those in $data; the old ones are
# kept as $astage/old-* until the stage goes. Stops at the first move that fails.
swap_agents() {
  for part in agents skills; do
    if [ -e "$data/$part" ] || [ -L "$data/$part" ]; then mv -f "$data/$part" "$astage/old-$part" || return 1; fi
    mv -f "$astage/$part" "$data/$part" || return 1
  done
}

# After a failed step from swap_agents on: $data as it was before it. Goes on past a move that
# fails, and fails if any did.
put_back_agents() {
  ok=0
  for part in agents skills; do
    if [ -e "$astage/old-$part" ] || [ -L "$astage/old-$part" ]; then
      { rm -rf "$data/$part" && mv -f "$astage/old-$part" "$data/$part"; } || ok=1
    elif [ ! -e "$astage/$part" ]; then
      rm -rf "$data/$part" || ok=1
    fi
  done
  return "$ok"
}

# put_back_agents, then fail with `why`. Old folders it cannot put back stay in the stage, which
# is then kept, and are named: they are never deleted.
undo_agents() {
  if put_back_agents; then fail "$1"; fi
  kept="$astage"
  astage=""
  fail "$1, nor put all the old agents and skills back: what is left of them is in $kept (old-agents, old-skills)"
}

detect_target() {
  s="${XMU_UNAME_S:-$(uname -s)}"
  m="${XMU_UNAME_M:-$(uname -m)}"
  case "$s" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) fail "unsupported platform $s/$m (supported: linux, darwin on x64, arm64)" ;;
  esac
  case "$m" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) fail "unsupported platform $s/$m (supported: linux, darwin on x64, arm64)" ;;
  esac
  printf 'xmu-%s-%s\n' "$os" "$arch"
}

# The sha256 of a file, read from stdin: sha256sum escapes a name with a backslash or newline.
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum <"$1" | cut -d ' ' -f 1
  else shasum -a 256 <"$1" | cut -d ' ' -f 1; fi
}

# Runs `$1 version`; prints its line, or fails with what it wrote to stderr: its first line
# that starts with an error (`error: …`, `TypeError: …`), else its last line other than Bun's
# own version line. Bun prints a source excerpt before the error itself.
start() {
  if out="$(FORCE_COLOR=0 NO_COLOR=1 "$1" version 2>"$stage/start.err")"; then
    printf '%s\n' "$out"
    return
  fi
  # Read as bytes (LC_ALL=C), without colour codes or NUL bytes: otherwise grep calls the file
  # binary and prints nothing useful.
  esc="$(printf '\033')"
  LC_ALL=C tr -d '\000' <"$stage/start.err" | LC_ALL=C sed "s/$esc\\[[0-9;]*[A-Za-z]//g" |
    LC_ALL=C tr -cd '[:print:]\n' >"$stage/start.txt"
  why="$(LC_ALL=C grep -E '^([A-Za-z]*Error|error)(:| )' "$stage/start.txt" | head -n 1 || true)"
  [ -n "$why" ] ||
    why="$(LC_ALL=C grep -v -e '^[[:space:]]*$' -e '^Bun v' "$stage/start.txt" | tail -n 1 || true)"
  why="$(printf '%s' "$why" | cut -c 1-200)"
  fail "$2 failed to start: ${why:-no message}; $3"
}

# An absolute folder written plainly: no `.`, doubled or trailing slashes. `..` stays: after a
# symlink it leads where the system takes it, which the text alone cannot tell.
plain_dir() {
  out=""
  old_ifs="$IFS"
  IFS=/
  set -f
  for part in $1; do
    case "$part" in
      "" | .) ;;
      *) out="$out/$part" ;;
    esac
  done
  set +f
  IFS="$old_ifs"
  printf '%s\n' "${out:-/}"
}

# The folder a path really is (symlinks and `..` resolved by the system), or nothing.
real_dir() {
  (cd -P -- "$1" 2>/dev/null && pwd -P) || true
}

main() {
  if [ "${1:-}" = "--print-target" ]; then
    detect_target
    return
  fi

  base="${XMU_DOWNLOAD_BASE:-}"
  [ -n "$base" ] || fail "set XMU_DOWNLOAD_BASE to the release URL, or to a folder holding the release files"
  # One trailing slash is how a folder is often written; the files are joined with their own.
  base="${base%/}"
  if [ -n "${XMU_INSTALL_DIR:-}" ]; then
    dir="$XMU_INSTALL_DIR"
  elif [ -n "${HOME:-}" ]; then
    dir="$HOME/.local/bin"
  else
    fail "set HOME or XMU_INSTALL_DIR"
  fi
  case "$dir" in /*) ;; *) dir="$PWD/$dir" ;; esac
  dir="$(plain_dir "$dir")"
  # Where xmu reads its installed agents: an absolute XDG_DATA_HOME, else HOME's (XDG).
  # A relative one is ignored, as xmu ignores it: xmu would never look there.
  case "${XDG_DATA_HOME:-}" in
    /*) data="$XDG_DATA_HOME/xmu" ;;
    *)
      case "${HOME:-}" in
        /*) data="$HOME/.local/share/xmu" ;;
        *) fail "set HOME or XDG_DATA_HOME to an absolute folder, where xmu keeps its agents" ;;
      esac ;;
  esac
  data="$(plain_dir "$data")"
  agents_archive=xmu-agents.tar.gz

  artifact="$(detect_target)"
  ts_artifact="xmu-ts-${artifact#xmu-}"
  folder=""
  case "$base" in
    *://*)
      command -v curl >/dev/null 2>&1 || fail "curl is required"
      fetch() { curl -fsSL --connect-timeout 30 --retry 2 --speed-limit 1024 --speed-time 60 "$base/$1" -o "$2"; } ;;
    *)
      [ -d "$base" ] || fail "no such folder: $base (XMU_DOWNLOAD_BASE is a release URL or a folder)"
      folder=yes
      fetch() { cp "$base/$1" "$2" 2>/dev/null; } ;;
  esac
  command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 ||
    fail "sha256sum or shasum is required to verify the download"
  for name in xmu xmu-ts; do
    [ ! -d "$dir/$name" ] || fail "$dir/$name is a folder; move it away, then install again"
  done

  # Staged in the install folder itself, so each program then takes its place in one rename:
  # nothing is ever half-written under its own name.
  mkdir -p "$dir" 2>/dev/null || fail "cannot create $dir"
  stage="$(mktemp -d "$dir/.xmu-install.XXXXXX" 2>/dev/null)" || fail "cannot write to $dir"
  astage=""
  trap 'rm -rf "$stage" ${astage:+"$astage"}' EXIT
  trap 'exit 1' HUP INT TERM

  for name in "$artifact" "$ts_artifact"; do
    for file in "$name" "$name.sha256"; do
      if [ -n "$folder" ] && [ ! -e "$base/$file" ]; then
        [ "$file" = "$name" ] || fail "$file is not in $base"
        fail "$file is not in $base; this machine needs the $artifact and $ts_artifact files"
      fi
      fetch "$file" "$stage/$file" || fail "download failed: $base/$file"
    done
    expected="$(head -n 1 "$stage/$name.sha256" | cut -d ' ' -f 1 | tr -d '\r' | tr 'A-F' 'a-f')"
    case "$expected" in
      *[!0-9a-f]* | "") fail "$name.sha256 is not a sha256 checksum (is XMU_DOWNLOAD_BASE the release?)" ;;
    esac
    [ "${#expected}" -eq 64 ] || fail "$name.sha256 is not a sha256 checksum (is XMU_DOWNLOAD_BASE the release?)"
    actual="$(sha256 "$stage/$name")"
    [ "$expected" = "$actual" ] || fail "checksum mismatch for $name (expected $expected, got $actual)"
    chmod 755 "$stage/$name"
    # A file a browser downloaded carries macOS's quarantine mark, which a copy keeps: Gatekeeper
    # would then refuse these unsigned programs. The checksum above proves each file arrived whole,
    # not who made it: trust comes from where the release was downloaded (the repo's release).
    if [ "$(uname -s)" = Darwin ]; then xattr -d com.apple.quarantine "$stage/$name" 2>/dev/null || true; fi
  done

  # The agents and skills: checked now, unpacked once both programs start.
  for file in "$agents_archive" "$agents_archive.sha256"; do
    if [ -n "$folder" ] && [ ! -e "$base/$file" ]; then fail "$file is not in $base"; fi
    fetch "$file" "$stage/$file" || fail "download failed: $base/$file"
  done
  expected="$(head -n 1 "$stage/$agents_archive.sha256" | cut -d ' ' -f 1 | tr -d '\r' | tr 'A-F' 'a-f')"
  case "$expected" in
    *[!0-9a-f]* | "") fail "$agents_archive.sha256 is not a sha256 checksum (is XMU_DOWNLOAD_BASE the release?)" ;;
  esac
  [ "${#expected}" -eq 64 ] || fail "$agents_archive.sha256 is not a sha256 checksum (is XMU_DOWNLOAD_BASE the release?)"
  actual="$(sha256 "$stage/$agents_archive")"
  [ "$expected" = "$actual" ] || fail "checksum mismatch for $agents_archive (expected $expected, got $actual)"

  # The TS program extracts its Rust addon to $TMPDIR at startup (decision 0002).
  ts_line="$(start "$stage/$ts_artifact" xmu-ts "check that this release is for $artifact (Linux needs glibc 2.28 or later), and that TMPDIR allows running programs")"
  line="$(start "$stage/$artifact" xmu "check that this release is for $artifact (Linux needs glibc 2.28 or later)")"
  version="$(printf '%s\n' "$line" | cut -d ' ' -f 2)"
  ts_version="$(printf '%s\n' "$ts_line" | cut -d ' ' -f 2)"
  [ -n "$version" ] && [ "$version" = "$ts_version" ] ||
    fail "the release does not match: xmu is $version but xmu-ts is $ts_version"

  # Unpacked beside where they go, so each folder takes its place in one rename.
  mkdir -p "$data" 2>/dev/null || fail "cannot create $data"
  astage="$(mktemp -d "$data/.xmu-install.XXXXXX" 2>/dev/null)" || fail "cannot write to $data"
  # Owned by whoever installs, never by the uid that built the archive.
  tar -xzf "$stage/$agents_archive" --no-same-owner -C "$astage" && [ -d "$astage/agents" ] && [ -d "$astage/skills" ] ||
    fail "$agents_archive does not unpack to agents/ and skills/ (is XMU_DOWNLOAD_BASE the release?)"

  # Not stopped from here. The agents of this release first, and none an earlier one left (the
  # old folders go with the stage): if one cannot take its place, the old ones are put back and
  # the programs are not touched. Then xmu-ts: an xmu in place always has its xmu-ts.
  trap '' HUP INT TERM
  swap_agents || undo_agents "cannot put the agents in $data (the old ones are back, and nothing was installed)"
  { mv -f "$stage/$ts_artifact" "$dir/xmu-ts" && mv -f "$stage/$artifact" "$dir/xmu"; } ||
    undo_agents "cannot put xmu in $dir (the old agents are back)"
  say "installed xmu $version to $dir/xmu"
  on_path=""
  real="$(real_dir "$dir")"
  old_ifs="$IFS"
  IFS=:
  set -f
  for entry in ${PATH:-}; do
    case "$entry" in /*) [ "$(real_dir "$entry")" != "$real" ] || on_path=yes ;; esac
  done
  set +f
  IFS="$old_ifs"
  if [ -z "$on_path" ]; then
    say "add $dir to your PATH to run \`xmu\` directly"
  else
    # Another xmu earlier on PATH (cargo install puts one in ~/.cargo/bin) would run instead.
    first="$(command -v xmu 2>/dev/null || true)"
    case "$first" in
      /*) [ "$first" -ef "$dir/xmu" ] ||
        say "$first comes first on your PATH and runs instead; remove it, or put $dir first" ;;
    esac
  fi
}

main "$@"
