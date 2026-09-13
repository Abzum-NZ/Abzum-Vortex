#!/usr/bin/env bash

set -euo pipefail

run_uuid="${VORTEX_LOCAL_ADMINISTRATION_READ_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then
  [ -r /proc/sys/kernel/random/uuid ] || {
    echo 'a Linux random UUID source is required for the local-administration read proof' >&2
    exit 1
  }
  IFS= read -r run_uuid </proc/sys/kernel/random/uuid
fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  echo 'VORTEX_LOCAL_ADMINISTRATION_READ_PROOF_RUN_ID must be a lowercase UUID v4' >&2
  exit 1
}

readonly run_uuid
readonly run_token="${run_uuid//-/}"
readonly fixture_short_name="localread_${run_token:0:20}"
proof_root="$(mktemp -d /tmp/vortex-local-administration-read.XXXXXX)"
readonly proof_root
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id="17${run_uuid:2}"
readonly organization_id="27${run_uuid:2}"
readonly actor_identity_id="47${run_uuid:2}"
readonly target_identity_id="48${run_uuid:2}"
readonly actor_account_id="57${run_uuid:2}"
readonly target_account_id="58${run_uuid:2}"
readonly role_id="67${run_uuid:2}"
readonly assignment_id="77${run_uuid:2}"
readonly settings_assignment_id="78${run_uuid:2}"
readonly actor_id="97${run_uuid:2}"
readonly authority_id="87${run_uuid:2}"
readonly session_id="37${run_uuid:2}"

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
  echo 'local-administration read proof did not reach its transaction barrier' >&2
  return 1
}

read_backend_pid() {
  local candidate="$1"
  local backend_pid
  wait_for_file "$candidate"
  backend_pid="$(tr -d '[:space:]' <"$candidate")"
  [[ "$backend_pid" =~ ^[1-9][0-9]*$ ]] || {
    echo 'local-administration read proof captured an invalid backend identifier' >&2
    return 1
  }
  printf '%s\n' "$backend_pid"
}

wait_for_database_blocker() {
  local blocked_pid="$1"
  local blocking_pid="$2"
  local deadline=$((SECONDS + 20))
  local state
  while ((SECONDS < deadline)); do
    state="$(run_sql "select case when $blocking_pid = any(pg_catalog.pg_blocking_pids($blocked_pid)) then 'blocked' else '' end;")"
    [ "$state" = 'blocked' ] && return 0
    sleep 0.1
  done
  echo 'local-administration read proof did not observe the required governance wait' >&2
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

emit_failure_diagnostics() {
  local log_path
  echo 'local-administration read proof failed; bounded diagnostics follow' >&2
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
    declare target record;
    begin
      if not exists (
        select 1 from vortex_identity.organizations
        where organization_id = '$organization_id'
          and tenant_id = '$tenant_id'
          and short_name = '$fixture_short_name'
          and created_by = '$actor_id'
      ) then
        raise exception 'Local-administration read proof ownership marker mismatch';
      end if;
      for target in
        select columns.table_schema, columns.table_name
        from information_schema.columns
        where columns.column_name = 'organization_id'
          and columns.table_schema in ('vortex_identity', 'vortex_access', 'vortex_activity')
        order by columns.table_schema, columns.table_name
      loop
        execute pg_catalog.format(
          'delete from %I.%I where organization_id = \$1',
          target.table_schema, target.table_name
        ) using '$organization_id'::uuid;
      end loop;
      delete from vortex_identity.identity_projections
      where identity_id in ('$actor_identity_id', '$target_identity_id');
      delete from vortex_identity.tenants where tenant_id = '$tenant_id';
    end
    \$proof\$;
    commit;
  " >/dev/null
}

finalize() {
  local original_status=$?
  local cleanup_status=0
  local operation_status
  trap - EXIT INT TERM
  set +e
  touch "$proof_root/governance-release" "$proof_root/settings-release"
  stop_owned_workers
  if [ "$original_status" -ne 0 ]; then emit_failure_diagnostics; fi
  cleanup_fixture
  operation_status=$?
  if [ "$operation_status" -ne 0 ]; then cleanup_status="$operation_status"; fi
  case "$proof_root" in
    /tmp/vortex-local-administration-read.*)
      rm -rf -- "$proof_root"; operation_status=$?
      ;;
    *)
      echo "refusing to remove unexpected proof directory: $proof_root" >&2
      operation_status=1
      ;;
  esac
  if [ "$operation_status" -ne 0 ]; then cleanup_status="$operation_status"; fi
  if [ "$original_status" -ne 0 ]; then exit "$original_status"; fi
  exit "$cleanup_status"
}
trap finalize EXIT INT TERM

run_sql "
  begin;
  insert into vortex_identity.tenants(
    tenant_id, short_name, display_name, state, created_at, created_by,
    state_changed_at, revision
  ) values (
    '$tenant_id', '$fixture_short_name', 'Local administration read proof',
    'active', pg_catalog.clock_timestamp(), '$actor_id',
    pg_catalog.clock_timestamp(), 1
  );
  insert into vortex_identity.organizations(
    organization_id, tenant_id, short_name, display_name, state,
    created_at, created_by, state_changed_at, revision
  ) values (
    '$organization_id', '$tenant_id', '$fixture_short_name',
    'Local administration read proof', 'active', pg_catalog.clock_timestamp(),
    '$actor_id', pg_catalog.clock_timestamp(), 1
  );
  insert into vortex_identity.identity_projections(
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values
    ('$actor_identity_id', 'active', pg_catalog.clock_timestamp(),
      pg_catalog.clock_timestamp(), '$actor_id', 'a7${run_uuid:2}', 1),
    ('$target_identity_id', 'active', pg_catalog.clock_timestamp(),
      pg_catalog.clock_timestamp(), '$actor_id', 'b7${run_uuid:2}', 1);
  insert into vortex_identity.organization_accounts(
    organization_account_id, organization_id, identity_id, display_name,
    state, activated_at, suspended_at, changed_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values
    ('$actor_account_id', '$organization_id', '$actor_identity_id', 'Reader',
      'active', pg_catalog.clock_timestamp(), null, pg_catalog.clock_timestamp(),
      pg_catalog.clock_timestamp(), '$actor_id', 'c7${run_uuid:2}', 1),
    ('$target_account_id', '$organization_id', '$target_identity_id', 'Target',
      'suspended', pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
      pg_catalog.clock_timestamp(),
      pg_catalog.clock_timestamp(), '$actor_id', 'd7${run_uuid:2}', 1);
  select * from vortex_access.initialize_organization_access_version(
    '$organization_id', '$actor_id', 'e7${run_uuid:2}'
  );
  select * from vortex_access.initialize_platform_permission_catalogue(
    '$organization_id', '$actor_id', 'f7${run_uuid:2}'
  );
  insert into vortex_access.permission_continuities(
    organization_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id, state,
    continuity_revision, meaning_fingerprint,
    last_processed_registration_revision, changed_at
  )
  select entry.organization_id, null, entry.owner_kind, entry.owner_id,
    entry.permission_id, 'platform', entry.registration_owner_id,
    'available', 1, entry.meaning_fingerprint, entry.registration_revision,
    pg_catalog.clock_timestamp()
  from vortex_access.permission_catalogue_entries as entry
  where entry.organization_id = '$organization_id'
    and entry.permission_id in (
      '02c772e5-2921-4300-ad90-4f5772a7fa46',
      '9300e501-6d56-41b1-b203-3361dbace9bc',
      '6dffcb0b-ded8-4cd5-acc8-c50f7d4269a5'
    );
  insert into vortex_access.organization_roles(
    organization_id, role_id, role_kind, role_key, live_revision,
    created_by, created_at
  ) values (
    '$organization_id', '$role_id', 'custom', 'local_reader', 1,
    '$actor_account_id', pg_catalog.clock_timestamp()
  );
  insert into vortex_access.organization_role_permission_entries(
    organization_id, role_id, role_revision, entry_ordinal, role_kind,
    role_application_root_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id,
    accepted_registration_revision, catalogue_fingerprint,
    continuity_revision, meaning_fingerprint
  )
  select entry.organization_id, '$role_id', 1,
    pg_catalog.row_number() over (order by entry.permission_id), 'custom', null,
    entry.application_root_id, entry.owner_kind, entry.owner_id,
    entry.permission_id, entry.registration_kind, entry.registration_owner_id,
    entry.registration_revision, registration.permission_catalogue_fingerprint,
    continuity.continuity_revision, entry.meaning_fingerprint
  from vortex_access.permission_catalogue_entries as entry
  join vortex_access.permission_registration_revisions as registration
    on registration.organization_id = entry.organization_id
    and registration.registration_kind = entry.registration_kind
    and registration.registration_owner_id is not distinct from entry.registration_owner_id
    and registration.revision = entry.registration_revision
  join vortex_access.permission_continuities as continuity
    on continuity.organization_id = entry.organization_id
    and continuity.application_root_id is not distinct from entry.application_root_id
    and continuity.owner_kind = entry.owner_kind
    and continuity.owner_id = entry.owner_id
    and continuity.permission_id = entry.permission_id
  where entry.organization_id = '$organization_id'
    and entry.permission_id in (
      '02c772e5-2921-4300-ad90-4f5772a7fa46',
      '9300e501-6d56-41b1-b203-3361dbace9bc',
      '6dffcb0b-ded8-4cd5-acc8-c50f7d4269a5'
    );
  insert into vortex_access.organization_role_revisions(
    organization_id, role_id, revision, role_kind, lifecycle,
    privilege_classification, assignment_policy,
    policy_continuity_revision, authority_continuity_revision,
    activation_policy_id, activation_policy_revision,
    activation_policy_fingerprint, role_key, label, description,
    changed_by, changed_at, change_correlation_id
  ) values (
    '$organization_id', '$role_id', 1, 'custom', 'active', 'privileged',
    'standing', 1, 1, null, null, null, 'local_reader', 'Local reader',
    'Concurrency proof role with only the three local read permissions.',
    '$actor_account_id', pg_catalog.clock_timestamp(), '17${run_uuid:2}'
  );
  insert into vortex_access.organization_role_assignments(
    organization_id, role_assignment_id, role_id, assignee_kind,
    organization_account_id, group_id, assignment_kind, revision,
    starts_at, expires_at, state, granted_by, granted_at,
    grant_correlation_id, changed_by, changed_at, change_correlation_id
  ) values (
    '$organization_id', '$assignment_id', '$role_id', 'organization_account',
    '$actor_account_id', null, 'standing', 1,
    pg_catalog.clock_timestamp() - interval '1 minute', null, 'live',
    '$actor_account_id', pg_catalog.clock_timestamp(), '27${run_uuid:2}',
    '$actor_account_id', pg_catalog.clock_timestamp(), '27${run_uuid:2}'
  );
  select * from vortex_identity.initialize_organization_runtime_settings(
    '$organization_id', 'en-NZ', 'Pacific/Auckland', 'NZD', 'medium', 'auto'
  );
  commit;
" >/dev/null
fixture_claimed=1

# A governance transaction wins the Access lock and revokes the reader. The
# queued request must resolve the new Access version and refuse, never project
# rows under the stale assignment.
"${psql_command[@]}" >"$proof_root/governance.log" 2>&1 <<SQL &
begin;
select 1 from vortex_access.organization_access_versions
where organization_id = '$organization_id' for update;
select pg_catalog.pg_backend_pid() \g '$proof_root/governance.pid'
update vortex_access.organization_role_assignments
set state = 'revoked', revision = revision + 1,
  changed_by = '$actor_account_id', changed_at = pg_catalog.statement_timestamp(),
  change_correlation_id = '37${run_uuid:2}',
  revoked_by = '$actor_account_id', revoked_at = pg_catalog.statement_timestamp(),
  revocation_correlation_id = '37${run_uuid:2}'
where organization_id = '$organization_id'
  and role_assignment_id = '$assignment_id';
select * from vortex_access.increment_organization_access_version(
  '$organization_id', '$actor_account_id', '47${run_uuid:2}',
  'role_assignment_changed'
);
\! touch '$proof_root/governance-ready'
\! while [ ! -f '$proof_root/governance-release' ]; do sleep 0.05; done
commit;
SQL
governance_worker=$!
worker_pids+=("$governance_worker")
governance_pid="$(read_backend_pid "$proof_root/governance.pid")"
wait_for_file "$proof_root/governance-ready"

"${psql_command[@]}" >"$proof_root/refused-reader.log" 2>&1 <<SQL &
begin;
set local role vortex_runtime;
select pg_catalog.pg_backend_pid() \g '$proof_root/refused-reader.pid'
select * from vortex_access.resolve_human_organization_scope(
  '$actor_identity_id', '$organization_id'
) \gset scope_
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind', 'human', 'identityAuthorityId', '$authority_id',
  'tenantId', :'scope_tenant_id', 'organizationId', :'scope_organization_id',
  'organizationAccountId', :'scope_organization_account_id',
  'identityId', '$actor_identity_id', 'sessionId', '$session_id',
  'authenticationStrength', 'single_factor',
  'issuedAt', pg_catalog.clock_timestamp(),
  'expiresAt', pg_catalog.clock_timestamp() + interval '1 hour',
  'accessVersion', :scope_access_version,
  'correlationId', '57${run_uuid:2}'
));
set local role vortex_request;
\set ON_ERROR_STOP off
select * from vortex_access.list_organization_accounts_for_administration(null, 10);
\echo VORTEX_LOCAL_READ_REFUSAL|:SQLSTATE
\set ON_ERROR_STOP on
rollback;
SQL
refused_reader_worker=$!
worker_pids+=("$refused_reader_worker")
refused_reader_pid="$(read_backend_pid "$proof_root/refused-reader.pid")"
wait_for_database_blocker "$refused_reader_pid" "$governance_pid"
touch "$proof_root/governance-release"
wait_owned_worker "$governance_worker"
wait_owned_worker "$refused_reader_worker"
grep -q '^VORTEX_LOCAL_READ_REFUSAL|42501$' "$proof_root/refused-reader.log" || {
  echo 'a queued read used stale authority after governance committed' >&2
  exit 1
}

# Grant a new explicit assignment for the settings race; revocation is terminal.
run_sql "
  begin;
  insert into vortex_access.organization_role_assignments(
    organization_id, role_assignment_id, role_id, assignee_kind,
    organization_account_id, group_id, assignment_kind, revision,
    starts_at, expires_at, state, granted_by, granted_at,
    grant_correlation_id, changed_by, changed_at, change_correlation_id
  ) values (
    '$organization_id', '$settings_assignment_id', '$role_id',
    'organization_account', '$actor_account_id', null, 'standing', 1,
    pg_catalog.clock_timestamp() - interval '1 minute', null, 'live',
    '$actor_account_id', pg_catalog.clock_timestamp(), '67${run_uuid:2}',
    '$actor_account_id', pg_catalog.clock_timestamp(), '67${run_uuid:2}'
  );
  select * from vortex_access.increment_organization_access_version(
    '$organization_id', '$actor_account_id', '77${run_uuid:2}',
    'role_assignment_changed'
  );
  commit;
" >/dev/null

# The settings writer holds the same governance row used by request resolution.
# A queued administrative read must return the complete next revision.
"${psql_command[@]}" >"$proof_root/settings-writer.log" 2>&1 <<SQL &
begin;
select 1 from vortex_access.organization_access_versions
where organization_id = '$organization_id' for update;
select pg_catalog.pg_backend_pid() \g '$proof_root/settings-writer.pid'
update vortex_identity.organization_runtime_settings
set language = 'en-US', time_zone = 'America/New_York', currency = 'USD',
  date_format = 'long', number_format = 'always',
  changed_at = pg_catalog.clock_timestamp(), revision = revision + 1
where organization_id = '$organization_id';
\! touch '$proof_root/settings-ready'
\! while [ ! -f '$proof_root/settings-release' ]; do sleep 0.05; done
commit;
SQL
settings_worker=$!
worker_pids+=("$settings_worker")
settings_pid="$(read_backend_pid "$proof_root/settings-writer.pid")"
wait_for_file "$proof_root/settings-ready"

"${psql_command[@]}" >"$proof_root/settings-reader.log" 2>&1 <<SQL &
begin;
set local role vortex_runtime;
select pg_catalog.pg_backend_pid() \g '$proof_root/settings-reader.pid'
select * from vortex_access.resolve_human_organization_scope(
  '$actor_identity_id', '$organization_id'
) \gset scope_
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind', 'human', 'identityAuthorityId', '$authority_id',
  'tenantId', :'scope_tenant_id', 'organizationId', :'scope_organization_id',
  'organizationAccountId', :'scope_organization_account_id',
  'identityId', '$actor_identity_id', 'sessionId', '$session_id',
  'authenticationStrength', 'single_factor',
  'issuedAt', pg_catalog.clock_timestamp(),
  'expiresAt', pg_catalog.clock_timestamp() + interval '1 hour',
  'accessVersion', :scope_access_version,
  'correlationId', '87${run_uuid:2}'
));
set local role vortex_request;
select pg_catalog.concat_ws('|', outcome, settings ->> 'language',
  settings ->> 'timeZone', settings ->> 'currency',
  settings ->> 'dateFormat', settings ->> 'numberFormat',
  settings ->> 'revision') as result
from vortex_access.read_organization_runtime_settings_for_administration();
rollback;
SQL
settings_reader_worker=$!
worker_pids+=("$settings_reader_worker")
settings_reader_pid="$(read_backend_pid "$proof_root/settings-reader.pid")"
wait_for_database_blocker "$settings_reader_pid" "$settings_pid"
touch "$proof_root/settings-release"
wait_owned_worker "$settings_worker"
wait_owned_worker "$settings_reader_worker"

settings_result="$(tr -d '[:space:]' <"$proof_root/settings-reader.log")"
[ "$settings_result" = 'available|en-US|America/New_York|USD|long|always|2' ] || {
  echo 'a queued settings read did not return one complete next revision' >&2
  exit 1
}

[ "$(run_sql "select pg_catalog.string_agg(state||'|'||revision, ',' order by role_assignment_id) from vortex_access.organization_role_assignments where organization_id='$organization_id' and role_assignment_id in ('$assignment_id','$settings_assignment_id');")" = 'revoked|2,live|1' ] || {
  echo 'read concurrency proof left invalid authority state' >&2
  exit 1
}
[ "$(run_sql "select pg_catalog.concat_ws('|', language,time_zone,currency,date_format,number_format,revision) from vortex_identity.organization_runtime_settings where organization_id='$organization_id';")" = 'en-US|America/New_York|USD|long|always|2' ] || {
  echo 'read concurrency proof observed a mixed settings revision' >&2
  exit 1
}

echo 'organization local administration read concurrency proof passed'
