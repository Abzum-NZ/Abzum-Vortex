#!/usr/bin/env bash

set -euo pipefail

run_uuid="${VORTEX_REQUEST_CONTEXT_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then
  [ -r /proc/sys/kernel/random/uuid ] || {
    echo 'a Linux random UUID source is required for the request-context proof' >&2
    exit 1
  }
  IFS= read -r run_uuid </proc/sys/kernel/random/uuid
fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  echo 'VORTEX_REQUEST_CONTEXT_PROOF_RUN_ID must be a lowercase UUID v4' >&2
  exit 1
}

readonly run_uuid
readonly run_token="${run_uuid//-/}"
readonly fixture_short_name="request_${run_token:0:24}"
proof_root="$(mktemp -d /tmp/vortex-organization-request.XXXXXX)"
readonly proof_root
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id="13${run_uuid:2}"
readonly organization_id="23${run_uuid:2}"
readonly target_identity_id="43${run_uuid:2}"
readonly actor_identity_id="44${run_uuid:2}"
readonly foreign_identity_id="45${run_uuid:2}"
readonly target_account_id="53${run_uuid:2}"
readonly actor_account_id="54${run_uuid:2}"
readonly identity_authority_id="83${run_uuid:2}"
readonly session_id="63${run_uuid:2}"
readonly correlation_initialize="73${run_uuid:2}"
readonly correlation_r1_reader="74${run_uuid:2}"
readonly correlation_r1_writer="75${run_uuid:2}"
readonly correlation_reactivate="76${run_uuid:2}"
readonly correlation_r2_writer="77${run_uuid:2}"

fixture_claimed=0
declare -a worker_pids=()
declare -A reaped_worker_pids=()

psql_command=(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1)
if [ -n "$database_url" ]; then psql_command+=("$database_url"); fi

run_sql() { "${psql_command[@]}" --command "$1"; }

wait_for_file() {
  local candidate="$1"
  local deadline=$((SECONDS + 20))
  while ((SECONDS < deadline)); do
    [ -f "$candidate" ] && return 0
    sleep 0.05
  done
  echo 'request-context proof did not reach its transaction barrier' >&2
  return 1
}

read_backend_pid() {
  local candidate="$1"
  local backend_pid
  wait_for_file "$candidate"
  backend_pid="$(tr -d '[:space:]' <"$candidate")"
  [[ "$backend_pid" =~ ^[1-9][0-9]*$ ]] || {
    printf 'request-context proof captured an invalid backend identifier: %q\n' "$backend_pid" >&2
    return 1
  }
  printf '%s\n' "$backend_pid"
}

wait_for_database_blocker() {
  local blocked_pid="$1"
  local blocking_pid="$2"
  local description="$3"
  local deadline=$((SECONDS + 20))
  local state
  while ((SECONDS < deadline)); do
    state="$(run_sql "select case when $blocking_pid = any(pg_catalog.pg_blocking_pids($blocked_pid)) then 'blocked' else '' end;")"
    [ "$state" = 'blocked' ] && return 0
    sleep 0.1
  done
  echo "request-context proof did not observe $description" >&2
  return 1
}

wait_owned_worker() {
  local pid="$1"
  local status
  if wait "$pid"; then status=0; else status=$?; fi
  reaped_worker_pids["$pid"]=1
  return "$status"
}

stop_owned_workers() {
  local pid
  for pid in "${worker_pids[@]}"; do
    if [ "${reaped_worker_pids[$pid]:-0}" != 1 ] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
  for pid in "${worker_pids[@]}"; do
    if [ "${reaped_worker_pids[$pid]:-0}" != 1 ]; then
      wait "$pid" >/dev/null 2>&1 || true
      reaped_worker_pids["$pid"]=1
    fi
  done
}

emit_owned_failure_diagnostics() {
  local log_path
  echo 'request-context proof failed; bounded owned worker diagnostics follow' >&2
  for log_path in "$proof_root"/*.log; do
    [ -f "$log_path" ] || continue
    printf '%s\n' "--- ${log_path##*/} (last 100 lines) ---" >&2
    tail -n 100 -- "$log_path" >&2
  done
}

cleanup_fixture() {
  [ "$fixture_claimed" = 1 ] || return 0
  run_sql "
    begin;
    set local session_replication_role = replica;
    do \$proof\$
    begin
      if not exists (
        select 1 from vortex_identity.tenants
        where tenant_id = '$tenant_id'
          and short_name = '$fixture_short_name'
          and created_by = '$actor_identity_id'
      ) or not exists (
        select 1 from vortex_identity.organizations
        where organization_id = '$organization_id'
          and tenant_id = '$tenant_id'
          and short_name = '$fixture_short_name'
          and created_by = '$actor_identity_id'
      ) or not exists (
        select 1 from vortex_identity.organization_accounts
        where organization_account_id = '$target_account_id'
          and organization_id = '$organization_id'
          and identity_id = '$target_identity_id'
      ) or not exists (
        select 1 from vortex_identity.organization_accounts
        where organization_account_id = '$actor_account_id'
          and organization_id = '$organization_id'
          and identity_id = '$actor_identity_id'
      ) then
        raise exception 'Request-context proof fixture ownership marker mismatch';
      end if;
    end
    \$proof\$;
    delete from vortex_access.organization_access_versions
      where organization_id = '$organization_id';
    delete from vortex_identity.organization_accounts
      where organization_id = '$organization_id';
    delete from vortex_identity.identity_projections
      where identity_id in ('$target_identity_id', '$actor_identity_id');
    delete from vortex_identity.organizations
      where organization_id = '$organization_id';
    delete from vortex_identity.tenants where tenant_id = '$tenant_id';
    commit;
  " >/dev/null
}

finalize() {
  local original_status=$?
  local cleanup_status=0
  local operation_status
  trap - EXIT INT TERM
  set +e
  touch "$proof_root/r1-reader-release" "$proof_root/r2-holder-release"
  stop_owned_workers
  if [ "$original_status" -ne 0 ]; then emit_owned_failure_diagnostics; fi
  cleanup_fixture
  operation_status=$?
  if [ "$operation_status" -ne 0 ]; then cleanup_status="$operation_status"; fi
  case "$proof_root" in
    /tmp/vortex-organization-request.*) rm -rf -- "$proof_root"; operation_status=$? ;;
    *) echo "refusing to remove unexpected proof directory: $proof_root" >&2; operation_status=1 ;;
  esac
  if [ "$operation_status" -ne 0 ] && [ "$cleanup_status" -eq 0 ]; then
    cleanup_status="$operation_status"
  fi
  if [ "$original_status" -ne 0 ]; then exit "$original_status"; fi
  exit "$cleanup_status"
}
trap finalize EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

run_sql "
  begin;
  insert into vortex_identity.tenants (
    tenant_id, short_name, display_name, state, created_at, created_by,
    state_changed_at, revision
  ) values (
    '$tenant_id', '$fixture_short_name', 'Request context proof', 'active',
    pg_catalog.statement_timestamp(), '$actor_identity_id',
    pg_catalog.statement_timestamp(), 1
  );
  insert into vortex_identity.organizations (
    organization_id, tenant_id, short_name, display_name, state,
    created_at, created_by, state_changed_at, revision
  ) values (
    '$organization_id', '$tenant_id', '$fixture_short_name',
    'Request context proof', 'active', pg_catalog.statement_timestamp(),
    '$actor_identity_id', pg_catalog.statement_timestamp(), 1
  );
  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values
    ('$target_identity_id', 'active', pg_catalog.statement_timestamp(),
      pg_catalog.statement_timestamp(), '$actor_identity_id', '$correlation_initialize', 1),
    ('$actor_identity_id', 'active', pg_catalog.statement_timestamp(),
      pg_catalog.statement_timestamp(), '$actor_identity_id', '$correlation_initialize', 1);
  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name, state,
    activated_at, suspended_at, changed_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values
    ('$target_account_id', '$organization_id', '$target_identity_id',
      'Request target', 'active', pg_catalog.statement_timestamp(), null,
      pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(), '$actor_account_id',
      '$correlation_initialize', 1),
    ('$actor_account_id', '$organization_id', '$actor_identity_id',
      'Request actor', 'active', pg_catalog.statement_timestamp(), null,
      pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(), '$actor_account_id',
      '$correlation_initialize', 1);
  select 1 from vortex_access.initialize_organization_access_version(
    '$organization_id', '$actor_account_id', '$correlation_initialize'
  );
  commit;
" >/dev/null
fixture_claimed=1

# Reader-first: the resolved request holds Access and Identity shared locks. The
# real Access-owned account writer must wait at governance, then complete once.
PGAPPNAME='vortex-request-context-r1-reader' "${psql_command[@]}" >"$proof_root/r1-reader.log" 2>&1 <<SQL &
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
set local role vortex_runtime;
select pg_catalog.pg_backend_pid() \g '$proof_root/r1-reader.pid'
select access_version
from vortex_access.resolve_human_organization_scope('$target_identity_id', '$organization_id')
\g '$proof_root/r1-reader.version'
\! deadline=600; while [ ! -f '$proof_root/r1-reader-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/r1-reader-release' ]
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind', 'human',
  'identityAuthorityId', '$identity_authority_id',
  'tenantId', '$tenant_id',
  'organizationId', '$organization_id',
  'organizationAccountId', '$target_account_id',
  'identityId', '$target_identity_id',
  'sessionId', '$session_id',
  'authenticationStrength', 'single_factor',
  'issuedAt', pg_catalog.statement_timestamp() - interval '1 minute',
  'expiresAt', pg_catalog.statement_timestamp() + interval '5 minutes',
  'accessVersion', 1,
  'correlationId', '$correlation_r1_reader'
));
set local role vortex_request;
select vortex_access.validated_human_request_context() ->> 'organizationId'
\g '$proof_root/r1-reader.organization'
commit;
SQL
r1_reader_pid=$!
worker_pids+=("$r1_reader_pid")
r1_reader_db="$(read_backend_pid "$proof_root/r1-reader.pid")"
wait_for_file "$proof_root/r1-reader.version"

PGAPPNAME='vortex-request-context-r1-writer' "${psql_command[@]}" >"$proof_root/r1-writer.log" 2>&1 <<SQL &
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind', 'human',
  'identityAuthorityId', '$identity_authority_id',
  'tenantId', '$tenant_id',
  'organizationId', '$organization_id',
  'organizationAccountId', '$actor_account_id',
  'identityId', '$actor_identity_id',
  'sessionId', '$session_id',
  'authenticationStrength', 'single_factor',
  'issuedAt', pg_catalog.statement_timestamp() - interval '1 minute',
  'expiresAt', pg_catalog.statement_timestamp() + interval '5 minutes',
  'accessVersion', 1,
  'correlationId', '$correlation_r1_writer'
));
select pg_catalog.pg_backend_pid() \g '$proof_root/r1-writer.pid'
select state || '|' || revision::text || '|' || access_version::text
from vortex_access.change_organization_account_state('$target_account_id', 1, 'suspended')
\g '$proof_root/r1-writer.result'
commit;
SQL
r1_writer_pid=$!
worker_pids+=("$r1_writer_pid")
r1_writer_db="$(read_backend_pid "$proof_root/r1-writer.pid")"
wait_for_database_blocker "$r1_writer_db" "$r1_reader_db" 'the writer waiting behind the resolved request'
touch "$proof_root/r1-reader-release"
wait_owned_worker "$r1_reader_pid"
wait_owned_worker "$r1_writer_pid"

[ "$(tr -d '[:space:]' <"$proof_root/r1-reader.version")" = '1' ] || {
  echo 'reader-first request did not resolve the initial Access version' >&2
  exit 1
}
[ "$(tr -d '[:space:]' <"$proof_root/r1-reader.organization")" = "$organization_id" ] || {
  echo 'reader-first request did not remain valid through its transaction' >&2
  exit 1
}
[ "$(tr -d '[:space:]' <"$proof_root/r1-writer.result")" = 'suspended|2|2' ] || {
  echo 'reader-first account writer did not complete exactly once' >&2
  exit 1
}

# Return the target to active through the same real writer so the opposite order
# starts from a clean eligible account and an exact current Access version.
"${psql_command[@]}" >"$proof_root/reactivate.log" 2>&1 <<SQL
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind', 'human',
  'identityAuthorityId', '$identity_authority_id',
  'tenantId', '$tenant_id',
  'organizationId', '$organization_id',
  'organizationAccountId', '$actor_account_id',
  'identityId', '$actor_identity_id',
  'sessionId', '$session_id',
  'authenticationStrength', 'single_factor',
  'issuedAt', pg_catalog.statement_timestamp() - interval '1 minute',
  'expiresAt', pg_catalog.statement_timestamp() + interval '5 minutes',
  'accessVersion', 2,
  'correlationId', '$correlation_reactivate'
));
select state || '|' || revision::text || '|' || access_version::text
from vortex_access.change_organization_account_state('$target_account_id', 2, 'active')
\g '$proof_root/reactivate.result'
commit;
SQL
[ "$(tr -d '[:space:]' <"$proof_root/reactivate.result")" = 'active|3|3' ] || {
  echo 'request target could not be restored through the real writer' >&2
  exit 1
}

# Writer-first: a downstream account holder lets the real writer acquire Access
# first. The reader observes old eligibility, waits on Access, then must refuse
# when its authoritative Identity recheck sees the committed suspension.
PGAPPNAME='vortex-request-context-r2-holder' "${psql_command[@]}" >"$proof_root/r2-holder.log" 2>&1 <<SQL &
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select organization_account_id
from vortex_identity.organization_accounts
where organization_account_id = '$target_account_id'
for update;
select pg_catalog.pg_backend_pid() \g '$proof_root/r2-holder.pid'
\! deadline=600; while [ ! -f '$proof_root/r2-holder-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/r2-holder-release' ]
commit;
SQL
r2_holder_pid=$!
worker_pids+=("$r2_holder_pid")
r2_holder_db="$(read_backend_pid "$proof_root/r2-holder.pid")"

PGAPPNAME='vortex-request-context-r2-writer' "${psql_command[@]}" >"$proof_root/r2-writer.log" 2>&1 <<SQL &
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind', 'human',
  'identityAuthorityId', '$identity_authority_id',
  'tenantId', '$tenant_id',
  'organizationId', '$organization_id',
  'organizationAccountId', '$actor_account_id',
  'identityId', '$actor_identity_id',
  'sessionId', '$session_id',
  'authenticationStrength', 'single_factor',
  'issuedAt', pg_catalog.statement_timestamp() - interval '1 minute',
  'expiresAt', pg_catalog.statement_timestamp() + interval '5 minutes',
  'accessVersion', 3,
  'correlationId', '$correlation_r2_writer'
));
select pg_catalog.pg_backend_pid() \g '$proof_root/r2-writer.pid'
select state || '|' || revision::text || '|' || access_version::text
from vortex_access.change_organization_account_state('$target_account_id', 3, 'suspended')
\g '$proof_root/r2-writer.result'
commit;
SQL
r2_writer_pid=$!
worker_pids+=("$r2_writer_pid")
r2_writer_db="$(read_backend_pid "$proof_root/r2-writer.pid")"
wait_for_database_blocker "$r2_writer_db" "$r2_holder_db" 'the Access-first writer waiting on the account holder'

PGAPPNAME='vortex-request-context-r2-reader' "${psql_command[@]}" >"$proof_root/r2-reader.log" 2>&1 <<SQL &
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
set local role vortex_runtime;
select pg_catalog.pg_backend_pid() \g '$proof_root/r2-reader.pid'
do \$proof\$
begin
  perform 1
  from vortex_access.resolve_human_organization_scope('$target_identity_id', '$organization_id');
  raise exception 'writer-first resolver unexpectedly returned a stale scope';
exception when sqlstate '42501' then
  null;
end
\$proof\$;
select '42501' \g '$proof_root/r2-reader.result'
commit;
SQL
r2_reader_pid=$!
worker_pids+=("$r2_reader_pid")
r2_reader_db="$(read_backend_pid "$proof_root/r2-reader.pid")"
wait_for_database_blocker "$r2_reader_db" "$r2_writer_db" 'the resolver waiting behind the Access-first writer'

# A valid but unrelated identity must fail before attempting the held governance
# row. A lock timeout would expose an accidental Access lock by an ineligible scope.
if run_sql "
  set statement_timeout = '3s';
  set lock_timeout = '1s';
  set role vortex_runtime;
  select * from vortex_access.resolve_human_organization_scope(
    '$foreign_identity_id', '$organization_id'
  );
" >"$proof_root/foreign-scope.log" 2>&1; then
  echo 'foreign identity unexpectedly resolved the organization scope' >&2
  exit 1
fi
grep -Fq 'Organisation selection is unavailable' "$proof_root/foreign-scope.log"

touch "$proof_root/r2-holder-release"
wait_owned_worker "$r2_holder_pid"
wait_owned_worker "$r2_writer_pid"
wait_owned_worker "$r2_reader_pid"

[ "$(tr -d '[:space:]' <"$proof_root/r2-writer.result")" = 'suspended|4|4' ] || {
  echo 'writer-first account change did not commit exactly once' >&2
  exit 1
}
[ "$(tr -d '[:space:]' <"$proof_root/r2-reader.result")" = '42501' ] || {
  echo 'writer-first resolver did not refuse the invalidated scope' >&2
  exit 1
}

if run_sql "
  set role vortex_runtime;
  select * from vortex_access.resolve_human_organization_scope(
    '$target_identity_id', '$organization_id'
  );
" >"$proof_root/next-request.log" 2>&1; then
  echo 'the next request accepted a suspended organization account' >&2
  exit 1
fi
grep -Fq 'Organisation selection is unavailable' "$proof_root/next-request.log"

final_state="$(run_sql "
  select target.state || '|' || target.revision::text || '|' ||
    version.current_version::text || '|' || actor.state || '|' || actor.revision::text
  from vortex_identity.organization_accounts as target
  join vortex_identity.organization_accounts as actor
    on actor.organization_account_id = '$actor_account_id'
  join vortex_access.organization_access_versions as version
    on version.organization_id = target.organization_id
  where target.organization_account_id = '$target_account_id';
")"
[ "$final_state" = 'suspended|4|4|active|1' ] || {
  echo 'request-context proof left an unexpected account or Access state' >&2
  exit 1
}

echo 'organisation request-context concurrency proof passed'
