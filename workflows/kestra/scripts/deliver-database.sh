#!/usr/bin/env bash

set -euo pipefail

readonly EXPECTED_REPOSITORY="Abzum-NZ/Abzum-Vortex"
readonly REPOSITORY_URL="https://github.com/Abzum-NZ/Abzum-Vortex.git"
readonly COMMIT_RUNNER_PATH="workflows/kestra/scripts/run-database-delivery.sh"

die() {
  echo "database-delivery-bootstrap: FAILED: $*" >&2
  exit 1
}

require_variable() {
  local name="$1"
  [ -n "${!name:-}" ] || die "${name} is not set"
}

is_commit() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] && [[ ! "$1" =~ ^0{40}$ ]]
}

for name in \
  VORTEX_DELIVERY_OPERATION \
  VORTEX_DELIVERY_ENVIRONMENT \
  VORTEX_EXPECTED_REF \
  VORTEX_GITHUB_REPOSITORY \
  VORTEX_GITHUB_REF \
  VORTEX_GITHUB_COMMIT \
  VORTEX_EVIDENCE_PATH; do
  require_variable "$name"
done

case "$VORTEX_DELIVERY_OPERATION" in
  prepare | apply) ;;
  *) die "VORTEX_DELIVERY_OPERATION must be prepare or apply" ;;
esac

case "$VORTEX_DELIVERY_ENVIRONMENT" in
  testing)
    [ "$VORTEX_EXPECTED_REF" = "refs/heads/testing" ] || die "testing must use refs/heads/testing"
    ;;
  production)
    [ "$VORTEX_EXPECTED_REF" = "refs/heads/main" ] || die "production must use refs/heads/main"
    ;;
  *) die "unknown delivery environment" ;;
esac

[ "$VORTEX_GITHUB_REPOSITORY" = "$EXPECTED_REPOSITORY" ] || die "unexpected repository"
[ "$VORTEX_GITHUB_REF" = "$VORTEX_EXPECTED_REF" ] || die "unexpected Git ref"
is_commit "$VORTEX_GITHUB_COMMIT" || die "Git commit must be a complete non-zero lowercase SHA-1"
[[ "$VORTEX_EVIDENCE_PATH" =~ ^[a-z0-9][a-z0-9-]{0,99}[.]json$ ]] ||
  die "evidence path must be a local JSON filename"

mkdir -p "$(dirname "$VORTEX_EVIDENCE_PATH")"
workdir="$(mktemp -d /tmp/vortex-database-delivery.XXXXXX)"
readonly workdir
checkout="${workdir}/repository"
readonly checkout
trap 'rm -rf "$workdir"' EXIT

# Do not expose a database-capable service token to Git or another process used before the
# protected commit and its fixed runner path have been verified.
delivery_doppler_token="${VORTEX_DOPPLER_TOKEN:-}"
readonly delivery_doppler_token
unset VORTEX_DOPPLER_TOKEN

git init --quiet "$checkout"
git -C "$checkout" remote add origin "$REPOSITORY_URL"
git -C "$checkout" fetch --quiet --no-tags origin "$VORTEX_GITHUB_COMMIT"
commit="$(git -C "$checkout" rev-parse FETCH_HEAD)"
readonly commit
[ "$commit" = "$VORTEX_GITHUB_COMMIT" ] || die "fetched commit does not match the webhook commit"

branch_name="${VORTEX_EXPECTED_REF#refs/heads/}"
git -C "$checkout" fetch --quiet --no-tags origin \
  "+${VORTEX_EXPECTED_REF}:refs/remotes/origin/${branch_name}"
git -C "$checkout" merge-base --is-ancestor "$commit" "refs/remotes/origin/${branch_name}" ||
  die "webhook commit is not reachable from the expected protected branch"
git -C "$checkout" checkout --quiet --detach "$commit"

runner_tree_entry="$(git -C "$checkout" ls-tree "$commit" -- "$COMMIT_RUNNER_PATH")"
readonly runner_tree_entry
[[ "$runner_tree_entry" =~ ^100(644|755)[[:space:]]blob[[:space:]][0-9a-f]{40}[[:space:]] ]] ||
  die "selected commit does not contain the required regular delivery runner"
runner_path="${checkout}/${COMMIT_RUNNER_PATH}"
readonly runner_path
[ -f "$runner_path" ] && [ ! -L "$runner_path" ] ||
  die "selected commit delivery runner is not a regular file"

runner_sha256="$(git -C "$checkout" show "${commit}:${COMMIT_RUNNER_PATH}" | sha256sum | cut -d' ' -f1)"
readonly runner_sha256
[ "$(sha256sum "$runner_path" | cut -d' ' -f1)" = "$runner_sha256" ] ||
  die "checked-out delivery runner differs from the selected commit"

export VORTEX_VERIFIED_CHECKOUT="$checkout"
export VORTEX_VERIFIED_RUNNER_SHA256="$runner_sha256"
if [ -n "$delivery_doppler_token" ]; then
  export VORTEX_DOPPLER_TOKEN="$delivery_doppler_token"
fi

bash "$runner_path"
