#!/usr/bin/env bash

set -euo pipefail

readonly proof_root="$(mktemp -d /tmp/vortex-workflow-concurrency.XXXXXX)"
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"

readonly tenant_id='14780000-0000-4000-8000-000000000001'
readonly organization_id='24780000-0000-4000-8000-000000000001'
readonly app_root_id='34780000-0000-4000-8000-000000000001'
readonly workflow_id='44780000-0000-4000-8000-000000000001'
readonly actor_id='94780000-0000-4000-8000-000000000001'

readonly correlation_holder='c4780000-0000-4000-8000-000000000001'
readonly correlation_waiter='c4780000-0000-4000-8000-000000000002'
readonly correlation_stale='c4780000-0000-4000-8000-000000000003'

fixture_claimed=0

psql_command=(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1)
if [ -n "$database_url" ]; then
  psql_command+=("$database_url")
fi

run_sql() {
  "${psql_command[@]}" --command "$1"
}

wait_for_file() {
  local candidate="$1"
  local deadline=$((SECONDS + 20))
  while ((SECONDS < deadline)); do
    [ -f "$candidate" ] && return 0
    sleep 0.05
  done
  echo 'workflow-registration concurrency proof did not reach its transaction barrier' >&2
  return 1
}

read_backend_pid() {
  local candidate="$1"
  local backend_pid
  wait_for_file "$candidate"
  backend_pid="$(tr -d '[:space:]' <"$candidate")"
  [[ "$backend_pid" =~ ^[1-9][0-9]*$ ]] || {
    printf 'workflow-registration concurrency proof captured invalid backend pid: %q\n' "$backend_pid" >&2
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
  echo 'workflow-registration concurrency proof did not observe the required row lock' >&2
  return 1
}

cleanup() {
  local pid
  local -a owned_pids=()
  touch "$proof_root/release-holder"
  mapfile -t owned_pids < <(jobs -pr)
  for pid in "${owned_pids[@]}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
  for pid in "${owned_pids[@]}"; do
    wait "$pid" >/dev/null 2>&1 || true
  done
  if [ "$fixture_claimed" = 1 ]; then
    run_sql "
      begin;
      delete from vortex_workflow.workflow_application_authorizations where workflow_id = '$workflow_id';
      delete from vortex_workflow.workflow_revisions where workflow_id = '$workflow_id';
      delete from vortex_workflow.workflow_roots where workflow_id = '$workflow_id';
      delete from vortex_definition.roots where root_id = '$app_root_id';
      delete from vortex_identity.organizations where organization_id = '$organization_id';
      delete from vortex_identity.tenants where tenant_id = '$tenant_id';
      commit;
    " >/dev/null 2>&1 || true
  fi
  case "$proof_root" in
    /tmp/vortex-workflow-concurrency.*) rm -rf -- "$proof_root" ;;
    *) echo "refusing to remove unexpected proof directory: $proof_root" >&2 ;;
  esac
}
trap cleanup EXIT

# 1. Claim fixtures
run_sql "
  begin;
  insert into vortex_identity.tenants (
    tenant_id, short_name, display_name, state, created_at, created_by,
    state_changed_at, revision
  ) values (
    '$tenant_id', 'wf_conc_tenant', 'Workflow concurrency tenant', 'active',
    clock_timestamp(), '$actor_id', clock_timestamp(), 1
  );
  insert into vortex_identity.organizations (
    organization_id, tenant_id, parent_organization_id, short_name, display_name,
    state, created_at, created_by, state_changed_at, revision
  ) values (
    '$organization_id', '$tenant_id', null, 'wf_conc_org',
    'Workflow concurrency org', 'active', clock_timestamp(), '$actor_id',
    clock_timestamp(), 1
  );
  insert into vortex_definition.roots (
    root_id, organization_id, kind, key, created_at, created_by
  ) values (
    '$app_root_id', '$organization_id', 'application', 'vortex.conc.app',
    clock_timestamp(), '$actor_id'
  );
  select vortex_workflow.register_workflow_root_internal(
    '$workflow_id', '$organization_id', 'test.conc.workflow', 'Concurrency test workflow', '$actor_id'
  );
  select vortex_workflow.authorize_workflow_application_internal(
    '$workflow_id', '$app_root_id', '$actor_id'
  );
  commit;
" >/dev/null
fixture_claimed=1

# 2. Test Concurrency Serialization on Workflow Root
# Session Holder locks workflow root row and registers revision 1
PGAPPNAME='vortex-wf-holder' "${psql_command[@]}" >"$proof_root/holder.log" 2>&1 <<SQL &
begin;
set lock_timeout = '30s';
set statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/holder.pid'
select vortex_workflow.register_workflow_revision_internal(
  '$workflow_id', 1,
  'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  array['cold_archive_s3'],
  '$actor_id', '$correlation_holder'
);
\! touch '$proof_root/holder-registered'
\! deadline=600; while [ ! -f '$proof_root/release-holder' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/release-holder' ]
commit;
SQL
holder_pid=$!

wait_for_file "$proof_root/holder-registered"
holder_backend="$(read_backend_pid "$proof_root/holder.pid")"

# Session Waiter attempts to register revision 2 concurrently and must block on holder's root lock
PGAPPNAME='vortex-wf-waiter' "${psql_command[@]}" >"$proof_root/waiter.log" 2>&1 <<SQL &
begin;
set lock_timeout = '30s';
set statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/waiter.pid'
select vortex_workflow.register_workflow_revision_internal(
  '$workflow_id', 2,
  'sha256:2222222222222222222222222222222222222222222222222222222222222222',
  array['cold_archive_s3'],
  '$actor_id', '$correlation_waiter'
);
commit;
SQL
waiter_pid=$!

waiter_backend="$(read_backend_pid "$proof_root/waiter.pid")"

# Prove waiter is blocked on holder's lock
wait_for_database_blocker "$waiter_backend" "$holder_backend"

# Release holder
touch "$proof_root/release-holder"

wait "$holder_pid"
wait "$waiter_pid"

# Prove both revisions were committed sequentially
max_rev="$(run_sql "select max(revision) from vortex_workflow.workflow_revisions where workflow_id = '$workflow_id';")"
[ "$max_rev" = '2' ] || {
  echo "expected max revision 2 after serialized concurrent registration, got: $max_rev" >&2
  exit 1
}

# 3. Test Monotonic Activation and Reverse Ordering Rejection
# Prepare, verify, and activate revision 1
run_sql "
  begin;
  select vortex_workflow.prepare_workflow_revision_internal(
    '$workflow_id', 1,
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '$actor_id', '$correlation_holder'
  );
  select vortex_workflow.verify_workflow_revision_internal(
    '$workflow_id', 1,
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '$actor_id', '$correlation_holder'
  );
  select vortex_workflow.activate_workflow_revision_internal(
    '$workflow_id', 1, '$actor_id', '$correlation_holder'
  );
  commit;
" >/dev/null

rev1_state="$(run_sql "select state from vortex_workflow.workflow_revisions where workflow_id = '$workflow_id' and revision = 1;")"
[ "$rev1_state" = 'active' ] || {
  echo "expected revision 1 to be active, got: $rev1_state" >&2
  exit 1
}

# Prepare, verify, and activate revision 2 (strictly monotonic)
run_sql "
  begin;
  select vortex_workflow.prepare_workflow_revision_internal(
    '$workflow_id', 2,
    'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    '$actor_id', '$correlation_waiter'
  );
  select vortex_workflow.verify_workflow_revision_internal(
    '$workflow_id', 2,
    'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    '$actor_id', '$correlation_waiter'
  );
  select vortex_workflow.activate_workflow_revision_internal(
    '$workflow_id', 2, '$actor_id', '$correlation_waiter'
  );
  commit;
" >/dev/null

rev2_state="$(run_sql "select state from vortex_workflow.workflow_revisions where workflow_id = '$workflow_id' and revision = 2;")"
rev1_superseded="$(run_sql "select state from vortex_workflow.workflow_revisions where workflow_id = '$workflow_id' and revision = 1;")"
[ "$rev2_state" = 'active' ] || {
  echo "expected revision 2 to be active, got: $rev2_state" >&2
  exit 1
}
[ "$rev1_superseded" = 'superseded' ] || {
  echo "expected revision 1 to be superseded, got: $rev1_superseded" >&2
  exit 1
}

# Attempt reverse activation: activating revision 1 must be rejected by monotonicity check
if run_sql "
  select vortex_workflow.activate_workflow_revision_internal(
    '$workflow_id', 1, '$actor_id', '$correlation_stale'
  );
" 2>"$proof_root/stale-activation.err"; then
  echo "expected stale activation of revision 1 to fail, but it succeeded" >&2
  exit 1
fi

grep -q "Activated workflow revision must be strictly greater than all superseded revisions" "$proof_root/stale-activation.err" || {
  echo "stale activation failed with unexpected error:" >&2
  cat "$proof_root/stale-activation.err" >&2
  exit 1
}

# Attempt stale registration: re-registering revision 1 or lower must be rejected
if run_sql "
  select vortex_workflow.register_workflow_revision_internal(
    '$workflow_id', 1,
    'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    array['cold_archive_s3'],
    '$actor_id', '$correlation_stale'
  );
" 2>"$proof_root/stale-registration.err"; then
  echo "expected stale registration of revision 1 to fail, but it succeeded" >&2
  exit 1
fi

grep -q "Newly registered workflow revision must be strictly greater than all prior revisions" "$proof_root/stale-registration.err" || {
  echo "stale registration failed with unexpected error:" >&2
  cat "$proof_root/stale-registration.err" >&2
  exit 1
}

# Re-activation of current active revision 2 must be rejected by monotonicity check
if run_sql "
  select vortex_workflow.activate_workflow_revision_internal(
    '$workflow_id', 2, '$actor_id', '$correlation_waiter'
  );
" 2>"$proof_root/active-reactivation.err"; then
  echo "expected re-activation of active revision 2 to fail, but it succeeded" >&2
  exit 1
fi

grep -q "Activated workflow revision must be strictly greater than current active revision" "$proof_root/active-reactivation.err" || {
  echo "re-activation of active revision failed with unexpected error:" >&2
  cat "$proof_root/active-reactivation.err" >&2
  exit 1
}

active_rev="$(run_sql "select revision from vortex_workflow.workflow_revisions where workflow_id = '$workflow_id' and state = 'active';")"
[ "$active_rev" = '2' ] || {
  echo "expected active revision to remain 2, got: $active_rev" >&2
  exit 1
}

echo 'workflow-registration concurrency proof passed'
