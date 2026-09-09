#!/bin/bash
# Prepare a PodHarbor release:
#   bump version -> commit -> tag -> push -> GitHub Actions builds native assets.
#
# Usage: ./release.sh [options] <version>
#   <version>            SemVer version, e.g. 0.2.0
#
# Options:
#   -y, --yes            Skip the confirmation prompt.
#   -n, --dry-run        Print the steps without changing anything.
#       --no-commit      Do not bump/commit; tag the current HEAD.
#       --no-push        Do not push the commit or tag.
#   -h, --help           Show this help.
set -euo pipefail
cd "$(dirname "$0")"

VERSION=""
ASSUME_YES=0
DRY_RUN=0
DO_COMMIT=1
DO_PUSH=1

err()  { printf "\033[31merror:\033[0m %s\n" "$*" >&2; exit 1; }
info() { printf "\033[36m▸\033[0m %s\n" "$*"; }
run()  { if [ "$DRY_RUN" -eq 1 ]; then printf "  \033[2m(dry-run)\033[0m %s\n" "$*"; else eval "$*"; fi; }

usage() { sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//; s/^set -euo.*//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes)     ASSUME_YES=1; shift ;;
    -n|--dry-run) DRY_RUN=1; shift ;;
    --no-commit)  DO_COMMIT=0; shift ;;
    --no-push)    DO_PUSH=0; shift ;;
    -h|--help)    usage 0 ;;
    -*)           err "unknown option: $1 (try --help)" ;;
    *)            if [ -z "$VERSION" ]; then VERSION="$1"; else err "unexpected argument: $1"; fi; shift ;;
  esac
done

[ -n "$VERSION" ] || usage 1
echo "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || err "version must look like 0.2.0 (got '$VERSION')"

TAG="v${VERSION}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" != HEAD ] || err "release from a branch, not detached HEAD"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || err "not a git repository"
git remote get-url origin >/dev/null 2>&1 || err "origin remote is not configured"

if git rev-parse "$TAG" >/dev/null 2>&1 || git ls-remote --exit-code --tags origin "$TAG" >/dev/null 2>&1; then
  err "tag $TAG already exists"
fi

[ -z "$(git status --porcelain)" ] || err "worktree must be clean before releasing"
if [ "$DO_COMMIT" -eq 0 ]; then
  node scripts/check-version.mjs "$VERSION"
fi

if [ "$DO_COMMIT" -eq 1 ]; then
  git diff --quiet || err "worktree has unstaged changes; commit or stash them before releasing"
  git diff --cached --quiet || err "index has staged changes; commit or unstage them before releasing"
fi

echo
info "Release plan"
echo "  version:   $VERSION"
echo "  tag:       $TAG"
echo "  branch:    $BRANCH"
echo "  commit:    $([ "$DO_COMMIT" -eq 1 ] && echo 'bump package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml, src-tauri/Cargo.lock' || echo 'skip; tag current HEAD')"
echo "  push:      $([ "$DO_PUSH" -eq 1 ] && echo 'push branch and tag to origin' || echo 'skip')"
echo "  workflow:  GitHub Actions builds macOS Intel/Apple Silicon, Windows x64, Linux x64/ARM64"
echo

if [ "$DRY_RUN" -eq 0 ] && [ "$ASSUME_YES" -eq 0 ]; then
  read -r -p "Proceed? [y/N] " ans
  case "$ans" in y|Y|yes|YES) ;; *) echo "aborted."; exit 1 ;; esac
fi

if [ "$DO_COMMIT" -eq 1 ]; then
  info "Bumping project version to $VERSION"
  run "node --input-type=module -e \"
    import fs from 'node:fs';
    for (const file of ['package.json', 'src-tauri/tauri.conf.json']) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      data.version = process.argv[1];
      fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\\n');
    }
  \" '$VERSION'"
  run "perl -0pi -e 's/^version = \"[^\"]+\"/version = \"$VERSION\"/m' src-tauri/Cargo.toml"
  run "cargo check --manifest-path src-tauri/Cargo.toml"

  info "Committing release bump"
  run "git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock"
  run "git diff --cached --quiet || git commit -m 'Release $VERSION'"
fi

info "Creating tag $TAG"
run "git tag -a '$TAG' -m 'PodHarbor $VERSION'"

if [ "$DO_PUSH" -eq 1 ]; then
  info "Pushing branch and tag"
  run "git push --atomic origin '$BRANCH' '$TAG'"
fi

echo
info "Done."
echo "  GitHub Actions will publish the release after all builds succeed:"
echo "  https://github.com/Banegasn/podharbor/releases/tag/$TAG"
