#!/usr/bin/env bash

set -euo pipefail

readonly source_repository="${VORTEX_TEST_SOURCE_REPOSITORY:-/source}"
readonly delivery_script="${VORTEX_TEST_DELIVERY_SCRIPT:-/app/vortex-operations/deliver-database.sh}"
readonly test_root="$(mktemp -d /tmp/vortex-database-delivery-test.XXXXXX)"
trap 'rm -rf "$test_root"' EXIT
cd "$test_root"

# Runner stages that ran to completion, in execution order, from its timing lines.
completed_check_stages() {
  sed --quiet --regexp-extended \
    's/^database-delivery: timing (migration_apply|lint:[^:]*|sql:.*|proof:.*): [0-9]+ms$/\1/p' "$1"
}

git config --global --add safe.directory "$source_repository"
git clone --bare --quiet "$source_repository" "$test_root/remote.git"
git --git-dir="$test_root/remote.git" config user.name delivery-test
git --git-dir="$test_root/remote.git" config user.email delivery-test@example.invalid
commit="$(git -C "$source_repository" rev-parse HEAD)"
git --git-dir="$test_root/remote.git" update-ref refs/heads/main "$commit"
git config --global \
  "url.file://${test_root}/remote.git.insteadOf" \
  https://github.com/Abzum-NZ/Abzum-Vortex.git
verification_manifest="${source_repository}/workflows/kestra/database-verification.json"
readonly verification_manifest
verification_proof_count="$(jq '.concurrencyProofs | length' "$verification_manifest")"
readonly verification_proof_count
verification_lint_schema_count="$(jq '.lintSchemas | length' "$verification_manifest")"
readonly verification_lint_schema_count

export VORTEX_DELIVERY_ENVIRONMENT=production
export VORTEX_EXPECTED_REF=refs/heads/main
export VORTEX_GITHUB_REPOSITORY=Abzum-NZ/Abzum-Vortex
export VORTEX_GITHUB_REF=refs/heads/main
export VORTEX_GITHUB_COMMIT="$commit"
export VORTEX_EXECUTION_ID=local-delivery-test
export VORTEX_EVIDENCE_PATH=evidence.json

export VORTEX_DELIVERY_OPERATION=prepare
"$delivery_script"
jq --exit-status \
  --argjson expected_proof_count "$verification_proof_count" \
  --argjson expected_lint_schema_count "$verification_lint_schema_count" \
  '.schema_version == 3 and
   .status == "prepared" and
   .environment == "production" and
   .commit == env.VORTEX_GITHUB_COMMIT and
   .approval == null and
   .database_project_ref == null and
   .verification.mode == "prepared" and
   .verification.source == null and
   (.verification.input_sha256 | test("^[0-9a-f]{64}$")) and
   (.runner.sha256 | test("^[0-9a-f]{64}$")) and
   (.verification_manifest.sha256 | test("^[0-9a-f]{64}$")) and
   (.selected_sql_suites | length) > 0 and
   (.completed_sql_suites | length) == 0 and
   (.selected_concurrency_proofs | length) == $expected_proof_count and
   (.selected_lint_schemas | length) == $expected_lint_schema_count and
   (.completed_concurrency_proofs | length) == 0 and
   (.completed_lint_schemas | length) == 0 and
   (.migrations | length) > 0' \
  "$VORTEX_EVIDENCE_PATH" >/dev/null

assert_partial_concurrency_release_refused() {
  local migration_path="$1"
  local proof_path="$2"
  local artifact_path="$3"
  local expected_message="$4"
  local partial_checkout="$test_root/partial-checkout"
  local partial_commit

  rm -rf "$partial_checkout"
  git clone --quiet "$test_root/remote.git" "$partial_checkout"
  git -C "$partial_checkout" config user.name delivery-test
  git -C "$partial_checkout" config user.email delivery-test@example.invalid
  rm -f "$partial_checkout/$migration_path" "$partial_checkout/$proof_path"
  mkdir -p "$(dirname "${partial_checkout}/${artifact_path}")"
  : >"${partial_checkout}/${artifact_path}"
  git -C "$partial_checkout" add --all -- supabase/migrations supabase/tests
  git -C "$partial_checkout" commit --quiet -m "Create partial hierarchy release"
  partial_commit="$(git -C "$partial_checkout" rev-parse HEAD)"
  git -C "$partial_checkout" push --quiet origin HEAD:main
  export VORTEX_GITHUB_COMMIT="$partial_commit"

  if "$delivery_script" >"$test_root/partial-release.log" 2>&1; then
    echo "expected a partial migration/concurrency-proof release to be refused" >&2
    exit 1
  fi
  grep --fixed-strings --quiet "$expected_message" "$test_root/partial-release.log"

  git --git-dir="$test_root/remote.git" update-ref refs/heads/main "$commit"
  export VORTEX_GITHUB_COMMIT="$commit"
}

while IFS=$'\t' read -r migration proof label; do
  assert_partial_concurrency_release_refused \
    "$migration" \
    "$proof" \
    "$migration" \
    "${label} migration has no concurrency proof"
  assert_partial_concurrency_release_refused \
    "$migration" \
    "$proof" \
    "$proof" \
    "${label} concurrency proof has no migration"
done < <(jq --raw-output \
  '.concurrencyProofs[] | [.migration, .proof, .label] | @tsv' \
  "$verification_manifest")

invalid_manifest_checkout="$test_root/invalid-manifest-checkout"
git clone --quiet "$test_root/remote.git" "$invalid_manifest_checkout"
git -C "$invalid_manifest_checkout" config user.name delivery-test
git -C "$invalid_manifest_checkout" config user.email delivery-test@example.invalid
jq 'del(.concurrencyProofs[0])' \
  "$invalid_manifest_checkout/workflows/kestra/database-verification.json" \
  >"$invalid_manifest_checkout/workflows/kestra/database-verification.json.next"
mv \
  "$invalid_manifest_checkout/workflows/kestra/database-verification.json.next" \
  "$invalid_manifest_checkout/workflows/kestra/database-verification.json"
git -C "$invalid_manifest_checkout" add workflows/kestra/database-verification.json
git -C "$invalid_manifest_checkout" commit --quiet -m "Create incomplete verification manifest"
invalid_manifest_commit="$(git -C "$invalid_manifest_checkout" rev-parse HEAD)"
git -C "$invalid_manifest_checkout" push --quiet origin HEAD:main
export VORTEX_GITHUB_COMMIT="$invalid_manifest_commit"
if "$delivery_script" >"$test_root/invalid-manifest.log" 2>&1; then
  echo "expected an incomplete verification manifest to be refused" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "database verification manifest does not list every concurrency proof exactly once" \
  "$test_root/invalid-manifest.log"
git --git-dir="$test_root/remote.git" update-ref refs/heads/main "$commit"
export VORTEX_GITHUB_COMMIT="$commit"

assert_invalid_manifest_mutation_refused() {
  local name="$1"
  local filter="$2"
  local checkout="$test_root/${name}-checkout"
  local mutated_commit

  git clone --quiet "$test_root/remote.git" "$checkout"
  git -C "$checkout" config user.name delivery-test
  git -C "$checkout" config user.email delivery-test@example.invalid
  jq "$filter" \
    "$checkout/workflows/kestra/database-verification.json" \
    >"$checkout/workflows/kestra/database-verification.json.next"
  mv \
    "$checkout/workflows/kestra/database-verification.json.next" \
    "$checkout/workflows/kestra/database-verification.json"
  git -C "$checkout" add workflows/kestra/database-verification.json
  git -C "$checkout" commit --quiet -m "Create ${name} verification manifest"
  mutated_commit="$(git -C "$checkout" rev-parse HEAD)"
  git -C "$checkout" push --quiet origin HEAD:main
  export VORTEX_GITHUB_COMMIT="$mutated_commit"

  if "$delivery_script" >"$test_root/${name}.log" 2>&1; then
    echo "expected ${name} verification manifest to be refused" >&2
    exit 1
  fi
  grep --fixed-strings --quiet \
    "database verification manifest is invalid" \
    "$test_root/${name}.log"

  git --git-dir="$test_root/remote.git" update-ref refs/heads/main "$commit"
  export VORTEX_GITHUB_COMMIT="$commit"
}

assert_invalid_manifest_mutation_refused \
  duplicate-migration \
  '.concurrencyProofs += [{migration: .concurrencyProofs[0].migration, proof: "supabase/tests/duplicate-migration-concurrency.test.sh", label: "Duplicate migration"}]'
assert_invalid_manifest_mutation_refused \
  duplicate-proof \
  '.concurrencyProofs += [{migration: "supabase/migrations/20990101000000_duplicate_proof.sql", proof: .concurrencyProofs[0].proof, label: "Duplicate proof"}]'
assert_invalid_manifest_mutation_refused \
  duplicate-schema \
  '.lintSchemas += [.lintSchemas[0]]'

missing_schema_checkout="$test_root/missing-schema-checkout"
git clone --quiet "$test_root/remote.git" "$missing_schema_checkout"
git -C "$missing_schema_checkout" config user.name delivery-test
git -C "$missing_schema_checkout" config user.email delivery-test@example.invalid
printf '%s\n' \
  'create schema vortex_unlisted authorization postgres;' \
  >"$missing_schema_checkout/supabase/migrations/20990101000000_unlisted_schema.sql"
git -C "$missing_schema_checkout" add supabase/migrations
git -C "$missing_schema_checkout" commit --quiet -m "Create unlisted operated schema"
missing_schema_commit="$(git -C "$missing_schema_checkout" rev-parse HEAD)"
git -C "$missing_schema_checkout" push --quiet origin HEAD:main
export VORTEX_GITHUB_COMMIT="$missing_schema_commit"
if "$delivery_script" >"$test_root/missing-schema.log" 2>&1; then
  echo "expected an unlisted operated schema to be refused" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "database verification manifest does not list every operated schema exactly once" \
  "$test_root/missing-schema.log"
git --git-dir="$test_root/remote.git" update-ref refs/heads/main "$commit"
export VORTEX_GITHUB_COMMIT="$commit"

missing_record_schema_checkout="$test_root/missing-record-schema-checkout"
git clone --quiet "$test_root/remote.git" "$missing_record_schema_checkout"
git -C "$missing_record_schema_checkout" config user.name delivery-test
git -C "$missing_record_schema_checkout" config user.email delivery-test@example.invalid
jq '.lintSchemas -= ["record_data"]' \
  "$missing_record_schema_checkout/workflows/kestra/database-verification.json" \
  >"$missing_record_schema_checkout/workflows/kestra/database-verification.json.next"
mv \
  "$missing_record_schema_checkout/workflows/kestra/database-verification.json.next" \
  "$missing_record_schema_checkout/workflows/kestra/database-verification.json"
git -C "$missing_record_schema_checkout" add workflows/kestra/database-verification.json
git -C "$missing_record_schema_checkout" commit --quiet -m "Omit generated record storage from lint"
missing_record_schema_commit="$(git -C "$missing_record_schema_checkout" rev-parse HEAD)"
git -C "$missing_record_schema_checkout" push --quiet origin HEAD:main
export VORTEX_GITHUB_COMMIT="$missing_record_schema_commit"
if "$delivery_script" >"$test_root/missing-record-schema.log" 2>&1; then
  echo "expected omitted record_data lint coverage to be refused" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "database verification manifest does not list every operated schema exactly once" \
  "$test_root/missing-record-schema.log"
git --git-dir="$test_root/remote.git" update-ref refs/heads/main "$commit"
export VORTEX_GITHUB_COMMIT="$commit"

unexpected_schema_checkout="$test_root/unexpected-schema-checkout"
git clone --quiet "$test_root/remote.git" "$unexpected_schema_checkout"
git -C "$unexpected_schema_checkout" config user.name delivery-test
git -C "$unexpected_schema_checkout" config user.email delivery-test@example.invalid
jq '.lintSchemas += ["vortex_uncreated"]' \
  "$unexpected_schema_checkout/workflows/kestra/database-verification.json" \
  >"$unexpected_schema_checkout/workflows/kestra/database-verification.json.next"
mv \
  "$unexpected_schema_checkout/workflows/kestra/database-verification.json.next" \
  "$unexpected_schema_checkout/workflows/kestra/database-verification.json"
git -C "$unexpected_schema_checkout" add workflows/kestra/database-verification.json
git -C "$unexpected_schema_checkout" commit --quiet -m "Create unexpected lint schema"
unexpected_schema_commit="$(git -C "$unexpected_schema_checkout" rev-parse HEAD)"
git -C "$unexpected_schema_checkout" push --quiet origin HEAD:main
export VORTEX_GITHUB_COMMIT="$unexpected_schema_commit"
if "$delivery_script" >"$test_root/unexpected-schema.log" 2>&1; then
  echo "expected a manifest-only schema to be refused" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "database verification manifest does not list every operated schema exactly once" \
  "$test_root/unexpected-schema.log"
git --git-dir="$test_root/remote.git" update-ref refs/heads/main "$commit"
export VORTEX_GITHUB_COMMIT="$commit"

missing_runner_checkout="$test_root/missing-runner-checkout"
git clone --quiet "$test_root/remote.git" "$missing_runner_checkout"
git -C "$missing_runner_checkout" config user.name delivery-test
git -C "$missing_runner_checkout" config user.email delivery-test@example.invalid
rm "$missing_runner_checkout/workflows/kestra/scripts/run-database-delivery.sh"
git -C "$missing_runner_checkout" add workflows/kestra/scripts/run-database-delivery.sh
git -C "$missing_runner_checkout" commit --quiet -m "Create missing runner fixture"
missing_runner_commit="$(git -C "$missing_runner_checkout" rev-parse HEAD)"
git -C "$missing_runner_checkout" push --quiet origin HEAD:main
export VORTEX_GITHUB_COMMIT="$missing_runner_commit"
if "$delivery_script" >"$test_root/missing-runner.log" 2>&1; then
  echo "expected a commit without the fixed runner to be refused" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "selected commit does not contain the required regular delivery runner" \
  "$test_root/missing-runner.log"
git --git-dir="$test_root/remote.git" update-ref refs/heads/main "$commit"
export VORTEX_GITHUB_COMMIT="$commit"

symlink_runner_checkout="$test_root/symlink-runner-checkout"
git clone --quiet "$test_root/remote.git" "$symlink_runner_checkout"
git -C "$symlink_runner_checkout" config user.name delivery-test
git -C "$symlink_runner_checkout" config user.email delivery-test@example.invalid
rm "$symlink_runner_checkout/workflows/kestra/scripts/run-database-delivery.sh"
ln -s ../database-verification.json \
  "$symlink_runner_checkout/workflows/kestra/scripts/run-database-delivery.sh"
git -C "$symlink_runner_checkout" add workflows/kestra/scripts/run-database-delivery.sh
git -C "$symlink_runner_checkout" commit --quiet -m "Create symbolic delivery runner"
symlink_runner_commit="$(git -C "$symlink_runner_checkout" rev-parse HEAD)"
git -C "$symlink_runner_checkout" push --quiet origin HEAD:main
export VORTEX_GITHUB_COMMIT="$symlink_runner_commit"
if "$delivery_script" >"$test_root/symlink-runner.log" 2>&1; then
  echo "expected a symbolic delivery runner to be refused" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "selected commit does not contain the required regular delivery runner" \
  "$test_root/symlink-runner.log"
git --git-dir="$test_root/remote.git" update-ref refs/heads/main "$commit"
export VORTEX_GITHUB_COMMIT="$commit"

symlink_manifest_checkout="$test_root/symlink-manifest-checkout"
git clone --quiet "$test_root/remote.git" "$symlink_manifest_checkout"
git -C "$symlink_manifest_checkout" config user.name delivery-test
git -C "$symlink_manifest_checkout" config user.email delivery-test@example.invalid
mv \
  "$symlink_manifest_checkout/workflows/kestra/database-verification.json" \
  "$symlink_manifest_checkout/workflows/kestra/database-verification-target.json"
ln -s database-verification-target.json \
  "$symlink_manifest_checkout/workflows/kestra/database-verification.json"
git -C "$symlink_manifest_checkout" add workflows/kestra/database-verification.json \
  workflows/kestra/database-verification-target.json
git -C "$symlink_manifest_checkout" commit --quiet -m "Create symbolic verification manifest"
symlink_manifest_commit="$(git -C "$symlink_manifest_checkout" rev-parse HEAD)"
git -C "$symlink_manifest_checkout" push --quiet origin HEAD:main
export VORTEX_GITHUB_COMMIT="$symlink_manifest_commit"
if "$delivery_script" >"$test_root/symlink-manifest.log" 2>&1; then
  echo "expected a symbolic verification manifest to be refused" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "database verification manifest is not a regular file in the selected commit" \
  "$test_root/symlink-manifest.log"
git --git-dir="$test_root/remote.git" update-ref refs/heads/main "$commit"
export VORTEX_GITHUB_COMMIT="$commit"

assert_bootstrap_refusal() {
  local variable="$1"
  local invalid_value="$2"
  local expected_message="$3"
  local original_value="${!variable}"

  export "$variable=$invalid_value"
  if "$delivery_script" >"$test_root/bootstrap-refusal.log" 2>&1; then
    echo "expected invalid bootstrap authority to be refused" >&2
    exit 1
  fi
  grep --fixed-strings --quiet "$expected_message" "$test_root/bootstrap-refusal.log"
  export "$variable=$original_value"
}

assert_bootstrap_refusal VORTEX_GITHUB_REPOSITORY Other/Repository "unexpected repository"
assert_bootstrap_refusal VORTEX_GITHUB_REF refs/heads/untrusted "unexpected Git ref"
assert_bootstrap_refusal VORTEX_GITHUB_COMMIT not-a-commit \
  "Git commit must be a complete non-zero lowercase SHA-1"
assert_bootstrap_refusal VORTEX_EVIDENCE_PATH ../evidence.json \
  "evidence path must be a local JSON filename"

untrusted_commit="$(
  printf '%s\n' 'Untrusted delivery commit' |
    git --git-dir="$test_root/remote.git" commit-tree "${commit}^{tree}"
)"
git --git-dir="$test_root/remote.git" update-ref refs/heads/untrusted "$untrusted_commit"
export VORTEX_GITHUB_COMMIT="$untrusted_commit"
if "$delivery_script" >"$test_root/unreachable.log" 2>&1; then
  echo "expected a commit outside the protected branch to be refused" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "webhook commit is not reachable from the expected protected branch" \
  "$test_root/unreachable.log"
export VORTEX_GITHUB_COMMIT="$commit"

real_git="$(command -v git)"
git_wrapper_directory="$test_root/git-wrapper"
mkdir -p "$git_wrapper_directory"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'if [ "${VORTEX_TEST_ASSERT_TOKEN_FREE_GIT:-}" = true ] &&' \
  '  [ -z "${VORTEX_VERIFIED_RUNNER_SHA256:-}" ] &&' \
  '  [ -n "${VORTEX_DOPPLER_TOKEN:-}" ]; then' \
  '  : >"$VORTEX_TEST_GIT_TOKEN_LEAK_MARKER"' \
  '  exit 97' \
  'fi' \
  '"$VORTEX_TEST_REAL_GIT" "$@" || exit $?' \
  'if [ "${VORTEX_TEST_TAMPER_RUNNER_AFTER_CHECKOUT:-}" = true ] &&' \
  '  [ "${1:-}" = -C ] && [ "${3:-}" = checkout ]; then' \
  '  printf "%s\n" "# post-checkout tamper" >>"$2/workflows/kestra/scripts/run-database-delivery.sh"' \
  'fi' \
  >"$git_wrapper_directory/git"
chmod 0555 "$git_wrapper_directory/git"
original_path="$PATH"
export VORTEX_TEST_REAL_GIT="$real_git"
export PATH="$git_wrapper_directory:$PATH"

export VORTEX_TEST_TAMPER_RUNNER_AFTER_CHECKOUT=true
if "$delivery_script" >"$test_root/tampered-runner.log" 2>&1; then
  echo "expected modified checked-out runner bytes to be refused" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "checked-out delivery runner differs from the selected commit" \
  "$test_root/tampered-runner.log"
unset VORTEX_TEST_TAMPER_RUNNER_AFTER_CHECKOUT

export VORTEX_DOPPLER_TOKEN=local-placeholder
export VORTEX_TEST_ASSERT_TOKEN_FREE_GIT=true
export VORTEX_TEST_GIT_TOKEN_LEAK_MARKER="$test_root/git-token-leaked"
rm -f "$VORTEX_TEST_GIT_TOKEN_LEAK_MARKER"
"$delivery_script"
test ! -e "$VORTEX_TEST_GIT_TOKEN_LEAK_MARKER"
unset VORTEX_DOPPLER_TOKEN VORTEX_TEST_ASSERT_TOKEN_FREE_GIT VORTEX_TEST_GIT_TOKEN_LEAK_MARKER
export PATH="$original_path"
unset VORTEX_TEST_REAL_GIT

# The script path represents an older deployed image. The disposable protected commit below changes
# its runner and verification manifest; success proves the old bootstrap executes commit-owned logic.
older_bootstrap="$test_root/older-bootstrap.sh"
cp "$delivery_script" "$older_bootstrap"
chmod 0555 "$older_bootstrap"
fixture_checkout="$test_root/fixture-checkout"
git clone --quiet "$test_root/remote.git" "$fixture_checkout"
git -C "$fixture_checkout" config user.name delivery-test
git -C "$fixture_checkout" config user.email delivery-test@example.invalid

while read -r proof; do
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    'proof_name="$(basename "$0")"' \
    'printf "%s\\n" "$0" >>"$VORTEX_TEST_CONCURRENCY_PROOF_MARKER"' \
    '[ "${VORTEX_TEST_FAIL_CONCURRENCY_PROOF:-}" != "$proof_name" ]' \
    >"${fixture_checkout}/${proof}"
done < <(jq --raw-output '.concurrencyProofs[].proof' \
  "$fixture_checkout/workflows/kestra/database-verification.json")

parity_migration="supabase/migrations/20990101000000_runner_parity_fixture.sql"
parity_proof="supabase/tests/runner-parity-concurrency.test.sh"
printf '%s\n' \
  '-- Disposable operational-test migration with deliberately multiline schema syntax.' \
  'create' \
  '  schema' \
  '  if not' \
  '  exists' \
  '  vortex_runner_parity authorization postgres;' \
  >"${fixture_checkout}/${parity_migration}"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'proof_name="$(basename "$0")"' \
  'printf "%s\\n" "$0" >>"$VORTEX_TEST_CONCURRENCY_PROOF_MARKER"' \
  '[ "${VORTEX_TEST_FAIL_CONCURRENCY_PROOF:-}" != "$proof_name" ]' \
  >"${fixture_checkout}/${parity_proof}"
jq \
  --arg migration "$parity_migration" \
  --arg proof "$parity_proof" \
  '.concurrencyProofs += [{migration: $migration, proof: $proof, label: "Runner parity fixture"}] |
   .lintSchemas += ["vortex_runner_parity"]' \
  "$fixture_checkout/workflows/kestra/database-verification.json" \
  >"$fixture_checkout/workflows/kestra/database-verification.json.next"
mv \
  "$fixture_checkout/workflows/kestra/database-verification.json.next" \
  "$fixture_checkout/workflows/kestra/database-verification.json"
jq \
  --arg proof "$parity_proof" \
  '.groups |= map(if .id == "record-runtime" then
     .concurrencyPatterns += [$proof] | .lintSchemas += ["vortex_runner_parity"]
   else . end)' \
  "$fixture_checkout/workflows/kestra/database-verification-selection.json" \
  >"$fixture_checkout/workflows/kestra/database-verification-selection.json.next"
mv \
  "$fixture_checkout/workflows/kestra/database-verification-selection.json.next" \
  "$fixture_checkout/workflows/kestra/database-verification-selection.json"
parity_proof_count="$((verification_proof_count + 1))"
readonly parity_proof_count
parity_lint_schema_count="$((verification_lint_schema_count + 1))"
readonly parity_lint_schema_count
printf '%s\n' '# Disposable newer protected-commit runner.' \
  >>"$fixture_checkout/workflows/kestra/scripts/run-database-delivery.sh"
git -C "$fixture_checkout" add --all -- \
  supabase/migrations \
  supabase/tests \
  workflows/kestra/database-verification.json \
  workflows/kestra/database-verification-selection.json \
  workflows/kestra/scripts/run-database-delivery.sh
git -C "$fixture_checkout" commit --quiet -m "Create newer protected runner fixture"
fixture_commit="$(git -C "$fixture_checkout" rev-parse HEAD)"
git -C "$fixture_checkout" push --quiet origin HEAD:main

export VORTEX_GITHUB_COMMIT="$fixture_commit"
export VORTEX_TEST_SOURCE_REPOSITORY="$fixture_checkout"
"$older_bootstrap"
jq --exit-status \
  --arg expected_runner "$(
    git -C "$fixture_checkout" show \
      "${fixture_commit}:workflows/kestra/scripts/run-database-delivery.sh" |
      sha256sum | cut -d' ' -f1
  )" \
  --argjson expected_proof_count "$parity_proof_count" \
  --argjson expected_lint_schema_count "$parity_lint_schema_count" \
  '.schema_version == 3 and
   .status == "prepared" and
   .runner.sha256 == $expected_runner and
   (.selected_concurrency_proofs | length) == $expected_proof_count and
   (.selected_lint_schemas | length) == $expected_lint_schema_count and
   (.selected_lint_schemas[-1]) == "vortex_runner_parity"' \
  "$VORTEX_EVIDENCE_PATH" >/dev/null

testing_full_evidence="$(
  jq --compact-output \
    --arg execution_id testing-run \
    --arg project_ref abflfptnguasinoussws \
    --arg evidence_key "database-testing-full-${fixture_commit}-testing-run" \
    --arg execution_url "https://kestra.abzum.com/ui/main/executions/vortex.operations/testing_database_delivery/testing-run" \
    '.environment = "testing" |
     .ref = "refs/heads/testing" |
     .status = "succeeded" |
     .execution_id = $execution_id |
     .database_project_ref = $project_ref |
     .postgres_server_version_num = 170000 |
     .verification.mode = "full" |
     .verification.source = {
       evidence_key: $evidence_key,
       commit: .commit,
       execution_id: $execution_id,
       execution_url: $execution_url
     } |
     .completed_sql_suites = .selected_sql_suites |
     .completed_concurrency_proofs = .selected_concurrency_proofs |
     .completed_lint_schemas = .selected_lint_schemas |
     .applied_migration_count = (.migrations | length)' \
    "$VORTEX_EVIDENCE_PATH"
)"
export VORTEX_DELIVERY_OPERATION=apply
export VORTEX_APPROVED=true
export VORTEX_APPROVING_ACTOR=local-reviewer
export VORTEX_TESTING_COMMIT="$fixture_commit"
export VORTEX_TESTING_EVIDENCE="$(jq --compact-output '.status = "failed"' <<<"$testing_full_evidence")"
export VORTEX_TESTING_FULL_SOURCE_EVIDENCE="$testing_full_evidence"
if "$older_bootstrap" >"$test_root/refusal.log" 2>&1; then
  echo "expected unsuccessful Testing evidence to be refused" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "stored Testing evidence is invalid or does not cover the Production inputs" \
  "$test_root/refusal.log"

export VORTEX_TESTING_EVIDENCE="$testing_full_evidence"

assert_testing_coverage_refused() {
  local name="$1"
  local evidence_filter="$2"
  local expected_message="${3:-stored Testing evidence is invalid or does not cover the Production inputs}"
  local log="$test_root/${name}.log"

  export VORTEX_TESTING_EVIDENCE="$(jq --compact-output "$evidence_filter" <<<"$testing_full_evidence")"
  if "$older_bootstrap" >"$log" 2>&1; then
    echo "expected ${name} Testing coverage to be refused" >&2
    exit 1
  fi
  grep --fixed-strings --quiet \
    "$expected_message" \
    "$log"
  if grep --fixed-strings --quiet "VORTEX_DOPPLER_TOKEN is not set" "$log"; then
    echo "expected ${name} Testing coverage to be refused before secret access" >&2
    exit 1
  fi
}

assert_testing_coverage_refused \
  partial-sql-coverage \
  '.completed_sql_suites = .completed_sql_suites[0:-1]'
assert_testing_coverage_refused \
  partial-proof-coverage \
  '.completed_concurrency_proofs = .completed_concurrency_proofs[0:-1]'
assert_testing_coverage_refused \
  extra-coverage \
  '.selected_lint_schemas += ["vortex_extra"]'
assert_testing_coverage_refused \
  historical-schema \
  '.schema_version = 2'
assert_testing_coverage_refused \
  reused-without-source \
  '.verification.mode = "reused" | .verification.source = null | .completed_sql_suites = [] | .completed_concurrency_proofs = [] | .completed_lint_schemas = []' \
  'stored Testing source commit is invalid'

export VORTEX_TESTING_EVIDENCE="$testing_full_evidence"

if "$older_bootstrap" >"$test_root/secret-boundary.log" 2>&1; then
  echo "expected the credential-free test to stop before database access" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "VORTEX_DOPPLER_TOKEN is not set" \
  "$test_root/secret-boundary.log"

export PATH="/tests/fixtures:$PATH"
export VORTEX_DOPPLER_TOKEN=local-placeholder
export VORTEX_DOPPLER_PROJECT=local-placeholder
export VORTEX_DOPPLER_CONFIG=local-placeholder
export VORTEX_EXPECTED_DATABASE_PROJECT_REF=abcdefghijklmnopqrst
export VORTEX_TEST_DATABASE_URL_OVERRIDE='postgresql://postgres.abcdefghijklmnopqrst:placeholder%3A%3D%2F%25%3F%26password@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres'
if "$older_bootstrap" >"$test_root/embedded-password.log" 2>&1; then
  echo "expected an embedded database password to be refused" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "database connection must not embed a password" \
  "$test_root/embedded-password.log"

unset VORTEX_TEST_DATABASE_URL_OVERRIDE
export VORTEX_TEST_DATABASE_USER='invalid?role'
if "$older_bootstrap" >"$test_root/invalid-role.log" 2>&1; then
  echo "expected an invalid database role to be refused" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "database connection does not name a Supabase project owner" \
  "$test_root/invalid-role.log"

unset VORTEX_TEST_DATABASE_USER
export VORTEX_TEST_DATABASE_PROJECT_REF=tsrqponmlkjihgfedcba
if "$older_bootstrap" >"$test_root/wrong-project.log" 2>&1; then
  echo "expected a different Supabase project to be refused" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "database connection names the wrong Supabase project" \
  "$test_root/wrong-project.log"

unset VORTEX_TEST_DATABASE_PROJECT_REF
if "$older_bootstrap" >"$test_root/invalid-ca.log" 2>&1; then
  echo "expected an invalid Supabase root certificate to be refused" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "Supabase root certificate is invalid or expires within one day" \
  "$test_root/invalid-ca.log"

openssl req \
  -x509 \
  -newkey rsa:2048 \
  -keyout "$test_root/test-key.pem" \
  -out "$test_root/test-root.crt" \
  -sha256 \
  -days 2 \
  -nodes \
  -subj /CN=local-delivery-test \
  >/dev/null 2>&1
export VORTEX_TEST_SSL_ROOT_CERT="$(<"$test_root/test-root.crt")"
export VORTEX_TEST_EXPECTED_DATABASE_URL='postgresql://postgres.abcdefghijklmnopqrst@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres?sslmode=verify-full'
export VORTEX_DATABASE_URL='postgresql://attacker:password@attacker.invalid:5432/postgres?host=attacker.invalid&sslmode=disable'
export VORTEX_TEST_CONCURRENCY_PROOF_MARKER="$test_root/concurrency-proof-called"
export VORTEX_TEST_SUPABASE_CALL_MARKER="$test_root/supabase-called"

# The known Testing gap is permitted only with the reviewed remote maximum.
# Fake history changes to the complete set only after the migration command runs.
export VORTEX_TEST_INITIAL_HISTORY="$test_root/initial-history.txt"
git -C "$fixture_checkout" ls-tree -r --name-only "$VORTEX_GITHUB_COMMIT" -- supabase/migrations |
  LC_ALL=C sort | sed 's#^supabase/migrations/##' >"$test_root/complete-history.txt"
awk '$0 <= "20260908124240_adopt_shipped_platform_permission_catalogue.sql" &&
     $0 != "20260908122641_record_storage_provisioning.sql"' \
  "$test_root/complete-history.txt" >"$VORTEX_TEST_INITIAL_HISTORY"
rm -f "$VORTEX_TEST_SUPABASE_CALL_MARKER" "$VORTEX_EVIDENCE_PATH"
"$older_bootstrap" >"$test_root/reviewed-gap.log" 2>&1
grep --fixed-strings --quiet -- '--include-all' "$VORTEX_TEST_SUPABASE_CALL_MARKER"
jq --exit-status '.status == "succeeded"' "$VORTEX_EVIDENCE_PATH" >/dev/null

assert_unreviewed_gap_refused() {
  rm -f "$VORTEX_TEST_SUPABASE_CALL_MARKER" "$VORTEX_EVIDENCE_PATH"
  if "$older_bootstrap" >"$test_root/unreviewed-gap.log" 2>&1; then
    echo "expected an unreviewed migration gap to refuse before applying" >&2
    exit 1
  fi
  grep --fixed-strings --quiet 'unreviewed out-of-order migration gap' "$test_root/unreviewed-gap.log"
  test ! -e "$VORTEX_TEST_SUPABASE_CALL_MARKER"
  test ! -e "$VORTEX_EVIDENCE_PATH"
}

# Another missing older migration is not covered by the storage exception.
sed -i '/20260908041122_support_native_application_release_dependencies.sql/d' "$VORTEX_TEST_INITIAL_HISTORY"
assert_unreviewed_gap_refused
# The same storage gap against a newer history is not the reviewed ordering.
grep --fixed-strings --invert-match '20260908122641_record_storage_provisioning.sql' \
  "$test_root/complete-history.txt" >"$VORTEX_TEST_INITIAL_HISTORY"
assert_unreviewed_gap_refused

# An ordinary missing tail and an empty database retain normal CLI behavior.
sed '$d' "$test_root/complete-history.txt" >"$VORTEX_TEST_INITIAL_HISTORY"
rm -f "$VORTEX_TEST_SUPABASE_CALL_MARKER"
"$older_bootstrap" >"$test_root/ordinary-tail.log" 2>&1
if grep --fixed-strings --quiet -- '--include-all' "$VORTEX_TEST_SUPABASE_CALL_MARKER"; then
  echo "ordinary pending migrations must not use the gap exception" >&2; exit 1
fi
unset VORTEX_TEST_INITIAL_HISTORY
export VORTEX_TEST_EMPTY_HISTORY=true
rm -f "$VORTEX_TEST_SUPABASE_CALL_MARKER"
"$older_bootstrap" >"$test_root/empty-history.log" 2>&1
if grep --fixed-strings --quiet -- '--include-all' "$VORTEX_TEST_SUPABASE_CALL_MARKER"; then
  echo "a new database must not use the gap exception" >&2; exit 1
fi
unset VORTEX_TEST_EMPTY_HISTORY

rm -f "$VORTEX_EVIDENCE_PATH"
export VORTEX_TEST_FAIL_PG_PROVE=true
if "$older_bootstrap" >"$test_root/pg-prove-failure.log" 2>&1; then
  echo "expected a failed pgTAP command to fail delivery" >&2
  exit 1
fi
test ! -e "$VORTEX_EVIDENCE_PATH"
unset VORTEX_TEST_FAIL_PG_PROVE

# Lint runs directly after migration apply, so a lint failure must stop delivery
# before any SQL suite or concurrency proof starts.
export VORTEX_TEST_PG_PROVE_MARKER="$test_root/pg-prove-called"
rm -f "$VORTEX_EVIDENCE_PATH" "$VORTEX_TEST_CONCURRENCY_PROOF_MARKER" \
  "$VORTEX_TEST_PG_PROVE_MARKER"
export VORTEX_TEST_FAIL_DATABASE_LINT=true
if "$older_bootstrap" >"$test_root/lint-failure.log" 2>&1; then
  echo "expected a failed database lint command to fail delivery" >&2
  exit 1
fi
test ! -e "$VORTEX_EVIDENCE_PATH"
test ! -e "$VORTEX_TEST_CONCURRENCY_PROOF_MARKER" || {
  echo "expected a lint failure to stop before any concurrency proof" >&2
  exit 1
}
test ! -e "$VORTEX_TEST_PG_PROVE_MARKER" || {
  echo "expected a lint failure to stop before any SQL suite" >&2
  exit 1
}
first_lint_schema="$(jq --raw-output '.lintSchemas[0]' \
  "$fixture_checkout/workflows/kestra/database-verification.json")"
test "$(completed_check_stages "$test_root/lint-failure.log")" = \
  "$(printf '%s\n' migration_apply "lint:${first_lint_schema}")" || {
  echo "expected a lint failure to stop after migration apply and the first lint schema" >&2
  completed_check_stages "$test_root/lint-failure.log" >&2
  exit 1
}
unset VORTEX_TEST_FAIL_DATABASE_LINT VORTEX_TEST_PG_PROVE_MARKER

rm -f "$VORTEX_TEST_CONCURRENCY_PROOF_MARKER"
export VORTEX_TEST_REMOTE_MIGRATION_MISMATCH=true
if "$older_bootstrap" >"$test_root/history-mismatch.log" 2>&1; then
  echo "expected an unreviewed remote migration to be refused" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "remote migration history does not exactly match the selected commit" \
  "$test_root/history-mismatch.log"

unset VORTEX_TEST_REMOTE_MIGRATION_MISMATCH
rm -f "$VORTEX_TEST_SUPABASE_CALL_MARKER" "$VORTEX_EVIDENCE_PATH"
export VORTEX_TEST_POST_APPLY_MISMATCH=true
if "$older_bootstrap" >"$test_root/post-apply-history-mismatch.log" 2>&1; then
  echo "expected post-apply history mismatch to refuse a success receipt" >&2
  exit 1
fi
grep --quiet '^db push ' "$VORTEX_TEST_SUPABASE_CALL_MARKER"
grep --fixed-strings --quiet \
  'remote migration history does not exactly match the selected commit' \
  "$test_root/post-apply-history-mismatch.log"
test ! -e "$VORTEX_EVIDENCE_PATH"
unset VORTEX_TEST_POST_APPLY_MISMATCH
export VORTEX_TEST_PG_PROVE_MARKER="$test_root/pg-prove-called"
rm -f "$VORTEX_EVIDENCE_PATH" "$VORTEX_TEST_CONCURRENCY_PROOF_MARKER"
export VORTEX_TEST_FAIL_CONCURRENCY_PROOF=runner-parity-concurrency.test.sh
if "$older_bootstrap" >"$test_root/proof-failure.log" 2>&1; then
  echo "expected a failed concurrency command to fail delivery" >&2
  exit 1
fi
test ! -e "$VORTEX_EVIDENCE_PATH"
grep --fixed-strings --quiet \
  runner-parity-concurrency.test.sh \
  "$VORTEX_TEST_CONCURRENCY_PROOF_MARKER"
unset VORTEX_TEST_FAIL_CONCURRENCY_PROOF

rm -f "$VORTEX_TEST_CONCURRENCY_PROOF_MARKER"
"$older_bootstrap" >"$test_root/full-order.log" 2>&1
test -f "$VORTEX_TEST_PG_PROVE_MARKER" || {
  echo "expected the successful full run to record SQL suites" >&2
  exit 1
}
test -f "$VORTEX_TEST_CONCURRENCY_PROOF_MARKER" || {
  echo "expected the successful full run to record concurrency proofs" >&2
  exit 1
}
while read -r proof; do
  grep --fixed-strings --quiet "$proof" "$VORTEX_TEST_CONCURRENCY_PROOF_MARKER" || {
    echo "expected the successful full run to record proof ${proof}" >&2
    exit 1
  }
done < <(jq --raw-output '.concurrencyProofs[].proof' \
  "$fixture_checkout/workflows/kestra/database-verification.json")
while IFS= read -r expected_lint_schema; do
  grep --fixed-strings --quiet \
    "db lint --db-url $VORTEX_TEST_EXPECTED_DATABASE_URL --schema $expected_lint_schema --level warning --fail-on error" \
    "$VORTEX_TEST_SUPABASE_CALL_MARKER" || {
    echo "expected the successful full run to lint ${expected_lint_schema}" >&2
    exit 1
  }
done < <(jq --raw-output '.lintSchemas[]' \
  "$fixture_checkout/workflows/kestra/database-verification.json")
if ! jq --exit-status \
  --argjson expected_proof_count "$parity_proof_count" \
  '.status == "succeeded" and
   .environment == "production" and
   .schema_version == 3 and
   .verification.mode == "full" and
   .verification.source.commit == .commit and
   .applied_migration_count == (.migrations | length) and
   .completed_sql_suites == .selected_sql_suites and
   (.completed_concurrency_proofs | length) == $expected_proof_count and
   .completed_concurrency_proofs == .selected_concurrency_proofs and
   .completed_lint_schemas == .selected_lint_schemas and
   .approval.approved_by == "local-reviewer" and
   .approval.testing_execution_id == "testing-run"' \
  "$VORTEX_EVIDENCE_PATH" >/dev/null; then
  echo "expected the successful full run receipt to record complete coverage and approval" >&2
  exit 1
fi
# Every selected check ran exactly once: migration apply, then lint, then SQL
# suites, then concurrency proofs, each in its selected order.
expected_stages="$(jq --raw-output '
  ["migration_apply"] +
  (.selected_lint_schemas | map("lint:" + .)) +
  (.selected_sql_suites | map("sql:" + .)) +
  (.selected_concurrency_proofs | map("proof:" + .)) | .[]' \
  "$VORTEX_EVIDENCE_PATH")"
test "$(completed_check_stages "$test_root/full-order.log")" = "$expected_stages" || {
  echo "expected each selected check to run once: migration, lint, SQL suites, concurrency proofs" >&2
  diff <(completed_check_stages "$test_root/full-order.log") <(printf '%s\n' "$expected_stages") >&2 || true
  exit 1
}

run_logged_bootstrap() {
  local scenario="$1"
  local log="$2"

  if ! "$older_bootstrap" >"$log" 2>&1; then
    echo "${scenario} bootstrap failed; final log lines:" >&2
    tail -n 40 "$log" >&2
    return 1
  fi
}

set_reuse_candidate() {
  printf '%s' "$1" >"$test_root/reuse-candidate.json"
  export VORTEX_REUSE_CANDIDATE_PATH="$test_root/reuse-candidate.json"
  unset VORTEX_REUSE_CANDIDATE
}

# Testing first records an actual full result. A later commit outside the complete
# Supabase/Kestra input fingerprint reuses that direct source after environment and
# exact migration-history validation, without claiming to have executed the suites.
git --git-dir="$test_root/remote.git" update-ref refs/heads/testing "$fixture_commit"
export VORTEX_DELIVERY_ENVIRONMENT=testing
export VORTEX_EXPECTED_REF=refs/heads/testing
export VORTEX_GITHUB_REF=refs/heads/testing
unset \
  VORTEX_APPROVED \
  VORTEX_APPROVING_ACTOR \
  VORTEX_TESTING_COMMIT \
  VORTEX_TESTING_EVIDENCE \
  VORTEX_TESTING_FULL_SOURCE_EVIDENCE
export VORTEX_GITHUB_COMMIT="$fixture_commit"
export VORTEX_EXECUTION_ID=testing-full-baseline
export VORTEX_REUSABLE_BASELINE_PATH=reusable-baseline.json
set_reuse_candidate null
export VORTEX_FORCE_FULL_VERIFICATION=false
rm -f \
  "$VORTEX_EVIDENCE_PATH" \
  "$VORTEX_REUSABLE_BASELINE_PATH" \
  "$VORTEX_TEST_SUPABASE_CALL_MARKER" \
  "$VORTEX_TEST_PG_PROVE_MARKER" \
  "$VORTEX_TEST_CONCURRENCY_PROOF_MARKER"
run_logged_bootstrap "Testing full baseline" "$test_root/testing-full.log"
if ! jq --exit-status \
  '.schema_version == 3 and
   .status == "succeeded" and
   .environment == "testing" and
   .verification.mode == "full" and
   .verification.source.commit == .commit and
   .verification.source.execution_id == "testing-full-baseline" and
   .verification.source.evidence_key == ("database-testing-full-" + .commit + "-testing-full-baseline") and
   .verification.receipt_key == .verification.source.evidence_key and
   .verification.selection.mode == "full" and
   .verification.selection.selector_mode == "full" and
   (.verification.selection.inventory_sha256 | test("^[0-9a-f]{64}$")) and
   (.verification.selection.selector_sha256 | test("^[0-9a-f]{64}$")) and
   (.verification.selection.changed_input_sha256 | test("^[0-9a-f]{64}$")) and
   (.database_state.sha256 | test("^[0-9a-f]{64}$")) and
   .approval == null and
   .postgres_server_version_num == 170000 and
   .completed_sql_suites == .selected_sql_suites and
   .completed_concurrency_proofs == .selected_concurrency_proofs and
   .completed_lint_schemas == .selected_lint_schemas and
   .required_checks == .executed_checks and
   (.reused_checks | length) == 0 and
   (.required_checks | length) == ((.selected_sql_suites + .selected_concurrency_proofs + .selected_lint_schemas) | length) and
   . as $receipt |
   all(.executed_checks[]; .source.evidence_key == $receipt.verification.receipt_key and (.duration_ms | type == "number")) and
   (.stage_timings_ms.sql_suites | type == "number") and
   ([.stage_timings_ms | keys[] | select(startswith("sql:"))] | length) == (.selected_sql_suites | length) and
   ([.stage_timings_ms | keys[] | select(startswith("proof:"))] | length) == (.selected_concurrency_proofs | length)' \
  "$VORTEX_EVIDENCE_PATH" >/dev/null; then
  echo "expected the Testing full baseline receipt to have null approval and complete coverage" >&2
  exit 1
fi
if ! jq --exit-status --slurpfile receipt "$VORTEX_EVIDENCE_PATH" '
  .schema_version == 1 and .commit == $receipt[0].commit and
  .execution_id == $receipt[0].execution_id and
  .receipt_key == $receipt[0].verification.receipt_key and
  .database_state == $receipt[0].database_state and
  .receipt == $receipt[0] and
  (.sources | length) == 1 and
  .sources[0].verification.receipt_key == $receipt[0].verification.receipt_key and
  .sources[0].executed_checks == $receipt[0].executed_checks and
  .sources[0].completed_sql_suites == $receipt[0].completed_sql_suites and
  .sources[0].completed_concurrency_proofs == $receipt[0].completed_concurrency_proofs and
  .sources[0].completed_lint_schemas == $receipt[0].completed_lint_schemas
' "$VORTEX_REUSABLE_BASELINE_PATH" >/dev/null; then
  echo "expected a direct fresh-source coverage baseline" >&2
  exit 1
fi
testing_full_baseline="$(<"$VORTEX_REUSABLE_BASELINE_PATH")"

selected_sql_suite="supabase/tests/000_database_foundation.test.sql"
printf '%s\n' '-- Direct selected verification fixture.' \
  >>"$fixture_checkout/$selected_sql_suite"
git -C "$fixture_checkout" add "$selected_sql_suite"
git -C "$fixture_checkout" commit --quiet -m "Change one database verification check"
reuse_commit="$(git -C "$fixture_checkout" rev-parse HEAD)"
git -C "$fixture_checkout" push --quiet origin HEAD:testing
export VORTEX_GITHUB_COMMIT="$reuse_commit"
export VORTEX_EXECUTION_ID=testing-reused
set_reuse_candidate "$testing_full_baseline"

# A database patch-level change invalidates an otherwise identical baseline.
# This still uses the complete path because the original proof covered a
# different exact server build.
export VORTEX_TEST_SERVER_VERSION_NUM=170001
rm -f \
  "$VORTEX_EVIDENCE_PATH" \
  "$VORTEX_REUSABLE_BASELINE_PATH" \
  "$VORTEX_TEST_SUPABASE_CALL_MARKER"
run_logged_bootstrap \
  "Testing server-version invalidation" \
  "$test_root/testing-server-version-change.log"
jq --exit-status \
  '.verification.mode == "full" and .postgres_server_version_num == 170001' \
  "$VORTEX_EVIDENCE_PATH" >/dev/null
grep --quiet '^db push ' "$VORTEX_TEST_SUPABASE_CALL_MARKER"
unset VORTEX_TEST_SERVER_VERSION_NUM

assert_candidate_forces_full() {
  local name="$1"
  local candidate_filter="$2"
  export VORTEX_EXECUTION_ID="testing-${name}"
  set_reuse_candidate "$(jq --compact-output "$candidate_filter" <<<"$testing_full_baseline")"
  rm -f \
    "$VORTEX_EVIDENCE_PATH" \
    "$VORTEX_REUSABLE_BASELINE_PATH" \
    "$VORTEX_TEST_SUPABASE_CALL_MARKER"
  run_logged_bootstrap "Testing ${name} source refusal" "$test_root/testing-${name}.log"
  jq --exit-status '
    .verification.mode == "full" and
    .executed_checks == .required_checks and
    (.reused_checks | length) == 0
  ' "$VORTEX_EVIDENCE_PATH" >/dev/null
  grep --quiet '^db push ' "$VORTEX_TEST_SUPABASE_CALL_MARKER"
}

assert_candidate_identity_forces_full() {
  local name="$1"
  local candidate_filter="$2"
  export VORTEX_DELIVERY_OPERATION=prepare
  export VORTEX_EXECUTION_ID="testing-${name}"
  set_reuse_candidate "$(jq --compact-output "$candidate_filter" <<<"$testing_full_baseline")"
  rm -f "$VORTEX_EVIDENCE_PATH" "$VORTEX_REUSABLE_BASELINE_PATH"
  run_logged_bootstrap "Testing ${name} identity refusal" "$test_root/testing-${name}.log"
  jq --exit-status '
    .status == "prepared" and
    .verification.mode == "prepared" and
    .verification.selection.mode == "full" and
    .verification.selection.executedChecks == .verification.selection.requiredChecks and
    (.verification.selection.reusedChecks | length) == 0
  ' "$VORTEX_EVIDENCE_PATH" >/dev/null
  export VORTEX_DELIVERY_OPERATION=apply
}

assert_candidate_forces_full malformed-source 'del(.sources[0].executed_checks)'
assert_candidate_forces_full incomplete-source '.sources[0].completed_sql_suites = []'
assert_candidate_forces_full foreign-source '.sources[0].repository = "Other/Repository"'
assert_candidate_forces_full replayed-source '.sources[0].execution_id = "replayed-source"'
assert_candidate_forces_full failed-source '.sources[0].status = "failed"'
assert_candidate_forces_full reuse-chain '.sources[0].executed_checks[0].disposition = "reused"'
assert_candidate_forces_full altered-baseline ".commit = \"$commit\""
assert_candidate_identity_forces_full correlated-commit-tampering \
  ".commit = \"$commit\" | .receipt.commit = \"$commit\" | .receipt.verification.selection.target = \"$commit\""
assert_candidate_identity_forces_full correlated-execution-tampering \
  '.execution_id = "tampered-execution" | .receipt.execution_id = "tampered-execution"'
assert_candidate_identity_forces_full correlated-key-tampering \
  '.receipt_key = "database-testing-full-0000000000000000000000000000000000000001-tampered" |
   .receipt.verification.receipt_key = .receipt_key'
assert_candidate_identity_forces_full unsupported-baseline-mode \
  '.receipt.verification.mode = "aggregate"'

export VORTEX_EXECUTION_ID=testing-state-drift
set_reuse_candidate "$testing_full_baseline"
export VORTEX_TEST_DATABASE_STATE_SNAPSHOT=snapshot-drifted
rm -f "$VORTEX_EVIDENCE_PATH" "$VORTEX_REUSABLE_BASELINE_PATH" "$VORTEX_TEST_SUPABASE_CALL_MARKER"
run_logged_bootstrap "Testing database state drift" "$test_root/testing-state-drift.log"
jq --exit-status '.verification.mode == "full" and .executed_checks == .required_checks' \
  "$VORTEX_EVIDENCE_PATH" >/dev/null
unset VORTEX_TEST_DATABASE_STATE_SNAPSHOT

export VORTEX_EXECUTION_ID=testing-post-state-change
set_reuse_candidate "$testing_full_baseline"
export VORTEX_TEST_DATABASE_STATE_SNAPSHOT_COUNTER="$test_root/post-state-counter"
export VORTEX_TEST_POST_DATABASE_STATE_SNAPSHOT=snapshot-changed-during-selected-run
rm -f \
  "$VORTEX_EVIDENCE_PATH" \
  "$VORTEX_REUSABLE_BASELINE_PATH" \
  "$VORTEX_TEST_DATABASE_STATE_SNAPSHOT_COUNTER"
if "$older_bootstrap" >"$test_root/testing-post-state-change.log" 2>&1; then
  echo "expected a selected run with post-verification state change to fail" >&2
  exit 1
fi
grep --fixed-strings --quiet 'database state changed during selected verification' \
  "$test_root/testing-post-state-change.log"
test ! -e "$VORTEX_EVIDENCE_PATH"
test "$(<"$VORTEX_TEST_DATABASE_STATE_SNAPSHOT_COUNTER")" = 2
unset VORTEX_TEST_POST_DATABASE_STATE_SNAPSHOT VORTEX_TEST_DATABASE_STATE_SNAPSHOT_COUNTER

rm -f \
  "$VORTEX_EVIDENCE_PATH" \
  "$VORTEX_REUSABLE_BASELINE_PATH" \
  "$VORTEX_TEST_SUPABASE_CALL_MARKER" \
  "$VORTEX_TEST_PG_PROVE_MARKER" \
  "$VORTEX_TEST_CONCURRENCY_PROOF_MARKER"
export VORTEX_EXECUTION_ID=testing-selected
set_reuse_candidate "$testing_full_baseline"
run_logged_bootstrap "Testing selected direct check" "$test_root/testing-reused.log"
jq --exit-status \
  --arg source_commit "$fixture_commit" \
  --arg selected_sql_suite "$selected_sql_suite" \
  '.schema_version == 3 and
   .status == "succeeded" and
   .commit == env.VORTEX_GITHUB_COMMIT and
   .verification.mode == "selected" and
   .verification.source == null and
   .verification.baseline.commit == $source_commit and
   .verification.baseline.execution_id == "testing-full-baseline" and
   .selected_sql_suites == [$selected_sql_suite] and
   .completed_sql_suites == [$selected_sql_suite] and
   .completed_concurrency_proofs == [] and
   .completed_lint_schemas == [] and
   (.executed_checks | map(.id)) == ["sql:000_database_foundation"] and
   (.reused_checks | length) > 0 and
   ((.executed_checks + .reused_checks | sort_by(.id)) == .required_checks) and
   all(.reused_checks[]; .source.commit == $source_commit and .source.execution_id == "testing-full-baseline") and
   .applied_migration_count == (.migrations | length)' \
  "$VORTEX_EVIDENCE_PATH" >/dev/null
test ! -e "$VORTEX_TEST_SUPABASE_CALL_MARKER"
test "$(<"$VORTEX_TEST_PG_PROVE_MARKER")" = "$selected_sql_suite"
test ! -e "$VORTEX_TEST_CONCURRENCY_PROOF_MARKER"
jq --exit-status '
  .schema_version == 1 and .commit == env.VORTEX_GITHUB_COMMIT and
  (.sources | length) == 2 and
  ([.sources[].verification.mode] | sort) == ["full", "selected"]
' "$VORTEX_REUSABLE_BASELINE_PATH" >/dev/null
selected_baseline="$(<"$VORTEX_REUSABLE_BASELINE_PATH")"

# Production deliberately rejects selected receipts until a separately reviewed
# aggregate consumer exists; it cannot mistake one direct source for full coverage.
testing_reused_evidence="$(<"$VORTEX_EVIDENCE_PATH")"

# Re-running the original commit creates a distinct immutable full-source key;
# it cannot replace the source named by the already-issued reused receipt.
git --git-dir="$test_root/remote.git" update-ref refs/heads/testing "$fixture_commit"
export VORTEX_GITHUB_COMMIT="$fixture_commit"
export VORTEX_EXECUTION_ID=testing-full-rerun
export VORTEX_FORCE_FULL_VERIFICATION=true
rm -f "$VORTEX_EVIDENCE_PATH" "$VORTEX_TEST_SUPABASE_CALL_MARKER"
run_logged_bootstrap "Testing full-source rerun" "$test_root/testing-full-rerun.log"
jq --exit-status \
  --arg original_key "$(jq --raw-output '.verification.source.evidence_key' <<<"$testing_full_baseline")" \
  '.verification.mode == "full" and
   .verification.source.evidence_key == ("database-testing-full-" + .commit + "-testing-full-rerun") and
   .verification.source.evidence_key != $original_key' \
  "$VORTEX_EVIDENCE_PATH" >/dev/null
git --git-dir="$test_root/remote.git" update-ref refs/heads/testing "$reuse_commit"
export VORTEX_FORCE_FULL_VERIFICATION=false
export VORTEX_GITHUB_COMMIT="$reuse_commit"

export VORTEX_TESTING_EVIDENCE="$(
  jq --compact-output '.database_project_ref = "abflfptnguasinoussws"' \
    <<<"$testing_reused_evidence"
)"
export VORTEX_TESTING_FULL_SOURCE_EVIDENCE="$(
  jq --compact-output '.sources[0].database_project_ref = "abflfptnguasinoussws" | .sources[0]' \
    <<<"$testing_full_baseline"
)"
git --git-dir="$test_root/remote.git" update-ref refs/heads/main "$reuse_commit"
export VORTEX_DELIVERY_ENVIRONMENT=production
export VORTEX_EXPECTED_REF=refs/heads/main
export VORTEX_GITHUB_REF=refs/heads/main
export VORTEX_APPROVED=true
export VORTEX_APPROVING_ACTOR=local-reviewer
export VORTEX_GITHUB_COMMIT="$reuse_commit"
export VORTEX_EXECUTION_ID=production-from-reused-testing
export VORTEX_TESTING_COMMIT="$reuse_commit"
rm -f "$VORTEX_EVIDENCE_PATH"
if "$older_bootstrap" >"$test_root/production-selected-refusal.log" 2>&1; then
  echo "expected Production to reject a selected Testing receipt" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  'stored Testing evidence has an unsupported verification mode' \
  "$test_root/production-selected-refusal.log"

export VORTEX_DELIVERY_ENVIRONMENT=testing
export VORTEX_EXPECTED_REF=refs/heads/testing
export VORTEX_GITHUB_REF=refs/heads/testing
unset \
  VORTEX_APPROVED \
  VORTEX_APPROVING_ACTOR \
  VORTEX_TESTING_COMMIT \
  VORTEX_TESTING_EVIDENCE \
  VORTEX_TESTING_FULL_SOURCE_EVIDENCE

# A descendant with no changed paths executes nothing and still proves complete
# coverage through the same direct fresh receipts, without creating a chain.
git -C "$fixture_checkout" commit --quiet --allow-empty -m "Create unchanged verification descendant"
unchanged_commit="$(git -C "$fixture_checkout" rev-parse HEAD)"
git -C "$fixture_checkout" push --quiet origin HEAD:testing
export VORTEX_GITHUB_COMMIT="$unchanged_commit"
export VORTEX_EXECUTION_ID=testing-unchanged
set_reuse_candidate "$selected_baseline"
export VORTEX_TEST_DATABASE_STATE_SNAPSHOT_COUNTER="$test_root/unchanged-state-counter"
rm -f \
  "$VORTEX_EVIDENCE_PATH" \
  "$VORTEX_REUSABLE_BASELINE_PATH" \
  "$VORTEX_TEST_SUPABASE_CALL_MARKER" \
  "$VORTEX_TEST_PG_PROVE_MARKER" \
  "$VORTEX_TEST_CONCURRENCY_PROOF_MARKER" \
  "$VORTEX_TEST_DATABASE_STATE_SNAPSHOT_COUNTER"
run_logged_bootstrap "Testing unchanged descendant" "$test_root/testing-unchanged.log"
jq --exit-status '
  .verification.mode == "selected" and
  (.executed_checks | length) == 0 and
  .required_checks == .reused_checks and
  .selected_sql_suites == [] and .completed_sql_suites == [] and
  .selected_concurrency_proofs == [] and .completed_concurrency_proofs == [] and
  .selected_lint_schemas == [] and .completed_lint_schemas == []
' "$VORTEX_EVIDENCE_PATH" >/dev/null
test "$(<"$VORTEX_TEST_DATABASE_STATE_SNAPSHOT_COUNTER")" = 2
unset VORTEX_TEST_DATABASE_STATE_SNAPSHOT_COUNTER
test ! -e "$VORTEX_TEST_SUPABASE_CALL_MARKER"
test ! -e "$VORTEX_TEST_PG_PROVE_MARKER"
test ! -e "$VORTEX_TEST_CONCURRENCY_PROOF_MARKER"
jq --exit-status '(.sources | length) == 2 and all(.sources[]; (.executed_checks | length) > 0)' \
  "$VORTEX_REUSABLE_BASELINE_PATH" >/dev/null

# Any change under Supabase or the Kestra operations boundary refuses reuse and
# executes the complete path. The successful result becomes the new full source.
printf '%s\n' '-- Changed verification helper fixture.' \
  >>"$fixture_checkout/supabase/tests/helpers/private-schema-assertions.psql"
git -C "$fixture_checkout" add supabase/tests/helpers/private-schema-assertions.psql
git -C "$fixture_checkout" commit --quiet -m "Change a database verification input"
changed_input_commit="$(git -C "$fixture_checkout" rev-parse HEAD)"
git -C "$fixture_checkout" push --quiet origin HEAD:testing
export VORTEX_GITHUB_COMMIT="$changed_input_commit"
export VORTEX_EXECUTION_ID=testing-changed-input
rm -f \
  "$VORTEX_EVIDENCE_PATH" \
  "$VORTEX_REUSABLE_BASELINE_PATH" \
  "$VORTEX_TEST_SUPABASE_CALL_MARKER" \
  "$VORTEX_TEST_PG_PROVE_MARKER" \
  "$VORTEX_TEST_CONCURRENCY_PROOF_MARKER"
run_logged_bootstrap "Testing changed-input full path" "$test_root/testing-changed-input.log"
jq --exit-status \
  '.verification.mode == "full" and
   .verification.source.commit == env.VORTEX_GITHUB_COMMIT and
   .completed_sql_suites == .selected_sql_suites and
   .completed_concurrency_proofs == .selected_concurrency_proofs and
   .completed_lint_schemas == .selected_lint_schemas' \
  "$VORTEX_EVIDENCE_PATH" >/dev/null
grep --quiet '^db push ' "$VORTEX_TEST_SUPABASE_CALL_MARKER"
test "$(wc -l <"$VORTEX_TEST_PG_PROVE_MARKER" | tr -d '[:space:]')" = \
  "$(jq '.selected_sql_suites | length' "$VORTEX_EVIDENCE_PATH")"

# Manual maintenance can force the full path even when committed inputs match.
changed_input_baseline="$(<"$VORTEX_REUSABLE_BASELINE_PATH")"
printf '%s\n' '# Force-full fixture outside database verification inputs.' \
  >>"$fixture_checkout/docs/testing-verification-reuse-fixture.md"
git -C "$fixture_checkout" add docs/testing-verification-reuse-fixture.md
git -C "$fixture_checkout" commit --quiet -m "Create force-full fixture"
force_full_commit="$(git -C "$fixture_checkout" rev-parse HEAD)"
git -C "$fixture_checkout" push --quiet origin HEAD:testing
export VORTEX_GITHUB_COMMIT="$force_full_commit"
export VORTEX_EXECUTION_ID=testing-force-full
set_reuse_candidate "$changed_input_baseline"
export VORTEX_FORCE_FULL_VERIFICATION=true
rm -f "$VORTEX_EVIDENCE_PATH" "$VORTEX_TEST_SUPABASE_CALL_MARKER"
run_logged_bootstrap "Testing operator-forced full path" "$test_root/testing-force-full.log"
jq --exit-status '.verification.mode == "full"' "$VORTEX_EVIDENCE_PATH" >/dev/null
grep --fixed-strings --quiet 'full verification forced by the operator' \
  "$test_root/testing-force-full.log"
grep --quiet '^db push ' "$VORTEX_TEST_SUPABASE_CALL_MARKER"

echo "database-delivery contract tests passed"
