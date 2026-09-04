#!/usr/bin/env bash

set -euo pipefail

readonly source_repository="${VORTEX_TEST_SOURCE_REPOSITORY:-/source}"
readonly delivery_script="${VORTEX_TEST_DELIVERY_SCRIPT:-/app/vortex-operations/deliver-database.sh}"
readonly test_root="$(mktemp -d /tmp/vortex-database-delivery-test.XXXXXX)"
trap 'rm -rf "$test_root"' EXIT
cd "$test_root"

git config --global --add safe.directory "$source_repository"
git clone --bare --quiet "$source_repository" "$test_root/remote.git"
git --git-dir="$test_root/remote.git" config user.name delivery-test
git --git-dir="$test_root/remote.git" config user.email delivery-test@example.invalid
commit="$(git -C "$source_repository" rev-parse HEAD)"
git --git-dir="$test_root/remote.git" update-ref refs/heads/main "$commit"
git config --global \
  "url.file://${test_root}/remote.git.insteadOf" \
  https://github.com/Abzum-NZ/Abzum-Vortex.git

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
  '.schema_version == 2 and
   .status == "prepared" and
   .environment == "production" and
   .commit == env.VORTEX_GITHUB_COMMIT and
   .approval == null and
   (.runner.sha256 | test("^[0-9a-f]{64}$")) and
   (.verification_manifest.sha256 | test("^[0-9a-f]{64}$")) and
   (.selected_concurrency_proofs | length) == 7 and
   (.selected_lint_schemas | length) == 5 and
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

assert_partial_concurrency_release_refused \
  supabase/migrations/20260903174244_tenant_organization_foundation.sql \
  supabase/tests/tenant-organization-concurrency.test.sh \
  supabase/migrations/20260903174244_tenant_organization_foundation.sql \
  "tenant and organisation migration has no concurrency proof"
assert_partial_concurrency_release_refused \
  supabase/migrations/20260903174244_tenant_organization_foundation.sql \
  supabase/tests/tenant-organization-concurrency.test.sh \
  supabase/tests/tenant-organization-concurrency.test.sh \
  "tenant and organisation concurrency proof has no migration"
assert_partial_concurrency_release_refused \
  supabase/migrations/20260903231258_definition_publication_operations.sql \
  supabase/tests/definition-publication-concurrency.test.sh \
  supabase/migrations/20260903231258_definition_publication_operations.sql \
  "Definition publication migration has no concurrency proof"
assert_partial_concurrency_release_refused \
  supabase/migrations/20260903231258_definition_publication_operations.sql \
  supabase/tests/definition-publication-concurrency.test.sh \
  supabase/tests/definition-publication-concurrency.test.sh \
  "Definition publication concurrency proof has no migration"
assert_partial_concurrency_release_refused \
  supabase/migrations/20260904025500_definition_consumer_reads.sql \
  supabase/tests/definition-consumer-read-concurrency.test.sh \
  supabase/migrations/20260904025500_definition_consumer_reads.sql \
  "Definition consumer read migration has no concurrency proof"
assert_partial_concurrency_release_refused \
  supabase/migrations/20260904025500_definition_consumer_reads.sql \
  supabase/tests/definition-consumer-read-concurrency.test.sh \
  supabase/tests/definition-consumer-read-concurrency.test.sh \
  "Definition consumer read concurrency proof has no migration"
assert_partial_concurrency_release_refused \
  supabase/migrations/20260904040758_definition_history_restore.sql \
  supabase/tests/definition-history-restore-concurrency.test.sh \
  supabase/migrations/20260904040758_definition_history_restore.sql \
  "Definition history and restore migration has no concurrency proof"
assert_partial_concurrency_release_refused \
  supabase/migrations/20260904040758_definition_history_restore.sql \
  supabase/tests/definition-history-restore-concurrency.test.sh \
  supabase/tests/definition-history-restore-concurrency.test.sh \
  "Definition history and restore concurrency proof has no migration"
assert_partial_concurrency_release_refused \
  supabase/migrations/20260904094030_identity_accounts_invitations.sql \
  supabase/tests/identity-invitation-concurrency.test.sh \
  supabase/migrations/20260904094030_identity_accounts_invitations.sql \
  "Identity invitation migration has no concurrency proof"
assert_partial_concurrency_release_refused \
  supabase/migrations/20260904094030_identity_accounts_invitations.sql \
  supabase/tests/identity-invitation-concurrency.test.sh \
  supabase/tests/identity-invitation-concurrency.test.sh \
  "Identity invitation concurrency proof has no migration"
assert_partial_concurrency_release_refused \
  supabase/migrations/20260904112625_access_version_foundation.sql \
  supabase/tests/access-version-concurrency.test.sh \
  supabase/migrations/20260904112625_access_version_foundation.sql \
  "Access version migration has no concurrency proof"
assert_partial_concurrency_release_refused \
  supabase/migrations/20260904112625_access_version_foundation.sql \
  supabase/tests/access-version-concurrency.test.sh \
  supabase/tests/access-version-concurrency.test.sh \
  "Access version concurrency proof has no migration"
assert_partial_concurrency_release_refused \
  supabase/migrations/20260905043000_organization_request_context.sql \
  supabase/tests/organization-request-context-concurrency.test.sh \
  supabase/migrations/20260905043000_organization_request_context.sql \
  "Organisation request context migration has no concurrency proof"
assert_partial_concurrency_release_refused \
  supabase/migrations/20260905043000_organization_request_context.sql \
  supabase/tests/organization-request-context-concurrency.test.sh \
  supabase/tests/organization-request-context-concurrency.test.sh \
  "Organisation request context concurrency proof has no migration"

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
printf '%s\n' '# Disposable newer protected-commit runner.' \
  >>"$fixture_checkout/workflows/kestra/scripts/run-database-delivery.sh"
git -C "$fixture_checkout" add --all -- \
  supabase/migrations \
  supabase/tests \
  workflows/kestra/database-verification.json \
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
  '.schema_version == 2 and
   .status == "prepared" and
   .runner.sha256 == $expected_runner and
   (.selected_concurrency_proofs | length) == 8 and
   (.selected_lint_schemas | length) == 6 and
   (.selected_lint_schemas[-1]) == "vortex_runner_parity"' \
  "$VORTEX_EVIDENCE_PATH" >/dev/null

migration_set_sha256="$(jq --raw-output '.migration_set_sha256' "$VORTEX_EVIDENCE_PATH")"
runner_sha256="$(jq --raw-output '.runner.sha256' "$VORTEX_EVIDENCE_PATH")"
manifest_sha256="$(jq --raw-output '.verification_manifest.sha256' "$VORTEX_EVIDENCE_PATH")"
coverage_sha256="$(jq --raw-output '.verification_coverage_sha256' "$VORTEX_EVIDENCE_PATH")"
export VORTEX_DELIVERY_OPERATION=apply
export VORTEX_APPROVED=true
export VORTEX_APPROVING_ACTOR=local-reviewer
export VORTEX_TESTING_COMMIT="$fixture_commit"
export VORTEX_TESTING_EXECUTION_ID=testing-run
export VORTEX_TESTING_MIGRATION_SET_SHA256="$migration_set_sha256"
export VORTEX_TESTING_EVIDENCE_SCHEMA_VERSION=2
export VORTEX_TESTING_EVIDENCE_ENVIRONMENT=testing
export VORTEX_TESTING_EVIDENCE_REPOSITORY=Abzum-NZ/Abzum-Vortex
export VORTEX_TESTING_EVIDENCE_REF=refs/heads/testing
export VORTEX_TESTING_EVIDENCE_COMMIT="$fixture_commit"
export VORTEX_TESTING_EVIDENCE_SUPABASE_CLI_VERSION=2.116.0
export VORTEX_TESTING_EVIDENCE_POSTGRES_MAJOR=17
export VORTEX_TESTING_EVIDENCE_RUNNER_SHA256="$runner_sha256"
export VORTEX_TESTING_EVIDENCE_MANIFEST_SHA256="$manifest_sha256"
export VORTEX_TESTING_EVIDENCE_COVERAGE_SHA256="$coverage_sha256"

export VORTEX_TESTING_EVIDENCE_STATUS=failed
if "$older_bootstrap" >"$test_root/refusal.log" 2>&1; then
  echo "expected unsuccessful Testing evidence to be refused" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "stored Testing evidence does not record a successful run" \
  "$test_root/refusal.log"

export VORTEX_TESTING_EVIDENCE_STATUS=succeeded
export VORTEX_TESTING_EVIDENCE_SCHEMA_VERSION=1
if "$older_bootstrap" >"$test_root/v1-evidence.log" 2>&1; then
  echo "expected a historical v1 receipt to be refused for Production approval" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "stored Testing evidence uses an unsupported schema" \
  "$test_root/v1-evidence.log"
export VORTEX_TESTING_EVIDENCE_SCHEMA_VERSION=2

export VORTEX_TESTING_EVIDENCE_RUNNER_SHA256="$(printf '0%.0s' {1..64})"
if "$older_bootstrap" >"$test_root/runner-evidence.log" 2>&1; then
  echo "expected mismatched Testing runner evidence to be refused" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "Production runner differs from the successful Testing runner" \
  "$test_root/runner-evidence.log"
export VORTEX_TESTING_EVIDENCE_RUNNER_SHA256="$runner_sha256"

export VORTEX_TESTING_EVIDENCE_MANIFEST_SHA256="$(printf '0%.0s' {1..64})"
if "$older_bootstrap" >"$test_root/manifest-evidence.log" 2>&1; then
  echo "expected mismatched Testing manifest evidence to be refused" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "Production verification manifest differs from successful Testing" \
  "$test_root/manifest-evidence.log"
export VORTEX_TESTING_EVIDENCE_MANIFEST_SHA256="$manifest_sha256"

export VORTEX_TESTING_EVIDENCE_COVERAGE_SHA256="$(printf '0%.0s' {1..64})"
if "$older_bootstrap" >"$test_root/coverage-evidence.log" 2>&1; then
  echo "expected mismatched Testing coverage evidence to be refused" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "stored Testing evidence did not complete the current verification coverage" \
  "$test_root/coverage-evidence.log"
export VORTEX_TESTING_EVIDENCE_COVERAGE_SHA256="$coverage_sha256"

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

rm -f "$VORTEX_EVIDENCE_PATH"
export VORTEX_TEST_FAIL_PG_PROVE=true
if "$older_bootstrap" >"$test_root/pg-prove-failure.log" 2>&1; then
  echo "expected a failed pgTAP command to fail delivery" >&2
  exit 1
fi
test ! -e "$VORTEX_EVIDENCE_PATH"
unset VORTEX_TEST_FAIL_PG_PROVE

rm -f "$VORTEX_EVIDENCE_PATH" "$VORTEX_TEST_CONCURRENCY_PROOF_MARKER"
export VORTEX_TEST_FAIL_DATABASE_LINT=true
if "$older_bootstrap" >"$test_root/lint-failure.log" 2>&1; then
  echo "expected a failed database lint command to fail delivery" >&2
  exit 1
fi
test ! -e "$VORTEX_EVIDENCE_PATH"
test "$(wc -l <"$VORTEX_TEST_CONCURRENCY_PROOF_MARKER" | tr -d '[:space:]')" = "8"
unset VORTEX_TEST_FAIL_DATABASE_LINT

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
"$older_bootstrap"
test -f "$VORTEX_TEST_PG_PROVE_MARKER"
test -f "$VORTEX_TEST_CONCURRENCY_PROOF_MARKER"
grep --fixed-strings --quiet \
  "supabase/tests/tenant-organization-concurrency.test.sh" \
  "$VORTEX_TEST_CONCURRENCY_PROOF_MARKER"
grep --fixed-strings --quiet \
  "supabase/tests/definition-publication-concurrency.test.sh" \
  "$VORTEX_TEST_CONCURRENCY_PROOF_MARKER"
grep --fixed-strings --quiet \
  "supabase/tests/definition-consumer-read-concurrency.test.sh" \
  "$VORTEX_TEST_CONCURRENCY_PROOF_MARKER"
grep --fixed-strings --quiet \
  "supabase/tests/definition-history-restore-concurrency.test.sh" \
  "$VORTEX_TEST_CONCURRENCY_PROOF_MARKER"
grep --fixed-strings --quiet \
  "supabase/tests/identity-invitation-concurrency.test.sh" \
  "$VORTEX_TEST_CONCURRENCY_PROOF_MARKER"
grep --fixed-strings --quiet \
  "supabase/tests/access-version-concurrency.test.sh" \
  "$VORTEX_TEST_CONCURRENCY_PROOF_MARKER"
grep --fixed-strings --quiet \
  "supabase/tests/organization-request-context-concurrency.test.sh" \
  "$VORTEX_TEST_CONCURRENCY_PROOF_MARKER"
grep --fixed-strings --quiet \
  "runner-parity-concurrency.test.sh" \
  "$VORTEX_TEST_CONCURRENCY_PROOF_MARKER"
grep --fixed-strings --quiet \
  "db lint --db-url $VORTEX_TEST_EXPECTED_DATABASE_URL --schema public,vortex_context,vortex_identity,vortex_definition,vortex_access,vortex_runner_parity --level warning --fail-on error" \
  "$VORTEX_TEST_SUPABASE_CALL_MARKER"
jq --exit-status \
  '.status == "succeeded" and
   .environment == "production" and
   .schema_version == 2 and
   .applied_migration_count == (.migrations | length) and
   (.completed_concurrency_proofs | length) == 8 and
   .completed_concurrency_proofs == .selected_concurrency_proofs and
   .completed_lint_schemas == .selected_lint_schemas and
   .approval.approved_by == "local-reviewer" and
   .approval.testing_execution_id == "testing-run"' \
  "$VORTEX_EVIDENCE_PATH" >/dev/null

echo "database-delivery contract tests passed"
