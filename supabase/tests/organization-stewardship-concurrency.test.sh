#!/usr/bin/env bash

set -euo pipefail

run_uuid="${VORTEX_STEWARDSHIP_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then
  [ -r /proc/sys/kernel/random/uuid ] || {
    echo 'a Linux random UUID source is required for the stewardship proof' >&2
    exit 1
  }
  IFS= read -r run_uuid </proc/sys/kernel/random/uuid
fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  echo 'VORTEX_STEWARDSHIP_PROOF_RUN_ID must be a lowercase UUID v4' >&2
  exit 1
}

readonly run_uuid
readonly run_token="${run_uuid//-/}"
readonly fixture_name_token="${run_token:0:24}"
readonly fixture_short_name="steward_${fixture_name_token}"
proof_root="$(mktemp -d /tmp/vortex-stewardship.XXXXXX)"
readonly proof_root
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id="d1${run_uuid:2}"
readonly organization_id="d2${run_uuid:2}"
readonly identity_a_id="d3${run_uuid:2}"
readonly identity_b_id="d4${run_uuid:2}"
readonly account_a_id="d5${run_uuid:2}"
readonly account_b_id="d6${run_uuid:2}"
readonly role_id="d7${run_uuid:2}"
readonly assignment_a_id="d8${run_uuid:2}"
readonly assignment_b_id="d9${run_uuid:2}"
readonly delegation_a_id="da${run_uuid:2}"
readonly delegation_b_id="db${run_uuid:2}"
readonly actor_id="dc${run_uuid:2}"
readonly correlation_initialize="dd${run_uuid:2}"
readonly correlation_catalogue="de${run_uuid:2}"
readonly correlation_adopt="df${run_uuid:2}"
readonly correlation_assignment_b="e1${run_uuid:2}"
readonly correlation_delegation_b="e2${run_uuid:2}"
readonly correlation_remove_a="e3${run_uuid:2}"
readonly correlation_remove_b="e4${run_uuid:2}"

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
  echo 'stewardship proof did not reach its transaction barrier' >&2
  return 1
}

read_backend_pid() {
  local candidate="$1"
  local backend_pid
  wait_for_file "$candidate"
  backend_pid="$(tr -d '[:space:]' <"$candidate")"
  [[ "$backend_pid" =~ ^[1-9][0-9]*$ ]] || {
    printf 'stewardship proof captured an invalid backend identifier: %q\n' "$backend_pid" >&2
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
  echo 'stewardship proof did not observe the required governance lock' >&2
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
  echo 'stewardship proof failed; bounded owned worker diagnostics follow' >&2
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
        where organization_id = '$organization_id'
          and organization_account_id = '$account_a_id'
          and identity_id = '$identity_a_id'
      ) or not exists (
        select 1 from vortex_identity.organization_accounts
        where organization_id = '$organization_id'
          and organization_account_id = '$account_b_id'
          and identity_id = '$identity_b_id'
      ) or not exists (
        select 1
        from vortex_access.organization_stewardship_requirements
        where organization_id = '$organization_id'
          and original_organization_account_id = '$account_a_id'
          and original_role_id = '$role_id'
          and original_role_assignment_id = '$assignment_a_id'
          and original_delegation_authority_id = '$delegation_a_id'
          and adopted_by = '$actor_id'
          and adoption_correlation_id = '$correlation_adopt'
      ) then
        raise exception 'Stewardship proof fixture ownership marker mismatch';
      end if;
    end
    \$proof\$;
    delete from vortex_access.organization_stewardship_requirements
      where organization_id = '$organization_id';
    delete from vortex_access.organization_delegation_authorities
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
      where identity_id in ('$identity_a_id', '$identity_b_id');
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
  touch "$proof_root/remove-a-release"
  stop_owned_workers
  if [ "$original_status" -ne 0 ]; then emit_owned_failure_diagnostics; fi
  cleanup_fixture
  operation_status=$?
  if [ "$operation_status" -ne 0 ]; then cleanup_status="$operation_status"; fi
  case "$proof_root" in
    /tmp/vortex-stewardship.*) rm -rf -- "$proof_root"; operation_status=$? ;;
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
    '$tenant_id', '$fixture_short_name', 'Stewardship proof', 'active',
    pg_catalog.statement_timestamp(), '$actor_id',
    pg_catalog.statement_timestamp(), 1
  );
  insert into vortex_identity.organizations (
    organization_id, tenant_id, short_name, display_name, state,
    created_at, created_by, state_changed_at, revision
  ) values (
    '$organization_id', '$tenant_id', '$fixture_short_name',
    'Stewardship proof', 'active', pg_catalog.statement_timestamp(),
    '$actor_id', pg_catalog.statement_timestamp(), 1
  );
  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values
    ('$identity_a_id', 'active', pg_catalog.statement_timestamp(),
      pg_catalog.statement_timestamp(), '$actor_id', '$correlation_initialize', 1),
    ('$identity_b_id', 'active', pg_catalog.statement_timestamp(),
      pg_catalog.statement_timestamp(), '$actor_id', '$correlation_initialize', 1);
  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name,
    state, activated_at, suspended_at, changed_at, state_changed_at,
    state_changed_by, state_change_correlation_id, revision
  ) values
    ('$account_a_id', '$organization_id', '$identity_a_id', 'Steward A',
      'active', pg_catalog.statement_timestamp(), null,
      pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
      '$actor_id', '$correlation_initialize', 1),
    ('$account_b_id', '$organization_id', '$identity_b_id', 'Steward B',
      'active', pg_catalog.statement_timestamp(), null,
      pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
      '$actor_id', '$correlation_initialize', 1);
  select * from vortex_access.initialize_organization_access_version(
    '$organization_id', '$actor_id', '$correlation_initialize'
  );
  select * from vortex_access.initialize_platform_permission_catalogue(
    '$organization_id', '$actor_id', '$correlation_catalogue'
  );
  select * from vortex_access.coordinate_organization_stewardship_adoption(
    '$organization_id', '$account_a_id', '$role_id',
    'organization_steward', 'Organisation steward',
    'Permanent minimum organisation administration.',
    '$assignment_a_id', '$delegation_a_id', '$actor_id', '$correlation_adopt'
  );
  select * from vortex_access.coordinate_organization_role_assignment_change(
    'grant', '$organization_id', '$assignment_b_id', null, '$role_id', 1,
    'organization_account', '$account_b_id', null, 'standing',
    pg_catalog.clock_timestamp(), null, '$actor_id', '$correlation_assignment_b'
  );
  select *
  from vortex_access.coordinate_organization_delegation_authority_change(
    'grant_delegation', '$organization_id', '$delegation_b_id', null,
    'organization_account', '$account_b_id', null,
    'organization_catalogue', null, null, pg_catalog.clock_timestamp(), null,
    '$actor_id', '$correlation_delegation_b'
  );
  set constraints all immediate;
  commit;
" >/dev/null
fixture_claimed=1

baseline_access="$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id = '$organization_id';")"
[[ "$baseline_access" =~ ^[1-9][0-9]*$ ]] || {
  echo 'stewardship proof could not read its baseline Access version' >&2
  exit 1
}
expected_access=$((baseline_access + 1))

# The first real writer removes one of two qualifying stewards, then retains
# the governance lock. The competing writer is observed waiting on that exact
# transaction and must recheck the final-steward invariant after it commits.
PGAPPNAME="vortex-steward-remove-a-$fixture_name_token" "${psql_command[@]}" >"$proof_root/remove-a.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/remove-a.pid'
select outcome, operation, revision, access_version
from vortex_access.coordinate_organization_role_assignment_change(
  'revoke', '$organization_id', '$assignment_a_id', 1,
  null, null, null, null, null, null, null, null,
  '$actor_id', '$correlation_remove_a'
);
\! touch '$proof_root/remove-a-ready'
\! deadline=600; while [ ! -f '$proof_root/remove-a-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/remove-a-release' ]
commit;
SQL
remove_a_pid=$!; worker_pids+=("$remove_a_pid")
wait_for_file "$proof_root/remove-a-ready"
remove_a_db="$(read_backend_pid "$proof_root/remove-a.pid")"

PGAPPNAME="vortex-steward-remove-b-$fixture_name_token" "${psql_command[@]}" >"$proof_root/remove-b.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/remove-b.pid'
select outcome, operation, revision, access_version
from vortex_access.coordinate_organization_role_assignment_change(
  'revoke', '$organization_id', '$assignment_b_id', 1,
  null, null, null, null, null, null, null, null,
  '$actor_id', '$correlation_remove_b'
);
commit;
SQL
remove_b_pid=$!; worker_pids+=("$remove_b_pid")
remove_b_db="$(read_backend_pid "$proof_root/remove-b.pid")"
wait_for_database_blocker "$remove_b_db" "$remove_a_db"
touch "$proof_root/remove-a-release"

wait_owned_worker "$remove_a_pid"
if wait_owned_worker "$remove_b_pid"; then
  echo 'the competing final-steward removal unexpectedly committed' >&2
  exit 1
fi

grep -Fq "changed|revoke|2|$expected_access" "$proof_root/remove-a.log" || {
  echo 'the first steward removal did not return its exact result' >&2
  exit 1
}
grep -q '23514' "$proof_root/remove-b.log" || {
  echo 'the competing final-steward removal lacked invariant-refusal evidence' >&2
  exit 1
}

final_state="$(run_sql "
  select pg_catalog.concat_ws('|', version.current_version,
    assignment_a.revision, assignment_a.state,
    assignment_b.revision, assignment_b.state,
    vortex_access.organization_has_permanent_steward(
      version.organization_id, pg_catalog.clock_timestamp()
    ),
    (select pg_catalog.count(*)
      from vortex_access.organization_stewardship_requirements
      where organization_id = version.organization_id)
  )
  from vortex_access.organization_access_versions as version
  join vortex_access.organization_role_assignments as assignment_a
    on assignment_a.organization_id = version.organization_id
    and assignment_a.role_assignment_id = '$assignment_a_id'
  join vortex_access.organization_role_assignments as assignment_b
    on assignment_b.organization_id = version.organization_id
    and assignment_b.role_assignment_id = '$assignment_b_id'
  where version.organization_id = '$organization_id';
")"
[ "$final_state" = "$expected_access|2|revoked|1|live|t|1" ] || {
  echo "concurrent steward removals left unexpected exact state: $final_state" >&2
  exit 1
}

echo 'organization stewardship concurrency proof passed'
