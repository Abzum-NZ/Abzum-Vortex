#!/usr/bin/env bash
set -euo pipefail

run_uuid="${VORTEX_TENANT_GOVERNANCE_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then IFS= read -r run_uuid </proc/sys/kernel/random/uuid; fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || { echo 'tenant governance proof requires a lowercase UUID v4' >&2; exit 1; }
readonly tenant_id="15${run_uuid:2}" actor_id="45${run_uuid:2}" subject_id="46${run_uuid:2}"
readonly read_only_id="47${run_uuid:2}" scheduled_id="48${run_uuid:2}" expired_id="49${run_uuid:2}"
readonly revoked_id="4a${run_uuid:2}" inactive_id="4b${run_uuid:2}" expiring_id="4c${run_uuid:2}" second_manager_id="4d${run_uuid:2}"
readonly actor_assignment_id="35${run_uuid:2}" target_assignment_id="36${run_uuid:2}"
readonly read_only_assignment_id="37${run_uuid:2}" scheduled_assignment_id="38${run_uuid:2}" expired_assignment_id="39${run_uuid:2}"
readonly revoked_assignment_id="3a${run_uuid:2}" inactive_assignment_id="3b${run_uuid:2}" expiring_assignment_id="3c${run_uuid:2}" second_manager_assignment_id="3d${run_uuid:2}"
readonly duplicate_one="b5${run_uuid:2}" duplicate_two="b6${run_uuid:2}"
readonly duplicate_expiring="b7${run_uuid:2}"
proof_root="$(mktemp -d /tmp/vortex-tenant-governance.XXXXXX)"; readonly proof_root
database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
psql_command=(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1)
if [ -n "$database_url" ]; then psql_command+=("$database_url"); fi
run_sql() { "${psql_command[@]}" --command "$1"; }
worker_one=''; worker_two=''; worker_three=''; fixture_created=0
cleanup() {
  status=$?; trap - EXIT INT TERM; set +e; touch "$proof_root/release"
  [ -z "$worker_one" ] || wait "$worker_one" >/dev/null 2>&1
  [ -z "$worker_two" ] || wait "$worker_two" >/dev/null 2>&1
  [ -z "$worker_three" ] || wait "$worker_three" >/dev/null 2>&1
  if [ "$fixture_created" = 1 ]; then run_sql "begin; set local session_replication_role=replica; delete from vortex_identity.accepted_administration_receipts where tenant_id='$tenant_id'; delete from vortex_identity.tenant_administrator_assignments where tenant_id='$tenant_id'; delete from vortex_identity.tenants where tenant_id='$tenant_id'; delete from vortex_identity.identity_projections where identity_id in ('$actor_id','$subject_id','$read_only_id','$scheduled_id','$expired_id','$revoked_id','$inactive_id','$expiring_id','$second_manager_id'); commit;" >/dev/null; fi
  case "$proof_root" in /tmp/vortex-tenant-governance.*) rm -rf -- "$proof_root";; *) echo 'refusing unexpected cleanup path' >&2;; esac
  exit "$status"
}
trap cleanup EXIT; trap 'exit 130' INT; trap 'exit 143' TERM
wait_file() { deadline=$((SECONDS+20)); while ((SECONDS<deadline)); do [ -f "$1" ] && return; sleep 0.05; done; echo "missing barrier ${1##*/}" >&2; return 1; }
expect_state() {
  expected="$1"; statement="$2"
  output="$("${psql_command[@]}" 2>&1 <<SQL
\set ON_ERROR_STOP off
$statement;
\echo :SQLSTATE
SQL
)"
  state="$(printf '%s\n' "$output" | grep -E "^${expected}$" || true)"
  [ "$state" = "$expected" ] || { echo "expected $expected refusal" >&2; printf '%s\n' "$output" >&2; return 1; }
}

run_sql "
insert into vortex_identity.tenants(tenant_id,short_name,display_name,state,created_at,created_by,state_changed_at,revision) values('$tenant_id','tg_${run_uuid//-/}','Tenant governance race','active',now()-interval '1 day','$actor_id',now()-interval '1 day',1);
insert into vortex_identity.identity_projections(identity_id,state,created_at,state_changed_at,state_changed_by,state_change_correlation_id,revision) values
('$actor_id','active',now()-interval '1 day',now()-interval '1 day','$actor_id','a5${run_uuid:2}',1),
('$subject_id','active',now()-interval '1 day',now()-interval '1 day','$actor_id','a6${run_uuid:2}',1),
('$read_only_id','active',now()-interval '1 day',now()-interval '1 day','$actor_id','a9${run_uuid:2}',1),
('$scheduled_id','active',now()-interval '1 day',now()-interval '1 day','$actor_id','aa${run_uuid:2}',1),
('$expired_id','active',now()-interval '1 day',now()-interval '1 day','$actor_id','ab${run_uuid:2}',1),
('$revoked_id','active',now()-interval '1 day',now()-interval '1 day','$actor_id','ac${run_uuid:2}',1),
('$inactive_id','suspended',now()-interval '1 day',now()-interval '1 hour','$actor_id','ad${run_uuid:2}',2),
('$expiring_id','active',now()-interval '1 day',now()-interval '1 day','$actor_id','ae${run_uuid:2}',1),
('$second_manager_id','active',now()-interval '1 day',now()-interval '1 day','$actor_id','af${run_uuid:2}',1);
insert into vortex_identity.tenant_administrator_assignments(assignment_id,tenant_id,identity_id,capability_keys,starts_at,expires_at,revision,granted_at,granted_by_actor_id,grant_correlation_id,changed_at,changed_by_actor_id,change_correlation_id) values
('$actor_assignment_id','$tenant_id','$actor_id',array['platform.tenant.administrators.manage','platform.tenant.administrators.read','platform.tenant.hierarchy.read'],now()-interval '1 hour',null,1,now()-interval '1 hour','$actor_id','a7${run_uuid:2}',now()-interval '1 hour','$actor_id','a7${run_uuid:2}'),
('$target_assignment_id','$tenant_id','$subject_id',array['platform.tenant.hierarchy.read'],now()-interval '1 hour',null,1,now()-interval '1 hour','$actor_id','a8${run_uuid:2}',now()-interval '1 hour','$actor_id','a8${run_uuid:2}'),
('$read_only_assignment_id','$tenant_id','$read_only_id',array['platform.tenant.administrators.read'],now()-interval '1 hour',null,1,now()-interval '1 hour','$actor_id','b1${run_uuid:2}',now()-interval '1 hour','$actor_id','b1${run_uuid:2}'),
('$scheduled_assignment_id','$tenant_id','$scheduled_id',array['platform.tenant.administrators.manage'],now()+interval '1 hour',null,1,now()-interval '1 hour','$actor_id','b2${run_uuid:2}',now()-interval '1 hour','$actor_id','b2${run_uuid:2}'),
('$expired_assignment_id','$tenant_id','$expired_id',array['platform.tenant.administrators.manage'],now()-interval '2 hours',now()-interval '1 hour',1,now()-interval '2 hours','$actor_id','b3${run_uuid:2}',now()-interval '2 hours','$actor_id','b3${run_uuid:2}'),
('$inactive_assignment_id','$tenant_id','$inactive_id',array['platform.tenant.administrators.manage'],now()-interval '1 hour',null,1,now()-interval '1 hour','$actor_id','b4${run_uuid:2}',now()-interval '1 hour','$actor_id','b4${run_uuid:2}'),
('$expiring_assignment_id','$tenant_id','$expiring_id',array['platform.tenant.administrators.manage'],now()-interval '1 hour',now()+interval '1 day',1,now()-interval '1 hour','$actor_id','b8${run_uuid:2}',now()-interval '1 hour','$actor_id','b8${run_uuid:2}'),
('$second_manager_assignment_id','$tenant_id','$second_manager_id',array['platform.tenant.administrators.manage'],now()-interval '1 hour',null,1,now()-interval '1 hour','$actor_id','b9${run_uuid:2}',now()-interval '1 hour','$actor_id','b9${run_uuid:2}');
insert into vortex_identity.tenant_administrator_assignments(assignment_id,tenant_id,identity_id,capability_keys,starts_at,expires_at,revision,granted_at,granted_by_actor_id,grant_correlation_id,changed_at,changed_by_actor_id,change_correlation_id,revoked_at,revoked_by_actor_id,revocation_correlation_id)
values('$revoked_assignment_id','$tenant_id','$revoked_id',array['platform.tenant.administrators.manage'],now()-interval '2 hours',null,2,now()-interval '2 hours','$actor_id','ba${run_uuid:2}',now()-interval '1 hour','$actor_id','bb${run_uuid:2}',now()-interval '1 hour','$actor_id','bb${run_uuid:2}');"
fixture_created=1

[ "$(run_sql "select count(*) from vortex_identity.list_tenant_administrator_assignments('$read_only_id','$tenant_id',20,null);")" -gt 0 ] || { echo 'administrators.read did not authorize the exact read' >&2; exit 1; }
expect_state V3101 "select count(*) from vortex_identity.list_tenant_administrator_assignments('$second_manager_id','$tenant_id',20,null)"
expect_state V3101 "select * from vortex_identity.grant_tenant_administrator('$read_only_id','c1${run_uuid:2}','sha256:1111111111111111111111111111111111111111111111111111111111111111','$tenant_id','$subject_id','[\"platform.tenant.administrators.read\"]',now(),null)"
expect_state V3101 "select * from vortex_identity.grant_tenant_administrator('$scheduled_id','c2${run_uuid:2}','sha256:2222222222222222222222222222222222222222222222222222222222222222','$tenant_id','$subject_id','[\"platform.tenant.administrators.manage\"]',now(),null)"
expect_state V3101 "select * from vortex_identity.grant_tenant_administrator('$expired_id','c3${run_uuid:2}','sha256:3333333333333333333333333333333333333333333333333333333333333333','$tenant_id','$subject_id','[\"platform.tenant.administrators.manage\"]',now(),null)"
expect_state V3101 "select * from vortex_identity.grant_tenant_administrator('$revoked_id','c4${run_uuid:2}','sha256:4444444444444444444444444444444444444444444444444444444444444444','$tenant_id','$subject_id','[\"platform.tenant.administrators.manage\"]',now(),null)"
expect_state V3101 "select * from vortex_identity.grant_tenant_administrator('$inactive_id','c5${run_uuid:2}','sha256:5555555555555555555555555555555555555555555555555555555555555555','$tenant_id','$subject_id','[\"platform.tenant.administrators.manage\"]',now(),null)"
run_sql "update vortex_identity.tenants set state='suspended',state_changed_at=clock_timestamp(),revision=revision+1 where tenant_id='$tenant_id';" >/dev/null
expect_state V3101 "select * from vortex_identity.list_tenant_hierarchy('$actor_id','$tenant_id',20,null)"
run_sql "update vortex_identity.tenants set state='active',state_changed_at=clock_timestamp(),revision=revision+1 where tenant_id='$tenant_id';" >/dev/null
pre_race_assignment_count="$(run_sql "select count(*) from vortex_identity.tenant_administrator_assignments where tenant_id='$tenant_id';")"
pre_race_receipt_count="$(run_sql "select count(*) from vortex_identity.accepted_administration_receipts where tenant_id='$tenant_id';")"

call_one="select outcome||'|'||revision from vortex_identity.change_tenant_administrator('$actor_id','$duplicate_one','sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','$tenant_id','$target_assignment_id',1,'[\"platform.tenant.administrators.read\"]',now()-interval '30 minutes',null)"
call_two="select outcome||'|'||revision from vortex_identity.change_tenant_administrator('$actor_id','$duplicate_two','sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','$tenant_id','$target_assignment_id',1,'[\"platform.tenant.administrators.read\"]',now()-interval '30 minutes',null)"

"${psql_command[@]}" >"$proof_root/one.log" 2>&1 <<SQL &
begin; set local lock_timeout='20s'; set local statement_timeout='30s';
select pg_catalog.pg_backend_pid() \g '$proof_root/one.pid'
$call_one \g '$proof_root/one.result'
\! touch '$proof_root/one-ready'
\! while [ ! -f '$proof_root/release' ]; do sleep 0.05; done
commit;
SQL
worker_one=$!; wait_file "$proof_root/one-ready"

"${psql_command[@]}" >"$proof_root/two.log" 2>&1 <<SQL &
begin; set local lock_timeout='20s'; set local statement_timeout='30s';
select pg_catalog.pg_backend_pid() \g '$proof_root/two.pid'
\set ON_ERROR_STOP off
$call_two;
\echo :SQLSTATE
rollback;
SQL
worker_two=$!; wait_file "$proof_root/two.pid"
run_sql "update vortex_identity.tenant_administrator_assignments set expires_at=clock_timestamp()+interval '5 seconds' where assignment_id='$expiring_assignment_id';" >/dev/null
"${psql_command[@]}" >"$proof_root/three.log" 2>&1 <<SQL &
begin; set local lock_timeout='20s'; set local statement_timeout='30s';
select pg_catalog.pg_backend_pid() \g '$proof_root/three.pid'
\set ON_ERROR_STOP off
select * from vortex_identity.grant_tenant_administrator('$expiring_id','$duplicate_expiring','sha256:7777777777777777777777777777777777777777777777777777777777777777','$tenant_id','$subject_id','["platform.tenant.administrators.manage"]',now(),null);
\echo :SQLSTATE
rollback;
SQL
worker_three=$!; wait_file "$proof_root/three.pid"
blocked_pid="$(tr -d '[:space:]' <"$proof_root/two.pid")"; blocker_pid="$(tr -d '[:space:]' <"$proof_root/one.pid")"
expiring_pid="$(tr -d '[:space:]' <"$proof_root/three.pid")"
deadline=$((SECONDS+20)); observed=''; expiring_observed=''; while ((SECONDS<deadline)); do
  observed="$(run_sql "select case when $blocker_pid=any(pg_catalog.pg_blocking_pids($blocked_pid)) then 'yes' else '' end;")"
  expiring_observed="$(run_sql "select case when pg_catalog.cardinality(pg_catalog.pg_blocking_pids($expiring_pid))>0 then 'yes' else '' end;")"
  [ "$observed" = yes ] && [ "$expiring_observed" = yes ] && break; sleep 0.1
done
[ "$observed" = yes ] || { echo 'competing tenant mutation did not block on tenant serialization' >&2; exit 1; }
[ "$expiring_observed" = yes ] || { echo 'expiring authority did not block on tenant serialization' >&2; exit 1; }
assignment_effective="$(run_sql "select case when starts_at<=clock_timestamp() and expires_at>clock_timestamp() and revoked_at is null then 'yes' else '' end from vortex_identity.tenant_administrator_assignments where assignment_id='$expiring_assignment_id';")"
[ "$assignment_effective" = yes ] || { echo 'expiring authority was not effective while blocked on tenant serialization' >&2; exit 1; }
deadline=$((SECONDS+20)); authority_expired=''; while ((SECONDS<deadline)); do
  authority_expired="$(run_sql "select case when clock_timestamp()>=expires_at then 'yes' else '' end from vortex_identity.tenant_administrator_assignments where assignment_id='$expiring_assignment_id';")"
  [ "$authority_expired" = yes ] && break; sleep 0.05
done
[ "$authority_expired" = yes ] || { echo 'database clock did not pass the blocked authority expiry' >&2; exit 1; }
touch "$proof_root/release"; wait "$worker_one"; worker_one=''; wait "$worker_two"; worker_two=''; wait "$worker_three"; worker_three=''
first_result="$(tr -d '[:space:]' <"$proof_root/one.result")"
[ "$first_result" = 'accepted|2' ] || { echo "first mutation did not win at revision 2: ${first_result:-<empty>}" >&2; cat "$proof_root/one.log" >&2; exit 1; }
pg_catalog_state="$(grep -E '^V3102$' "$proof_root/two.log" || true)"
[ "$pg_catalog_state" = 'V3102' ] || { echo 'second mutation did not receive the stale-revision refusal' >&2; cat "$proof_root/two.log" >&2; exit 1; }
expiring_state="$(grep -E '^V3101$' "$proof_root/three.log" || true)"
[ "$expiring_state" = 'V3101' ] || { echo 'expired blocked authority was not refused after lock release' >&2; cat "$proof_root/three.log" >&2; exit 1; }
[ "$(run_sql "select revision||'|'||capability_keys[1] from vortex_identity.tenant_administrator_assignments where assignment_id='$target_assignment_id';")" = '2|platform.tenant.administrators.read' ] || { echo 'final assignment facts are not the single winning change' >&2; exit 1; }
[ "$(run_sql "select count(*) from vortex_identity.tenant_administrator_assignments where tenant_id='$tenant_id';")" = "$pre_race_assignment_count" ] || { echo 'expired blocked authority created an assignment' >&2; exit 1; }
[ "$(run_sql "select count(*) from vortex_identity.accepted_administration_receipts where tenant_id='$tenant_id';")" = "$((pre_race_receipt_count+1))" ] || { echo 'refused or stale race wrote an unexpected receipt' >&2; exit 1; }
[ "$(run_sql "select count(*) from vortex_identity.accepted_administration_receipts where tenant_id='$tenant_id' and duplicate_key='$duplicate_expiring';")" = 0 ] || { echo 'expired blocked authority wrote a receipt' >&2; exit 1; }

echo 'tenant governance serialization proof passed'
