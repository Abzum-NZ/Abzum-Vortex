#!/usr/bin/env bash

set -euo pipefail

run_uuid="${VORTEX_GROUP_CHANGE_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then
  [ -r /proc/sys/kernel/random/uuid ] || {
    echo 'a Linux random UUID source is required for the Group-change proof' >&2
    exit 1
  }
  IFS= read -r run_uuid </proc/sys/kernel/random/uuid
fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  echo 'VORTEX_GROUP_CHANGE_PROOF_RUN_ID must be a lowercase UUID v4' >&2
  exit 1
}

readonly run_uuid
readonly run_token="${run_uuid//-/}"
readonly fixture_name_token="${run_token:0:24}"
readonly fixture_short_name="group_${fixture_name_token}"
proof_root="$(mktemp -d /tmp/vortex-group-change.XXXXXX)"
readonly proof_root
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id="c1${run_uuid:2}"
readonly organization_id="c2${run_uuid:2}"
readonly group_a_id="c3${run_uuid:2}"
readonly group_b_id="c4${run_uuid:2}"
readonly group_c_id="c5${run_uuid:2}"
readonly role_id="c6${run_uuid:2}"
readonly assignment_b_id="c7${run_uuid:2}"
readonly assignment_c_id="c8${run_uuid:2}"
readonly actor_id="c9${run_uuid:2}"
readonly correlation_initialize="ca${run_uuid:2}"
readonly correlation_create_a="cb${run_uuid:2}"
readonly correlation_create_b="cc${run_uuid:2}"
readonly correlation_create_c="cd${run_uuid:2}"
readonly correlation_revise_a="ce${run_uuid:2}"
readonly correlation_retire_a="cf${run_uuid:2}"
readonly correlation_grant_b="d0${run_uuid:2}"
readonly correlation_retire_b="d1${run_uuid:2}"
readonly correlation_retire_c="d2${run_uuid:2}"
readonly correlation_grant_c="d3${run_uuid:2}"

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
  echo 'Group-change proof did not reach its transaction barrier' >&2
  return 1
}

read_backend_pid() {
  local candidate="$1"
  local backend_pid
  wait_for_file "$candidate"
  backend_pid="$(tr -d '[:space:]' <"$candidate")"
  [[ "$backend_pid" =~ ^[1-9][0-9]*$ ]] || {
    printf 'Group-change proof captured an invalid backend identifier: %q\n' "$backend_pid" >&2
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
  echo 'Group-change proof did not observe the required lock ordering' >&2
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
  echo 'Group-change proof failed; bounded owned worker diagnostics follow' >&2
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
      ) then
        raise exception 'Group-change proof fixture ownership marker mismatch';
      end if;
    end
    \$proof\$;
    delete from vortex_access.organization_role_assignments
      where organization_id = '$organization_id'
        and role_assignment_id in ('$assignment_b_id', '$assignment_c_id');
    delete from vortex_access.organization_role_permission_entries
      where organization_id = '$organization_id' and role_id = '$role_id';
    delete from vortex_access.organization_role_revisions
      where organization_id = '$organization_id' and role_id = '$role_id';
    delete from vortex_access.organization_roles
      where organization_id = '$organization_id' and role_id = '$role_id';
    delete from vortex_access.organization_groups
      where organization_id = '$organization_id'
        and group_id in ('$group_a_id', '$group_b_id', '$group_c_id');
    delete from vortex_access.organization_access_versions
      where organization_id = '$organization_id';
    delete from vortex_identity.organizations
      where organization_id = '$organization_id';
    delete from vortex_identity.tenants where tenant_id = '$tenant_id';
    commit;
  " >/dev/null
}

finalize() {
  local original_status=$?
  local cleanup_status=0
  touch "$proof_root/r1-release" "$proof_root/r2-release" "$proof_root/r3-release" || true
  stop_owned_workers
  if [ "$original_status" -ne 0 ]; then emit_owned_failure_diagnostics; fi
  if cleanup_fixture; then :; else cleanup_status=$?; fi
  case "$proof_root" in
    /tmp/vortex-group-change.*) rm -rf -- "$proof_root" ;;
    *) echo 'refusing to remove an unexpected Group-change proof directory' >&2; cleanup_status=1 ;;
  esac
  if [ "$original_status" -ne 0 ]; then exit "$original_status"; fi
  exit "$cleanup_status"
}
trap finalize EXIT

run_sql "
  begin;
  insert into vortex_identity.tenants (
    tenant_id, short_name, display_name, state, created_at, created_by,
    state_changed_at, revision
  ) values (
    '$tenant_id', '$fixture_short_name', 'Group change proof', 'active',
    pg_catalog.clock_timestamp(), '$actor_id', pg_catalog.clock_timestamp(), 1
  );
  insert into vortex_identity.organizations (
    organization_id, tenant_id, short_name, display_name, state, created_at,
    created_by, state_changed_at, revision
  ) values (
    '$organization_id', '$tenant_id', '$fixture_short_name',
    'Group change proof', 'active', pg_catalog.clock_timestamp(), '$actor_id',
    pg_catalog.clock_timestamp(), 1
  );
  select * from vortex_access.initialize_organization_access_version(
    '$organization_id', '$actor_id', '$correlation_initialize'
  );
  set local session_replication_role = replica;
  insert into vortex_access.organization_roles (
    organization_id, role_id, role_kind, role_key, live_revision,
    created_by, created_at
  ) values (
    '$organization_id', '$role_id', 'custom', 'proof_group_role', 1,
    '$actor_id', pg_catalog.clock_timestamp()
  );
  insert into vortex_access.organization_role_revisions (
    organization_id, role_id, revision, role_kind, lifecycle,
    privilege_classification, assignment_policy, policy_continuity_revision,
    authority_continuity_revision, role_key, label, description,
    changed_by, changed_at, change_correlation_id
  ) values (
    '$organization_id', '$role_id', 1, 'custom', 'active', 'standard',
    'standing', 1, 1, 'proof_group_role', 'Proof Group role',
    'Neutral role used only by the Group-change concurrency proof.',
    '$actor_id', pg_catalog.clock_timestamp(), '$correlation_initialize'
  );
  set local session_replication_role = origin;
  commit;
" >/dev/null
fixture_claimed=1

run_sql "select * from vortex_access.coordinate_organization_group_change(
  'create_group', '$organization_id', '$group_a_id', null,
  'proof_group_a_${fixture_name_token}', 'Proof Group A', '$actor_id',
  '$correlation_create_a');" >/dev/null
run_sql "select * from vortex_access.coordinate_organization_group_change(
  'create_group', '$organization_id', '$group_b_id', null,
  'proof_group_b_${fixture_name_token}', 'Proof Group B', '$actor_id',
  '$correlation_create_b');" >/dev/null
run_sql "select * from vortex_access.coordinate_organization_group_change(
  'create_group', '$organization_id', '$group_c_id', null,
  'proof_group_c_${fixture_name_token}', 'Proof Group C', '$actor_id',
  '$correlation_create_c');" >/dev/null

[ "$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id = '$organization_id';")" = '4' ] || {
  echo 'Group-change proof did not establish the expected Access baseline' >&2
  exit 1
}

# R1: two real Group writers review revision one. Revision wins governance and
# retirement waits, then rechecks and refuses without a second Access increment.
PGAPPNAME="vortex-group-r1-revise-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r1-revise.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r1-revise.pid'
select 1 from vortex_access.organization_access_versions
where organization_id = '$organization_id' for update;
\! touch '$proof_root/r1-ready'
\! deadline=600; while [ ! -f '$proof_root/r1-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/r1-release' ]
select outcome, operation, revision, access_version
from vortex_access.coordinate_organization_group_change(
  'revise_group_label', '$organization_id', '$group_a_id', 1,
  null, 'Proof Group A revised', '$actor_id', '$correlation_revise_a'
);
commit;
SQL
r1_revise_pid=$!; worker_pids+=("$r1_revise_pid")
wait_for_file "$proof_root/r1-ready"
r1_revise_db="$(read_backend_pid "$proof_root/r1-revise.pid")"

PGAPPNAME="vortex-group-r1-retire-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r1-retire.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r1-retire.pid'
select * from vortex_access.coordinate_organization_group_change(
  'retire_group', '$organization_id', '$group_a_id', 1,
  null, null, '$actor_id', '$correlation_retire_a'
);
commit;
SQL
r1_retire_pid=$!; worker_pids+=("$r1_retire_pid")
r1_retire_db="$(read_backend_pid "$proof_root/r1-retire.pid")"
wait_for_database_blocker "$r1_retire_db" "$r1_revise_db"
touch "$proof_root/r1-release"
wait_owned_worker "$r1_revise_pid"
if wait_owned_worker "$r1_retire_pid"; then
  echo 'retirement behind a committed label revision unexpectedly succeeded' >&2
  exit 1
fi
grep -Fq 'changed|revise_group_label|2|5' "$proof_root/r1-revise.log" || {
  echo 'the revision-first writer did not return its exact result' >&2
  exit 1
}
grep -q '40001' "$proof_root/r1-retire.log" || {
  echo 'the stale retirement lacked stable stale evidence' >&2
  exit 1
}
[ "$(run_sql "select pg_catalog.concat_ws('|', version.current_version, organization_group.revision, organization_group.state, organization_group.label) from vortex_access.organization_access_versions as version join vortex_access.organization_groups as organization_group on organization_group.organization_id = version.organization_id where version.organization_id = '$organization_id' and organization_group.group_id = '$group_a_id';")" = '5|2|active|Proof Group A revised' ] || {
  echo 'revision-versus-retirement left unexpected Group or Access state' >&2
  exit 1
}

# R2: the real Group assignment owns governance, waits on the Group row, then
# commits before retirement. Retirement preserves the already granted fact.
PGAPPNAME="vortex-group-r2-holder-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r2-holder.log" 2>&1 <<SQL &
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r2-holder.pid'
select 1 from vortex_access.organization_groups
where organization_id = '$organization_id' and group_id = '$group_b_id' for update;
\! touch '$proof_root/r2-ready'
\! deadline=600; while [ ! -f '$proof_root/r2-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/r2-release' ]
commit;
SQL
r2_holder_pid=$!; worker_pids+=("$r2_holder_pid")
wait_for_file "$proof_root/r2-ready"
r2_holder_db="$(read_backend_pid "$proof_root/r2-holder.pid")"

PGAPPNAME="vortex-group-r2-grant-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r2-grant.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r2-grant.pid'
select outcome, operation, revision, access_version
from vortex_access.coordinate_organization_role_assignment_change(
  'grant', '$organization_id', '$assignment_b_id', null,
  '$role_id', 1, 'group', null, '$group_b_id', 'standing',
  pg_catalog.clock_timestamp(), null, '$actor_id', '$correlation_grant_b'
);
commit;
SQL
r2_grant_pid=$!; worker_pids+=("$r2_grant_pid")
r2_grant_db="$(read_backend_pid "$proof_root/r2-grant.pid")"
wait_for_database_blocker "$r2_grant_db" "$r2_holder_db"

PGAPPNAME="vortex-group-r2-retire-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r2-retire.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r2-retire.pid'
select outcome, operation, revision, access_version
from vortex_access.coordinate_organization_group_change(
  'retire_group', '$organization_id', '$group_b_id', 1,
  null, null, '$actor_id', '$correlation_retire_b'
);
commit;
SQL
r2_retire_pid=$!; worker_pids+=("$r2_retire_pid")
r2_retire_db="$(read_backend_pid "$proof_root/r2-retire.pid")"
wait_for_database_blocker "$r2_retire_db" "$r2_grant_db"
touch "$proof_root/r2-release"
wait_owned_worker "$r2_holder_pid"
wait_owned_worker "$r2_grant_pid"
wait_owned_worker "$r2_retire_pid"
grep -Fq 'changed|grant|1|6' "$proof_root/r2-grant.log" || {
  echo 'the grant-first writer did not return its exact result' >&2
  exit 1
}
grep -Fq 'changed|retire_group|2|7' "$proof_root/r2-retire.log" || {
  echo 'retirement after the Group grant did not return its exact result' >&2
  exit 1
}
[ "$(run_sql "select pg_catalog.concat_ws('|', version.current_version, organization_group.revision, organization_group.state, assignment.revision, assignment.state, pg_catalog.count(*) over ()) from vortex_access.organization_access_versions as version join vortex_access.organization_groups as organization_group on organization_group.organization_id = version.organization_id and organization_group.group_id = '$group_b_id' join vortex_access.organization_role_assignments as assignment on assignment.organization_id = version.organization_id and assignment.role_assignment_id = '$assignment_b_id' where version.organization_id = '$organization_id';")" = '7|2|retired|1|live|1' ] || {
  echo 'grant-first retirement did not preserve the exact assignment fact' >&2
  exit 1
}

# R3: retirement owns governance first. The queued real grant rechecks the
# Group after the terminal successor and refuses without an Access increment.
PGAPPNAME="vortex-group-r3-retire-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r3-retire.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r3-retire.pid'
select 1 from vortex_access.organization_access_versions
where organization_id = '$organization_id' for update;
\! touch '$proof_root/r3-ready'
\! deadline=600; while [ ! -f '$proof_root/r3-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/r3-release' ]
select outcome, operation, revision, access_version
from vortex_access.coordinate_organization_group_change(
  'retire_group', '$organization_id', '$group_c_id', 1,
  null, null, '$actor_id', '$correlation_retire_c'
);
commit;
SQL
r3_retire_pid=$!; worker_pids+=("$r3_retire_pid")
wait_for_file "$proof_root/r3-ready"
r3_retire_db="$(read_backend_pid "$proof_root/r3-retire.pid")"

PGAPPNAME="vortex-group-r3-grant-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r3-grant.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r3-grant.pid'
select * from vortex_access.coordinate_organization_role_assignment_change(
  'grant', '$organization_id', '$assignment_c_id', null,
  '$role_id', 1, 'group', null, '$group_c_id', 'standing',
  pg_catalog.clock_timestamp(), null, '$actor_id', '$correlation_grant_c'
);
commit;
SQL
r3_grant_pid=$!; worker_pids+=("$r3_grant_pid")
r3_grant_db="$(read_backend_pid "$proof_root/r3-grant.pid")"
wait_for_database_blocker "$r3_grant_db" "$r3_retire_db"
touch "$proof_root/r3-release"
wait_owned_worker "$r3_retire_pid"
if wait_owned_worker "$r3_grant_pid"; then
  echo 'the Group grant waiting behind retirement unexpectedly committed' >&2
  exit 1
fi
grep -Fq 'changed|retire_group|2|8' "$proof_root/r3-retire.log" || {
  echo 'the retirement-first writer did not return its exact result' >&2
  exit 1
}
grep -q '40001' "$proof_root/r3-grant.log" || {
  echo 'the grant after retirement lacked stable stale evidence' >&2
  exit 1
}
[ "$(run_sql "select pg_catalog.concat_ws('|', version.current_version, organization_group.revision, organization_group.state, (select pg_catalog.count(*) from vortex_access.organization_role_assignments where organization_id = '$organization_id' and role_assignment_id = '$assignment_c_id') ) from vortex_access.organization_access_versions as version join vortex_access.organization_groups as organization_group on organization_group.organization_id = version.organization_id and organization_group.group_id = '$group_c_id' where version.organization_id = '$organization_id';")" = '8|2|retired|0' ] || {
  echo 'retirement-first ordering left unexpected Group, assignment or Access state' >&2
  exit 1
}

echo 'organization Group-change concurrency proof passed'
