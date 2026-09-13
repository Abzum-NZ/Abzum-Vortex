#!/usr/bin/env bash
set -euo pipefail

run_uuid="${VORTEX_TENANT_GOVERNANCE_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then IFS= read -r run_uuid </proc/sys/kernel/random/uuid; fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || { echo 'tenant governance proof requires a lowercase UUID v4' >&2; exit 1; }
readonly tenant_id="15${run_uuid:2}" actor_id="45${run_uuid:2}" subject_id="46${run_uuid:2}"
readonly actor_assignment_id="35${run_uuid:2}" target_assignment_id="36${run_uuid:2}"
readonly duplicate_one="b5${run_uuid:2}" duplicate_two="b6${run_uuid:2}"
proof_root="$(mktemp -d /tmp/vortex-tenant-governance.XXXXXX)"; readonly proof_root
database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
psql_command=(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1)
if [ -n "$database_url" ]; then psql_command+=("$database_url"); fi
run_sql() { "${psql_command[@]}" --command "$1"; }
worker_one=''; worker_two=''; fixture_created=0
cleanup() {
  status=$?; trap - EXIT INT TERM; set +e; touch "$proof_root/release"
  [ -z "$worker_one" ] || wait "$worker_one" >/dev/null 2>&1
  [ -z "$worker_two" ] || wait "$worker_two" >/dev/null 2>&1
  if [ "$fixture_created" = 1 ]; then run_sql "begin; set local session_replication_role=replica; delete from vortex_identity.accepted_administration_receipts where tenant_id='$tenant_id'; delete from vortex_identity.tenant_administrator_assignments where tenant_id='$tenant_id'; delete from vortex_identity.tenants where tenant_id='$tenant_id'; delete from vortex_identity.identity_projections where identity_id in ('$actor_id','$subject_id'); commit;" >/dev/null; fi
  case "$proof_root" in /tmp/vortex-tenant-governance.*) rm -rf -- "$proof_root";; *) echo 'refusing unexpected cleanup path' >&2;; esac
  exit "$status"
}
trap cleanup EXIT; trap 'exit 130' INT; trap 'exit 143' TERM
wait_file() { deadline=$((SECONDS+20)); while ((SECONDS<deadline)); do [ -f "$1" ] && return; sleep 0.05; done; echo "missing barrier ${1##*/}" >&2; return 1; }

run_sql "
insert into vortex_identity.tenants(tenant_id,short_name,display_name,state,created_at,created_by,state_changed_at,revision) values('$tenant_id','tg_${run_uuid//-/}','Tenant governance race','active',now()-interval '1 day','$actor_id',now()-interval '1 day',1);
insert into vortex_identity.identity_projections(identity_id,state,created_at,state_changed_at,state_changed_by,state_change_correlation_id,revision) values
('$actor_id','active',now()-interval '1 day',now()-interval '1 day','$actor_id','a5${run_uuid:2}',1),
('$subject_id','active',now()-interval '1 day',now()-interval '1 day','$actor_id','a6${run_uuid:2}',1);
insert into vortex_identity.tenant_administrator_assignments(assignment_id,tenant_id,identity_id,capability_keys,starts_at,expires_at,revision,granted_at,granted_by_actor_id,grant_correlation_id,changed_at,changed_by_actor_id,change_correlation_id) values
('$actor_assignment_id','$tenant_id','$actor_id',array['platform.tenant.administrators.manage','platform.tenant.administrators.read','platform.tenant.hierarchy.read'],now()-interval '1 hour',null,1,now()-interval '1 hour','$actor_id','a7${run_uuid:2}',now()-interval '1 hour','$actor_id','a7${run_uuid:2}'),
('$target_assignment_id','$tenant_id','$subject_id',array['platform.tenant.hierarchy.read'],now()-interval '1 hour',null,1,now()-interval '1 hour','$actor_id','a8${run_uuid:2}',now()-interval '1 hour','$actor_id','a8${run_uuid:2}');"
fixture_created=1

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
blocked_pid="$(tr -d '[:space:]' <"$proof_root/two.pid")"; blocker_pid="$(tr -d '[:space:]' <"$proof_root/one.pid")"
deadline=$((SECONDS+20)); observed=''; while ((SECONDS<deadline)); do observed="$(run_sql "select case when $blocker_pid=any(pg_catalog.pg_blocking_pids($blocked_pid)) then 'yes' else '' end;")"; [ "$observed" = yes ] && break; sleep 0.1; done
[ "$observed" = yes ] || { echo 'competing tenant mutation did not block on tenant serialization' >&2; exit 1; }
touch "$proof_root/release"; wait "$worker_one"; worker_one=''; wait "$worker_two"; worker_two=''
first_result="$(tr -d '[:space:]' <"$proof_root/one.result")"
[ "$first_result" = 'accepted|2' ] || { echo "first mutation did not win at revision 2: ${first_result:-<empty>}" >&2; cat "$proof_root/one.log" >&2; exit 1; }
pg_catalog_state="$(grep -E '^V3102$' "$proof_root/two.log" || true)"
[ "$pg_catalog_state" = 'V3102' ] || { echo 'second mutation did not receive the stale-revision refusal' >&2; cat "$proof_root/two.log" >&2; exit 1; }
[ "$(run_sql "select revision||'|'||capability_keys[1] from vortex_identity.tenant_administrator_assignments where assignment_id='$target_assignment_id';")" = '2|platform.tenant.administrators.read' ] || { echo 'final assignment facts are not the single winning change' >&2; exit 1; }
[ "$(run_sql "select count(*) from vortex_identity.accepted_administration_receipts where tenant_id='$tenant_id';")" = 1 ] || { echo 'race wrote an unexpected receipt count' >&2; exit 1; }

echo 'tenant governance serialization proof passed'
