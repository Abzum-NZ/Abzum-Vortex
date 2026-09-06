#!/usr/bin/env bash

set -euo pipefail

run_uuid="${VORTEX_ACTIVITY_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then
  [ -r /proc/sys/kernel/random/uuid ] || {
    echo 'a Linux random UUID source is required for the Activity proof' >&2
    exit 1
  }
  IFS= read -r run_uuid </proc/sys/kernel/random/uuid
fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  echo 'VORTEX_ACTIVITY_PROOF_RUN_ID must be a lowercase UUID v4' >&2
  exit 1
}

readonly run_uuid
readonly run_token="${run_uuid//-/}"
readonly fixture_name_token="${run_token:0:24}"
readonly fixture_short_name="activity_${fixture_name_token}"
proof_root="$(mktemp -d /tmp/vortex-activity.XXXXXX)"
readonly proof_root
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id="a1${run_uuid:2}"
readonly organization_id="a2${run_uuid:2}"
readonly rolled_back_organization_id="a3${run_uuid:2}"
readonly exact_activity_id="a4${run_uuid:2}"
readonly conflict_activity_id="a5${run_uuid:2}"
readonly rollback_activity_id="a6${run_uuid:2}"
readonly refusal_activity_id="a7${run_uuid:2}"
readonly actor_id="a8${run_uuid:2}"
readonly subject_id="a9${run_uuid:2}"
readonly field_id="aa${run_uuid:2}"
readonly correlation_exact="ab${run_uuid:2}"
readonly correlation_conflict="ac${run_uuid:2}"
readonly correlation_rollback="ad${run_uuid:2}"
readonly correlation_refusal="ae${run_uuid:2}"

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
  echo 'Activity proof did not reach its transaction barrier' >&2
  return 1
}

read_backend_pid() {
  local candidate="$1"
  local backend_pid
  wait_for_file "$candidate"
  backend_pid="$(tr -d '[:space:]' <"$candidate")"
  [[ "$backend_pid" =~ ^[1-9][0-9]*$ ]] || {
    printf 'Activity proof captured an invalid backend identifier: %q\n' "$backend_pid" >&2
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
  echo 'Activity proof did not observe the required duplicate-key wait' >&2
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
  echo 'Activity proof failed; bounded owned worker diagnostics follow' >&2
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
        raise exception 'Activity proof fixture ownership marker mismatch';
      end if;
    end
    \$proof\$;
    delete from vortex_activity.organization_activity_entries
      where organization_id = '$organization_id'
        and activity_id in (
          '$exact_activity_id', '$conflict_activity_id',
          '$rollback_activity_id', '$refusal_activity_id'
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
  touch "$proof_root/r1-release" "$proof_root/r2-release" || true
  stop_owned_workers
  if [ "$original_status" -ne 0 ]; then emit_owned_failure_diagnostics; fi
  if cleanup_fixture; then :; else cleanup_status=$?; fi
  case "$proof_root" in
    /tmp/vortex-activity.*) rm -rf -- "$proof_root" ;;
    *) echo 'refusing to remove an unexpected Activity proof directory' >&2; cleanup_status=1 ;;
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
    '$tenant_id', '$fixture_short_name', 'Activity proof', 'active',
    pg_catalog.clock_timestamp(), '$actor_id', pg_catalog.clock_timestamp(), 1
  );
  insert into vortex_identity.organizations (
    organization_id, tenant_id, short_name, display_name, state, created_at,
    created_by, state_changed_at, revision
  ) values (
    '$organization_id', '$tenant_id', '$fixture_short_name', 'Activity proof',
    'active', pg_catalog.clock_timestamp(), '$actor_id',
    pg_catalog.clock_timestamp(), 1
  );
  commit;
" >/dev/null
fixture_claimed=1

# R1: an exact duplicate waits for the first owner and then returns the
# already-recorded result without creating a second entry.
"${psql_command[@]}" >"$proof_root/r1-owner.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r1-owner.pid'
update vortex_identity.organizations
set display_name = 'Activity proof committed mutation'
where organization_id = '$organization_id';
select vortex_activity.append_organization_activity_entry(
  '$organization_id', '$exact_activity_id', '2026-09-06 09:00:00.123456+00',
  'system', '$actor_id', 'proof_completed', array['$subject_id']::uuid[],
  array['$field_id']::uuid[], 'system', '$correlation_exact', 'completed'
) \g '$proof_root/r1-owner.result'
\! touch '$proof_root/r1-ready'
\! deadline=600; while [ ! -f '$proof_root/r1-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/r1-release' ]
commit;
SQL
r1_owner_pid=$!
worker_pids+=("$r1_owner_pid")
wait_for_file "$proof_root/r1-ready"
r1_owner_backend="$(read_backend_pid "$proof_root/r1-owner.pid")"

"${psql_command[@]}" >"$proof_root/r1-retry.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r1-retry.pid'
select vortex_activity.append_organization_activity_entry(
  '$organization_id', '$exact_activity_id', '2026-09-06 09:00:00.123456+00',
  'system', '$actor_id', 'proof_completed', array['$subject_id']::uuid[],
  array['$field_id']::uuid[], 'system', '$correlation_exact', 'completed'
) \g '$proof_root/r1-retry.result'
commit;
SQL
r1_retry_pid=$!
worker_pids+=("$r1_retry_pid")
r1_retry_backend="$(read_backend_pid "$proof_root/r1-retry.pid")"
wait_for_database_blocker "$r1_retry_backend" "$r1_owner_backend"
touch "$proof_root/r1-release"
wait_owned_worker "$r1_owner_pid"
wait_owned_worker "$r1_retry_pid"
[ "$(tr -d '[:space:]' <"$proof_root/r1-owner.result")" = 'inserted' ]
[ "$(tr -d '[:space:]' <"$proof_root/r1-retry.result")" = 'already_recorded' ]
[ "$(run_sql "select count(*) from vortex_activity.organization_activity_entries where organization_id = '$organization_id' and activity_id = '$exact_activity_id';")" = '1' ]
[ "$(run_sql "select display_name from vortex_identity.organizations where organization_id = '$organization_id';")" = 'Activity proof committed mutation' ]

# R2: conflicting evidence for one Activity identity waits for the winner and
# then refuses, leaving the exact winner as the sole durable row.
"${psql_command[@]}" >"$proof_root/r2-owner.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r2-owner.pid'
select vortex_activity.append_organization_activity_entry(
  '$organization_id', '$conflict_activity_id', '2026-09-06 10:00:00+00',
  'identity', '$actor_id', 'proof_completed', array['$subject_id']::uuid[],
  array[]::uuid[], 'workflow', '$correlation_conflict', 'completed'
) \g '$proof_root/r2-owner.result'
\! touch '$proof_root/r2-ready'
\! deadline=600; while [ ! -f '$proof_root/r2-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/r2-release' ]
commit;
SQL
r2_owner_pid=$!
worker_pids+=("$r2_owner_pid")
wait_for_file "$proof_root/r2-ready"
r2_owner_backend="$(read_backend_pid "$proof_root/r2-owner.pid")"

"${psql_command[@]}" >"$proof_root/r2-conflict.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r2-conflict.pid'
update vortex_identity.organizations
set display_name = 'Activity proof must roll back'
where organization_id = '$organization_id';
select vortex_activity.append_organization_activity_entry(
  '$organization_id', '$conflict_activity_id', '2026-09-06 10:00:00+00',
  'identity', '$actor_id', 'different_action', array['$subject_id']::uuid[],
  array[]::uuid[], 'workflow', '$correlation_conflict', 'completed'
);
commit;
SQL
r2_conflict_pid=$!
worker_pids+=("$r2_conflict_pid")
r2_conflict_backend="$(read_backend_pid "$proof_root/r2-conflict.pid")"
wait_for_database_blocker "$r2_conflict_backend" "$r2_owner_backend"
touch "$proof_root/r2-release"
wait_owned_worker "$r2_owner_pid"
if wait_owned_worker "$r2_conflict_pid"; then
  echo 'conflicting Activity evidence unexpectedly committed' >&2
  exit 1
fi
grep -q 'ERROR:  22023: Activity identity already records different evidence' "$proof_root/r2-conflict.log"
[ "$(run_sql "select action || ':' || count(*) from vortex_activity.organization_activity_entries where organization_id = '$organization_id' and activity_id = '$conflict_activity_id' group by action;")" = 'proof_completed:1' ]
[ "$(run_sql "select display_name from vortex_identity.organizations where organization_id = '$organization_id';")" = 'Activity proof committed mutation' ]

# R3: success evidence shares the owning mutation transaction and disappears
# on rollback. A verified refusal is then appended in a separate transaction.
run_sql "
  begin;
  insert into vortex_identity.organizations (
    organization_id, tenant_id, short_name, display_name, state, created_at,
    created_by, state_changed_at, revision
  ) values (
    '$rolled_back_organization_id', '$tenant_id',
    'rolled_${fixture_name_token}', 'Rolled back operation', 'active',
    pg_catalog.clock_timestamp(), '$actor_id', pg_catalog.clock_timestamp(), 1
  );
  select vortex_activity.append_organization_activity_entry(
    '$organization_id', '$rollback_activity_id', '2026-09-06 11:00:00+00',
    'organization_account', '$actor_id', 'proof_completed',
    array['$rolled_back_organization_id']::uuid[], array[]::uuid[], 'interface',
    '$correlation_rollback', 'completed'
  );
  rollback;
" >/dev/null
[ "$(run_sql "select count(*) from vortex_identity.organizations where organization_id = '$rolled_back_organization_id';")" = '0' ]
[ "$(run_sql "select count(*) from vortex_activity.organization_activity_entries where organization_id = '$organization_id' and activity_id = '$rollback_activity_id';")" = '0' ]

[ "$(run_sql "begin; select vortex_activity.append_organization_activity_entry('$organization_id', '$refusal_activity_id', '2026-09-06 11:00:01+00', 'public_session', '$actor_id', 'proof_refused', array['$organization_id']::uuid[], array[]::uuid[], 'web', '$correlation_refusal', 'refused'); commit;")" = 'inserted' ]
[ "$(run_sql "select outcome || ':' || count(*) from vortex_activity.organization_activity_entries where organization_id = '$organization_id' and activity_id = '$refusal_activity_id' group by outcome;")" = 'refused:1' ]

echo 'Activity append concurrency proof passed'
