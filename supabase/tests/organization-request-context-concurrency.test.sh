#!/usr/bin/env bash

set -euo pipefail

readonly proof_root="$(mktemp -d /tmp/vortex-organization-request.XXXXXX)"
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id='13000000-0000-4000-8000-000000000027'
readonly organization_id='23000000-0000-4000-8000-000000000027'
readonly identity_id='43000000-0000-4000-8000-000000000027'
readonly account_id='53000000-0000-4000-8000-000000000027'
readonly actor_id='93000000-0000-4000-8000-000000000027'

psql_command=(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1)
if [ -n "$database_url" ]; then
  psql_command+=("$database_url")
fi

run_sql() {
  "${psql_command[@]}" --command "$1"
}

cleanup() {
  local pid
  while read -r pid; do
    kill "$pid" >/dev/null 2>&1 || true
  done < <(jobs -pr)
  run_sql "
    delete from vortex_access.organization_access_versions where organization_id = '$organization_id';
    delete from vortex_identity.organization_accounts where organization_id = '$organization_id';
    delete from vortex_identity.identity_projections where identity_id = '$identity_id';
    delete from vortex_identity.organizations where organization_id = '$organization_id';
    delete from vortex_identity.tenants where tenant_id = '$tenant_id';
  " >/dev/null 2>&1 || true
  rm -rf "$proof_root"
}
trap cleanup EXIT

run_sql "
  insert into vortex_identity.tenants (
    tenant_id, short_name, display_name, state, created_at, created_by,
    state_changed_at, revision
  ) values (
    '$tenant_id', 'request_context_race', 'Request context race', 'active',
    clock_timestamp(), '$actor_id', clock_timestamp(), 1
  );
  insert into vortex_identity.organizations (
    organization_id, tenant_id, short_name, display_name, state,
    created_at, created_by, state_changed_at, revision
  ) values (
    '$organization_id', '$tenant_id', 'request_context_race',
    'Request context race', 'active', clock_timestamp(), '$actor_id',
    clock_timestamp(), 1
  );
  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values (
    '$identity_id', 'active', clock_timestamp(), clock_timestamp(), '$identity_id',
    '73000000-0000-4000-8000-000000000027', 1
  );
  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name, state,
    activated_at, changed_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values (
    '$account_id', '$organization_id', '$identity_id', 'Request person', 'active',
    clock_timestamp(), clock_timestamp(), clock_timestamp(), '$identity_id',
    '73000000-0000-4000-8000-000000000028', 1
  );
  select * from vortex_access.initialize_organization_access_version(
    '$organization_id', '$actor_id', '73000000-0000-4000-8000-000000000029'
  );
" >/dev/null

PGAPPNAME='vortex-request-context-reader' "${psql_command[@]}" >"$proof_root/reader.log" 2>&1 <<SQL &
begin;
set local role vortex_runtime;
select access_version
from vortex_access.resolve_human_organization_scope('$identity_id', '$organization_id')
\g '$proof_root/resolved.version'
select pg_catalog.pg_sleep(1.5);
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind', 'human',
  'identityAuthorityId', '83000000-0000-4000-8000-000000000027',
  'tenantId', '$tenant_id',
  'organizationId', '$organization_id',
  'organizationAccountId', '$account_id',
  'identityId', '$identity_id',
  'sessionId', '63000000-0000-4000-8000-000000000027',
  'authenticationStrength', 'single_factor',
  'issuedAt', pg_catalog.statement_timestamp() - interval '1 minute',
  'expiresAt', pg_catalog.statement_timestamp() + interval '5 minutes',
  'accessVersion', 1,
  'correlationId', '73000000-0000-4000-8000-000000000030'
));
set local role vortex_request;
select (vortex_access.validated_human_request_context() ->> 'organizationId')
\g '$proof_root/validated.organization'
commit;
SQL
reader_pid=$!

for _ in $(seq 1 200); do
  [ -f "$proof_root/resolved.version" ] && break
  sleep 0.05
done
[ -f "$proof_root/resolved.version" ] || {
  echo 'request resolver did not reach its transaction barrier' >&2
  exit 1
}

PGAPPNAME='vortex-request-context-writer' "${psql_command[@]}" >"$proof_root/writer.log" 2>&1 <<SQL &
begin;
update vortex_identity.organization_accounts
set state = 'suspended',
    suspended_at = pg_catalog.statement_timestamp(),
    changed_at = pg_catalog.statement_timestamp(),
    state_changed_at = pg_catalog.statement_timestamp(),
    state_changed_by = '$actor_id',
    state_change_correlation_id = '73000000-0000-4000-8000-000000000031',
    revision = revision + 1
where organization_account_id = '$account_id';
select current_version
from vortex_access.increment_organization_access_version(
  '$organization_id', '$actor_id',
  '73000000-0000-4000-8000-000000000032',
  'organization_account_suspended'
)
\g '$proof_root/writer.version'
commit;
SQL
writer_pid=$!

sleep 0.4
[ ! -f "$proof_root/writer.version" ] || {
  echo 'authority-changing writer was not blocked by the protected request' >&2
  exit 1
}

wait "$reader_pid"
wait "$writer_pid"

[ "$(tr -d '[:space:]' <"$proof_root/resolved.version")" = '1' ] || {
  echo 'request did not resolve the initial Access version' >&2
  exit 1
}
[ "$(tr -d '[:space:]' <"$proof_root/validated.organization")" = "$organization_id" ] || {
  echo 'request context did not remain valid through protected work' >&2
  exit 1
}
[ "$(tr -d '[:space:]' <"$proof_root/writer.version")" = '2' ] || {
  echo 'authority change did not complete after the request committed' >&2
  exit 1
}

if run_sql "
  set role vortex_runtime;
  select * from vortex_access.resolve_human_organization_scope(
    '$identity_id', '$organization_id'
  );
" >"$proof_root/next-request.log" 2>&1; then
  echo 'the next request accepted a suspended organisation account' >&2
  exit 1
fi
grep -Fq 'Organisation selection is unavailable' "$proof_root/next-request.log"

echo 'organisation request-context concurrency proof passed'
