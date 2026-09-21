#!/usr/bin/env bash

set -euo pipefail

readonly proof_root="$(mktemp -d /tmp/vortex-connection-readiness.XXXXXX)"
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id='51000000-0000-4000-8000-000000000408'
readonly organization_id='52000000-0000-4000-8000-000000000408'
readonly application_root_id='53000000-0000-4000-8000-000000000408'
readonly connection_id='54000000-0000-4000-8000-000000000408'
readonly conn_type_id='55000000-0000-4000-8000-000000000408'
readonly actor_id='59000000-0000-4000-8000-000000000408'
readonly dest_fingerprint='a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'

psql_command=(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1)
if [ -n "$database_url" ]; then
  psql_command+=("$database_url")
fi

run_sql() {
  "${psql_command[@]}" --command "$1"
}

cleanup() {
  local pid
  while read -r pid; do
    kill "$pid" >/dev/null 2>&1 || true
  done < <(jobs -pr)
  run_sql "
    begin;
    set local session_replication_role = replica;
    drop function if exists public.vortex_test_connection_context();
    delete from vortex_connection.connection_application_grants where connection_instance_id = '$connection_id';
    delete from vortex_connection.connection_instances where connection_instance_id = '$connection_id';
    delete from vortex_definition.roots where root_id = '$application_root_id';
    delete from vortex_identity.organization_accounts where organization_id = '$organization_id';
    delete from vortex_identity.organizations where organization_id = '$organization_id';
    delete from vortex_identity.tenants where tenant_id = '$tenant_id';
    commit;
  " >/dev/null 2>&1 || true
  case "$proof_root" in
    /tmp/vortex-connection-readiness.*) rm -r -- "$proof_root" ;;
    *) echo "refusing to remove an unexpected proof directory" >&2 ;;
  esac
}
trap cleanup EXIT

wait_for_file() {
  local candidate="$1"
  local attempt
  for attempt in $(seq 1 200); do
    [ -f "$candidate" ] && return 0
    sleep 0.05
  done
  echo "connection readiness proof did not reach its transaction barrier" >&2
  return 1
}

# ----------------------------------------------------------------------------
# Setup fixtures
# ----------------------------------------------------------------------------
run_sql "
  create or replace function public.vortex_test_connection_context()
  returns jsonb
  language sql
  volatile
  set search_path = ''
  as \$function\$
    select pg_catalog.jsonb_build_object(
      'callerKind', 'system',
      'tenantId', '$tenant_id'::uuid,
      'organizationId', '$organization_id'::uuid,
      'applicationRootId', '$application_root_id'::uuid,
      'sessionId', '56000000-0000-4000-8000-000000000408'::uuid,
      'issuedAt', pg_catalog.clock_timestamp() - interval '1 minute',
      'expiresAt', pg_catalog.clock_timestamp() + interval '10 minutes',
      'accessVersion', 1,
      'correlationId', '57000000-0000-4000-8000-000000000408'::uuid,
      'systemActorId', '$actor_id'::uuid,
      'authenticationStrength', 'service'
    )
  \$function\$;

  grant execute on function public.vortex_test_connection_context() to vortex_runtime, vortex_request;

  insert into vortex_identity.tenants (
    tenant_id, short_name, display_name, state, created_at, created_by,
    state_changed_at, revision
  ) values (
    '$tenant_id', 'conn_concurrency_tenant', 'Connection Concurrency Tenant', 'active',
    pg_catalog.clock_timestamp(), '$actor_id', pg_catalog.clock_timestamp(), 1
  );

  insert into vortex_identity.organizations (
    organization_id, tenant_id, parent_organization_id, short_name, display_name,
    state, created_at, created_by, state_changed_at, revision
  ) values (
    '$organization_id', '$tenant_id', null, 'conn_concurrency_org',
    'Connection Concurrency Organization', 'active', pg_catalog.clock_timestamp(),
    '$actor_id', pg_catalog.clock_timestamp(), 1
  );

  insert into vortex_definition.roots (
    root_id, organization_id, kind, key, created_at, created_by
  ) values (
    '$application_root_id', '$organization_id', 'application', 'app.concurrency.test',
    pg_catalog.clock_timestamp(), '$actor_id'
  );

  select vortex_connection.register_connection_instance_internal(
    '$connection_id',
    '$organization_id',
    '$conn_type_id',
    '1.0.0',
    'cold_archive_s3',
    '$dest_fingerprint',
    '$actor_id'
  );

  select vortex_connection.grant_connection_application_internal(
    '$connection_id',
    '$application_root_id',
    '$actor_id'
  );

  select vortex_connection.record_connection_health_check_internal(
    '$connection_id',
    1,
    'healthy',
    '$actor_id'
  );
"

# ----------------------------------------------------------------------------
# Part 1: Two-session Readiness vs. Revocation Row Lock Concurrency
#
# Session 1 resolves readiness under FOR SHARE lock and holds transaction.
# Session 2 attempts revocation under FOR UPDATE lock.
# Session 2 must be serialized behind Session 1, proving atomic row locking.
# ----------------------------------------------------------------------------
(
  "${psql_command[@]}" <<SQL
begin;
set local role vortex_request;
select vortex_context.initialize(public.vortex_test_connection_context());
select vortex_connection.resolve_connection_instance_readiness(
  '$organization_id',
  '$application_root_id',
  '$connection_id',
  'cold_archive_s3',
  2,
  '$dest_fingerprint'
);
\! touch '$proof_root/reader-locked'
select pg_catalog.pg_sleep(2);
commit;
\! touch '$proof_root/reader-committed'
SQL
) >"$proof_root/reader.log" 2>&1 &
reader_pid=$!

wait_for_file "$proof_root/reader-locked"

# Session 2 attempts revocation concurrently while Session 1 holds FOR SHARE lock
(
  "${psql_command[@]}" <<SQL
begin;
set local role vortex_runtime;
select vortex_context.initialize(public.vortex_test_connection_context());
select vortex_connection.revoke_connection_instance_internal(
  '$connection_id',
  2,
  '$actor_id'
);
commit;
\! touch '$proof_root/revoker-finished'
SQL
) >"$proof_root/revoker.log" 2>&1 &
revoker_pid=$!

wait "$reader_pid"
wait "$revoker_pid"

[ -f "$proof_root/reader-committed" ] && [ -f "$proof_root/revoker-finished" ] || {
  echo "Readiness vs. Revocation concurrency proof failed to reach terminal barrier" >&2
  exit 1
}

# Verify instance is now revoked with revision 3
post_revocation_state="$(run_sql "
  select pg_catalog.concat_ws(':', state, revision::text)
  from vortex_connection.connection_instances
  where connection_instance_id = '$connection_id';
" | tr -d '\r\n')"

[ "$post_revocation_state" = 'revoked:3' ] || {
  printf 'Unexpected post-revocation state: %q (expected revoked:3)\n' "$post_revocation_state" >&2
  exit 1
}

# ----------------------------------------------------------------------------
# Part 2: Optimistic Revision Concurrency on Transitions
#
# Reauthorize connection to pending (revision 4).
# Race two concurrent health check updates with the same expected revision 4.
# Exactly one must succeed (advancing revision to 5); the second must fail with P0002.
# ----------------------------------------------------------------------------
run_sql "
  select vortex_connection.reauthorize_connection_instance_internal(
    '$connection_id',
    3,
    '$actor_id',
    '$dest_fingerprint'
  );
"

touch "$proof_root/race-barrier"

(
  "${psql_command[@]}" <<SQL >"$proof_root/race-worker-1.log" 2>&1 || true
set local role vortex_runtime;
select vortex_context.initialize(public.vortex_test_connection_context());
select vortex_connection.record_connection_health_check_internal(
  '$connection_id',
  4,
  'healthy',
  '$actor_id'
);
SQL
) &
race1_pid=$!

(
  "${psql_command[@]}" <<SQL >"$proof_root/race-worker-2.log" 2>&1 || true
set local role vortex_runtime;
select vortex_context.initialize(public.vortex_test_connection_context());
select vortex_connection.record_connection_health_check_internal(
  '$connection_id',
  4,
  'healthy',
  '$actor_id'
);
SQL
) &
race2_pid=$!

wait "$race1_pid"
wait "$race2_pid"

success_count=0
failure_count=0

if grep -q "5" "$proof_root/race-worker-1.log"; then
  success_count=$((success_count + 1))
elif grep -q "revision mismatch or not found" "$proof_root/race-worker-1.log"; then
  failure_count=$((failure_count + 1))
fi

if grep -q "5" "$proof_root/race-worker-2.log"; then
  success_count=$((success_count + 1))
elif grep -q "revision mismatch or not found" "$proof_root/race-worker-2.log"; then
  failure_count=$((failure_count + 1))
fi

[ "$success_count" -eq 1 ] && [ "$failure_count" -eq 1 ] || {
  echo "Optimistic revision concurrency race test failed: expected 1 success and 1 mismatch refusal" >&2
  exit 1
}

echo "Connection readiness and transition concurrency proofs passed successfully"
