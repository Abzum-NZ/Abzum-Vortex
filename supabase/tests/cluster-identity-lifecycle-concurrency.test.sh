#!/usr/bin/env bash
set -euo pipefail

run_uuid="${VORTEX_CLUSTER_IDENTITY_LIFECYCLE_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then IFS= read -r run_uuid </proc/sys/kernel/random/uuid; fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  echo 'cluster identity lifecycle proof requires a lowercase UUID v4' >&2
  exit 1
}

readonly tenant_id="1${run_uuid:1}" organization_one_id="2${run_uuid:1}"
readonly organization_two_id="3${run_uuid:1}" target_id="4${run_uuid:1}"
readonly manager_one_id="5${run_uuid:1}" manager_two_id="6${run_uuid:1}"
readonly target_account_one_id="7${run_uuid:1}" target_account_two_id="8${run_uuid:1}"
readonly actor_id="9${run_uuid:1}" assignment_one_id="a${run_uuid:1}"
readonly assignment_two_id="b${run_uuid:1}" cluster_id="c${run_uuid:1}"
readonly correlation_id="d${run_uuid:1}" adoption_receipt_id="e${run_uuid:1}"
readonly competition_id="f${run_uuid:1}"
readonly duplicate_scope="1${run_uuid:1}" duplicate_manager_one="2${run_uuid:1}"
readonly duplicate_manager_two="3${run_uuid:1}" duplicate_suspend="4${run_uuid:1}"
readonly duplicate_close="5${run_uuid:1}" duplicate_request="6${run_uuid:1}"

proof_root="$(mktemp -d /tmp/vortex-cluster-identity-lifecycle.XXXXXX)"
readonly proof_root
database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
psql_command=(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1)
if [ -n "$database_url" ]; then psql_command+=("$database_url"); fi
run_sql() { "${psql_command[@]}" --command "$1"; }
fixture_created=0
declare -a workers=()

wait_file() {
  local deadline=$((SECONDS+25))
  while ((SECONDS<deadline)); do [ -f "$1" ] && return 0; sleep 0.05; done
  echo "cluster identity lifecycle proof missed barrier ${1##*/}" >&2
  return 1
}
read_pid() { wait_file "$1"; tr -d '[:space:]' <"$1"; }
wait_blocked() {
  local blocked="$1" blocker="$2" description="$3" state='' deadline=$((SECONDS+25))
  while ((SECONDS<deadline)); do
    state="$(run_sql "select case when $blocker=any(pg_catalog.pg_blocking_pids($blocked)) then 'yes' else '' end;")"
    [ "$state" = yes ] && return 0
    sleep 0.1
  done
  echo "cluster identity lifecycle proof did not observe $description" >&2
  return 1
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  touch "$proof_root/release-scope" "$proof_root/release-request" "$proof_root/release-managers" \
    "$proof_root/release-competition"
  for worker in "${workers[@]}"; do wait "$worker" >/dev/null 2>&1 || true; done
  if [ "$fixture_created" = 1 ]; then
    run_sql "begin; set local session_replication_role=replica;
      delete from vortex_identity.accepted_administration_receipts
        where tenant_id='$tenant_id' or cluster_id='$cluster_id';
      delete from vortex_identity.organization_accounts
        where organization_id in ('$organization_one_id','$organization_two_id');
      delete from vortex_access.organization_access_versions
        where organization_id in ('$organization_one_id','$organization_two_id');
      delete from vortex_identity.tenant_administrator_assignments where tenant_id='$tenant_id';
      delete from vortex_identity.organizations
        where organization_id in ('$organization_one_id','$organization_two_id');
      delete from vortex_identity.tenants where tenant_id='$tenant_id';
      delete from vortex_identity.identity_projections
        where identity_id in ('$target_id','$manager_one_id','$manager_two_id','$competition_id');
      commit;" >/dev/null
  fi
  case "$proof_root" in
    /tmp/vortex-cluster-identity-lifecycle.*) rm -rf -- "$proof_root" ;;
  esac
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

run_token="${run_uuid//-/}"
run_sql "
  insert into vortex_identity.tenants(
    tenant_id,short_name,display_name,state,created_at,created_by,state_changed_at,revision
  ) values ('$tenant_id','cil_${run_token:0:24}','Lifecycle race','active',now(),'$actor_id',now(),1);
  insert into vortex_identity.organizations(
    organization_id,tenant_id,parent_organization_id,short_name,display_name,state,
    created_at,created_by,state_changed_at,revision
  ) values
    ('$organization_one_id','$tenant_id',null,'cil_one_${run_token:0:20}','First scope','active',now(),'$actor_id',now(),1),
    ('$organization_two_id','$tenant_id',null,'cil_two_${run_token:0:20}','Second scope','active',now(),'$actor_id',now(),1);
  insert into vortex_identity.identity_projections(
    identity_id,state,created_at,state_changed_at,state_changed_by,state_change_correlation_id,revision
  ) values
    ('$target_id','active',now(),now(),'$actor_id','$correlation_id',1),
    ('$manager_one_id','active',now(),now(),'$actor_id','$correlation_id',1),
    ('$manager_two_id','active',now(),now(),'$actor_id','$correlation_id',1),
    ('$competition_id','active',now(),now(),'$actor_id','$correlation_id',1);
  insert into vortex_identity.organization_accounts(
    organization_account_id,organization_id,identity_id,display_name,state,
    activated_at,changed_at,state_changed_at,state_changed_by,state_change_correlation_id,revision
  ) values ('$target_account_one_id','$organization_one_id','$target_id','Target','active',
    now(),now(),now(),'$actor_id','$correlation_id',1);
  insert into vortex_access.organization_access_versions(
    organization_id,current_version,changed_at,changed_by,change_correlation_id,change_reason
  ) values
    ('$organization_one_id',1,now(),'$actor_id','$correlation_id','organization_initialized'),
    ('$organization_two_id',1,now(),'$actor_id','$correlation_id','organization_initialized');
  insert into vortex_identity.tenant_administrator_assignments(
    assignment_id,tenant_id,identity_id,capability_keys,starts_at,expires_at,revision,
    granted_at,granted_by_actor_id,grant_correlation_id,changed_at,changed_by_actor_id,change_correlation_id
  ) values
    ('$assignment_one_id','$tenant_id','$manager_one_id',array['platform.tenant.administrators.manage'],
      now()-interval '1 hour',null,1,now()-interval '1 hour','$actor_id','$correlation_id',
      now()-interval '1 hour','$actor_id','$correlation_id'),
    ('$assignment_two_id','$tenant_id','$manager_two_id',array['platform.tenant.administrators.manage'],
      now()-interval '1 hour',null,1,now()-interval '1 hour','$actor_id','$correlation_id',
      now()-interval '1 hour','$actor_id','$correlation_id');
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id,actor_id,tenant_id,operation_key,duplicate_key,command_fingerprint,
    subject_ids,subject_revisions,accepted_at
  ) values ('$adoption_receipt_id','$actor_id','$tenant_id','adopt_tenant','$run_uuid',
    'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    array['$tenant_id'::uuid],array[1::bigint],now());" >/dev/null
fixture_created=1

# Hold the initially discovered governance row. Add another account while the
# lifecycle command waits; its post-lock scope reread must refuse stale.
"${psql_command[@]}" >"$proof_root/scope-holder.log" 2>&1 <<SQL &
begin; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/scope-holder.pid'
select 1 from vortex_access.organization_access_versions
  where organization_id='$organization_one_id' for update;
\! touch '$proof_root/scope-holder.ready'
\! while [ ! -f '$proof_root/release-scope' ]; do sleep 0.05; done
commit;
SQL
w=$!; workers+=("$w"); wait_file "$proof_root/scope-holder.ready"
scope_holder_pid="$(read_pid "$proof_root/scope-holder.pid")"
"${psql_command[@]}" >"$proof_root/scope-command.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/scope-command.pid'
\set ON_ERROR_STOP off
select * from vortex_identity.suspend_cluster_identity(
  '$cluster_id','$actor_id','$duplicate_scope',
  'sha256:2222222222222222222222222222222222222222222222222222222222222222',
  '$target_id',1);
\echo :SQLSTATE
rollback;
SQL
w=$!; workers+=("$w"); scope_command_pid="$(read_pid "$proof_root/scope-command.pid")"
wait_blocked "$scope_command_pid" "$scope_holder_pid" 'command queued on discovered governance'
run_sql "insert into vortex_identity.organization_accounts(
  organization_account_id,organization_id,identity_id,display_name,state,
  activated_at,changed_at,state_changed_at,state_changed_by,state_change_correlation_id,revision
) values ('$target_account_two_id','$organization_two_id','$target_id','Added scope','active',
  now(),now(),now(),'$actor_id','$correlation_id',1);" >/dev/null
touch "$proof_root/release-scope"; wait "${workers[0]}"; wait "${workers[1]}"
grep -qx 'V3102' "$proof_root/scope-command.log" || {
  echo 'scope expansion did not refuse stale' >&2; exit 1;
}
[ "$(run_sql "select state||'|'||revision from vortex_identity.identity_projections where identity_id='$target_id';")" = 'active|1' ] || {
  echo 'scope expansion changed the target projection' >&2; exit 1;
}

# Request resolution takes the same organisation governance row. Once the
# configured transition commits, the queued request must recheck the projection
# and refuse rather than returning a stale active context.
"${psql_command[@]}" >"$proof_root/request-suspend.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/request-suspend.pid'
select outcome||'|'||revision from vortex_identity.suspend_cluster_identity(
  '$cluster_id','$actor_id','$duplicate_request',
  'sha256:7777777777777777777777777777777777777777777777777777777777777777',
  '$target_id',1) \g '$proof_root/request-suspend.result'
\! touch '$proof_root/request-suspend.ready'
\! while [ ! -f '$proof_root/release-request' ]; do sleep 0.05; done
commit;
SQL
w=$!; workers+=("$w"); wait_file "$proof_root/request-suspend.ready"
request_suspend_pid="$(read_pid "$proof_root/request-suspend.pid")"
"${psql_command[@]}" >"$proof_root/request-resolver.log" 2>&1 <<SQL &
begin; set local role vortex_runtime; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/request-resolver.pid'
\set ON_ERROR_STOP off
select * from vortex_access.resolve_human_organization_scope(
  '$target_id','$organization_one_id');
\echo :SQLSTATE
rollback;
SQL
w=$!; workers+=("$w"); request_resolver_pid="$(read_pid "$proof_root/request-resolver.pid")"
wait_blocked "$request_resolver_pid" "$request_suspend_pid" 'request resolution queued on lifecycle governance'
touch "$proof_root/release-request"; wait "${workers[2]}"; wait "${workers[3]}"
[ "$(tr -d '[:space:]' <"$proof_root/request-suspend.result")" = 'accepted|2' ] || {
  echo 'request-order projection suspension failed' >&2; exit 1;
}
grep -qx '42501' "$proof_root/request-resolver.log" || {
  echo 'request resolver did not recheck the suspended projection' >&2; exit 1;
}

# Two current permanent managers may race to leave. Tenant serialization lets
# one transition commit and refuses the other rather than losing both.
"${psql_command[@]}" >"$proof_root/manager-one.log" 2>&1 <<SQL &
begin; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/manager-one.pid'
select outcome from vortex_identity.suspend_cluster_identity(
  '$cluster_id','$actor_id','$duplicate_manager_one',
  'sha256:3333333333333333333333333333333333333333333333333333333333333333',
  '$manager_one_id',1) \g '$proof_root/manager-one.result'
\! touch '$proof_root/manager-one.ready'
\! while [ ! -f '$proof_root/release-managers' ]; do sleep 0.05; done
commit;
SQL
w=$!; workers+=("$w"); wait_file "$proof_root/manager-one.ready"
manager_one_pid="$(read_pid "$proof_root/manager-one.pid")"
"${psql_command[@]}" >"$proof_root/manager-two.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/manager-two.pid'
\set ON_ERROR_STOP off
select * from vortex_identity.suspend_cluster_identity(
  '$cluster_id','$actor_id','$duplicate_manager_two',
  'sha256:4444444444444444444444444444444444444444444444444444444444444444',
  '$manager_two_id',1);
\echo :SQLSTATE
rollback;
SQL
w=$!; workers+=("$w"); manager_two_pid="$(read_pid "$proof_root/manager-two.pid")"
wait_blocked "$manager_two_pid" "$manager_one_pid" 'second manager transition queued on tenant'
touch "$proof_root/release-managers"; wait "${workers[4]}"; wait "${workers[5]}"
[ "$(tr -d '[:space:]' <"$proof_root/manager-one.result")" = accepted ] || {
  echo 'first manager transition was not accepted' >&2; exit 1;
}
grep -qx 'V3002' "$proof_root/manager-two.log" || {
  echo 'second manager transition did not preserve a permanent manager' >&2; exit 1;
}
[ "$(run_sql "select string_agg(identity_id::text||':'||state,',' order by identity_id) from vortex_identity.identity_projections where identity_id in ('$manager_one_id','$manager_two_id');")" = "$manager_one_id:suspended,$manager_two_id:active" ] || {
  echo 'mutual manager transitions produced an invalid final state' >&2; exit 1;
}

# Competing lifecycle operations on one otherwise-unscoped projection serialize
# on the projection row. The queued command observes a stale revision.
"${psql_command[@]}" >"$proof_root/competition-suspend.log" 2>&1 <<SQL &
begin; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/competition-suspend.pid'
select outcome from vortex_identity.suspend_cluster_identity(
  '$cluster_id','$actor_id','$duplicate_suspend',
  'sha256:5555555555555555555555555555555555555555555555555555555555555555',
  '$competition_id',1) \g '$proof_root/competition-suspend.result'
\! touch '$proof_root/competition-suspend.ready'
\! while [ ! -f '$proof_root/release-competition' ]; do sleep 0.05; done
commit;
SQL
w=$!; workers+=("$w"); wait_file "$proof_root/competition-suspend.ready"
competition_pid="$(read_pid "$proof_root/competition-suspend.pid")"
"${psql_command[@]}" >"$proof_root/competition-close.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/competition-close.pid'
\set ON_ERROR_STOP off
select * from vortex_identity.close_cluster_identity(
  '$cluster_id','$actor_id','$duplicate_close',
  'sha256:6666666666666666666666666666666666666666666666666666666666666666',
  '$competition_id',1);
\echo :SQLSTATE
rollback;
SQL
w=$!; workers+=("$w"); competition_close_pid="$(read_pid "$proof_root/competition-close.pid")"
wait_blocked "$competition_close_pid" "$competition_pid" 'competing lifecycle command queued on target'
touch "$proof_root/release-competition"; wait "${workers[6]}"; wait "${workers[7]}"
grep -qx 'V3102' "$proof_root/competition-close.log" || {
  echo 'competing transition did not refuse its stale revision' >&2; exit 1;
}
[ "$(run_sql "select state||'|'||revision from vortex_identity.identity_projections where identity_id='$competition_id';")" = 'suspended|2' ] || {
  echo 'competing transitions partially applied' >&2; exit 1;
}

echo 'cluster identity lifecycle concurrency proof passed'
