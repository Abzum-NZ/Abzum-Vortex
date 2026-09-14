#!/usr/bin/env bash

set -euo pipefail

readonly candidate_path="$(realpath "$1")"
readonly source_repository=/workspace
readonly test_root="$(mktemp -d /tmp/vortex-absent-baseline-preparation.XXXXXX)"
trap 'rm -rf "$test_root"' EXIT

jq --exit-status 'type == "null"' "$candidate_path" >/dev/null

git config --global --add safe.directory "$source_repository"
git config --global --add safe.directory "$source_repository/.git"
git clone --bare --quiet "$source_repository" "$test_root/remote.git"
commit="$(git -C "$source_repository" rev-parse HEAD)"
readonly commit
git --git-dir="$test_root/remote.git" update-ref refs/heads/testing "$commit"
git config --global \
  "url.file://${test_root}/remote.git.insteadOf" \
  https://github.com/Abzum-NZ/Abzum-Vortex.git

cd "$test_root"
export VORTEX_DELIVERY_OPERATION=prepare
export VORTEX_DELIVERY_ENVIRONMENT=testing
export VORTEX_EXPECTED_REF=refs/heads/testing
export VORTEX_GITHUB_REPOSITORY=Abzum-NZ/Abzum-Vortex
export VORTEX_GITHUB_REF=refs/heads/testing
export VORTEX_GITHUB_COMMIT="$commit"
export VORTEX_EXECUTION_ID=issue-494-absent-baseline
export VORTEX_EVIDENCE_PATH=preparation-evidence.json
export VORTEX_REUSE_CANDIDATE_PATH="$candidate_path"
export VORTEX_FORCE_FULL_VERIFICATION=false
export VORTEX_EXPECTED_DATABASE_PROJECT_REF=abflfptnguasinoussws
unset VORTEX_DOPPLER_TOKEN

"$source_repository/workflows/kestra/scripts/deliver-database.sh"

jq --exit-status '
  .status == "prepared" and
  .verification.mode == "prepared" and
  .verification.selection.mode == "full" and
  .verification.selection.baseline == "" and
  (.verification.selection.full_coverage_reasons |
    index("full:ambiguous-history:missing-baseline")) != null and
  (.reused_checks | length) == 0 and
  (.selected_sql_suites | length) > 0 and
  (.selected_concurrency_proofs | length) > 0 and
  (.selected_lint_schemas | length) > 0
' "$VORTEX_EVIDENCE_PATH" >/dev/null
