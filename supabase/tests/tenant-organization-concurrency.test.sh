#!/usr/bin/env bash

set -euo pipefail

readonly proof_root="$(mktemp -d /tmp/vortex-tenant-concurrency.XXXXXX)"
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id='31000000-0000-4000-8000-000000000001'
readonly actor_id='39000000-0000-4000-8000-000000000001'

psql_command=(psql --no-psqlrc --set=ON_ERROR_STOP=1)
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

wait_for_database_lock() {
  local application_name="$1"
  local attempt
  local wait_type
  for attempt in $(seq 1 200); do
    wait_type="$(run_sql "
      select coalesce(wait_event_type, '')
      from pg_catalog.pg_stat_activity
      where datname = current_database()
        and application_name = '$application_name'
        and state = 'active';
    ")"
    if [ "$wait_type" = 'Lock' ]; then
      return 0
    fi
    sleep 0.05
  done
  echo "concurrent change did not wait on the tenant serialization lock" >&2
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

assert_failed_with_invariant() {
  local pid="$1"
  local log_file="$2"
  if wait "$pid"; then
    echo "concurrent conflicting change unexpectedly committed" >&2
    return 1
  fi
  grep -q '23514' "$log_file" || {
    echo "concurrent conflict failed without the expected invariant code" >&2
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
update vortex_identity.organizations
set parent_organization_id = '32000000-0000-4000-8000-000000000002', revision = revision + 1
where organization_id = '32000000-0000-4000-8000-000000000001';
\! touch '$proof_root/cycle-a-ready'
\! while [ ! -f '$proof_root/cycle-a-release' ]; do sleep 0.05; done
commit;
SQL
cycle_a_pid=$!
wait_for_file "$proof_root/cycle-a-ready"

PGAPPNAME='vortex-proof-cycle-b' "${psql_command[@]}" >"$proof_root/cycle-b.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
update vortex_identity.organizations
set parent_organization_id = '32000000-0000-4000-8000-000000000001', revision = revision + 1
where organization_id = '32000000-0000-4000-8000-000000000002';
commit;
SQL
cycle_b_pid=$!
wait_for_database_lock 'vortex-proof-cycle-b'
touch "$proof_root/cycle-a-release"
wait "$cycle_a_pid"
assert_failed_with_invariant "$cycle_b_pid" "$proof_root/cycle-b.log"
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
update vortex_identity.tenants
set state = 'archived', state_changed_at = clock_timestamp(), revision = revision + 1
where tenant_id = '$tenant_id';
\! touch '$proof_root/tenant-a-ready'
\! while [ ! -f '$proof_root/tenant-a-release' ]; do sleep 0.05; done
commit;
SQL
tenant_a_pid=$!
wait_for_file "$proof_root/tenant-a-ready"

PGAPPNAME='vortex-proof-tenant-b' "${psql_command[@]}" >"$proof_root/tenant-b.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
update vortex_identity.organizations
set state = 'active', state_changed_at = clock_timestamp(), revision = revision + 1
where organization_id = '32000000-0000-4000-8000-000000000003';
commit;
SQL
tenant_b_pid=$!
wait_for_database_lock 'vortex-proof-tenant-b'
touch "$proof_root/tenant-a-release"
wait "$tenant_a_pid"
assert_failed_with_invariant "$tenant_b_pid" "$proof_root/tenant-b.log"

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
update vortex_identity.organizations
set state = 'archived', state_changed_at = clock_timestamp(), revision = revision + 1
where organization_id = '32000000-0000-4000-8000-000000000004';
\! touch '$proof_root/parent-a-ready'
\! while [ ! -f '$proof_root/parent-a-release' ]; do sleep 0.05; done
commit;
SQL
parent_a_pid=$!
wait_for_file "$proof_root/parent-a-ready"

PGAPPNAME='vortex-proof-parent-b' "${psql_command[@]}" >"$proof_root/parent-b.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
update vortex_identity.organizations
set state = 'active', state_changed_at = clock_timestamp(), revision = revision + 1
where organization_id = '32000000-0000-4000-8000-000000000005';
commit;
SQL
parent_b_pid=$!
wait_for_database_lock 'vortex-proof-parent-b'
touch "$proof_root/parent-a-release"
wait "$parent_a_pid"
assert_failed_with_invariant "$parent_b_pid" "$proof_root/parent-b.log"

echo 'tenant and organisation concurrency proof passed'
