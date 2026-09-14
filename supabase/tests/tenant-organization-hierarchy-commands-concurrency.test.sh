#!/usr/bin/env bash
set -euo pipefail

run_uuid="${VORTEX_TENANT_HIERARCHY_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then IFS= read -r run_uuid </proc/sys/kernel/random/uuid; fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  echo 'tenant hierarchy proof requires a lowercase UUID v4' >&2
  exit 1
}

readonly tenant_id="16${run_uuid:2}" actor_id="46${run_uuid:2}" expiring_id="47${run_uuid:2}"
readonly actor_assignment_id="36${run_uuid:2}" expiring_assignment_id="37${run_uuid:2}"
readonly organization_a="26${run_uuid:2}" organization_b="27${run_uuid:2}" organization_c="28${run_uuid:2}"
readonly duplicate_one="c6${run_uuid:2}" duplicate_two="c7${run_uuid:2}" duplicate_expiring="c8${run_uuid:2}"
proof_root="$(mktemp -d /tmp/vortex-tenant-hierarchy.XXXXXX)"
readonly proof_root
database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
psql_command=(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1)
if [ -n "$database_url" ]; then psql_command+=("$database_url"); fi
run_sql() { "${psql_command[@]}" --command "$1"; }
worker_one=''; worker_two=''; worker_three=''; fixture_created=0

cleanup() {
  status=$?
  trap - EXIT INT TERM
  set +e
  touch "$proof_root/release"
  [ -z "$worker_one" ] || wait "$worker_one" >/dev/null 2>&1
  [ -z "$worker_two" ] || wait "$worker_two" >/dev/null 2>&1
  [ -z "$worker_three" ] || wait "$worker_three" >/dev/null 2>&1
  if [ "$status" -ne 0 ]; then
    for log in "$proof_root"/*.log; do
      [ -f "$log" ] || continue
      printf '\nWorker log: %s\n' "${log##*/}" >&2
      cat "$log" >&2
    done
  fi
  if [ "$fixture_created" = 1 ]; then
    run_sql "begin; set local session_replication_role=replica; delete from vortex_identity.accepted_administration_receipts where tenant_id='$tenant_id'; delete from vortex_identity.tenant_administrator_assignments where tenant_id='$tenant_id'; delete from vortex_identity.organizations where tenant_id='$tenant_id'; delete from vortex_identity.tenants where tenant_id='$tenant_id'; delete from vortex_identity.identity_projections where identity_id in ('$actor_id','$expiring_id'); commit;" >/dev/null
  fi
  case "$proof_root" in
    /tmp/vortex-tenant-hierarchy.*) rm -rf -- "$proof_root" ;;
    *) echo 'refusing unexpected cleanup path' >&2 ;;
  esac
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

wait_file() {
  deadline=$((SECONDS+20))
  while ((SECONDS<deadline)); do
    [ -f "$1" ] && return
    sleep 0.05
  done
  echo "missing barrier ${1##*/}" >&2
  return 1
}

run_sql "
insert into vortex_identity.tenants(tenant_id,short_name,display_name,state,created_at,created_by,state_changed_at,revision)
values('$tenant_id','th_${run_uuid//-/}','Tenant hierarchy race','active',now()-interval '1 day','$actor_id',now()-interval '1 day',1);
insert into vortex_identity.identity_projections(identity_id,state,created_at,state_changed_at,state_changed_by,state_change_correlation_id,revision) values
('$actor_id','active',now()-interval '1 day',now()-interval '1 day','$actor_id','a6${run_uuid:2}',1),
('$expiring_id','active',now()-interval '1 day',now()-interval '1 day','$actor_id','a7${run_uuid:2}',1);
insert into vortex_identity.organizations(organization_id,tenant_id,parent_organization_id,short_name,display_name,state,created_at,created_by,state_changed_at,revision) values
('$organization_a','$tenant_id',null,'organization_a','Organization A','active',now()-interval '1 day','$actor_id',now()-interval '1 day',1),
('$organization_b','$tenant_id',null,'organization_b','Organization B','active',now()-interval '1 day','$actor_id',now()-interval '1 day',1),
('$organization_c','$tenant_id',null,'organization_c','Organization C','active',now()-interval '1 day','$actor_id',now()-interval '1 day',1);
insert into vortex_identity.tenant_administrator_assignments(assignment_id,tenant_id,identity_id,capability_keys,starts_at,expires_at,revision,granted_at,granted_by_actor_id,grant_correlation_id,changed_at,changed_by_actor_id,change_correlation_id) values
('$actor_assignment_id','$tenant_id','$actor_id',array['platform.tenant.organizations.reparent'],now()-interval '1 hour',null,1,now()-interval '1 hour','$actor_id','b6${run_uuid:2}',now()-interval '1 hour','$actor_id','b6${run_uuid:2}'),
('$expiring_assignment_id','$tenant_id','$expiring_id',array['platform.tenant.organizations.rename'],now()-interval '1 hour',clock_timestamp()+interval '1 day',1,now()-interval '1 hour','$actor_id','b7${run_uuid:2}',now()-interval '1 hour','$actor_id','b7${run_uuid:2}');"
fixture_created=1

# Deliberately exceed the old fixture expiry window before acquiring any locks.
sleep 6

call_one="select outcome||'|'||revision from vortex_identity.reparent_tenant_organization('$actor_id','$duplicate_one','sha256:1111111111111111111111111111111111111111111111111111111111111111','$tenant_id','$organization_a',1,'$organization_b')"
call_two="select * from vortex_identity.reparent_tenant_organization('$actor_id','$duplicate_two','sha256:2222222222222222222222222222222222222222222222222222222222222222','$tenant_id','$organization_b',1,'$organization_a')"

"${psql_command[@]}" >"$proof_root/one.log" 2>&1 <<SQL &
begin; set local lock_timeout='20s'; set local statement_timeout='30s';
select pg_catalog.pg_backend_pid() \g '$proof_root/one.pid'
$call_one \g '$proof_root/one.result'
\! touch '$proof_root/one-ready'
\! while [ ! -f '$proof_root/release' ]; do sleep 0.05; done
commit;
SQL
worker_one=$!
wait_file "$proof_root/one-ready"

"${psql_command[@]}" >"$proof_root/two.log" 2>&1 <<SQL &
begin; set local lock_timeout='20s'; set local statement_timeout='30s';
select pg_catalog.pg_backend_pid() \g '$proof_root/two.pid'
\set ON_ERROR_STOP off
$call_two;
\echo :SQLSTATE
rollback;
SQL
worker_two=$!
wait_file "$proof_root/two.pid"

"${psql_command[@]}" >"$proof_root/three.log" 2>&1 <<SQL &
begin; set local lock_timeout='20s'; set local statement_timeout='30s';
select pg_catalog.pg_backend_pid() \g '$proof_root/three.pid'
\set ON_ERROR_STOP off
select * from vortex_identity.rename_tenant_organization('$expiring_id','$duplicate_expiring','sha256:3333333333333333333333333333333333333333333333333333333333333333','$tenant_id','$organization_c',1,'Expired rename');
\echo :SQLSTATE
rollback;
SQL
worker_three=$!
wait_file "$proof_root/three.pid"

blocker_pid="$(tr -d '[:space:]' <"$proof_root/one.pid")"
cycle_pid="$(tr -d '[:space:]' <"$proof_root/two.pid")"
expiring_pid="$(tr -d '[:space:]' <"$proof_root/three.pid")"
deadline=$((SECONDS+20)); cycle_blocked=''; expiring_blocked=''
while ((SECONDS<deadline)); do
  cycle_blocked="$(run_sql "select case when $blocker_pid=any(pg_catalog.pg_blocking_pids($cycle_pid)) then 'yes' else '' end;")"
  expiring_blocked="$(run_sql "select case when pg_catalog.cardinality(pg_catalog.pg_blocking_pids($expiring_pid))>0 then 'yes' else '' end;")"
  [ "$cycle_blocked" = yes ] && [ "$expiring_blocked" = yes ] && break
  sleep 0.1
done
[ "$cycle_blocked" = yes ] || { echo 'competing move did not queue on tenant serialization' >&2; exit 1; }
[ "$expiring_blocked" = yes ] || { echo 'expiring authority did not queue on tenant serialization' >&2; exit 1; }

authority_effective="$(run_sql "select case when starts_at<=clock_timestamp() and expires_at>clock_timestamp() and revoked_at is null then 'yes' else '' end from vortex_identity.tenant_administrator_assignments where assignment_id='$expiring_assignment_id';")"
[ "$authority_effective" = yes ] || { echo 'expiring authority was not effective while queued' >&2; exit 1; }
run_sql "update vortex_identity.tenant_administrator_assignments set expires_at=clock_timestamp()+interval '5 seconds' where assignment_id='$expiring_assignment_id';" >/dev/null
deadline=$((SECONDS+20)); authority_expired=''
while ((SECONDS<deadline)); do
  authority_expired="$(run_sql "select case when clock_timestamp()>=expires_at then 'yes' else '' end from vortex_identity.tenant_administrator_assignments where assignment_id='$expiring_assignment_id';")"
  [ "$authority_expired" = yes ] && break
  sleep 0.05
done
[ "$authority_expired" = yes ] || {
  echo 'database clock did not pass the queued authority expiry' >&2
  run_sql "select 'contender=$expiring_pid blockers='||coalesce(array_to_string(pg_catalog.pg_blocking_pids($expiring_pid), ','), 'none');" >&2
  exit 1
}
still_blocked="$(run_sql "select case when pg_catalog.cardinality(pg_catalog.pg_blocking_pids($expiring_pid))>0 then 'yes' else '' end;")"
[ "$still_blocked" = yes ] || {
  echo 'expiring authority was no longer blocked after database time passed expiry' >&2
  run_sql "select 'holder=$blocker_pid contender=$expiring_pid blockers='||coalesce(array_to_string(pg_catalog.pg_blocking_pids($expiring_pid), ','), 'none');" >&2
  exit 1
}

touch "$proof_root/release"
wait "$worker_one"; worker_one=''
wait "$worker_two"; worker_two=''
wait "$worker_three"; worker_three=''

first_result="$(tr -d '[:space:]' <"$proof_root/one.result")"
[ "$first_result" = 'accepted|2' ] || { echo "first move did not commit revision 2: ${first_result:-<empty>}" >&2; cat "$proof_root/one.log" >&2; exit 1; }
cycle_state="$(grep -E '^23514$' "$proof_root/two.log" || true)"
[ "$cycle_state" = '23514' ] || { echo 'competing move did not receive the cycle refusal' >&2; cat "$proof_root/two.log" >&2; exit 1; }
expiring_state="$(grep -E '^V3101$' "$proof_root/three.log" || true)"
[ "$expiring_state" = 'V3101' ] || { echo 'expired queued authority was not refused after lock release' >&2; cat "$proof_root/three.log" >&2; exit 1; }

[ "$(run_sql "select revision||'|'||parent_organization_id from vortex_identity.organizations where organization_id='$organization_a';")" = "2|$organization_b" ] || { echo 'winning move facts are incorrect' >&2; exit 1; }
[ "$(run_sql "select revision||'|'||coalesce(parent_organization_id::text,'root') from vortex_identity.organizations where organization_id='$organization_b';")" = '1|root' ] || { echo 'competing move changed the second organization' >&2; exit 1; }
[ "$(run_sql "select revision||'|'||display_name from vortex_identity.organizations where organization_id='$organization_c';")" = '1|Organization C' ] || { echo 'expired queued authority changed the organization' >&2; exit 1; }
[ "$(run_sql "select count(*) from vortex_identity.accepted_administration_receipts where tenant_id='$tenant_id';")" = 1 ] || { echo 'refused concurrency commands wrote an accepted receipt' >&2; exit 1; }
[ "$(run_sql "select count(*) from vortex_identity.accepted_administration_receipts where duplicate_key in ('$duplicate_two','$duplicate_expiring');")" = 0 ] || { echo 'a refused command retained a receipt' >&2; exit 1; }

echo 'tenant organization hierarchy command concurrency proof passed'
