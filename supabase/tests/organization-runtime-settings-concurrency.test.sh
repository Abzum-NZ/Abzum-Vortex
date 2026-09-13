#!/usr/bin/env bash

# This proof deliberately keeps one psql connection open for each scenario.
# A staged settings command is tied to both its PostgreSQL backend and its
# top-level transaction, so a committed or rolled-back stage must not become
# usable by the next request on that same backend.
set -euo pipefail

run_uuid="${VORTEX_RUNTIME_SETTINGS_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then
  [ -r /proc/sys/kernel/random/uuid ] || {
    echo 'a Linux random UUID source is required for the runtime-settings proof' >&2
    exit 1
  }
  IFS= read -r run_uuid </proc/sys/kernel/random/uuid
fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  echo 'VORTEX_RUNTIME_SETTINGS_PROOF_RUN_ID must be a lowercase UUID v4' >&2
  exit 1
}

readonly run_uuid
readonly run_token="${run_uuid//-/}"
readonly fixture_short_name="runtime_${run_token:0:20}"
proof_root="$(mktemp -d /tmp/vortex-runtime-settings.XXXXXX)"
readonly proof_root
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id="14${run_uuid:2}"
readonly organization_id="24${run_uuid:2}"
readonly identity_id="44${run_uuid:2}"
readonly account_id="54${run_uuid:2}"
readonly update_first_identity_id="45${run_uuid:2}"
readonly update_first_account_id="55${run_uuid:2}"
readonly revocation_target_identity_id="46${run_uuid:2}"
readonly revocation_target_account_id="56${run_uuid:2}"
readonly role_id="64${run_uuid:2}"
readonly assignment_id="74${run_uuid:2}"
readonly update_first_assignment_id="75${run_uuid:2}"
readonly revocation_target_assignment_id="76${run_uuid:2}"
readonly identity_authority_id="84${run_uuid:2}"
readonly session_id="94${run_uuid:2}"
readonly correlation_initialize="a4${run_uuid:2}"
readonly correlation_catalogue="b4${run_uuid:2}"
readonly correlation_role="c4${run_uuid:2}"
readonly correlation_assignment="d4${run_uuid:2}"
readonly correlation_committed_stage="e4${run_uuid:2}"
readonly correlation_rolled_back_stage="f4${run_uuid:2}"
readonly correlation_success="14${run_uuid:2}"
readonly correlation_stale="24${run_uuid:2}"
readonly correlation_concurrent_update_one="34${run_uuid:2}"
readonly correlation_concurrent_update_two="44${run_uuid:2}"
readonly correlation_revocation_first="54${run_uuid:2}"
readonly correlation_revocation_first_update="64${run_uuid:2}"
readonly correlation_update_first="74${run_uuid:2}"
readonly correlation_update_first_revocation="84${run_uuid:2}"

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
  echo 'runtime-settings concurrency proof did not reach its transaction barrier' >&2
  return 1
}

read_backend_pid() {
  local candidate="$1"
  local backend_pid
  local deadline=$((SECONDS + 20))
  while ((SECONDS < deadline)); do
    if [ -f "$candidate" ]; then
      backend_pid="$(tr -d '[:space:]' <"$candidate")"
      if [[ "$backend_pid" =~ ^[1-9][0-9]*$ ]]; then
        printf '%s\n' "$backend_pid"
        return 0
      fi
    fi
    sleep 0.05
  done
  printf 'runtime-settings concurrency proof did not capture a valid backend identifier from %q\n' "$candidate" >&2
  return 1
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
  echo 'runtime-settings concurrency proof did not observe the required database wait' >&2
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

assert_same_backend_pid() {
  local scenario="$1"
  local log_path="$2"
  local staged_marker="$3"
  local request_marker="$4"
  local staged_pid
  local request_pid

  staged_pid="$(awk -F'|' -v marker="$staged_marker" '
    $1 == "VORTEX_RUNTIME_SETTINGS_PROOF_BACKEND" && $2 == marker { print $3; exit }
  ' "$log_path")"
  request_pid="$(awk -F'|' -v marker="$request_marker" '
    $1 == "VORTEX_RUNTIME_SETTINGS_PROOF_BACKEND" && $2 == marker { print $3; exit }
  ' "$log_path")"

  if [ -z "$staged_pid" ] || [ -z "$request_pid" ]; then
    echo "$scenario could not establish both PostgreSQL backend PIDs; refusing to interpret its result" >&2
    exit 1
  fi
  if [ "$staged_pid" != "$request_pid" ]; then
    echo "$scenario changed PostgreSQL backends ($staged_pid -> $request_pid); transaction-bound staging cannot be proven through this pooled connection" >&2
    exit 1
  fi
}

emit_failure_diagnostics() {
  local log_path
  echo 'runtime-settings concurrency proof failed; bounded diagnostics follow' >&2
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
          and created_by = '$account_id'
      ) or not exists (
        select 1 from vortex_identity.organizations
        where organization_id = '$organization_id'
          and tenant_id = '$tenant_id'
          and short_name = '$fixture_short_name'
          and created_by = '$account_id'
      ) or not exists (
        select 1 from vortex_identity.organization_accounts
        where organization_id = '$organization_id'
          and organization_account_id = '$account_id'
          and identity_id = '$identity_id'
      ) or not exists (
        select 1 from vortex_identity.organization_accounts
        where organization_id = '$organization_id'
          and organization_account_id = '$update_first_account_id'
          and identity_id = '$update_first_identity_id'
      ) or not exists (
        select 1 from vortex_identity.organization_accounts
        where organization_id = '$organization_id'
          and organization_account_id = '$revocation_target_account_id'
          and identity_id = '$revocation_target_identity_id'
      ) then
        raise exception 'Runtime-settings proof fixture ownership marker mismatch';
      end if;
    end
    \$proof\$;
    delete from vortex_identity.organization_runtime_settings_update_staging
      where settings ->> 'organizationId' = '$organization_id';
    delete from vortex_identity.organization_runtime_settings
      where organization_id = '$organization_id';
    delete from vortex_access.organization_role_activations
      where organization_id = '$organization_id';
    delete from vortex_access.organization_role_assignments
      where organization_id = '$organization_id';
    delete from vortex_access.organization_role_permission_entries
      where organization_id = '$organization_id';
    delete from vortex_access.organization_role_revisions
      where organization_id = '$organization_id';
    delete from vortex_access.organization_role_activation_policy_revisions
      where organization_id = '$organization_id';
    delete from vortex_access.organization_roles
      where organization_id = '$organization_id';
    delete from vortex_access.application_role_template_continuities
      where organization_id = '$organization_id';
    delete from vortex_access.permission_continuities
      where organization_id = '$organization_id';
    delete from vortex_access.permission_catalogue_entries
      where organization_id = '$organization_id';
    delete from vortex_access.permission_registrations
      where organization_id = '$organization_id';
    delete from vortex_access.permission_registration_revisions
      where organization_id = '$organization_id';
    delete from vortex_access.organization_access_versions
      where organization_id = '$organization_id';
    delete from vortex_identity.organization_accounts
      where organization_id = '$organization_id';
    delete from vortex_identity.identity_projections
      where identity_id in (
        '$identity_id', '$update_first_identity_id', '$revocation_target_identity_id'
      );
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
  touch "$proof_root/initialize-release" "$proof_root/update-release" \
    "$proof_root/revocation-first-release" "$proof_root/update-first-release" || true
  stop_owned_workers
  if [ "$original_status" -ne 0 ]; then emit_failure_diagnostics; fi
  cleanup_fixture
  operation_status=$?
  if [ "$operation_status" -ne 0 ]; then cleanup_status="$operation_status"; fi
  case "$proof_root" in
    /tmp/vortex-runtime-settings.*) rm -rf -- "$proof_root"; operation_status=$? ;;
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

# Build an owned fixture that has exactly the real platform permission used by
# the protected operation.  This is intentionally not a test-only bypass.
run_sql "
  begin;
  do \$proof\$
  begin
    if exists (select 1 from vortex_identity.tenants where tenant_id = '$tenant_id')
      or exists (select 1 from vortex_identity.organizations where organization_id = '$organization_id') then
      raise exception 'Runtime-settings proof fixture scope already exists';
    end if;
  end
  \$proof\$;
  insert into vortex_identity.tenants (
    tenant_id, short_name, display_name, state, created_at, created_by,
    state_changed_at, revision
  ) values (
    '$tenant_id', '$fixture_short_name', 'Runtime settings proof', 'active',
    pg_catalog.clock_timestamp(), '$account_id', pg_catalog.clock_timestamp(), 1
  );
  insert into vortex_identity.organizations (
    organization_id, tenant_id, short_name, display_name, state, created_at,
    created_by, state_changed_at, revision
  ) values (
    '$organization_id', '$tenant_id', '$fixture_short_name',
    'Runtime settings proof', 'active', pg_catalog.clock_timestamp(),
    '$account_id', pg_catalog.clock_timestamp(), 1
  );
  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values (
    '$identity_id', 'active', pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), '$account_id', '$correlation_initialize', 1
  );
  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values
    ('$update_first_identity_id', 'active', pg_catalog.clock_timestamp(),
      pg_catalog.clock_timestamp(), '$account_id', '$correlation_initialize', 1),
    ('$revocation_target_identity_id', 'active', pg_catalog.clock_timestamp(),
      pg_catalog.clock_timestamp(), '$account_id', '$correlation_initialize', 1);
  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name, state,
    activated_at, suspended_at, changed_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values (
    '$account_id', '$organization_id', '$identity_id', 'Runtime settings actor',
    'active', pg_catalog.clock_timestamp(), null, pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), '$account_id', '$correlation_initialize', 1
  );
  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name, state,
    activated_at, suspended_at, changed_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values
    ('$update_first_account_id', '$organization_id', '$update_first_identity_id',
      'Runtime settings update-first actor', 'active', pg_catalog.clock_timestamp(),
      null, pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), '$account_id',
      '$correlation_initialize', 1),
    ('$revocation_target_account_id', '$organization_id', '$revocation_target_identity_id',
      'Runtime settings revocation target', 'active', pg_catalog.clock_timestamp(),
      null, pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), '$account_id',
      '$correlation_initialize', 1);
  select vortex_access.initialize_organization_access_version(
    '$organization_id', '$account_id', '$correlation_initialize'
  );
  select vortex_access.initialize_platform_permission_catalogue(
    '$organization_id', '$account_id', '$correlation_catalogue'
  );
  insert into vortex_access.organization_roles (
    organization_id, role_id, role_kind, role_key, live_revision, created_by, created_at
  ) values (
    '$organization_id', '$role_id', 'custom', 'runtime_settings_manager', 1,
    '$account_id', pg_catalog.clock_timestamp()
  );
  insert into vortex_access.organization_role_permission_entries (
    organization_id, role_id, role_revision, entry_ordinal, role_kind,
    role_application_root_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id,
    accepted_registration_revision, catalogue_fingerprint,
    continuity_revision, meaning_fingerprint
  )
  select entry.organization_id, '$role_id'::uuid, 1, 1, 'custom', null,
    entry.application_root_id, entry.owner_kind, entry.owner_id, entry.permission_id,
    entry.registration_kind, entry.registration_owner_id, entry.registration_revision,
    registration.permission_catalogue_fingerprint, continuity.continuity_revision,
    entry.meaning_fingerprint
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
    and entry.permission_id = 'c658c254-2884-414a-9012-512c0cfe4b34';
  do \$proof\$
  begin
    if (select count(*) from vortex_access.organization_role_permission_entries
      where organization_id = '$organization_id' and role_id = '$role_id') <> 1 then
      raise exception 'Runtime-settings proof did not receive the fixed manage permission';
    end if;
  end
  \$proof\$;
  insert into vortex_access.organization_role_revisions (
    organization_id, role_id, revision, role_kind, lifecycle,
    privilege_classification, assignment_policy, policy_continuity_revision,
    authority_continuity_revision, activation_policy_id, activation_policy_revision,
    activation_policy_fingerprint, role_key, label, description, changed_by,
    changed_at, change_correlation_id
  ) values (
    '$organization_id', '$role_id', 1, 'custom', 'active', 'privileged',
    'standing', 1, 1, null, null, null, 'runtime_settings_manager',
    'Runtime settings manager', 'Fixture role with only runtime-settings manage authority.',
    '$account_id', pg_catalog.clock_timestamp(), '$correlation_role'
  );
  insert into vortex_access.organization_role_assignments (
    organization_id, role_assignment_id, role_id, assignee_kind,
    organization_account_id, group_id, assignment_kind, revision, starts_at,
    expires_at, state, granted_by, granted_at, grant_correlation_id, changed_by,
    changed_at, change_correlation_id
  ) values (
    '$organization_id', '$assignment_id', '$role_id', 'organization_account',
    '$account_id', null, 'standing', 1, pg_catalog.clock_timestamp() - interval '1 minute',
    pg_catalog.clock_timestamp() + interval '30 minutes', 'live', '$account_id',
    pg_catalog.clock_timestamp(), '$correlation_assignment', '$account_id',
    pg_catalog.clock_timestamp(), '$correlation_assignment'
  );
  insert into vortex_access.organization_role_assignments (
    organization_id, role_assignment_id, role_id, assignee_kind,
    organization_account_id, group_id, assignment_kind, revision, starts_at,
    expires_at, state, granted_by, granted_at, grant_correlation_id, changed_by,
    changed_at, change_correlation_id
  ) values
    ('$organization_id', '$update_first_assignment_id', '$role_id',
      'organization_account', '$update_first_account_id', null, 'standing', 1,
      pg_catalog.clock_timestamp() - interval '1 minute',
      pg_catalog.clock_timestamp() + interval '30 minutes', 'live', '$account_id',
      pg_catalog.clock_timestamp(), '$correlation_assignment', '$account_id',
      pg_catalog.clock_timestamp(), '$correlation_assignment'),
    ('$organization_id', '$revocation_target_assignment_id', '$role_id',
      'organization_account', '$revocation_target_account_id', null, 'standing', 1,
      pg_catalog.clock_timestamp() - interval '1 minute',
      pg_catalog.clock_timestamp() + interval '30 minutes', 'live', '$account_id',
      pg_catalog.clock_timestamp(), '$correlation_assignment', '$account_id',
      pg_catalog.clock_timestamp(), '$correlation_assignment');
  set constraints all immediate;
  commit;
" >/dev/null
fixture_claimed=1

# The exact same initialization request from two runtime transactions must
# serialize through the real organisation row.  The second request is held on
# that row lock, then becomes an idempotent retry rather than a duplicate row
# or a unique-key accident.
"${psql_command[@]}" >"$proof_root/initialize-one.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
set local role vortex_runtime;
select pg_catalog.pg_backend_pid() \g '$proof_root/initialize-one.pid'
select organization_id || '|' || revision
from vortex_identity.initialize_organization_runtime_settings(
  '$organization_id', 'en-NZ', 'Pacific/Auckland', 'NZD', 'medium', 'auto'
) \g '$proof_root/initialize-one.result'
\! touch '$proof_root/initialize-one-ready'
\! deadline=600; while [ ! -f '$proof_root/initialize-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/initialize-release' ]
commit;
SQL
initialize_one_pid=$!
worker_pids+=("$initialize_one_pid")
wait_for_file "$proof_root/initialize-one-ready"
initialize_one_backend="$(read_backend_pid "$proof_root/initialize-one.pid")"

"${psql_command[@]}" >"$proof_root/initialize-two.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
set local role vortex_runtime;
select pg_catalog.pg_backend_pid() \g '$proof_root/initialize-two.pid'
select organization_id || '|' || revision
from vortex_identity.initialize_organization_runtime_settings(
  '$organization_id', 'en-NZ', 'Pacific/Auckland', 'NZD', 'medium', 'auto'
) \g '$proof_root/initialize-two.result'
commit;
SQL
initialize_two_pid=$!
worker_pids+=("$initialize_two_pid")
initialize_two_backend="$(read_backend_pid "$proof_root/initialize-two.pid")"
wait_for_database_blocker "$initialize_two_backend" "$initialize_one_backend"
touch "$proof_root/initialize-release"
wait_owned_worker "$initialize_one_pid"
wait_owned_worker "$initialize_two_pid"
[ "$(tr -d '[:space:]' <"$proof_root/initialize-one.result")" = "${organization_id}|1" ] || {
  echo 'the first concurrent initialization did not return revision one' >&2
  exit 1
}
[ "$(tr -d '[:space:]' <"$proof_root/initialize-two.result")" = "${organization_id}|1" ] || {
  echo 'the second concurrent initialization did not return the same revision-one settings' >&2
  exit 1
}
[ "$(run_sql "select count(*) from vortex_identity.organization_runtime_settings where organization_id = '$organization_id';")" = '1' ] || {
  echo 'concurrent initialization created more than one runtime-settings row' >&2
  exit 1
}

# A stage that commits exists in the private table only for the prior transaction.
# The fresh request has a real resolved human context on the same psql backend and
# must still refuse because its current xid does not match that old stage.
"${psql_command[@]}" >"$proof_root/committed-stage.log" 2>&1 <<SQL
\set VERBOSITY verbose
begin;
select 'VORTEX_RUNTIME_SETTINGS_PROOF_BACKEND|committed-stage|'
  || pg_catalog.pg_backend_pid();
set local role vortex_runtime;
select vortex_identity.stage_organization_runtime_settings_update(
  pg_catalog.jsonb_build_object(
    'organizationId', '$organization_id', 'language', 'en-NZ',
    'timeZone', 'Pacific/Auckland', 'currency', 'AUD', 'dateFormat', 'medium',
    'numberFormat', 'auto', 'revision', 1
  )
);
commit;
begin;
select 'VORTEX_RUNTIME_SETTINGS_PROOF_BACKEND|committed-request|'
  || pg_catalog.pg_backend_pid();
set local role vortex_runtime;
select current_version as resolved_access_version
from vortex_access.organization_access_versions
where organization_id = '$organization_id' \gset
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind', 'human', 'identityAuthorityId', '$identity_authority_id',
  'tenantId', '$tenant_id', 'organizationId', '$organization_id',
  'organizationAccountId', '$account_id', 'identityId', '$identity_id',
  'sessionId', '$session_id', 'authenticationStrength', 'single_factor',
  'issuedAt', pg_catalog.clock_timestamp(),
  'expiresAt', pg_catalog.clock_timestamp() + interval '5 minutes',
  'accessVersion', :resolved_access_version,
  'correlationId', '$correlation_committed_stage'
));
set local role vortex_request;
\set ON_ERROR_STOP off
select * from vortex_access.update_organization_runtime_settings_for_administration(1);
\set ON_ERROR_STOP on
rollback;
SQL
assert_same_backend_pid \
  'committed-stage isolation proof' \
  "$proof_root/committed-stage.log" \
  'committed-stage' \
  'committed-request'
grep -Fq '42501' "$proof_root/committed-stage.log" || {
  echo 'a committed stage was unexpectedly usable by a fresh same-backend transaction' >&2
  exit 1
}
[ "$(run_sql "select currency || '|' || revision from vortex_identity.organization_runtime_settings where organization_id = '$organization_id';")" = 'NZD|1' ] || {
  echo 'a committed stage changed settings without a protected request update' >&2
  exit 1
}

# Rollback removes both the private stage and any possible settings effect.  The
# following transaction on that same psql connection again has a valid context.
"${psql_command[@]}" >"$proof_root/rolled-back-stage.log" 2>&1 <<SQL
\set VERBOSITY verbose
begin;
select 'VORTEX_RUNTIME_SETTINGS_PROOF_BACKEND|rolled-back-stage|'
  || pg_catalog.pg_backend_pid();
set local role vortex_runtime;
select vortex_identity.stage_organization_runtime_settings_update(
  pg_catalog.jsonb_build_object(
    'organizationId', '$organization_id', 'language', 'en-NZ',
    'timeZone', 'Pacific/Auckland', 'currency', 'USD', 'dateFormat', 'medium',
    'numberFormat', 'auto', 'revision', 1
  )
);
rollback;
begin;
select 'VORTEX_RUNTIME_SETTINGS_PROOF_BACKEND|rolled-back-request|'
  || pg_catalog.pg_backend_pid();
set local role vortex_runtime;
select current_version as resolved_access_version
from vortex_access.organization_access_versions
where organization_id = '$organization_id' \gset
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind', 'human', 'identityAuthorityId', '$identity_authority_id',
  'tenantId', '$tenant_id', 'organizationId', '$organization_id',
  'organizationAccountId', '$account_id', 'identityId', '$identity_id',
  'sessionId', '$session_id', 'authenticationStrength', 'single_factor',
  'issuedAt', pg_catalog.clock_timestamp(),
  'expiresAt', pg_catalog.clock_timestamp() + interval '5 minutes',
  'accessVersion', :resolved_access_version,
  'correlationId', '$correlation_rolled_back_stage'
));
set local role vortex_request;
\set ON_ERROR_STOP off
select * from vortex_access.update_organization_runtime_settings_for_administration(1);
\set ON_ERROR_STOP on
rollback;
SQL
assert_same_backend_pid \
  'rolled-back-stage isolation proof' \
  "$proof_root/rolled-back-stage.log" \
  'rolled-back-stage' \
  'rolled-back-request'
grep -Fq '42501' "$proof_root/rolled-back-stage.log" || {
  echo 'a rolled-back stage was unexpectedly usable by a fresh same-backend transaction' >&2
  exit 1
}
[ "$(run_sql "select currency || '|' || revision from vortex_identity.organization_runtime_settings where organization_id = '$organization_id';")" = 'NZD|1' ] || {
  echo 'a rolled-back stage left a settings-row effect' >&2
  exit 1
}

# The first request performs the genuine protected update.  A second stage on
# the same psql backend deliberately carries the old revision; authorization is
# still current, but the Identity row lock rejects the stale write and preserves
# the first result without a second effect.
"${psql_command[@]}" >"$proof_root/stale-update.log" 2>&1 <<SQL
\set VERBOSITY verbose
begin;
select 'VORTEX_RUNTIME_SETTINGS_PROOF_BACKEND|stale-update-first|'
  || pg_catalog.pg_backend_pid();
set local role vortex_runtime;
select vortex_identity.stage_organization_runtime_settings_update(
  pg_catalog.jsonb_build_object(
    'organizationId', '$organization_id', 'language', 'en-NZ',
    'timeZone', 'Pacific/Auckland', 'currency', 'AUD', 'dateFormat', 'long',
    'numberFormat', 'always', 'revision', 1
  )
);
select current_version as resolved_access_version
from vortex_access.organization_access_versions
where organization_id = '$organization_id' \gset
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind', 'human', 'identityAuthorityId', '$identity_authority_id',
  'tenantId', '$tenant_id', 'organizationId', '$organization_id',
  'organizationAccountId', '$account_id', 'identityId', '$identity_id',
  'sessionId', '$session_id', 'authenticationStrength', 'single_factor',
  'issuedAt', pg_catalog.clock_timestamp(),
  'expiresAt', pg_catalog.clock_timestamp() + interval '5 minutes',
  'accessVersion', :resolved_access_version,
  'correlationId', '$correlation_success'
));
set local role vortex_request;
select settings ->> 'currency' as currency, (settings ->> 'revision')::bigint as revision
from vortex_access.update_organization_runtime_settings_for_administration(1);
commit;
begin;
select 'VORTEX_RUNTIME_SETTINGS_PROOF_BACKEND|stale-update-replay|'
  || pg_catalog.pg_backend_pid();
set local role vortex_runtime;
select vortex_identity.stage_organization_runtime_settings_update(
  pg_catalog.jsonb_build_object(
    'organizationId', '$organization_id', 'language', 'en-NZ',
    'timeZone', 'Pacific/Auckland', 'currency', 'CAD', 'dateFormat', 'full',
    'numberFormat', 'never', 'revision', 1
  )
);
select current_version as resolved_access_version
from vortex_access.organization_access_versions
where organization_id = '$organization_id' \gset
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind', 'human', 'identityAuthorityId', '$identity_authority_id',
  'tenantId', '$tenant_id', 'organizationId', '$organization_id',
  'organizationAccountId', '$account_id', 'identityId', '$identity_id',
  'sessionId', '$session_id', 'authenticationStrength', 'single_factor',
  'issuedAt', pg_catalog.clock_timestamp(),
  'expiresAt', pg_catalog.clock_timestamp() + interval '5 minutes',
  'accessVersion', :resolved_access_version,
  'correlationId', '$correlation_stale'
));
set local role vortex_request;
\set ON_ERROR_STOP off
select * from vortex_access.update_organization_runtime_settings_for_administration(1);
\set ON_ERROR_STOP on
rollback;
SQL
assert_same_backend_pid \
  'stale-update replay proof' \
  "$proof_root/stale-update.log" \
  'stale-update-first' \
  'stale-update-replay'
grep -Fq 'AUD|2' "$proof_root/stale-update.log" || {
  echo 'the first protected settings update did not return its exact revision' >&2
  exit 1
}
grep -Fq '40001' "$proof_root/stale-update.log" || {
  echo 'a second protected update with the old revision did not fail stale' >&2
  exit 1
}
[ "$(run_sql "select currency || '|' || date_format || '|' || number_format || '|' || revision from vortex_identity.organization_runtime_settings where organization_id = '$organization_id';")" = 'AUD|long|always|2' ] || {
  echo 'a stale protected update had a second settings-row effect' >&2
  exit 1
}

# Two authorized requests can stage separate updates with the same current
# revision. The second reaches the real Access-version lock and waits for the
# winner. Once that winner commits revision three, the waiting request is stale
# at the Identity row and cannot overwrite it.
"${psql_command[@]}" >"$proof_root/concurrent-update-one.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
set local role vortex_runtime;
select pg_catalog.pg_backend_pid() \g '$proof_root/concurrent-update-one.pid'
select vortex_identity.stage_organization_runtime_settings_update(
  pg_catalog.jsonb_build_object(
    'organizationId', '$organization_id', 'language', 'en-NZ',
    'timeZone', 'Pacific/Auckland', 'currency', 'CAD', 'dateFormat', 'full',
    'numberFormat', 'never', 'revision', 2
  )
);
select current_version as resolved_access_version
from vortex_access.organization_access_versions
where organization_id = '$organization_id' \gset
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind', 'human', 'identityAuthorityId', '$identity_authority_id',
  'tenantId', '$tenant_id', 'organizationId', '$organization_id',
  'organizationAccountId', '$account_id', 'identityId', '$identity_id',
  'sessionId', '$session_id', 'authenticationStrength', 'single_factor',
  'issuedAt', pg_catalog.clock_timestamp(),
  'expiresAt', pg_catalog.clock_timestamp() + interval '5 minutes',
  'accessVersion', :resolved_access_version,
  'correlationId', '$correlation_concurrent_update_one'
));
set local role vortex_request;
select (settings ->> 'currency') || '|' || (settings ->> 'revision')
from vortex_access.update_organization_runtime_settings_for_administration(2)
  \g '$proof_root/concurrent-update-one.result'
\! touch '$proof_root/concurrent-update-one-ready'
\! deadline=600; while [ ! -f '$proof_root/update-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/update-release' ]
commit;
SQL
concurrent_update_one_pid=$!
worker_pids+=("$concurrent_update_one_pid")
wait_for_file "$proof_root/concurrent-update-one-ready"
concurrent_update_one_backend="$(read_backend_pid "$proof_root/concurrent-update-one.pid")"

"${psql_command[@]}" >"$proof_root/concurrent-update-two.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
set local role vortex_runtime;
select pg_catalog.pg_backend_pid() \g '$proof_root/concurrent-update-two.pid'
select vortex_identity.stage_organization_runtime_settings_update(
  pg_catalog.jsonb_build_object(
    'organizationId', '$organization_id', 'language', 'en-NZ',
    'timeZone', 'Pacific/Auckland', 'currency', 'USD', 'dateFormat', 'medium',
    'numberFormat', 'auto', 'revision', 2
  )
);
select current_version as resolved_access_version
from vortex_access.organization_access_versions
where organization_id = '$organization_id' \gset
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind', 'human', 'identityAuthorityId', '$identity_authority_id',
  'tenantId', '$tenant_id', 'organizationId', '$organization_id',
  'organizationAccountId', '$account_id', 'identityId', '$identity_id',
  'sessionId', '$session_id', 'authenticationStrength', 'single_factor',
  'issuedAt', pg_catalog.clock_timestamp(),
  'expiresAt', pg_catalog.clock_timestamp() + interval '5 minutes',
  'accessVersion', :resolved_access_version,
  'correlationId', '$correlation_concurrent_update_two'
));
set local role vortex_request;
\set ON_ERROR_STOP off
select * from vortex_access.update_organization_runtime_settings_for_administration(2);
\set ON_ERROR_STOP on
rollback;
SQL
concurrent_update_two_pid=$!
worker_pids+=("$concurrent_update_two_pid")
concurrent_update_two_backend="$(read_backend_pid "$proof_root/concurrent-update-two.pid")"
wait_for_database_blocker "$concurrent_update_two_backend" "$concurrent_update_one_backend"
touch "$proof_root/update-release"
wait_owned_worker "$concurrent_update_one_pid"
wait_owned_worker "$concurrent_update_two_pid"
[ "$(tr -d '[:space:]' <"$proof_root/concurrent-update-one.result")" = 'CAD|3' ] || {
  echo 'the winning concurrent protected update did not return revision three' >&2
  exit 1
}
grep -Fq '40001' "$proof_root/concurrent-update-two.log" || {
  echo 'the waiting concurrent protected update did not fail stale' >&2
  exit 1
}
[ "$(run_sql "select currency || '|' || date_format || '|' || number_format || '|' || revision from vortex_identity.organization_runtime_settings where organization_id = '$organization_id';")" = 'CAD|full|never|3' ] || {
  echo 'the stale concurrent protected update overwrote the winner' >&2
  exit 1
}

# Revocation owns the shared Access-version lock before the already-staged
# request may enter the protected update.  The real assignment change advances
# Access, so the waiting request must revalidate and refuse before it writes.
PGAPPNAME="vortex-runtime-settings-revocation-first-$fixture_short_name" \
  "${psql_command[@]}" >"$proof_root/revocation-first.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/revocation-first.pid'
select 1 from vortex_access.organization_access_versions
where organization_id = '$organization_id' for update;
\! touch '$proof_root/revocation-first-ready'
\! deadline=600; while [ ! -f '$proof_root/revocation-first-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/revocation-first-release' ]
select outcome, operation, revision, access_version
from vortex_access.coordinate_organization_role_assignment_change(
  'revoke', '$organization_id', '$assignment_id', 1,
  null, null, null, null, null, null, null, null,
  '$account_id', '$correlation_revocation_first'
);
commit;
SQL
revocation_first_pid=$!
worker_pids+=("$revocation_first_pid")
wait_for_file "$proof_root/revocation-first-ready"
revocation_first_backend="$(read_backend_pid "$proof_root/revocation-first.pid")"

PGAPPNAME="vortex-runtime-settings-revocation-first-update-$fixture_short_name" \
  "${psql_command[@]}" >"$proof_root/revocation-first-update.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
set local role vortex_runtime;
select pg_catalog.pg_backend_pid() \g '$proof_root/revocation-first-update.pid'
select vortex_identity.stage_organization_runtime_settings_update(
  pg_catalog.jsonb_build_object(
    'organizationId', '$organization_id', 'language', 'en-NZ',
    'timeZone', 'Pacific/Auckland', 'currency', 'USD', 'dateFormat', 'medium',
    'numberFormat', 'auto', 'revision', 3
  )
);
select current_version as resolved_access_version
from vortex_access.organization_access_versions
where organization_id = '$organization_id' \gset
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind', 'human', 'identityAuthorityId', '$identity_authority_id',
  'tenantId', '$tenant_id', 'organizationId', '$organization_id',
  'organizationAccountId', '$account_id', 'identityId', '$identity_id',
  'sessionId', '$session_id', 'authenticationStrength', 'single_factor',
  'issuedAt', pg_catalog.clock_timestamp(),
  'expiresAt', pg_catalog.clock_timestamp() + interval '5 minutes',
  'accessVersion', :resolved_access_version,
  'correlationId', '$correlation_revocation_first_update'
));
set local role vortex_request;
\set ON_ERROR_STOP off
select * from vortex_access.update_organization_runtime_settings_for_administration(3);
\set ON_ERROR_STOP on
rollback;
SQL
revocation_first_update_pid=$!
worker_pids+=("$revocation_first_update_pid")
revocation_first_update_backend="$(read_backend_pid "$proof_root/revocation-first-update.pid")"
wait_for_database_blocker "$revocation_first_update_backend" "$revocation_first_backend"
touch "$proof_root/revocation-first-release"
wait_owned_worker "$revocation_first_pid"
wait_owned_worker "$revocation_first_update_pid"
grep -Fq 'changed|revoke|2|2' "$proof_root/revocation-first.log" || {
  echo 'revocation-first did not commit the real terminal assignment state and Access version' >&2
  exit 1
}
grep -Fq '42501' "$proof_root/revocation-first-update.log" || {
  echo 'a settings update staged before revocation did not refuse after its Access wait' >&2
  exit 1
}
[ "$(run_sql "select pg_catalog.concat_ws('|', version.current_version, assignment.revision, assignment.state) from vortex_access.organization_access_versions as version join vortex_access.organization_role_assignments as assignment on assignment.organization_id = version.organization_id where version.organization_id = '$organization_id' and assignment.role_assignment_id = '$assignment_id';")" = '2|2|revoked' ] || {
  echo 'revocation-first left unexpected assignment or Access state' >&2
  exit 1
}
[ "$(run_sql "select currency || '|' || date_format || '|' || number_format || '|' || revision from vortex_identity.organization_runtime_settings where organization_id = '$organization_id';")" = 'CAD|full|never|3' ] || {
  echo 'a revoked actor changed runtime settings after the Access wait' >&2
  exit 1
}

# A different still-authorized actor wins the same Access-version lock with a
# single settings write.  A real revocation of an independent assignment waits
# behind that update, then commits after it; neither operation is skipped.
PGAPPNAME="vortex-runtime-settings-update-first-$fixture_short_name" \
  "${psql_command[@]}" >"$proof_root/update-first.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
set local role vortex_runtime;
select pg_catalog.pg_backend_pid() \g '$proof_root/update-first.pid'
select vortex_identity.stage_organization_runtime_settings_update(
  pg_catalog.jsonb_build_object(
    'organizationId', '$organization_id', 'language', 'en-NZ',
    'timeZone', 'Pacific/Auckland', 'currency', 'GBP', 'dateFormat', 'long',
    'numberFormat', 'min2', 'revision', 3
  )
);
select current_version as resolved_access_version
from vortex_access.organization_access_versions
where organization_id = '$organization_id' \gset
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind', 'human', 'identityAuthorityId', '$identity_authority_id',
  'tenantId', '$tenant_id', 'organizationId', '$organization_id',
  'organizationAccountId', '$update_first_account_id',
  'identityId', '$update_first_identity_id', 'sessionId', '$session_id',
  'authenticationStrength', 'single_factor',
  'issuedAt', pg_catalog.clock_timestamp(),
  'expiresAt', pg_catalog.clock_timestamp() + interval '5 minutes',
  'accessVersion', :resolved_access_version,
  'correlationId', '$correlation_update_first'
));
set local role vortex_request;
select (settings ->> 'currency') || '|' || (settings ->> 'revision')
from vortex_access.update_organization_runtime_settings_for_administration(3)
  \g '$proof_root/update-first.result'
\! touch '$proof_root/update-first-ready'
\! deadline=600; while [ ! -f '$proof_root/update-first-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/update-first-release' ]
commit;
SQL
update_first_pid=$!
worker_pids+=("$update_first_pid")
wait_for_file "$proof_root/update-first-ready"
update_first_backend="$(read_backend_pid "$proof_root/update-first.pid")"

PGAPPNAME="vortex-runtime-settings-update-first-revocation-$fixture_short_name" \
  "${psql_command[@]}" >"$proof_root/update-first-revocation.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/update-first-revocation.pid'
select outcome, operation, revision, access_version
from vortex_access.coordinate_organization_role_assignment_change(
  'revoke', '$organization_id', '$revocation_target_assignment_id', 1,
  null, null, null, null, null, null, null, null,
  '$account_id', '$correlation_update_first_revocation'
);
commit;
SQL
update_first_revocation_pid=$!
worker_pids+=("$update_first_revocation_pid")
update_first_revocation_backend="$(read_backend_pid "$proof_root/update-first-revocation.pid")"
wait_for_database_blocker "$update_first_revocation_backend" "$update_first_backend"
touch "$proof_root/update-first-release"
wait_owned_worker "$update_first_pid"
wait_owned_worker "$update_first_revocation_pid"
[ "$(tr -d '[:space:]' <"$proof_root/update-first.result")" = 'GBP|4' ] || {
  echo 'update-first did not commit its one protected settings revision' >&2
  exit 1
}
grep -Fq 'changed|revoke|2|3' "$proof_root/update-first-revocation.log" || {
  echo 'the real revocation after the settings update did not commit exact state' >&2
  exit 1
}
[ "$(run_sql "select pg_catalog.concat_ws('|', version.current_version, assignment.revision, assignment.state) from vortex_access.organization_access_versions as version join vortex_access.organization_role_assignments as assignment on assignment.organization_id = version.organization_id where version.organization_id = '$organization_id' and assignment.role_assignment_id = '$revocation_target_assignment_id';")" = '3|2|revoked' ] || {
  echo 'update-first/revocation ordering left unexpected assignment or Access state' >&2
  exit 1
}
[ "$(run_sql "select currency || '|' || date_format || '|' || number_format || '|' || revision from vortex_identity.organization_runtime_settings where organization_id = '$organization_id';")" = 'GBP|long|min2|4' ] || {
  echo 'the revocation after update changed or repeated the settings write' >&2
  exit 1
}

echo 'organization runtime-settings transaction-binding proof passed'
