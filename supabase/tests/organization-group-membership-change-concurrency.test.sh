#!/usr/bin/env bash

set -euo pipefail

run_uuid="${VORTEX_GROUP_MEMBERSHIP_CHANGE_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then
  [ -r /proc/sys/kernel/random/uuid ] || {
    echo 'a Linux random UUID source is required for the membership-change proof' >&2
    exit 1
  }
  IFS= read -r run_uuid </proc/sys/kernel/random/uuid
fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  echo 'VORTEX_GROUP_MEMBERSHIP_CHANGE_PROOF_RUN_ID must be a lowercase UUID v4' >&2
  exit 1
}

readonly run_uuid
readonly run_token="${run_uuid//-/}"
readonly fixture_name_token="${run_token:0:20}"
readonly fixture_short_name="member_${fixture_name_token}"
proof_root="$(mktemp -d /tmp/vortex-membership-change.XXXXXX)"
readonly proof_root
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id="d1${run_uuid:2}"
readonly organization_id="d2${run_uuid:2}"
readonly group_duplicate_id="d3${run_uuid:2}"
readonly group_change_id="d4${run_uuid:2}"
readonly group_restore_first_id="d5${run_uuid:2}"
readonly group_retire_first_id="d6${run_uuid:2}"
readonly group_expiry_id="d7${run_uuid:2}"
readonly account_id="d8${run_uuid:2}"
readonly identity_id="d9${run_uuid:2}"
readonly membership_duplicate_winner_id="e1${run_uuid:2}"
readonly membership_duplicate_loser_id="e2${run_uuid:2}"
readonly membership_change_id="e3${run_uuid:2}"
readonly membership_restore_first_id="e4${run_uuid:2}"
readonly membership_retire_first_id="e5${run_uuid:2}"
readonly membership_expiry_id="e6${run_uuid:2}"
readonly actor_id="e9${run_uuid:2}"
readonly correlation_initialize="ea${run_uuid:2}"
readonly correlation_r1_winner="eb${run_uuid:2}"
readonly correlation_r1_loser="ec${run_uuid:2}"
readonly correlation_r2_add="ed${run_uuid:2}"
readonly correlation_r2_winner="ee${run_uuid:2}"
readonly correlation_r2_loser="ef${run_uuid:2}"
readonly correlation_r3_add="f1${run_uuid:2}"
readonly correlation_r3_remove="f2${run_uuid:2}"
readonly correlation_r3_restore="f3${run_uuid:2}"
readonly correlation_r3_retire="f4${run_uuid:2}"
readonly correlation_r3b_add="f5${run_uuid:2}"
readonly correlation_r3b_remove="f6${run_uuid:2}"
readonly correlation_r3b_retire="f7${run_uuid:2}"
readonly correlation_r3b_restore="f8${run_uuid:2}"
readonly correlation_r4_add="a1${run_uuid:2}"
readonly correlation_r4_remove="a2${run_uuid:2}"
readonly correlation_r4_restore="a3${run_uuid:2}"

fixture_claimed=0
declare -a worker_pids=()
declare -A reaped_worker_pids=()

psql_command=(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1)
if [ -n "$database_url" ]; then psql_command+=("$database_url"); fi

run_sql() { "${psql_command[@]}" --command "$1"; }

wait_for_file() {
  local candidate="$1"
  local deadline=$((SECONDS + 25))
  while ((SECONDS < deadline)); do
    [ -f "$candidate" ] && return 0
    sleep 0.05
  done
  echo 'membership-change proof did not reach its transaction barrier' >&2
  return 1
}

read_backend_pid() {
  local candidate="$1"
  local backend_pid
  wait_for_file "$candidate"
  backend_pid="$(tr -d '[:space:]' <"$candidate")"
  [[ "$backend_pid" =~ ^[1-9][0-9]*$ ]] || {
    printf 'membership-change proof captured an invalid backend identifier: %q\n' "$backend_pid" >&2
    return 1
  }
  printf '%s\n' "$backend_pid"
}

wait_for_database_blocker() {
  local blocked_pid="$1"
  local blocking_pid="$2"
  local deadline=$((SECONDS + 25))
  local state
  while ((SECONDS < deadline)); do
    state="$(run_sql "select case when $blocking_pid = any(pg_catalog.pg_blocking_pids($blocked_pid)) then 'blocked' else '' end;")"
    [ "$state" = 'blocked' ] && return 0
    sleep 0.1
  done
  echo 'membership-change proof did not observe the required lock ordering' >&2
  return 1
}

wait_for_database_time() {
  local target="$1"
  local deadline=$((SECONDS + 20))
  local reached
  while ((SECONDS < deadline)); do
    reached="$(run_sql "select case when pg_catalog.clock_timestamp() >= '$target'::timestamptz then 'yes' else '' end;")"
    [ "$reached" = 'yes' ] && return 0
    sleep 0.05
  done
  echo 'membership-change proof did not reach the fixed expiry boundary' >&2
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
  echo 'membership-change proof failed; bounded owned worker diagnostics follow' >&2
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
        raise exception 'membership-change proof fixture ownership marker mismatch';
      end if;
    end
    \$proof\$;
    delete from vortex_access.organization_group_memberships
      where organization_id = '$organization_id'
        and membership_id in (
          '$membership_duplicate_winner_id', '$membership_duplicate_loser_id',
          '$membership_change_id', '$membership_restore_first_id',
          '$membership_retire_first_id', '$membership_expiry_id'
        );
    delete from vortex_access.organization_groups
      where organization_id = '$organization_id'
        and group_id in (
          '$group_duplicate_id', '$group_change_id', '$group_restore_first_id',
          '$group_retire_first_id', '$group_expiry_id'
        );
    delete from vortex_access.organization_access_versions
      where organization_id = '$organization_id';
    delete from vortex_identity.organization_accounts
      where organization_id = '$organization_id'
        and organization_account_id = '$account_id';
    delete from vortex_identity.identity_projections
      where identity_id = '$identity_id';
    delete from vortex_identity.organizations
      where organization_id = '$organization_id';
    delete from vortex_identity.tenants where tenant_id = '$tenant_id';
    commit;
  " >/dev/null
}

finalize() {
  local original_status=$?
  local cleanup_status=0
  touch \
    "$proof_root/r1-release" "$proof_root/r2-release" \
    "$proof_root/r3a-release" "$proof_root/r3b-release" \
    "$proof_root/r4-release" || true
  stop_owned_workers
  if [ "$original_status" -ne 0 ]; then emit_owned_failure_diagnostics; fi
  if cleanup_fixture; then :; else cleanup_status=$?; fi
  case "$proof_root" in
    /tmp/vortex-membership-change.*) rm -rf -- "$proof_root" ;;
    *) echo 'refusing to remove an unexpected membership-change proof directory' >&2; cleanup_status=1 ;;
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
    '$tenant_id', '$fixture_short_name', 'Membership change proof', 'active',
    pg_catalog.clock_timestamp(), '$actor_id', pg_catalog.clock_timestamp(), 1
  );
  insert into vortex_identity.organizations (
    organization_id, tenant_id, short_name, display_name, state, created_at,
    created_by, state_changed_at, revision
  ) values (
    '$organization_id', '$tenant_id', '$fixture_short_name',
    'Membership change proof', 'active', pg_catalog.clock_timestamp(), '$actor_id',
    pg_catalog.clock_timestamp(), 1
  );
  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values (
    '$identity_id', 'active', pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), '$actor_id', '$correlation_initialize', 1
  );
  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name, state,
    activated_at, changed_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values (
    '$account_id', '$organization_id', '$identity_id', 'Membership proof person',
    'active', pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), '$actor_id', '$correlation_initialize', 1
  );
  insert into vortex_access.organization_groups (
    organization_id, group_id, group_key, label, state, revision,
    created_by, created_at, changed_by, changed_at, change_correlation_id
  ) values
    ('$organization_id', '$group_duplicate_id', 'duplicate_${fixture_name_token}',
      'Duplicate Group', 'active', 1, '$actor_id', pg_catalog.clock_timestamp(),
      '$actor_id', pg_catalog.clock_timestamp(), '$correlation_initialize'),
    ('$organization_id', '$group_change_id', 'change_${fixture_name_token}',
      'Change Group', 'active', 1, '$actor_id', pg_catalog.clock_timestamp(),
      '$actor_id', pg_catalog.clock_timestamp(), '$correlation_initialize'),
    ('$organization_id', '$group_restore_first_id', 'restore_first_${fixture_name_token}',
      'Restore first Group', 'active', 1, '$actor_id', pg_catalog.clock_timestamp(),
      '$actor_id', pg_catalog.clock_timestamp(), '$correlation_initialize'),
    ('$organization_id', '$group_retire_first_id', 'retire_first_${fixture_name_token}',
      'Retire first Group', 'active', 1, '$actor_id', pg_catalog.clock_timestamp(),
      '$actor_id', pg_catalog.clock_timestamp(), '$correlation_initialize'),
    ('$organization_id', '$group_expiry_id', 'expiry_${fixture_name_token}',
      'Expiry Group', 'active', 1, '$actor_id', pg_catalog.clock_timestamp(),
      '$actor_id', pg_catalog.clock_timestamp(), '$correlation_initialize');
  select * from vortex_access.initialize_organization_access_version(
    '$organization_id', '$actor_id', '$correlation_initialize'
  );
  commit;
" >/dev/null
fixture_claimed=1

# R1: two real additions review the same live pair. The governance winner
# commits one identity; the queued writer rechecks against that exact result
# and its unique live-pair insertion refuses without a second Access change.
PGAPPNAME="vortex-member-r1-winner-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r1-winner.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r1-winner.pid'
select 1 from vortex_access.organization_access_versions
where organization_id = '$organization_id' for update;
\! touch '$proof_root/r1-ready'
\! deadline=600; while [ ! -f '$proof_root/r1-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/r1-release' ]
select outcome, operation, membership ->> 'revision', access_version
from vortex_access.coordinate_organization_group_membership_change(
  'add_membership', '$organization_id', '$membership_duplicate_winner_id', null,
  '$group_duplicate_id', '$account_id', pg_catalog.clock_timestamp(), null,
  null, '$actor_id', '$correlation_r1_winner'
);
commit;
SQL
r1_winner_pid=$!; worker_pids+=("$r1_winner_pid")
wait_for_file "$proof_root/r1-ready"
r1_winner_db="$(read_backend_pid "$proof_root/r1-winner.pid")"

PGAPPNAME="vortex-member-r1-loser-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r1-loser.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r1-loser.pid'
select * from vortex_access.coordinate_organization_group_membership_change(
  'add_membership', '$organization_id', '$membership_duplicate_loser_id', null,
  '$group_duplicate_id', '$account_id', pg_catalog.clock_timestamp(), null,
  null, '$actor_id', '$correlation_r1_loser'
);
commit;
SQL
r1_loser_pid=$!; worker_pids+=("$r1_loser_pid")
r1_loser_db="$(read_backend_pid "$proof_root/r1-loser.pid")"
wait_for_database_blocker "$r1_loser_db" "$r1_winner_db"
touch "$proof_root/r1-release"
wait_owned_worker "$r1_winner_pid"
if wait_owned_worker "$r1_loser_pid"; then
  echo 'duplicate live-pair addition unexpectedly committed twice' >&2
  exit 1
fi
grep -Fq 'changed|add_membership|1|2' "$proof_root/r1-winner.log" || {
  echo 'the duplicate-add winner did not return its exact result' >&2
  exit 1
}
grep -q '23505' "$proof_root/r1-loser.log" || {
  echo 'the duplicate-add loser lacked the live-pair uniqueness refusal' >&2
  exit 1
}
[ "$(run_sql "select pg_catalog.concat_ws('|', version.current_version, pg_catalog.count(*) filter (where membership.state = 'live'), pg_catalog.count(*) filter (where membership.membership_id = '$membership_duplicate_loser_id')) from vortex_access.organization_access_versions as version left join vortex_access.organization_group_memberships as membership on membership.organization_id = version.organization_id and membership.group_id = '$group_duplicate_id' and membership.organization_account_id = '$account_id' where version.organization_id = '$organization_id' group by version.current_version;")" = '2|1|0' ] || {
  echo 'duplicate addition left unexpected membership or Access state' >&2
  exit 1
}

run_sql "select * from vortex_access.coordinate_organization_group_membership_change(
  'add_membership', '$organization_id', '$membership_change_id', null,
  '$group_change_id', '$account_id', pg_catalog.clock_timestamp(), null,
  null, '$actor_id', '$correlation_r2_add');" >/dev/null

# R2: two real removals review revision one. Exactly one successor commits;
# the queued duplicate observes the revoked revision and refuses as stale.
PGAPPNAME="vortex-member-r2-winner-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r2-winner.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r2-winner.pid'
select 1 from vortex_access.organization_access_versions
where organization_id = '$organization_id' for update;
\! touch '$proof_root/r2-ready'
\! deadline=600; while [ ! -f '$proof_root/r2-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/r2-release' ]
select outcome, operation, membership ->> 'revision', access_version
from vortex_access.coordinate_organization_group_membership_change(
  'remove_membership', '$organization_id', '$membership_change_id', 1,
  null, null, null, null, null, '$actor_id', '$correlation_r2_winner'
);
commit;
SQL
r2_winner_pid=$!; worker_pids+=("$r2_winner_pid")
wait_for_file "$proof_root/r2-ready"
r2_winner_db="$(read_backend_pid "$proof_root/r2-winner.pid")"

PGAPPNAME="vortex-member-r2-loser-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r2-loser.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r2-loser.pid'
select * from vortex_access.coordinate_organization_group_membership_change(
  'remove_membership', '$organization_id', '$membership_change_id', 1,
  null, null, null, null, null, '$actor_id', '$correlation_r2_loser'
);
commit;
SQL
r2_loser_pid=$!; worker_pids+=("$r2_loser_pid")
r2_loser_db="$(read_backend_pid "$proof_root/r2-loser.pid")"
wait_for_database_blocker "$r2_loser_db" "$r2_winner_db"
touch "$proof_root/r2-release"
wait_owned_worker "$r2_winner_pid"
if wait_owned_worker "$r2_loser_pid"; then
  echo 'competing revision-one removal unexpectedly committed twice' >&2
  exit 1
fi
grep -Fq 'changed|remove_membership|2|4' "$proof_root/r2-winner.log" || {
  echo 'the competing-change winner did not return its exact result' >&2
  exit 1
}
grep -q '40001' "$proof_root/r2-loser.log" || {
  echo 'the competing-change loser lacked stable stale evidence' >&2
  exit 1
}
[ "$(run_sql "select pg_catalog.concat_ws('|', version.current_version, membership.revision, membership.state, pg_catalog.count(*) over ()) from vortex_access.organization_access_versions as version join vortex_access.organization_group_memberships as membership on membership.organization_id = version.organization_id and membership.membership_id = '$membership_change_id' where version.organization_id = '$organization_id';")" = '4|2|revoked|1' ] || {
  echo 'competing removal left unexpected membership or Access state' >&2
  exit 1
}

run_sql "select * from vortex_access.coordinate_organization_group_membership_change(
  'add_membership', '$organization_id', '$membership_restore_first_id', null,
  '$group_restore_first_id', '$account_id', pg_catalog.clock_timestamp(), null,
  null, '$actor_id', '$correlation_r3_add');
select * from vortex_access.coordinate_organization_group_membership_change(
  'remove_membership', '$organization_id', '$membership_restore_first_id', 1,
  null, null, null, null, null, '$actor_id', '$correlation_r3_remove');" >/dev/null

# R3a: a real restore owns governance and waits on its Group row. Retirement
# queues behind it; after release both commit in that order and the restored
# membership remains as an historical/current fact under the retired Group.
PGAPPNAME="vortex-member-r3a-holder-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r3a-holder.log" 2>&1 <<SQL &
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r3a-holder.pid'
select 1 from vortex_access.organization_groups
where organization_id = '$organization_id' and group_id = '$group_restore_first_id' for update;
\! touch '$proof_root/r3a-ready'
\! deadline=600; while [ ! -f '$proof_root/r3a-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/r3a-release' ]
commit;
SQL
r3a_holder_pid=$!; worker_pids+=("$r3a_holder_pid")
wait_for_file "$proof_root/r3a-ready"
r3a_holder_db="$(read_backend_pid "$proof_root/r3a-holder.pid")"

PGAPPNAME="vortex-member-r3a-restore-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r3a-restore.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r3a-restore.pid'
select outcome, operation, membership ->> 'revision', access_version
from vortex_access.coordinate_organization_group_membership_change(
  'restore_membership', '$organization_id', '$membership_restore_first_id', 2,
  null, null, null, null, null, '$actor_id', '$correlation_r3_restore'
);
commit;
SQL
r3a_restore_pid=$!; worker_pids+=("$r3a_restore_pid")
r3a_restore_db="$(read_backend_pid "$proof_root/r3a-restore.pid")"
wait_for_database_blocker "$r3a_restore_db" "$r3a_holder_db"

PGAPPNAME="vortex-member-r3a-retire-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r3a-retire.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r3a-retire.pid'
select outcome, operation, revision, access_version
from vortex_access.coordinate_organization_group_change(
  'retire_group', '$organization_id', '$group_restore_first_id', 1,
  null, null, '$actor_id', '$correlation_r3_retire'
);
commit;
SQL
r3a_retire_pid=$!; worker_pids+=("$r3a_retire_pid")
r3a_retire_db="$(read_backend_pid "$proof_root/r3a-retire.pid")"
wait_for_database_blocker "$r3a_retire_db" "$r3a_restore_db"
touch "$proof_root/r3a-release"
wait_owned_worker "$r3a_holder_pid"
wait_owned_worker "$r3a_restore_pid"
wait_owned_worker "$r3a_retire_pid"
grep -Fq 'changed|restore_membership|3|7' "$proof_root/r3a-restore.log" || {
  echo 'restore-first writer did not return its exact result' >&2
  exit 1
}
grep -Fq 'changed|retire_group|2|8' "$proof_root/r3a-retire.log" || {
  echo 'retirement after restore did not return its exact result' >&2
  exit 1
}
[ "$(run_sql "select pg_catalog.concat_ws('|', version.current_version, organization_group.revision, organization_group.state, membership.revision, membership.state) from vortex_access.organization_access_versions as version join vortex_access.organization_groups as organization_group on organization_group.organization_id = version.organization_id and organization_group.group_id = '$group_restore_first_id' join vortex_access.organization_group_memberships as membership on membership.organization_id = version.organization_id and membership.membership_id = '$membership_restore_first_id' where version.organization_id = '$organization_id';")" = '8|2|retired|3|live' ] || {
  echo 'restore-first retirement left unexpected Group, membership or Access state' >&2
  exit 1
}

run_sql "select * from vortex_access.coordinate_organization_group_membership_change(
  'add_membership', '$organization_id', '$membership_retire_first_id', null,
  '$group_retire_first_id', '$account_id', pg_catalog.clock_timestamp(), null,
  null, '$actor_id', '$correlation_r3b_add');
select * from vortex_access.coordinate_organization_group_membership_change(
  'remove_membership', '$organization_id', '$membership_retire_first_id', 1,
  null, null, null, null, null, '$actor_id', '$correlation_r3b_remove');" >/dev/null

# R3b: retirement owns governance. The queued restore rechecks the now-retired
# Group and refuses, preserving the revoked membership and one winning change.
PGAPPNAME="vortex-member-r3b-retire-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r3b-retire.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r3b-retire.pid'
select 1 from vortex_access.organization_access_versions
where organization_id = '$organization_id' for update;
\! touch '$proof_root/r3b-ready'
\! deadline=600; while [ ! -f '$proof_root/r3b-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/r3b-release' ]
select outcome, operation, revision, access_version
from vortex_access.coordinate_organization_group_change(
  'retire_group', '$organization_id', '$group_retire_first_id', 1,
  null, null, '$actor_id', '$correlation_r3b_retire'
);
commit;
SQL
r3b_retire_pid=$!; worker_pids+=("$r3b_retire_pid")
wait_for_file "$proof_root/r3b-ready"
r3b_retire_db="$(read_backend_pid "$proof_root/r3b-retire.pid")"

PGAPPNAME="vortex-member-r3b-restore-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r3b-restore.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r3b-restore.pid'
select * from vortex_access.coordinate_organization_group_membership_change(
  'restore_membership', '$organization_id', '$membership_retire_first_id', 2,
  null, null, null, null, null, '$actor_id', '$correlation_r3b_restore'
);
commit;
SQL
r3b_restore_pid=$!; worker_pids+=("$r3b_restore_pid")
r3b_restore_db="$(read_backend_pid "$proof_root/r3b-restore.pid")"
wait_for_database_blocker "$r3b_restore_db" "$r3b_retire_db"
touch "$proof_root/r3b-release"
wait_owned_worker "$r3b_retire_pid"
if wait_owned_worker "$r3b_restore_pid"; then
  echo 'restore behind Group retirement unexpectedly committed' >&2
  exit 1
fi
grep -Fq 'changed|retire_group|2|11' "$proof_root/r3b-retire.log" || {
  echo 'retirement-first writer did not return its exact result' >&2
  exit 1
}
grep -q '40001' "$proof_root/r3b-restore.log" || {
  echo 'restore after retirement lacked stable stale evidence' >&2
  exit 1
}
[ "$(run_sql "select pg_catalog.concat_ws('|', version.current_version, organization_group.state, membership.revision, membership.state) from vortex_access.organization_access_versions as version join vortex_access.organization_groups as organization_group on organization_group.organization_id = version.organization_id and organization_group.group_id = '$group_retire_first_id' join vortex_access.organization_group_memberships as membership on membership.organization_id = version.organization_id and membership.membership_id = '$membership_retire_first_id' where version.organization_id = '$organization_id';")" = '11|retired|2|revoked' ] || {
  echo 'retirement-first ordering left unexpected Group, membership or Access state' >&2
  exit 1
}

# R4: the restore begins before expiry but waits for the governance lock. Its
# post-lock clock observation sees the fixed window expire and refuses without
# reviving the old identity or incrementing Access.
expiry_at="$(run_sql "select pg_catalog.clock_timestamp() + interval '3 seconds';")"
readonly expiry_at
run_sql "select * from vortex_access.coordinate_organization_group_membership_change(
  'add_membership', '$organization_id', '$membership_expiry_id', null,
  '$group_expiry_id', '$account_id', pg_catalog.clock_timestamp(), '$expiry_at',
  null, '$actor_id', '$correlation_r4_add');
select * from vortex_access.coordinate_organization_group_membership_change(
  'remove_membership', '$organization_id', '$membership_expiry_id', 1,
  null, null, null, null, null, '$actor_id', '$correlation_r4_remove');" >/dev/null

PGAPPNAME="vortex-member-r4-holder-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r4-holder.log" 2>&1 <<SQL &
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r4-holder.pid'
select 1 from vortex_access.organization_access_versions
where organization_id = '$organization_id' for update;
\! touch '$proof_root/r4-ready'
\! deadline=600; while [ ! -f '$proof_root/r4-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/r4-release' ]
commit;
SQL
r4_holder_pid=$!; worker_pids+=("$r4_holder_pid")
wait_for_file "$proof_root/r4-ready"
r4_holder_db="$(read_backend_pid "$proof_root/r4-holder.pid")"

PGAPPNAME="vortex-member-r4-restore-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r4-restore.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r4-restore.pid'
select * from vortex_access.coordinate_organization_group_membership_change(
  'restore_membership', '$organization_id', '$membership_expiry_id', 2,
  null, null, null, null, null, '$actor_id', '$correlation_r4_restore'
);
commit;
SQL
r4_restore_pid=$!; worker_pids+=("$r4_restore_pid")
r4_restore_db="$(read_backend_pid "$proof_root/r4-restore.pid")"
wait_for_database_blocker "$r4_restore_db" "$r4_holder_db"
wait_for_database_time "$expiry_at"
touch "$proof_root/r4-release"
wait_owned_worker "$r4_holder_pid"
if wait_owned_worker "$r4_restore_pid"; then
  echo 'restore queued through expiry unexpectedly committed' >&2
  exit 1
fi
grep -q '40001' "$proof_root/r4-restore.log" || {
  echo 'post-lock expiry refusal lacked stable stale evidence' >&2
  exit 1
}
[ "$(run_sql "select pg_catalog.concat_ws('|', version.current_version, membership.revision, membership.state, membership.expires_at = '$expiry_at'::timestamptz, pg_catalog.count(*) over ()) from vortex_access.organization_access_versions as version join vortex_access.organization_group_memberships as membership on membership.organization_id = version.organization_id and membership.membership_id = '$membership_expiry_id' where version.organization_id = '$organization_id';")" = '13|2|revoked|t|1' ] || {
  echo 'expiry-during-wait left unexpected membership or Access state' >&2
  exit 1
}

[ "$(run_sql "select pg_catalog.concat_ws('|', version.current_version, version.changed_by, version.change_correlation_id, version.change_reason, (select pg_catalog.count(*) from vortex_access.organization_groups where organization_id = '$organization_id'), (select pg_catalog.count(*) from vortex_access.organization_group_memberships where organization_id = '$organization_id')) from vortex_access.organization_access_versions as version where version.organization_id = '$organization_id';")" = "13|$actor_id|$correlation_r4_remove|team_membership_changed|5|5" ] || {
  echo 'membership-change proof final evidence or scoped row counts are inconsistent' >&2
  exit 1
}

echo 'organization Group-membership change concurrency proof passed'
