#!/usr/bin/env bash

set -euo pipefail

readonly EXPECTED_REPOSITORY="Abzum-NZ/Abzum-Vortex"
readonly REPOSITORY_URL="https://github.com/Abzum-NZ/Abzum-Vortex.git"
readonly EXPECTED_SUPABASE_VERSION="2.116.0"
readonly EXPECTED_PG_PROVE_VERSION="pg_prove 3.36"
readonly EXPECTED_POSTGRES_MAJOR="17"

die() {
  echo "database-delivery: FAILED: $*" >&2
  exit 1
}

say() {
  echo "database-delivery: $*"
}

prepare_database_only_checkout() {
  local config_path="${checkout}/supabase/config.toml"
  local temporary_config="${config_path}.database-delivery"

  [ -f "$config_path" ] || die "Supabase configuration is missing"

  # Hosted migrations do not use the Local-only Auth signing key. The Supabase CLI parses the
  # complete configuration before `db push`, so remove only that path from this disposable checkout
  # instead of generating or copying a private signing key into the workflow runner.
  sed \
    '/^[[:space:]]*signing_keys_path[[:space:]]*=/d' \
    "$config_path" >"$temporary_config"
  mv "$temporary_config" "$config_path"
}

require_variable() {
  local name="$1"
  [ -n "${!name:-}" ] || die "${name} is not set"
}

is_commit() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] && [[ ! "$1" =~ ^0{40}$ ]]
}

validate_plain_value() {
  local name="$1"
  local value="${!name}"
  [[ "$value" =~ ^[A-Za-z0-9._:/@+-]+$ ]] || die "${name} contains unsupported characters"
}

migration_digest() {
  local revision="$1"
  local file
  local files=()

  mapfile -t files < <(
    git -C "$checkout" ls-tree -r --name-only "$revision" -- supabase/migrations |
      LC_ALL=C sort
  )

  [ "${#files[@]}" -gt 0 ] || die "${revision} contains no database migrations"

  for file in "${files[@]}"; do
    [[ "$file" =~ ^supabase/migrations/[0-9]{14}_[a-z0-9_]+\.sql$ ]] ||
      die "migration path does not follow the required format"
    printf '%s\n' "$file"
    git -C "$checkout" show "${revision}:${file}" | sha256sum | cut -d' ' -f1
  done | sha256sum | cut -d' ' -f1
}

write_evidence() {
  local status="$1"
  local applied_count="${2:-0}"
  local migrations_json

  migrations_json="$({
    git -C "$checkout" ls-tree -r --name-only "$commit" -- supabase/migrations |
      LC_ALL=C sort
  } | jq --raw-input --slurp 'split("\n") | map(select(length > 0))')"

  jq --null-input \
    --arg schema_version "1" \
    --arg environment "$VORTEX_DELIVERY_ENVIRONMENT" \
    --arg repository "$VORTEX_GITHUB_REPOSITORY" \
    --arg ref "$VORTEX_GITHUB_REF" \
    --arg commit "$commit" \
    --arg migration_set_sha256 "$migration_set_sha256" \
    --arg supabase_cli_version "$EXPECTED_SUPABASE_VERSION" \
    --arg postgres_major "$EXPECTED_POSTGRES_MAJOR" \
    --arg status "$status" \
    --arg execution_id "${VORTEX_EXECUTION_ID:-local}" \
    --arg approved_by "${VORTEX_APPROVING_ACTOR:-}" \
    --arg testing_commit "${VORTEX_TESTING_COMMIT:-}" \
    --arg testing_execution_id "${VORTEX_TESTING_EXECUTION_ID:-}" \
    --argjson applied_migration_count "$applied_count" \
    --argjson migrations "$migrations_json" \
    '{
      schema_version: ($schema_version | tonumber),
      environment: $environment,
      repository: $repository,
      ref: $ref,
      commit: $commit,
      migration_set_sha256: $migration_set_sha256,
      migrations: $migrations,
      supabase_cli_version: $supabase_cli_version,
      postgres_major: ($postgres_major | tonumber),
      status: $status,
      execution_id: $execution_id,
      approval: (if $approved_by == "" then null else {
        approved_by: $approved_by,
        testing_commit: $testing_commit,
        testing_execution_id: $testing_execution_id
      } end),
      applied_migration_count: $applied_migration_count
    }' >"$VORTEX_EVIDENCE_PATH"
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

mkdir -p "$(dirname "$VORTEX_EVIDENCE_PATH")"
workdir="$(mktemp -d /tmp/vortex-database-delivery.XXXXXX)"
readonly workdir
checkout="${workdir}/repository"
readonly checkout
trap 'rm -rf "$workdir"' EXIT

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

migration_set_sha256="$(migration_digest "$commit")"
readonly migration_set_sha256
say "validated ${VORTEX_DELIVERY_ENVIRONMENT} commit ${commit} with migration set ${migration_set_sha256}"

if [ "$VORTEX_DELIVERY_OPERATION" = "prepare" ]; then
  write_evidence prepared 0
  say "preparation evidence written without connecting to a database"
  exit 0
fi

if [ "$VORTEX_DELIVERY_ENVIRONMENT" = "production" ]; then
  require_variable VORTEX_APPROVED
  require_variable VORTEX_APPROVING_ACTOR
  require_variable VORTEX_TESTING_COMMIT
  require_variable VORTEX_TESTING_EXECUTION_ID
  require_variable VORTEX_TESTING_MIGRATION_SET_SHA256
  require_variable VORTEX_TESTING_EVIDENCE_SCHEMA_VERSION
  require_variable VORTEX_TESTING_EVIDENCE_ENVIRONMENT
  require_variable VORTEX_TESTING_EVIDENCE_REPOSITORY
  require_variable VORTEX_TESTING_EVIDENCE_REF
  require_variable VORTEX_TESTING_EVIDENCE_COMMIT
  require_variable VORTEX_TESTING_EVIDENCE_STATUS
  require_variable VORTEX_TESTING_EVIDENCE_SUPABASE_CLI_VERSION
  require_variable VORTEX_TESTING_EVIDENCE_POSTGRES_MAJOR
  [ "$VORTEX_APPROVED" = "true" ] || die "production approval was not granted"
  is_commit "$VORTEX_TESTING_COMMIT" || die "approved Testing commit is invalid"
  [[ "$VORTEX_TESTING_MIGRATION_SET_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
    die "approved Testing migration-set fingerprint is invalid"
  validate_plain_value VORTEX_APPROVING_ACTOR
  validate_plain_value VORTEX_TESTING_EXECUTION_ID
  [ "$VORTEX_TESTING_EVIDENCE_SCHEMA_VERSION" = "1" ] ||
    die "stored Testing evidence uses an unsupported schema"
  [ "$VORTEX_TESTING_EVIDENCE_ENVIRONMENT" = "testing" ] ||
    die "stored evidence is not from Testing"
  [ "$VORTEX_TESTING_EVIDENCE_REPOSITORY" = "$EXPECTED_REPOSITORY" ] ||
    die "stored Testing evidence is for another repository"
  [ "$VORTEX_TESTING_EVIDENCE_REF" = "refs/heads/testing" ] ||
    die "stored evidence is not from the protected Testing branch"
  [ "$VORTEX_TESTING_EVIDENCE_COMMIT" = "$VORTEX_TESTING_COMMIT" ] ||
    die "stored Testing evidence does not match the approved commit"
  [ "$VORTEX_TESTING_EVIDENCE_STATUS" = "succeeded" ] ||
    die "stored Testing evidence does not record a successful run"
  [ "$VORTEX_TESTING_EVIDENCE_SUPABASE_CLI_VERSION" = "$EXPECTED_SUPABASE_VERSION" ] ||
    die "stored Testing evidence used another Supabase CLI version"
  [ "$VORTEX_TESTING_EVIDENCE_POSTGRES_MAJOR" = "$EXPECTED_POSTGRES_MAJOR" ] ||
    die "stored Testing evidence used another PostgreSQL major"

  git -C "$checkout" fetch --quiet --no-tags origin "$VORTEX_TESTING_COMMIT"
  git -C "$checkout" merge-base --is-ancestor "$VORTEX_TESTING_COMMIT" "$commit" ||
    die "approved Testing commit is not an ancestor of the Production commit"
  testing_migration_set_sha256="$(migration_digest "$VORTEX_TESTING_COMMIT")"
  [ "$testing_migration_set_sha256" = "$VORTEX_TESTING_MIGRATION_SET_SHA256" ] ||
    die "approved Testing evidence does not match its commit"
  [ "$testing_migration_set_sha256" = "$migration_set_sha256" ] ||
    die "Production migration set differs from the approved Testing migration set"
fi

require_variable VORTEX_DOPPLER_TOKEN
require_variable VORTEX_DOPPLER_PROJECT
require_variable VORTEX_DOPPLER_CONFIG
require_variable VORTEX_EXPECTED_DATABASE_PROJECT_REF
[[ "$VORTEX_EXPECTED_DATABASE_PROJECT_REF" =~ ^[a-z0-9]{20}$ ]] ||
  die "expected Supabase project reference is invalid"

export DOPPLER_TOKEN="$VORTEX_DOPPLER_TOKEN"
read_doppler_secret() {
  doppler secrets get "$1" \
    --plain \
    --project "$VORTEX_DOPPLER_PROJECT" \
    --config "$VORTEX_DOPPLER_CONFIG" \
    --no-check-version \
    --silent
}

export VORTEX_DATABASE_PASSWORD="$(read_doppler_secret VORTEX_MIGRATION_DATABASE_PASSWORD)"
export VORTEX_DATABASE_CONNECTION="$(read_doppler_secret VORTEX_MIGRATION_DATABASE_URL)"
export VORTEX_DATABASE_SSL_ROOT_CERT="$(read_doppler_secret VORTEX_DATABASE_SSL_ROOT_CERT)"
unset DOPPLER_TOKEN VORTEX_DOPPLER_TOKEN
require_variable VORTEX_DATABASE_PASSWORD
require_variable VORTEX_DATABASE_CONNECTION
require_variable VORTEX_DATABASE_SSL_ROOT_CERT

connection_without_scheme="${VORTEX_DATABASE_CONNECTION#postgresql://}"
[ "$connection_without_scheme" != "$VORTEX_DATABASE_CONNECTION" ] ||
  die "database connection must use postgresql"
connection_credentials="${connection_without_scheme%%@*}"
connection_host_path="${connection_without_scheme#*@}"
[ "$connection_host_path" != "$connection_without_scheme" ] ||
  die "database connection has no host"
[[ "$connection_credentials" != *:* ]] ||
  die "database connection must not embed a password"
database_user="$connection_credentials"
database_host_port="${connection_host_path%%/*}"
database_name="${connection_host_path#*/}"
database_host="${database_host_port%:*}"
database_port="${database_host_port##*:}"

[[ "$database_user" =~ ^postgres\.[a-z0-9]{20}$ ]] ||
  die "database connection does not name a Supabase project owner"
database_project_ref="${database_user#postgres.}"
[ "$database_project_ref" = "$VORTEX_EXPECTED_DATABASE_PROJECT_REF" ] ||
  die "database connection names the wrong Supabase project"
[[ "$database_host" =~ ^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$ ]] ||
  die "database connection does not name the Supabase session pooler"
[ "$database_port" = "5432" ] || die "database connection is not session mode"
[ "$database_name" = "postgres" ] || die "database connection does not name postgres"
unset VORTEX_DATABASE_CONNECTION

database_url="postgresql://${database_user}@${database_host}:5432/postgres?sslmode=verify-full"
readonly database_url

database_ssl_root_cert="${workdir}/supabase-root.crt"
readonly database_ssl_root_cert
umask 077
printf '%s\n' "$VORTEX_DATABASE_SSL_ROOT_CERT" >"$database_ssl_root_cert"
openssl x509 -in "$database_ssl_root_cert" -noout -checkend 86400 >/dev/null 2>&1 ||
  die "Supabase root certificate is invalid or expires within one day"
unset VORTEX_DATABASE_SSL_ROOT_CERT
export PGPASSWORD="$VORTEX_DATABASE_PASSWORD"
unset VORTEX_DATABASE_PASSWORD
export PGSSLMODE=verify-full
export PGSSLROOTCERT="$database_ssl_root_cert"
export SSL_CERT_FILE="$database_ssl_root_cert"

[ "$(supabase --version)" = "$EXPECTED_SUPABASE_VERSION" ] || die "unexpected Supabase CLI version"
[ "$(pg_prove --version)" = "$EXPECTED_PG_PROVE_VERSION" ] || die "unexpected pg_prove version"
export PGCONNECT_TIMEOUT=15
server_version_num="$(psql "$database_url" --no-psqlrc --tuples-only --no-align \
  --command "select current_setting('server_version_num')")"
[[ "$server_version_num" =~ ^[0-9]+$ ]] || die "database returned an invalid server version"
[ "$((server_version_num / 10000))" = "$EXPECTED_POSTGRES_MAJOR" ] ||
  die "database PostgreSQL major does not match the reviewed project configuration"

say "applying pending migrations through Supabase migration history"
(
  cd "$checkout"
  prepare_database_only_checkout
  supabase db push --db-url "$database_url" --skip-vault --yes
  pg_prove \
    --dbname "$database_name" \
    --username "$database_user" \
    --host "$database_host" \
    --port "$database_port" \
    --ext .sql \
    --recurse \
    supabase/tests
  supabase db lint \
    --db-url "$database_url" \
    --schema "${VORTEX_LINT_SCHEMAS:-public,vortex_context}" \
    --level warning \
    --fail-on error
)

local_history="${workdir}/local-migration-history.txt"
remote_history="${workdir}/remote-migration-history.txt"
git -C "$checkout" ls-tree -r --name-only "$commit" -- supabase/migrations |
  LC_ALL=C sort |
  sed 's#^supabase/migrations/##' >"$local_history"
psql "$database_url" --no-psqlrc --tuples-only --no-align \
  --command "select version || case when coalesce(name, '') = '' then '' else '_' || name end || '.sql' from supabase_migrations.schema_migrations order by version, name" \
  >"$remote_history"
cmp --silent "$local_history" "$remote_history" ||
  die "remote migration history does not exactly match the selected commit"

applied_count="$(wc -l <"$remote_history" | tr -d '[:space:]')"
[[ "$applied_count" =~ ^[0-9]+$ ]] || die "migration history returned an invalid count"
write_evidence succeeded "$applied_count"
say "migration, database tests, and lint succeeded; evidence contains no credential"
