#!/usr/bin/env bash

set -euo pipefail

readonly proof_root="$(mktemp -d /tmp/vortex-tenant-concurrency.XXXXXX)"
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id='31000000-0000-4000-8000-000000000001'
readonly actor_id='39000000-0000-4000-8000-000000000001'

psql_command=(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1)
if [ -n "$database_url" ]; then
  psql_command+=("$database_url")
fi

run_sql() {
  "${psql_command[@]}" --quiet --tuples-only --no-align --command "$1"
}

cleanup() {
  local pid
  while read -r pid; do
    kill "$pid" >/dev/null 2>&1 || true
  done < <(jobs -pr)
  run_sql "
    delete from vortex_identity.organizations where tenant_id = '$tenant_id';
    delete from vortex_identity.tenants where tenant_id = '$tenant_id';
  " >/dev/null 2>&1 || true
  rm -rf "$proof_root"
}
trap cleanup EXIT

wait_for_file() {
  local candidate="$1"
  local attempt
  for attempt in $(seq 1 200); do
    [ -f "$candidate" ] && return 0
    sleep 0.05
  done
  echo "concurrency proof did not reach its transaction barrier" >&2
  return 1
}

read_backend_pid() {
  local candidate="$1"
  local backend_pid
  wait_for_file "$candidate"
  backend_pid="$(tr -d '[:space:]' <"$candidate")"
  [[ "$backend_pid" =~ ^[1-9][0-9]*$ ]] || {
    printf 'concurrency proof captured an invalid database backend identifier: %q\n' \
      "$backend_pid" >&2
    return 1
  }
  printf '%s\n' "$backend_pid"
}

wait_for_database_blocker() {
  local blocked_pid="$1"
  local blocking_pid="$2"
  local description="$3"
  local blocker_deadline=$((SECONDS + 20))
  local blocking_state
  while ((SECONDS < blocker_deadline)); do
    blocking_state="$(run_sql "
      select case
        when $blocking_pid = any(pg_catalog.pg_blocking_pids($blocked_pid)) then 'blocked'
        else ''
      end;
    ")"
    [ "$blocking_state" = 'blocked' ] && return 0
    sleep 0.1
  done
  echo "$description did not wait on the expected database transaction" >&2
  return 1
}

reset_fixture() {
  run_sql "
    delete from vortex_identity.organizations where tenant_id = '$tenant_id';
    delete from vortex_identity.tenants where tenant_id = '$tenant_id';
    insert into vortex_identity.tenants (
      tenant_id, short_name, display_name, state, created_at, created_by,
      state_changed_at, revision
    ) values (
      '$tenant_id', 'concurrency_tenant', 'Concurrency tenant', 'active',
      clock_timestamp(), '$actor_id', clock_timestamp(), 1
    );
  " >/dev/null
}

assert_failed_with_state() {
  local pid="$1"
  local log_file="$2"
  local state="$3"
  local description="$4"
  local message="$5"
  if wait "$pid"; then
    echo "$description unexpectedly committed" >&2
    return 1
  fi
  grep -q "$state" "$log_file" || {
    echo "$description failed without SQLSTATE $state" >&2
    return 1
  }
  grep -Fq "$message" "$log_file" || {
    echo "$description failed without its stable invariant message" >&2
    return 1
  }
}

# Opposing hierarchy moves: the second transaction waits for the same tenant
# row, then re-evaluates against the committed first move and refuses the cycle.
reset_fixture
run_sql "
  insert into vortex_identity.organizations (
    organization_id, tenant_id, parent_organization_id, short_name, display_name,
    state, created_at, created_by, state_changed_at, revision
  ) values
    ('32000000-0000-4000-8000-000000000001', '$tenant_id', null, 'node_one', 'Node one',
     'active', clock_timestamp(), '$actor_id', clock_timestamp(), 1),
    ('32000000-0000-4000-8000-000000000002', '$tenant_id', null, 'node_two', 'Node two',
     'active', clock_timestamp(), '$actor_id', clock_timestamp(), 1);
" >/dev/null

PGAPPNAME='vortex-proof-cycle-a' "${psql_command[@]}" >"$proof_root/cycle-a.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/cycle-a.pid'
update vortex_identity.organizations
set parent_organization_id = '32000000-0000-4000-8000-000000000002', revision = revision + 1
where organization_id = '32000000-0000-4000-8000-000000000001';
\! touch '$proof_root/cycle-a-ready'
\! while [ ! -f '$proof_root/cycle-a-release' ]; do sleep 0.05; done
commit;
SQL
cycle_a_pid=$!
wait_for_file "$proof_root/cycle-a-ready"

cycle_a_backend_pid="$(read_backend_pid "$proof_root/cycle-a.pid")"

PGAPPNAME='vortex-proof-cycle-b' "${psql_command[@]}" >"$proof_root/cycle-b.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/cycle-b.pid'
set local lock_timeout = '30s';
update vortex_identity.organizations
set parent_organization_id = '32000000-0000-4000-8000-000000000001', revision = revision + 1
where organization_id = '32000000-0000-4000-8000-000000000002';
commit;
SQL
cycle_b_pid=$!
cycle_b_backend_pid="$(read_backend_pid "$proof_root/cycle-b.pid")"
wait_for_database_blocker "$cycle_b_backend_pid" "$cycle_a_backend_pid" \
  'the concurrent opposing hierarchy move'
touch "$proof_root/cycle-a-release"
wait "$cycle_a_pid"
assert_failed_with_state "$cycle_b_pid" "$proof_root/cycle-b.log" '23514' \
  'the concurrent opposing hierarchy move' 'Organisation hierarchy cannot contain a cycle'
[ "$(run_sql "
  select count(*)
  from vortex_identity.organizations
  where tenant_id = '$tenant_id'
    and parent_organization_id is not null;
")" = '1' ] || {
  echo "cycle refusal did not preserve an acyclic committed graph" >&2
  exit 1
}

# Tenant archive versus organisation activation.
reset_fixture
run_sql "
  insert into vortex_identity.organizations (
    organization_id, tenant_id, parent_organization_id, short_name, display_name,
    state, created_at, created_by, state_changed_at, revision
  ) values (
    '32000000-0000-4000-8000-000000000003', '$tenant_id', null, 'archived_node',
    'Archived node', 'archived', clock_timestamp(), '$actor_id', clock_timestamp(), 1
  );
" >/dev/null

PGAPPNAME='vortex-proof-tenant-a' "${psql_command[@]}" >"$proof_root/tenant-a.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/tenant-a.pid'
update vortex_identity.tenants
set state = 'archived', state_changed_at = clock_timestamp(), revision = revision + 1
where tenant_id = '$tenant_id';
\! touch '$proof_root/tenant-a-ready'
\! while [ ! -f '$proof_root/tenant-a-release' ]; do sleep 0.05; done
commit;
SQL
tenant_a_pid=$!
wait_for_file "$proof_root/tenant-a-ready"

tenant_a_backend_pid="$(read_backend_pid "$proof_root/tenant-a.pid")"

PGAPPNAME='vortex-proof-tenant-b' "${psql_command[@]}" >"$proof_root/tenant-b.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/tenant-b.pid'
set local lock_timeout = '30s';
update vortex_identity.organizations
set state = 'active', state_changed_at = clock_timestamp(), revision = revision + 1
where organization_id = '32000000-0000-4000-8000-000000000003';
commit;
SQL
tenant_b_pid=$!
tenant_b_backend_pid="$(read_backend_pid "$proof_root/tenant-b.pid")"
wait_for_database_blocker "$tenant_b_backend_pid" "$tenant_a_backend_pid" \
  'the concurrent organisation activation'
touch "$proof_root/tenant-a-release"
wait "$tenant_a_pid"
assert_failed_with_state "$tenant_b_pid" "$proof_root/tenant-b.log" '23514' \
  'the concurrent organisation activation' 'An unresolved organisation requires a live tenant'

# Parent archive versus direct-child activation.
reset_fixture
run_sql "
  insert into vortex_identity.organizations (
    organization_id, tenant_id, parent_organization_id, short_name, display_name,
    state, created_at, created_by, state_changed_at, revision
  ) values
    ('32000000-0000-4000-8000-000000000004', '$tenant_id', null, 'parent_node', 'Parent node',
     'active', clock_timestamp(), '$actor_id', clock_timestamp(), 1),
    ('32000000-0000-4000-8000-000000000005', '$tenant_id',
     '32000000-0000-4000-8000-000000000004', 'child_node', 'Child node',
     'archived', clock_timestamp(), '$actor_id', clock_timestamp(), 1);
" >/dev/null

PGAPPNAME='vortex-proof-parent-a' "${psql_command[@]}" >"$proof_root/parent-a.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/parent-a.pid'
update vortex_identity.organizations
set state = 'archived', state_changed_at = clock_timestamp(), revision = revision + 1
where organization_id = '32000000-0000-4000-8000-000000000004';
\! touch '$proof_root/parent-a-ready'
\! while [ ! -f '$proof_root/parent-a-release' ]; do sleep 0.05; done
commit;
SQL
parent_a_pid=$!
wait_for_file "$proof_root/parent-a-ready"

parent_a_backend_pid="$(read_backend_pid "$proof_root/parent-a.pid")"

PGAPPNAME='vortex-proof-parent-b' "${psql_command[@]}" >"$proof_root/parent-b.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/parent-b.pid'
set local lock_timeout = '30s';
update vortex_identity.organizations
set state = 'active', state_changed_at = clock_timestamp(), revision = revision + 1
where organization_id = '32000000-0000-4000-8000-000000000005';
commit;
SQL
parent_b_pid=$!
parent_b_backend_pid="$(read_backend_pid "$proof_root/parent-b.pid")"
wait_for_database_blocker "$parent_b_backend_pid" "$parent_a_backend_pid" \
  'the concurrent child activation'
touch "$proof_root/parent-a-release"
wait "$parent_a_pid"
assert_failed_with_state "$parent_b_pid" "$proof_root/parent-b.log" '23514' \
  'the concurrent child activation' 'An unresolved organisation requires a live parent'

echo 'tenant and organisation concurrency proof passed'
