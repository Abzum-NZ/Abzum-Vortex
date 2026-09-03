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
jq --exit-status \
  '.status == "succeeded" and
   .environment == "production" and
   .applied_migration_count == (.migrations | length) and
   .approval.approved_by == "local-reviewer" and
   .approval.testing_execution_id == "testing-run"' \
  "$VORTEX_EVIDENCE_PATH" >/dev/null

echo "database-delivery contract tests passed"
