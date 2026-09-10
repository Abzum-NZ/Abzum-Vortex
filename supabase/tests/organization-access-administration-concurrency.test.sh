#!/usr/bin/env bash

set -euo pipefail

run_uuid="${VORTEX_ACCESS_ADMINISTRATION_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then
  [ -r /proc/sys/kernel/random/uuid ] || {
    echo 'a Linux random UUID source is required for the Access-administration proof' >&2
    exit 1
  }
  IFS= read -r run_uuid </proc/sys/kernel/random/uuid
fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  echo 'VORTEX_ACCESS_ADMINISTRATION_PROOF_RUN_ID must be a lowercase UUID v4' >&2
  exit 1
}

readonly run_uuid
readonly run_token="${run_uuid//-/}"
readonly fixture_short_name="access_admin_${run_token:0:19}"
proof_root="$(mktemp -d /tmp/vortex-access-administration.XXXXXX)"
readonly proof_root
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id="13${run_uuid:2}"
readonly organization_id="23${run_uuid:2}"
readonly identity_id="43${run_uuid:2}"
readonly foreign_identity_id="44${run_uuid:2}"
readonly account_id="53${run_uuid:2}"
readonly identity_authority_id="83${run_uuid:2}"
readonly session_id="73${run_uuid:2}"
readonly group_a_id="63${run_uuid:2}"
readonly group_b_id="64${run_uuid:2}"
readonly application_root_id="33${run_uuid:2}"
readonly source_role_id="65${run_uuid:2}"
readonly actor_id="93${run_uuid:2}"
readonly correlation_initialize="a3${run_uuid:2}"
readonly correlation_group_a="a4${run_uuid:2}"
readonly correlation_group_b="a5${run_uuid:2}"
readonly correlation_withdraw="a6${run_uuid:2}"

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
  echo 'Access-administration proof did not reach its transaction barrier' >&2
  return 1
}

read_backend_pid() {
  local candidate="$1"
  local backend_pid
  wait_for_file "$candidate"
  backend_pid="$(tr -d '[:space:]' <"$candidate")"
  [[ "$backend_pid" =~ ^[1-9][0-9]*$ ]] || {
    printf 'Access-administration proof captured an invalid backend identifier: %q\n' "$backend_pid" >&2
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
  echo "Access-administration proof did not observe $description" >&2
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
  echo 'Access-administration proof failed; bounded owned worker diagnostics follow' >&2
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
          and created_by = '$actor_id'
      ) or not exists (
        select 1 from vortex_identity.organizations
        where organization_id = '$organization_id'
          and tenant_id = '$tenant_id'
          and short_name = '$fixture_short_name'
          and created_by = '$actor_id'
      ) or not exists (
        select 1 from vortex_identity.organization_accounts
        where organization_account_id = '$account_id'
          and organization_id = '$organization_id'
          and identity_id = '$identity_id'
      ) then
        raise exception 'Access-administration proof fixture ownership marker mismatch';
      end if;
    end
    \$proof\$;
    delete from vortex_access.organization_groups
      where organization_id = '$organization_id'
        and group_id in ('$group_a_id', '$group_b_id');
    delete from vortex_access.application_role_template_continuities
      where organization_id = '$organization_id'
        and application_root_id = '$application_root_id';
    delete from vortex_access.permission_registrations
      where organization_id = '$organization_id'
        and registration_kind = 'application'
        and registration_owner_id = '$application_root_id';
    delete from vortex_access.permission_registration_revisions
      where organization_id = '$organization_id'
        and registration_kind = 'application'
        and registration_owner_id = '$application_root_id';
    delete from vortex_access.organization_access_versions
      where organization_id = '$organization_id';
    delete from vortex_identity.organization_accounts
      where organization_account_id = '$account_id';
    delete from vortex_identity.identity_projections
      where identity_id in ('$identity_id', '$foreign_identity_id');
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
  touch "$proof_root/r1-resolver-release" "$proof_root/r2-writer-release" \
    "$proof_root/r3-writer-release"
  stop_owned_workers
  if [ "$original_status" -ne 0 ]; then emit_owned_failure_diagnostics; fi
  cleanup_fixture
  operation_status=$?
  if [ "$operation_status" -ne 0 ]; then cleanup_status="$operation_status"; fi
  case "$proof_root" in
    /tmp/vortex-access-administration.*) rm -rf -- "$proof_root"; operation_status=$? ;;
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
    '$tenant_id', '$fixture_short_name', 'Access administration proof',
    'active', pg_catalog.clock_timestamp(), '$actor_id',
    pg_catalog.clock_timestamp(), 1
  );
  insert into vortex_identity.organizations (
    organization_id, tenant_id, short_name, display_name, state,
    created_at, created_by, state_changed_at, revision
  ) values (
    '$organization_id', '$tenant_id', '$fixture_short_name',
    'Access administration proof', 'active', pg_catalog.clock_timestamp(),
    '$actor_id', pg_catalog.clock_timestamp(), 1
  );
  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values
    ('$identity_id', 'active', pg_catalog.clock_timestamp(),
      pg_catalog.clock_timestamp(), '$actor_id', '$correlation_initialize', 1),
    ('$foreign_identity_id', 'active', pg_catalog.clock_timestamp(),
      pg_catalog.clock_timestamp(), '$actor_id', '$correlation_initialize', 1);
  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name,
    state, activated_at, changed_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values (
    '$account_id', '$organization_id', '$identity_id', 'Access administrator',
    'active', pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), '$actor_id', '$correlation_initialize', 1
  );
  select 1 from vortex_access.initialize_organization_access_version(
    '$organization_id', '$actor_id', '$correlation_initialize'
  );
  insert into vortex_access.permission_registration_revisions (
    organization_id, registration_kind, registration_owner_id, revision,
    state, operation, source_definition_key, source_version, source_revision,
    validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, permission_catalogue_fingerprint,
    candidate_fingerprint, changed_at, changed_by, change_correlation_id
  ) values (
    '$organization_id', 'application', '$application_root_id', 1, 'active',
    'register', 'neutral.access_administration_proof', '1.0.0', 1, '1.0.0',
    'sha256:' || pg_catalog.repeat('1', 64),
    'sha256:' || pg_catalog.repeat('2', 64),
    'sha256:' || pg_catalog.repeat('3', 64),
    'sha256:' || pg_catalog.repeat('4', 64), pg_catalog.clock_timestamp(),
    '$actor_id', '$correlation_initialize'
  );
  insert into vortex_access.permission_registrations (
    organization_id, registration_kind, registration_owner_id, state,
    revision, source_definition_key, source_version, source_revision,
    validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, permission_catalogue_fingerprint,
    candidate_fingerprint, changed_at, changed_by, change_correlation_id
  )
  select organization_id, registration_kind, registration_owner_id, state,
    revision, source_definition_key, source_version, source_revision,
    validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, permission_catalogue_fingerprint,
    candidate_fingerprint, changed_at, changed_by, change_correlation_id
  from vortex_access.permission_registration_revisions
  where organization_id = '$organization_id'
    and registration_kind = 'application'
    and registration_owner_id = '$application_root_id'
    and revision = 1;
  insert into vortex_access.application_role_template_continuities (
    organization_id, application_root_id, source_role_id, state,
    continuity_revision, source_template_fingerprint,
    last_processed_registration_revision, changed_at
  ) values (
    '$organization_id', '$application_root_id', '$source_role_id', 'available',
    1, 'sha256:' || pg_catalog.repeat('5', 64), 1,
    pg_catalog.clock_timestamp()
  );
  commit;
" >/dev/null
fixture_claimed=1

# Resolver-first: the protected change resolver owns the same Access row lock as
# the real Group writer, so the writer waits without a lock-order cycle.
PGAPPNAME='vortex-access-administration-r1-resolver' "${psql_command[@]}" >"$proof_root/r1-resolver.log" 2>&1 <<SQL &
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
set local role vortex_runtime;
select access_version
from vortex_access.resolve_human_organization_change_scope(
  '$identity_id', '$organization_id'
)
\g '$proof_root/r1-resolver.version'
select pg_catalog.pg_backend_pid() \g '$proof_root/r1-resolver.pid'
\! deadline=600; while [ ! -f '$proof_root/r1-resolver-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/r1-resolver-release' ]
commit;
SQL
r1_resolver_pid=$!
worker_pids+=("$r1_resolver_pid")
r1_resolver_db="$(read_backend_pid "$proof_root/r1-resolver.pid")"

PGAPPNAME='vortex-access-administration-r1-writer' "${psql_command[@]}" >"$proof_root/r1-writer.log" 2>&1 <<SQL &
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r1-writer.pid'
select access_version
from vortex_access.coordinate_organization_group_change(
  'create_group', '$organization_id', '$group_a_id', null,
  'resolver_first', 'Resolver first', '$actor_id', '$correlation_group_a'
)
\g '$proof_root/r1-writer.version'
commit;
SQL
r1_writer_pid=$!
worker_pids+=("$r1_writer_pid")
r1_writer_db="$(read_backend_pid "$proof_root/r1-writer.pid")"
wait_for_database_blocker "$r1_writer_db" "$r1_resolver_db" 'the Group writer behind the governance-first resolver'
touch "$proof_root/r1-resolver-release"
wait_owned_worker "$r1_resolver_pid"
wait_owned_worker "$r1_writer_pid"

[ "$(tr -d '[:space:]' <"$proof_root/r1-resolver.version")" = '1' ] || {
  echo 'resolver-first change scope did not capture Access version one' >&2
  exit 1
}
[ "$(tr -d '[:space:]' <"$proof_root/r1-writer.version")" = '2' ] || {
  echo 'resolver-first Group writer did not increment Access exactly once' >&2
  exit 1
}

# Application writer first: the real B2 withdrawal holds organization
# governance after changing the registration. The application change resolver
# waits on that lock, then refuses the now-withdrawn application.
PGAPPNAME='vortex-access-administration-r3-writer' "${psql_command[@]}" >"$proof_root/r3-writer.log" 2>&1 <<SQL &
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select access_version
from vortex_access.coordinate_application_access_change(
  'withdraw', 1, null, '$organization_id', '$application_root_id',
  '$actor_id', '$correlation_withdraw'
)
\g '$proof_root/r3-writer.version'
select pg_catalog.pg_backend_pid() \g '$proof_root/r3-writer.pid'
\! deadline=600; while [ ! -f '$proof_root/r3-writer-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/r3-writer-release' ]
commit;
SQL
r3_writer_pid=$!
worker_pids+=("$r3_writer_pid")
r3_writer_db="$(read_backend_pid "$proof_root/r3-writer.pid")"

PGAPPNAME='vortex-access-administration-r3-resolver' "${psql_command[@]}" >"$proof_root/r3-resolver.log" 2>&1 <<SQL &
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
set local role vortex_runtime;
select pg_catalog.pg_backend_pid() \g '$proof_root/r3-resolver.pid'
do \$proof\$
begin
  perform 1
  from vortex_access.resolve_human_application_change_scope(
    '$identity_id', '$organization_id', '$application_root_id'
  );
  raise exception 'writer-first application resolver unexpectedly returned a withdrawn scope';
exception when sqlstate '42501' then
  perform pg_catalog.set_config('vortex.proof_result', '42501', false);
end
\$proof\$;
select pg_catalog.current_setting('vortex.proof_result')
\g '$proof_root/r3-resolver.result'
commit;
SQL
r3_resolver_pid=$!
worker_pids+=("$r3_resolver_pid")
r3_resolver_db="$(read_backend_pid "$proof_root/r3-resolver.pid")"
wait_for_database_blocker "$r3_resolver_db" "$r3_writer_db" \
  'the application change resolver behind the real B2 withdrawal'
touch "$proof_root/r3-writer-release"
wait_owned_worker "$r3_writer_pid"
wait_owned_worker "$r3_resolver_pid"

[ "$(tr -d '[:space:]' <"$proof_root/r3-writer.version")" = '3' ] || {
  echo 'writer-first application withdrawal did not increment Access exactly once' >&2
  exit 1
}
[ "$(tr -d '[:space:]' <"$proof_root/r3-resolver.result")" = '42501' ] || {
  echo 'writer-first application resolver did not refuse the withdrawn application' >&2
  exit 1
}

# Writer-first: the real Access-owned account writer holds governance after its
# successful statement. The change resolver waits, then its authoritative
# Identity recheck refuses the account that became inactive during the wait.
PGAPPNAME='vortex-access-administration-r2-writer' "${psql_command[@]}" >"$proof_root/r2-writer.log" 2>&1 <<SQL &
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind', 'human',
  'identityAuthorityId', '$identity_authority_id',
  'tenantId', '$tenant_id',
  'organizationId', '$organization_id',
  'organizationAccountId', '$account_id',
  'identityId', '$identity_id',
  'sessionId', '$session_id',
  'authenticationStrength', 'single_factor',
  'issuedAt', pg_catalog.clock_timestamp() - interval '1 minute',
  'expiresAt', pg_catalog.clock_timestamp() + interval '5 minutes',
  'accessVersion', 3,
  'correlationId', '$correlation_group_b'
));
select access_version
from vortex_access.change_organization_account_state('$account_id', 1, 'suspended')
\g '$proof_root/r2-writer.version'
select pg_catalog.pg_backend_pid() \g '$proof_root/r2-writer.pid'
\! deadline=600; while [ ! -f '$proof_root/r2-writer-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/r2-writer-release' ]
commit;
SQL
r2_writer_pid=$!
worker_pids+=("$r2_writer_pid")
r2_writer_db="$(read_backend_pid "$proof_root/r2-writer.pid")"

PGAPPNAME='vortex-access-administration-r2-resolver' "${psql_command[@]}" >"$proof_root/r2-resolver.log" 2>&1 <<SQL &
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
set local role vortex_runtime;
select pg_catalog.pg_backend_pid() \g '$proof_root/r2-resolver.pid'
do \$proof\$
begin
  perform 1
  from vortex_access.resolve_human_organization_change_scope(
    '$identity_id', '$organization_id'
  );
  raise exception 'writer-first change resolver unexpectedly returned a stale scope';
exception when sqlstate '42501' then
  perform pg_catalog.set_config('vortex.proof_result', '42501', false);
end
\$proof\$;
select pg_catalog.current_setting('vortex.proof_result')
\g '$proof_root/r2-resolver.result'
commit;
SQL
r2_resolver_pid=$!
worker_pids+=("$r2_resolver_pid")
r2_resolver_db="$(read_backend_pid "$proof_root/r2-resolver.pid")"
wait_for_database_blocker "$r2_resolver_db" "$r2_writer_db" 'the change resolver behind the real Group writer'

if run_sql "
  set statement_timeout = '3s';
  set lock_timeout = '1s';
  set role vortex_runtime;
  select * from vortex_access.resolve_human_organization_change_scope(
    '$foreign_identity_id', '$organization_id'
  );
" >"$proof_root/foreign.log" 2>&1; then
  echo 'foreign identity unexpectedly reached the held governance row' >&2
  exit 1
fi
grep -Fq 'Organisation change selection is unavailable' "$proof_root/foreign.log"

touch "$proof_root/r2-writer-release"
wait_owned_worker "$r2_writer_pid"
wait_owned_worker "$r2_resolver_pid"

[ "$(tr -d '[:space:]' <"$proof_root/r2-writer.version")" = '4' ] || {
  echo 'writer-first account suspension did not increment Access exactly once' >&2
  exit 1
}
[ "$(tr -d '[:space:]' <"$proof_root/r2-resolver.result")" = '42501' ] || {
  echo 'writer-first resolver did not refuse the suspended account' >&2
  exit 1
}

final_state="$(run_sql "
  select version.current_version::text || '|' || pg_catalog.count(group_row.group_id)::text
    || '|' || account.state || '|' || account.revision::text
    || '|' || registration.state
  from vortex_access.organization_access_versions as version
  join vortex_identity.organization_accounts as account
    on account.organization_id = version.organization_id
    and account.organization_account_id = '$account_id'
  left join vortex_access.organization_groups as group_row
    on group_row.organization_id = version.organization_id
  join vortex_access.permission_registrations as registration
    on registration.organization_id = version.organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = '$application_root_id'
  where version.organization_id = '$organization_id'
  group by version.current_version, account.state, account.revision,
    registration.state;
")"
[ "$final_state" = '4|1|suspended|2|withdrawn' ] || {
  echo 'Access-administration proof left an unexpected Access or Group state' >&2
  exit 1
}

echo 'organization Access-administration concurrency proof passed'
