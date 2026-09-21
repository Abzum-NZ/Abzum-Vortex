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
    delete from vortex_activity.organization_activity_entries where organization_id = '$organization_id';
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
  echo "connection readiness proof did not reach its transaction barrier: $candidate" >&2
  return 1
}

assert_blocked_at_barrier() {
  local started_file="$1"
  local finished_file="$2"
  wait_for_file "$started_file"
  sleep 0.2
  if [ -f "$finished_file" ]; then
    echo "concurrent revocation crossed a reader-held row lock" >&2
    return 1
  fi
}

# ----------------------------------------------------------------------------
# Setup fixtures
# ----------------------------------------------------------------------------
run_sql "
  begin;
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

  select vortex_context.initialize(public.vortex_test_connection_context());
  set local role vortex_runtime;
  select vortex_connection.register_connection_instance_internal(
    '$connection_id', '$organization_id', '$conn_type_id', '1.0.0',
    'cold_archive_s3', '$dest_fingerprint',
    '58000000-0000-4000-8000-000000000401'
  );
  select vortex_connection.grant_connection_application_internal(
    '$connection_id', '$application_root_id',
    '58000000-0000-4000-8000-000000000402'
  );
  select vortex_connection.record_connection_health_check_internal(
    '$connection_id', 1, 'healthy',
    '58000000-0000-4000-8000-000000000403'
  );
  commit;
"

# ----------------------------------------------------------------------------
# Part 1: Readiness decision vs exact application-grant revocation
# ----------------------------------------------------------------------------
(
  "${psql_command[@]}" <<SQL
begin;
set local role vortex_request;
select vortex_context.initialize(public.vortex_test_connection_context());
select 'READINESS_RESULT:' || (
  vortex_connection.resolve_connection_instance_readiness(
    '$organization_id', '$application_root_id', '$connection_id',
    'cold_archive_s3', 2, '$dest_fingerprint'
  ) ->> 'outcome'
);
\! touch '$proof_root/readiness-grant-locked'
select pg_catalog.pg_sleep(2);
commit;
\! touch '$proof_root/readiness-grant-committed'
SQL
) >"$proof_root/readiness-grant-reader.log" 2>&1 &
readiness_grant_reader_pid=$!

wait_for_file "$proof_root/readiness-grant-locked"
(
  "${psql_command[@]}" <<SQL
begin;
set local role vortex_runtime;
select vortex_context.initialize(public.vortex_test_connection_context());
\! touch '$proof_root/readiness-grant-revoker-started'
select vortex_connection.revoke_connection_application_internal(
  '$connection_id', '$application_root_id',
  '58000000-0000-4000-8000-000000000404'
);
commit;
\! touch '$proof_root/readiness-grant-revoker-finished'
SQL
) >"$proof_root/readiness-grant-revoker.log" 2>&1 &
readiness_grant_revoker_pid=$!

assert_blocked_at_barrier \
  "$proof_root/readiness-grant-revoker-started" \
  "$proof_root/readiness-grant-revoker-finished"
wait "$readiness_grant_reader_pid"
wait "$readiness_grant_revoker_pid"

grep -Eq '^READINESS_RESULT:ready$' "$proof_root/readiness-grant-reader.log" || {
  echo "readiness reader did not emit the anchored ready marker" >&2
  exit 1
}
[ -f "$proof_root/readiness-grant-committed" ] && \
  [ -f "$proof_root/readiness-grant-revoker-finished" ] || {
  echo "readiness/grant-revocation race did not complete" >&2
  exit 1
}

grant_count="$(run_sql "
  select count(*)
  from vortex_connection.connection_application_grants
  where connection_instance_id = '$connection_id'
    and application_root_id = '$application_root_id';
" | tr -d '\r\n')"
[ "$grant_count" = '0' ] || {
  echo "grant revocation did not remove the exact application grant" >&2
  exit 1
}

run_sql "
  begin;
  set local role vortex_runtime;
  select vortex_context.initialize(public.vortex_test_connection_context());
  select vortex_connection.grant_connection_application_internal(
    '$connection_id', '$application_root_id',
    '58000000-0000-4000-8000-000000000405'
  );
  commit;
"

# ----------------------------------------------------------------------------
# Part 2: Active-evidence decision vs exact application-grant revocation
# ----------------------------------------------------------------------------
(
  "${psql_command[@]}" <<SQL
begin;
set local role vortex_request;
select vortex_context.initialize(public.vortex_test_connection_context());
select 'EVIDENCE_RESULT:' || count(*)::text
from vortex_connection.read_active_connection_evidence('$connection_id');
\! touch '$proof_root/evidence-grant-locked'
select pg_catalog.pg_sleep(2);
commit;
\! touch '$proof_root/evidence-grant-committed'
SQL
) >"$proof_root/evidence-grant-reader.log" 2>&1 &
evidence_grant_reader_pid=$!

wait_for_file "$proof_root/evidence-grant-locked"
(
  "${psql_command[@]}" <<SQL
begin;
set local role vortex_runtime;
select vortex_context.initialize(public.vortex_test_connection_context());
\! touch '$proof_root/evidence-grant-revoker-started'
select vortex_connection.revoke_connection_application_internal(
  '$connection_id', '$application_root_id',
  '58000000-0000-4000-8000-000000000406'
);
commit;
\! touch '$proof_root/evidence-grant-revoker-finished'
SQL
) >"$proof_root/evidence-grant-revoker.log" 2>&1 &
evidence_grant_revoker_pid=$!

assert_blocked_at_barrier \
  "$proof_root/evidence-grant-revoker-started" \
  "$proof_root/evidence-grant-revoker-finished"
wait "$evidence_grant_reader_pid"
wait "$evidence_grant_revoker_pid"

grep -Eq '^EVIDENCE_RESULT:1$' "$proof_root/evidence-grant-reader.log" || {
  echo "evidence reader did not emit the anchored one-row marker" >&2
  exit 1
}
[ -f "$proof_root/evidence-grant-committed" ] && \
  [ -f "$proof_root/evidence-grant-revoker-finished" ] || {
  echo "evidence/grant-revocation race did not complete" >&2
  exit 1
}

run_sql "
  begin;
  set local role vortex_runtime;
  select vortex_context.initialize(public.vortex_test_connection_context());
  select vortex_connection.grant_connection_application_internal(
    '$connection_id', '$application_root_id',
    '58000000-0000-4000-8000-000000000407'
  );
  commit;
"

# ----------------------------------------------------------------------------
# Part 3: Readiness decision vs Connection-instance revocation
# ----------------------------------------------------------------------------
(
  "${psql_command[@]}" <<SQL
begin;
set local role vortex_request;
select vortex_context.initialize(public.vortex_test_connection_context());
select 'INSTANCE_READINESS_RESULT:' || (
  vortex_connection.resolve_connection_instance_readiness(
    '$organization_id', '$application_root_id', '$connection_id',
    'cold_archive_s3', 2, '$dest_fingerprint'
  ) ->> 'outcome'
);
\! touch '$proof_root/instance-reader-locked'
select pg_catalog.pg_sleep(2);
commit;
\! touch '$proof_root/instance-reader-committed'
SQL
) >"$proof_root/instance-reader.log" 2>&1 &
instance_reader_pid=$!

wait_for_file "$proof_root/instance-reader-locked"
(
  "${psql_command[@]}" <<SQL
begin;
set local role vortex_runtime;
select vortex_context.initialize(public.vortex_test_connection_context());
\! touch '$proof_root/instance-revoker-started'
select vortex_connection.revoke_connection_instance_internal(
  '$connection_id', 2,
  '58000000-0000-4000-8000-000000000408'
);
commit;
\! touch '$proof_root/instance-revoker-finished'
SQL
) >"$proof_root/instance-revoker.log" 2>&1 &
instance_revoker_pid=$!

assert_blocked_at_barrier \
  "$proof_root/instance-revoker-started" \
  "$proof_root/instance-revoker-finished"
wait "$instance_reader_pid"
wait "$instance_revoker_pid"

grep -Eq '^INSTANCE_READINESS_RESULT:ready$' "$proof_root/instance-reader.log" || {
  echo "instance readiness reader did not emit the anchored ready marker" >&2
  exit 1
}

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
# Part 4: Real two-worker barrier and anchored optimistic-revision markers
# ----------------------------------------------------------------------------
run_sql "
  begin;
  set local role vortex_runtime;
  select vortex_context.initialize(public.vortex_test_connection_context());
  select vortex_connection.reauthorize_connection_instance_internal(
    '$connection_id', 3,
    '58000000-0000-4000-8000-000000000409',
    '$dest_fingerprint'
  );
  commit;
"

for worker in 1 2; do
  (
    "${psql_command[@]}" <<SQL
begin;
set local role vortex_runtime;
select vortex_context.initialize(public.vortex_test_connection_context());
\! touch '$proof_root/race-worker-$worker-ready'
\! while [ ! -f '$proof_root/race-release' ]; do sleep 0.02; done
do \$race\$
declare
  result_revision bigint;
begin
  result_revision := vortex_connection.record_connection_health_check_internal(
    '$connection_id', 4, 'healthy',
    '58000000-0000-4000-8000-00000000041$worker'
  );
  raise notice 'RESULT_SUCCESS:%', result_revision;
exception
  when sqlstate 'P0002' then
    raise notice 'RESULT_FAILURE:%', sqlerrm;
end
\$race\$;
commit;
SQL
  ) >"$proof_root/race-worker-$worker.log" 2>&1 &
  if [ "$worker" -eq 1 ]; then
    race1_pid=$!
  else
    race2_pid=$!
  fi
done

wait_for_file "$proof_root/race-worker-1-ready"
wait_for_file "$proof_root/race-worker-2-ready"
touch "$proof_root/race-release"
wait "$race1_pid"
wait "$race2_pid"

success_count=0
failure_count=0
for worker in 1 2; do
  if grep -Eq '^NOTICE:[[:space:]]+RESULT_SUCCESS:5$' "$proof_root/race-worker-$worker.log"; then
    success_count=$((success_count + 1))
  elif grep -Eq '^NOTICE:[[:space:]]+RESULT_FAILURE:Connection instance health update failed: revision mismatch or not found$' "$proof_root/race-worker-$worker.log"; then
    failure_count=$((failure_count + 1))
  else
    echo "race worker $worker emitted no anchored result marker" >&2
    exit 1
  fi
done

[ "$success_count" -eq 1 ] && [ "$failure_count" -eq 1 ] || {
  echo "optimistic revision race failed: expected one anchored success and one anchored mismatch" >&2
  exit 1
}

echo "Connection grant, evidence, readiness, revocation, and revision concurrency proofs passed successfully"
