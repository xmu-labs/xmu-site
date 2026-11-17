#!/bin/sh
# xmu bootstrap (XMU-808): `curl --proto '=https' --tlsv1.2 -fsSL https://xmu.sh/install | sh`
#
# While the release repository is private, this downloads through the GitHub CLI, signed in:
# this machine's two programs, xmu's agents and skills (when the release has them) and the
# release's own install.sh, into a new temporary folder. It then runs that install.sh on the
# folder, which checks every file against its sha256 and that both programs start before
# anything is installed. XMU_VERSION=vX.Y.Z picks a release; the latest one otherwise.
#
# Everything runs from `main`, called on the last line: a download cut short runs nothing.
set -eu

# The host by name: a GH_HOST set for GitHub Enterprise would otherwise send gh there.
REPO=github.com/xmu-labs/xmu-monorepo

fail() { printf 'xmu install: %s\n' "$*" >&2; exit 1; }

target() {
  s="${XMU_UNAME_S:-$(uname -s)}"
  m="${XMU_UNAME_M:-$(uname -m)}"
  case "$s" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) fail "unsupported platform $s/$m (supported: Linux and macOS on x64 and arm64)" ;;
  esac
  case "$m" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "unsupported platform $s/$m (supported: Linux and macOS on x64 and arm64)" ;;
  esac
  printf '%s-%s\n' "$os" "$arch"
}

# Whether the release lists `name` among its assets ($assets, one per line).
has() { printf '%s\n' "$assets" | grep -qxF "$1"; }

main() {
  tag="${XMU_VERSION:-}"
  if [ -n "$tag" ]; then
    # One line of v, digits and dots only: grep alone would pass a value with a second line.
    case "$tag" in *[!v0-9.]* | *.*.*.*) tag=bad ;; esac
    printf '%s\n' "$tag" | grep -Eqx 'v[0-9]+\.[0-9]+\.[0-9]+' ||
      fail "XMU_VERSION must be a release tag such as v0.5.0"
  fi
  t="$(target)"
  command -v gh >/dev/null 2>&1 ||
    fail "needs the GitHub CLI (gh), signed in, while the release is private: get it at https://cli.github.com, run gh auth login, then run this again"

  # $tag is empty for the latest release: left unquoted so it is no argument at all. gh's own
  # error is let through: it names the cause (a dropped network, an org's SSO). Whether gh is
  # signed in is asked only to word what to do: a bare `gh auth status` also fails for an
  # expired sign-in on some other host, which this download never uses.
  # shellcheck disable=SC2086
  if ! listed="$(gh release view $tag --repo "$REPO" --json tagName,isDraft,assets --jq '.tagName, .isDraft, .assets[].name')"; then
    gh auth status --hostname github.com >/dev/null 2>&1 ||
      fail "gh is not signed in to github.com, or cannot reach it: gh auth status says which, gh auth login signs in"
    fail "cannot read the ${tag:-latest} release of $REPO: check that gh can see it (gh release list --repo $REPO)"
  fi
  # The files come from the release the list came from, by its tag: a release published in
  # between cannot mix the two.
  tag="$(printf '%s\n' "$listed" | head -n 1)"
  draft="$(printf '%s\n' "$listed" | head -n 2 | tail -n 1)"
  assets="$(printf '%s\n' "$listed" | tail -n +3)"
  case "$tag" in *[!v0-9.]* | "") tag=bad ;; esac
  printf '%s\n' "$tag" | grep -Eqx 'v[0-9]+\.[0-9]+\.[0-9]+' ||
    fail "gh did not name a release tag for $REPO: check gh release list --repo $REPO"
  # gh finds a draft by its tag for anyone who can write to the repo: its files can still change.
  [ "$draft" = false ] ||
    fail "$tag is a draft release, not published yet: pick a published one (gh release list --repo $REPO)"
  release="$tag"
  set --
  for f in "xmu-$t" "xmu-$t.sha256" "xmu-ts-$t" "xmu-ts-$t.sha256" install.sh; do
    has "$f" || fail "$release has no $f: this machine needs xmu-$t and xmu-ts-$t"
    set -- "$@" -p "$f"
  done
  # Agents and skills ship in every release after v0.4.0.
  for f in xmu-agents.tar.gz xmu-agents.tar.gz.sha256; do
    if has "$f"; then set -- "$@" -p "$f"; fi
  done

  dir="$(mktemp -d "${TMPDIR:-/tmp}/xmu-release.XXXXXX")" || fail "cannot make a temporary folder"
  trap 'rm -rf "$dir"' EXIT
  trap 'exit 1' HUP INT TERM
  printf 'Downloading xmu (%s, %s)…\n' "$release" "$t"
  # shellcheck disable=SC2086
  gh release download $tag --repo "$REPO" -D "$dir" "$@" >/dev/null ||
    fail "the download failed (gh release download --repo $REPO)"
  # The release's own installer: it checks every file before it installs any.
  set +e
  XMU_DOWNLOAD_BASE="$dir" sh "$dir/install.sh"
  code=$?
  set -e
  exit "$code"
}

main "$@"
