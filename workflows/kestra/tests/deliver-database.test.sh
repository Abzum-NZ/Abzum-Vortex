#!/usr/bin/env bash

set -euo pipefail

readonly source_repository="${VORTEX_TEST_SOURCE_REPOSITORY:-/source}"
readonly delivery_script="${VORTEX_TEST_DELIVERY_SCRIPT:-/app/vortex-operations/deliver-database.sh}"
readonly test_root="$(mktemp -d /tmp/vortex-database-delivery-test.XXXXXX)"
trap 'rm -rf "$test_root"' EXIT

git config --global --add safe.directory "$source_repository"
git clone --bare --quiet "$source_repository" "$test_root/remote.git"
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
export VORTEX_EVIDENCE_PATH="$test_root/evidence.json"

export VORTEX_DELIVERY_OPERATION=prepare
"$delivery_script"
jq --exit-status \
  '.status == "prepared" and
   .environment == "production" and
   .commit == env.VORTEX_GITHUB_COMMIT and
   .approval == null and
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

migration_set_sha256="$(jq --raw-output '.migration_set_sha256' "$VORTEX_EVIDENCE_PATH")"
export VORTEX_DELIVERY_OPERATION=apply
export VORTEX_APPROVED=true
export VORTEX_APPROVING_ACTOR=local-reviewer
export VORTEX_TESTING_COMMIT="$commit"
export VORTEX_TESTING_EXECUTION_ID=testing-run
export VORTEX_TESTING_MIGRATION_SET_SHA256="$migration_set_sha256"
export VORTEX_TESTING_EVIDENCE_SCHEMA_VERSION=1
export VORTEX_TESTING_EVIDENCE_ENVIRONMENT=testing
export VORTEX_TESTING_EVIDENCE_REPOSITORY=Abzum-NZ/Abzum-Vortex
export VORTEX_TESTING_EVIDENCE_REF=refs/heads/testing
export VORTEX_TESTING_EVIDENCE_COMMIT="$commit"
export VORTEX_TESTING_EVIDENCE_SUPABASE_CLI_VERSION=2.116.0
export VORTEX_TESTING_EVIDENCE_POSTGRES_MAJOR=17

export VORTEX_TESTING_EVIDENCE_STATUS=failed
if "$delivery_script" >"$test_root/refusal.log" 2>&1; then
  echo "expected unsuccessful Testing evidence to be refused" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "stored Testing evidence does not record a successful run" \
  "$test_root/refusal.log"

export VORTEX_TESTING_EVIDENCE_STATUS=succeeded
if "$delivery_script" >"$test_root/secret-boundary.log" 2>&1; then
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
if "$delivery_script" >"$test_root/embedded-password.log" 2>&1; then
  echo "expected an embedded database password to be refused" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "database connection must not embed a password" \
  "$test_root/embedded-password.log"

unset VORTEX_TEST_DATABASE_URL_OVERRIDE
export VORTEX_TEST_DATABASE_USER='invalid?role'
if "$delivery_script" >"$test_root/invalid-role.log" 2>&1; then
  echo "expected an invalid database role to be refused" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "database connection does not name a Supabase project owner" \
  "$test_root/invalid-role.log"

unset VORTEX_TEST_DATABASE_USER
export VORTEX_TEST_DATABASE_PROJECT_REF=tsrqponmlkjihgfedcba
if "$delivery_script" >"$test_root/wrong-project.log" 2>&1; then
  echo "expected a different Supabase project to be refused" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "database connection names the wrong Supabase project" \
  "$test_root/wrong-project.log"

unset VORTEX_TEST_DATABASE_PROJECT_REF
if "$delivery_script" >"$test_root/invalid-ca.log" 2>&1; then
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
export VORTEX_TEST_REMOTE_MIGRATION_MISMATCH=true
if "$delivery_script" >"$test_root/history-mismatch.log" 2>&1; then
  echo "expected an unreviewed remote migration to be refused" >&2
  exit 1
fi
grep --fixed-strings --quiet \
  "remote migration history does not exactly match the selected commit" \
  "$test_root/history-mismatch.log"

unset VORTEX_TEST_REMOTE_MIGRATION_MISMATCH
export VORTEX_TEST_PG_PROVE_MARKER="$test_root/pg-prove-called"
"$delivery_script"
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
jq --exit-status \
  '.status == "succeeded" and
   .environment == "production" and
   .applied_migration_count == (.migrations | length) and
   .approval.approved_by == "local-reviewer" and
   .approval.testing_execution_id == "testing-run"' \
  "$VORTEX_EVIDENCE_PATH" >/dev/null

echo "database-delivery contract tests passed"
