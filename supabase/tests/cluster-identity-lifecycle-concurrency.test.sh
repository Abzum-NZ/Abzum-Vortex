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
readonly same_key_id="0${run_uuid:1}" creation_target_id="1${run_uuid:1}"
readonly invitation_target_id="2${run_uuid:1}" assignment_target_id="3${run_uuid:1}"
readonly steward_target_id="7${run_uuid:1}" steward_replacement_id="8${run_uuid:1}"
readonly manager_replacement_id="a${run_uuid:1}"
readonly replacement_role_assignment_id="c${run_uuid:1}"
readonly replacement_delegation_id="d${run_uuid:1}"
readonly invitation_id="e${run_uuid:1}"
readonly duplicate_scope="1${run_uuid:1}" duplicate_manager_one="2${run_uuid:1}"
readonly duplicate_manager_two="3${run_uuid:1}" duplicate_suspend="4${run_uuid:1}"
readonly duplicate_close="5${run_uuid:1}" duplicate_request="6${run_uuid:1}"
readonly duplicate_same="7${run_uuid:1}" duplicate_create="8${run_uuid:1}"
readonly duplicate_create_lifecycle="82${run_uuid:2}"
readonly duplicate_invitation_lifecycle="9${run_uuid:1}"
readonly duplicate_assignment="a${run_uuid:1}"
readonly duplicate_assignment_lifecycle="b${run_uuid:1}"
readonly duplicate_manager_replacement="c${run_uuid:1}"
readonly duplicate_manager_revoke="d${run_uuid:1}"
readonly duplicate_manager_target_suspend="cb${run_uuid:2}"
readonly duplicate_steward_org_create="83${run_uuid:2}"
readonly duplicate_steward_suspend="e${run_uuid:1}"
readonly duplicate_steward_reactivate="f${run_uuid:1}"
readonly duplicate_org_lifecycle="0${run_uuid:1}"
readonly duplicate_org_steward_suspend="aa${run_uuid:2}"

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
wait_worker() {
  local worker="$1" log_file="$2" description="$3"
  if ! wait "$worker"; then
    echo "cluster identity lifecycle proof failed: $description" >&2
    sed -n '1,160p' "$log_file" >&2
    return 1
  fi
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  touch "$proof_root/release-scope" "$proof_root/release-request" "$proof_root/release-managers" \
    "$proof_root/release-competition" "$proof_root/release-same" \
    "$proof_root/release-create" "$proof_root/release-invitation" \
    "$proof_root/release-assignment" "$proof_root/release-manager-mutation" \
    "$proof_root/release-steward-mutation" "$proof_root/release-org-lifecycle"
  for worker in "${workers[@]}"; do wait "$worker" >/dev/null 2>&1 || true; done
  if [ "$fixture_created" = 1 ]; then
    run_sql "begin; set local session_replication_role=replica;
      delete from vortex_identity.accepted_administration_receipts
        where tenant_id='$tenant_id' or cluster_id='$cluster_id';
      delete from vortex_access.organization_stewardship_requirements
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_access.organization_delegation_authorities
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_access.organization_role_activations
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_access.organization_role_assignments
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_access.organization_role_permission_entries
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_access.organization_role_revisions
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_access.organization_role_activation_policy_revisions
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_access.organization_roles
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_access.application_role_template_continuities
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_access.permission_continuities
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_access.permission_catalogue_entries
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_access.permission_registrations
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_access.permission_registration_revisions
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_identity.organization_runtime_settings
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_identity.organization_invitations
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_identity.organization_accounts
        where organization_id in ('$organization_one_id','$organization_two_id');
      delete from vortex_access.organization_access_versions
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_identity.organization_accounts
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_identity.tenant_administrator_assignments where tenant_id='$tenant_id';
      delete from vortex_identity.organizations where tenant_id='$tenant_id';
      delete from vortex_identity.tenants where tenant_id='$tenant_id';
      delete from vortex_identity.identity_projections
        where identity_id in ('$target_id','$manager_one_id','$manager_two_id','$competition_id',
          '$same_key_id','$creation_target_id','$invitation_target_id','$assignment_target_id',
          '$steward_target_id','$steward_replacement_id','$manager_replacement_id');
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
    ('$competition_id','active',now(),now(),'$actor_id','$correlation_id',1),
    ('$same_key_id','active',now(),now(),'$actor_id','$correlation_id',1),
    ('$creation_target_id','active',now(),now(),'$actor_id','$correlation_id',1),
    ('$invitation_target_id','active',now(),now(),'$actor_id','$correlation_id',1),
    ('$assignment_target_id','active',now(),now(),'$actor_id','$correlation_id',1),
    ('$steward_target_id','active',now(),now(),'$actor_id','$correlation_id',1),
    ('$steward_replacement_id','active',now(),now(),'$actor_id','$correlation_id',1),
    ('$manager_replacement_id','active',now(),now(),'$actor_id','$correlation_id',1);
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
    ('$assignment_two_id','$tenant_id','$manager_two_id',array[
      'platform.tenant.administrators.manage',
      'platform.tenant.administrators.read',
      'platform.tenant.hierarchy.read',
      'platform.tenant.organizations.create',
      'platform.tenant.organizations.lifecycle',
      'platform.tenant.organizations.rename',
      'platform.tenant.organizations.reparent'
    ],
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

# Exact same-key commands serialize on the configured receipt key. The queued
# command replays the one accepted mutation and returns its correlation ID.
"${psql_command[@]}" >"$proof_root/same-first.log" 2>&1 <<SQL &
begin; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/same-first.pid'
select outcome||'|'||revision||'|'||correlation_id::text
from vortex_identity.suspend_cluster_identity(
  '$cluster_id','$actor_id','$duplicate_same',
  'sha256:8888888888888888888888888888888888888888888888888888888888888888',
  '$same_key_id',1) \g '$proof_root/same-first.result'
\! touch '$proof_root/same-first.ready'
\! while [ ! -f '$proof_root/release-same' ]; do sleep 0.05; done
commit;
SQL
same_first_worker=$!; workers+=("$same_first_worker"); wait_file "$proof_root/same-first.ready"
same_first_pid="$(read_pid "$proof_root/same-first.pid")"
"${psql_command[@]}" >"$proof_root/same-second.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/same-second.pid'
select outcome||'|'||revision||'|'||correlation_id::text
from vortex_identity.suspend_cluster_identity(
  '$cluster_id','$actor_id','$duplicate_same',
  'sha256:8888888888888888888888888888888888888888888888888888888888888888',
  '$same_key_id',1) \g '$proof_root/same-second.result'
commit;
SQL
same_second_worker=$!; workers+=("$same_second_worker")
same_second_pid="$(read_pid "$proof_root/same-second.pid")"
wait_blocked "$same_second_pid" "$same_first_pid" 'same-key command queued on its receipt serializer'
touch "$proof_root/release-same"
wait_worker "$same_first_worker" "$proof_root/same-first.log" 'first same-key command'
wait_worker "$same_second_worker" "$proof_root/same-second.log" 'queued same-key replay'
same_first_result="$(tr -d '[:space:]' <"$proof_root/same-first.result")"
same_second_result="$(tr -d '[:space:]' <"$proof_root/same-second.result")"
same_correlation="${same_first_result##*|}"
[ "$same_first_result" = "accepted|2|$same_correlation" ] \
  && [ "$same_second_result" = "replayed|2|$same_correlation" ] || {
  echo 'same-key commands did not converge on one accepted receipt' >&2; exit 1;
}
[ "$(run_sql "select count(*) from vortex_identity.accepted_administration_receipts where cluster_id='$cluster_id' and actor_id='$actor_id' and operation_key='suspend_cluster_identity' and duplicate_key='$duplicate_same';")" = 1 ] || {
  echo 'same-key commands wrote more than one receipt' >&2; exit 1;
}

# The actual Slice 3D organisation creator holds the nominee projection after
# adding its account. A lifecycle command that discovered no scope must wait,
# then refuse stale when the committed organisation becomes visible.
"${psql_command[@]}" >"$proof_root/create-public.log" 2>&1 <<SQL &
begin; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/create-public.pid'
select outcome||'|'||organization_id::text||'|'||organization_account_id::text
from vortex_identity.create_tenant_organization(
  '$manager_two_id','$duplicate_create',
  'sha256:9191919191919191919191919191919191919191919191919191919191919191',
  '$tenant_id',null,'cil_create_${run_token:0:20}','Lifecycle-created scope',
  '$creation_target_id','Created steward','en-NZ','Pacific/Auckland',
  'en-NZ','Pacific/Auckland','NZD','medium','auto')
\g '$proof_root/create-public.result'
\! touch '$proof_root/create-public.ready'
\! while [ ! -f '$proof_root/release-create' ]; do sleep 0.05; done
commit;
SQL
create_worker=$!; workers+=("$create_worker"); wait_file "$proof_root/create-public.ready"
create_pid="$(read_pid "$proof_root/create-public.pid")"
"${psql_command[@]}" >"$proof_root/create-lifecycle.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/create-lifecycle.pid'
\set ON_ERROR_STOP off
select * from vortex_identity.suspend_cluster_identity(
  '$cluster_id','$actor_id','$duplicate_create_lifecycle',
  'sha256:9292929292929292929292929292929292929292929292929292929292929292',
  '$creation_target_id',1);
\echo :SQLSTATE
rollback;
SQL
create_lifecycle_worker=$!; workers+=("$create_lifecycle_worker")
create_lifecycle_pid="$(read_pid "$proof_root/create-lifecycle.pid")"
wait_blocked "$create_lifecycle_pid" "$create_pid" 'lifecycle command queued on the creating nominee'
touch "$proof_root/release-create"
wait_worker "$create_worker" "$proof_root/create-public.log" 'public organisation creation'
wait_worker "$create_lifecycle_worker" "$proof_root/create-lifecycle.log" 'creation lifecycle refusal'
grep -q '^accepted|' "$proof_root/create-public.result" || {
  echo 'public organisation creation did not commit' >&2; exit 1;
}
grep -qx 'V3102' "$proof_root/create-lifecycle.log" || {
  echo 'organisation creation did not force stale lifecycle scope refusal' >&2; exit 1;
}
[ "$(run_sql "select state||'|'||revision from vortex_identity.identity_projections where identity_id='$creation_target_id';")" = 'active|1' ] || {
  echo 'creation race changed the new steward projection' >&2; exit 1;
}
[ "$(run_sql "select count(*) from vortex_identity.accepted_administration_receipts where cluster_id='$cluster_id' and operation_key='suspend_cluster_identity' and duplicate_key='$duplicate_create_lifecycle';")" = 0 ] || {
  echo 'refused creation race wrote a lifecycle receipt' >&2; exit 1;
}

# Actual invitation acceptance adds an organisation account while holding the
# target projection. The waiting lifecycle command must observe the new scope.
invite_token="sha256:9393939393939393939393939393939393939393939393939393939393939393"
invite_email="cil-${run_token:0:20}@example.test"
run_sql "insert into vortex_identity.organization_invitations(
  invitation_id,organization_id,invited_email,token_fingerprint,
  invited_by_organization_account_id,created_at,invited_at,expires_at,changed_at,revision
) values ('$invitation_id','$organization_one_id','$invite_email','$invite_token',
  '$target_account_one_id',now(),now(),now()+interval '1 day',now(),1);" >/dev/null
"${psql_command[@]}" >"$proof_root/invitation-public.log" 2>&1 <<SQL &
begin; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/invitation-public.pid'
select outcome||'|'||revision from vortex_access.accept_organization_invitation(
  '$invite_token','$invitation_target_id','$invite_email','Invited identity',
  '94${run_uuid:2}') \g '$proof_root/invitation-public.result'
\! touch '$proof_root/invitation-public.ready'
\! while [ ! -f '$proof_root/release-invitation' ]; do sleep 0.05; done
commit;
SQL
invitation_worker=$!; workers+=("$invitation_worker"); wait_file "$proof_root/invitation-public.ready"
invitation_pid="$(read_pid "$proof_root/invitation-public.pid")"
"${psql_command[@]}" >"$proof_root/invitation-lifecycle.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/invitation-lifecycle.pid'
\set ON_ERROR_STOP off
select * from vortex_identity.suspend_cluster_identity(
  '$cluster_id','$actor_id','$duplicate_invitation_lifecycle',
  'sha256:9494949494949494949494949494949494949494949494949494949494949494',
  '$invitation_target_id',1);
\echo :SQLSTATE
rollback;
SQL
invitation_lifecycle_worker=$!; workers+=("$invitation_lifecycle_worker")
invitation_lifecycle_pid="$(read_pid "$proof_root/invitation-lifecycle.pid")"
wait_blocked "$invitation_lifecycle_pid" "$invitation_pid" 'lifecycle command queued on invitation acceptance'
touch "$proof_root/release-invitation"
wait_worker "$invitation_worker" "$proof_root/invitation-public.log" 'public invitation acceptance'
wait_worker "$invitation_lifecycle_worker" "$proof_root/invitation-lifecycle.log" 'invitation lifecycle refusal'
[ "$(tr -d '[:space:]' <"$proof_root/invitation-public.result")" = 'accepted|1' ] || {
  echo 'public invitation acceptance did not commit' >&2; exit 1;
}
grep -qx 'V3102' "$proof_root/invitation-lifecycle.log" || {
  echo 'invitation acceptance did not force stale lifecycle scope refusal' >&2; exit 1;
}
[ "$(run_sql "select count(*) from vortex_identity.organization_accounts where organization_id='$organization_one_id' and identity_id='$invitation_target_id' and state='active';")" = 1 ] || {
  echo 'invitation acceptance did not retain exactly one active account' >&2; exit 1;
}

# The public tenant-assignment command likewise makes a previously unscoped
# identity tenant-scoped while holding its projection share lock.
"${psql_command[@]}" >"$proof_root/assignment-public.log" 2>&1 <<SQL &
begin; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/assignment-public.pid'
select outcome||'|'||assignment_id::text from vortex_identity.grant_tenant_administrator(
  '$manager_two_id','$duplicate_assignment',
  'sha256:9595959595959595959595959595959595959595959595959595959595959595',
  '$tenant_id','$assignment_target_id','["platform.tenant.administrators.read"]',
  now()-interval '1 hour',null) \g '$proof_root/assignment-public.result'
\! touch '$proof_root/assignment-public.ready'
\! while [ ! -f '$proof_root/release-assignment' ]; do sleep 0.05; done
commit;
SQL
assignment_worker=$!; workers+=("$assignment_worker"); wait_file "$proof_root/assignment-public.ready"
assignment_pid="$(read_pid "$proof_root/assignment-public.pid")"
"${psql_command[@]}" >"$proof_root/assignment-lifecycle.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/assignment-lifecycle.pid'
\set ON_ERROR_STOP off
select * from vortex_identity.suspend_cluster_identity(
  '$cluster_id','$actor_id','$duplicate_assignment_lifecycle',
  'sha256:9696969696969696969696969696969696969696969696969696969696969696',
  '$assignment_target_id',1);
\echo :SQLSTATE
rollback;
SQL
assignment_lifecycle_worker=$!; workers+=("$assignment_lifecycle_worker")
assignment_lifecycle_pid="$(read_pid "$proof_root/assignment-lifecycle.pid")"
wait_blocked "$assignment_lifecycle_pid" "$assignment_pid" 'lifecycle command queued on tenant assignment grant'
touch "$proof_root/release-assignment"
wait_worker "$assignment_worker" "$proof_root/assignment-public.log" 'public tenant assignment grant'
wait_worker "$assignment_lifecycle_worker" "$proof_root/assignment-lifecycle.log" 'assignment lifecycle refusal'
grep -q '^accepted|' "$proof_root/assignment-public.result" || {
  echo 'public tenant assignment grant did not commit' >&2; exit 1;
}
grep -qx 'V3102' "$proof_root/assignment-lifecycle.log" || {
  echo 'tenant assignment grant did not force stale lifecycle scope refusal' >&2; exit 1;
}
[ "$(run_sql "select count(*) from vortex_identity.accepted_administration_receipts where cluster_id='$cluster_id' and operation_key='suspend_cluster_identity' and duplicate_key='$duplicate_assignment_lifecycle';")" = 0 ] || {
  echo 'refused assignment race wrote a lifecycle receipt' >&2; exit 1;
}

# Build one real adopted organisation and its second permanent steward through
# the delivered public compositions. It is reused for the remaining races.
steward_scope="$(run_sql "select organization_id::text||'|'||organization_account_id::text
from vortex_identity.create_tenant_organization(
  '$manager_two_id','$duplicate_steward_org_create',
  'sha256:9797979797979797979797979797979797979797979797979797979797979797',
  '$tenant_id',null,'cil_steward_${run_token:0:19}','Steward lifecycle scope',
  '$steward_target_id','Primary steward','en-NZ','Pacific/Auckland',
  'en-NZ','Pacific/Auckland','NZD','medium','auto');")"
IFS='|' read -r steward_org_id steward_target_account_id <<<"$steward_scope"
[[ "$steward_org_id|$steward_target_account_id" =~ ^[0-9a-f-]+\|[0-9a-f-]+$ ]] || {
  echo 'could not create the shared public stewardship fixture' >&2; exit 1;
}
replacement_invitation_id="b1${run_uuid:2}"
replacement_token="sha256:9898989898989898989898989898989898989898989898989898989898989898"
replacement_email="replacement-${run_token:0:16}@example.test"
run_sql "insert into vortex_identity.organization_invitations(
  invitation_id,organization_id,invited_email,token_fingerprint,
  invited_by_organization_account_id,created_at,invited_at,expires_at,changed_at,revision
) values ('$replacement_invitation_id','$steward_org_id','$replacement_email','$replacement_token',
  '$steward_target_account_id',now(),now(),now()+interval '1 day',now(),1);" >/dev/null
steward_replacement_account_id="$(run_sql "select organization_account_id from vortex_access.accept_organization_invitation(
  '$replacement_token','$steward_replacement_id','$replacement_email','Replacement steward','99${run_uuid:2}');")"
[[ "$steward_replacement_account_id" =~ ^[0-9a-f-]{36}$ ]] || {
  echo 'could not accept the replacement steward invitation' >&2; exit 1;
}
steward_role_id="$(run_sql "select original_role_id from vortex_access.organization_stewardship_requirements where organization_id='$steward_org_id';")"
run_sql "select outcome from vortex_access.coordinate_organization_role_assignment_change(
  'grant','$steward_org_id','$replacement_role_assignment_id',null,'$steward_role_id',1,
  'organization_account','$steward_replacement_account_id',null,'standing',
  now()-interval '1 hour',null,'$actor_id','9a${run_uuid:2}');
select outcome from vortex_access.coordinate_organization_delegation_authority_change(
  'grant_delegation','$steward_org_id','$replacement_delegation_id',null,
  'organization_account','$steward_replacement_account_id',null,
  'organization_catalogue',null,null,now()-interval '1 hour',null,
  '$actor_id','9b${run_uuid:2}');" >/dev/null

manager_replacement_assignment_id="$(run_sql "select assignment_id from vortex_identity.grant_tenant_administrator(
  '$manager_two_id','$duplicate_manager_replacement',
  'sha256:9999999999999999999999999999999999999999999999999999999999999999',
  '$tenant_id','$manager_replacement_id',
  pg_catalog.jsonb_build_array(
    'platform.tenant.administrators.manage','platform.tenant.administrators.read',
    'platform.tenant.hierarchy.read','platform.tenant.organizations.create',
    'platform.tenant.organizations.lifecycle','platform.tenant.organizations.rename',
    'platform.tenant.organizations.reparent'),
  now()-interval '1 hour',null);")"
[[ "$manager_replacement_assignment_id" =~ ^[0-9a-f-]{36}$ ]] || {
  echo 'could not grant the replacement tenant manager' >&2; exit 1;
}

# Once one of two managers is suspended, a queued public revocation of the
# replacement must fail and leave that replacement effective.
"${psql_command[@]}" >"$proof_root/manager-lifecycle.log" 2>&1 <<SQL &
begin; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/manager-lifecycle.pid'
select outcome from vortex_identity.suspend_cluster_identity(
  '$cluster_id','$actor_id','$duplicate_manager_target_suspend',
  'sha256:9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a',
  '$manager_two_id',1) \g '$proof_root/manager-lifecycle.result'
\! touch '$proof_root/manager-lifecycle.ready'
\! while [ ! -f '$proof_root/release-manager-mutation' ]; do sleep 0.05; done
commit;
SQL
manager_lifecycle_worker=$!; workers+=("$manager_lifecycle_worker")
if ! wait_file "$proof_root/manager-lifecycle.ready"; then
  wait_worker "$manager_lifecycle_worker" "$proof_root/manager-lifecycle.log" 'manager lifecycle setup'
  exit 1
fi
manager_lifecycle_pid="$(read_pid "$proof_root/manager-lifecycle.pid")"
"${psql_command[@]}" >"$proof_root/manager-revoke.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/manager-revoke.pid'
\set ON_ERROR_STOP off
select * from vortex_identity.revoke_tenant_administrator(
  '$manager_replacement_id','$duplicate_manager_revoke',
  'sha256:9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b',
  '$tenant_id','$manager_replacement_assignment_id',1);
\echo :SQLSTATE
rollback;
SQL
manager_revoke_worker=$!; workers+=("$manager_revoke_worker")
manager_revoke_pid="$(read_pid "$proof_root/manager-revoke.pid")"
wait_blocked "$manager_revoke_pid" "$manager_lifecycle_pid" 'replacement manager revocation queued on tenant governance'
touch "$proof_root/release-manager-mutation"
wait_worker "$manager_lifecycle_worker" "$proof_root/manager-lifecycle.log" 'manager lifecycle transition'
wait_worker "$manager_revoke_worker" "$proof_root/manager-revoke.log" 'replacement manager refusal'
[ "$(tr -d '[:space:]' <"$proof_root/manager-lifecycle.result")" = accepted ] \
  && grep -qx 'V3103' "$proof_root/manager-revoke.log" || {
  echo 'manager mutation race did not preserve its permanent replacement' >&2
  sed -n '1,120p' "$proof_root/manager-lifecycle.log" >&2
  sed -n '1,120p' "$proof_root/manager-revoke.log" >&2
  exit 1
}
[ "$(run_sql "select case when revoked_at is null then 'live' else 'revoked' end from vortex_identity.tenant_administrator_assignments where assignment_id='$manager_replacement_assignment_id';")" = live ] || {
  echo 'manager mutation race removed the remaining manager' >&2; exit 1;
}
[ "$(run_sql "select count(*) from vortex_identity.accepted_administration_receipts where tenant_id='$tenant_id' and operation_key='revoke_tenant_administrator' and duplicate_key='$duplicate_manager_revoke';")" = 0 ] || {
  echo 'refused manager revocation wrote a receipt' >&2; exit 1;
}

# The equivalent organisation race uses the delivered role-assignment writer.
# Its queued removal must re-evaluate after the primary steward is suspended.
steward_access_before="$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id='$steward_org_id';")"
"${psql_command[@]}" >"$proof_root/steward-lifecycle.log" 2>&1 <<SQL &
begin; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/steward-lifecycle.pid'
select outcome from vortex_identity.suspend_cluster_identity(
  '$cluster_id','$actor_id','$duplicate_steward_suspend',
  'sha256:9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c',
  '$steward_target_id',1) \g '$proof_root/steward-lifecycle.result'
\! touch '$proof_root/steward-lifecycle.ready'
\! while [ ! -f '$proof_root/release-steward-mutation' ]; do sleep 0.05; done
commit;
SQL
steward_lifecycle_worker=$!; workers+=("$steward_lifecycle_worker"); wait_file "$proof_root/steward-lifecycle.ready"
steward_lifecycle_pid="$(read_pid "$proof_root/steward-lifecycle.pid")"
"${psql_command[@]}" >"$proof_root/steward-revoke.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/steward-revoke.pid'
\set ON_ERROR_STOP off
select * from vortex_access.coordinate_organization_role_assignment_change(
  'revoke','$steward_org_id','$replacement_role_assignment_id',1,
  null,null,null,null,null,null,null,null,'$actor_id','9d${run_uuid:2}');
\echo :SQLSTATE
rollback;
SQL
steward_revoke_worker=$!; workers+=("$steward_revoke_worker")
steward_revoke_pid="$(read_pid "$proof_root/steward-revoke.pid")"
wait_blocked "$steward_revoke_pid" "$steward_lifecycle_pid" 'replacement steward revocation queued on organisation governance'
touch "$proof_root/release-steward-mutation"
wait_worker "$steward_lifecycle_worker" "$proof_root/steward-lifecycle.log" 'steward lifecycle transition'
wait_worker "$steward_revoke_worker" "$proof_root/steward-revoke.log" 'replacement steward refusal'
[ "$(tr -d '[:space:]' <"$proof_root/steward-lifecycle.result")" = accepted ] \
  && grep -qx '23514' "$proof_root/steward-revoke.log" || {
  echo 'steward mutation race did not preserve its permanent replacement' >&2; exit 1;
}
[ "$(run_sql "select state||'|'||revision from vortex_access.organization_role_assignments where organization_id='$steward_org_id' and role_assignment_id='$replacement_role_assignment_id';")" = 'live|1' ] \
  && [ "$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id='$steward_org_id';")" = "$steward_access_before" ] || {
  echo 'failed steward mutation changed authority or Access version' >&2; exit 1;
}

# Restore the primary steward, then legitimately remove the replacement. An
# actual organisation suspension holds the same governance row; the queued
# identity suspension must refuse because the organisation still needs a steward.
[ "$(run_sql "select outcome from vortex_identity.reactivate_cluster_identity(
  '$cluster_id','$actor_id','$duplicate_steward_reactivate',
  'sha256:9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e',
  '$steward_target_id',2);")" = accepted ] || {
  echo 'could not restore the primary steward for organisation lifecycle proof' >&2; exit 1;
}
[ "$(run_sql "select outcome from vortex_access.coordinate_organization_role_assignment_change(
  'revoke','$steward_org_id','$replacement_role_assignment_id',1,
  null,null,null,null,null,null,null,null,'$actor_id','9f${run_uuid:2}');")" = changed ] || {
  echo 'could not reduce the fixture to one primary steward' >&2; exit 1;
}
"${psql_command[@]}" >"$proof_root/org-lifecycle.log" 2>&1 <<SQL &
begin; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/org-lifecycle.pid'
select outcome||'|'||revision from vortex_identity.suspend_tenant_organization(
  '$manager_replacement_id','$duplicate_org_lifecycle',
  'sha256:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
  '$tenant_id','$steward_org_id',1) \g '$proof_root/org-lifecycle.result'
\! touch '$proof_root/org-lifecycle.ready'
\! while [ ! -f '$proof_root/release-org-lifecycle' ]; do sleep 0.05; done
commit;
SQL
org_lifecycle_worker=$!; workers+=("$org_lifecycle_worker"); wait_file "$proof_root/org-lifecycle.ready"
org_lifecycle_pid="$(read_pid "$proof_root/org-lifecycle.pid")"
"${psql_command[@]}" >"$proof_root/org-steward-lifecycle.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/org-steward-lifecycle.pid'
\set ON_ERROR_STOP off
select * from vortex_identity.suspend_cluster_identity(
  '$cluster_id','$actor_id','$duplicate_org_steward_suspend',
  'sha256:a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2',
  '$steward_target_id',3);
\echo :SQLSTATE
rollback;
SQL
org_steward_worker=$!; workers+=("$org_steward_worker")
org_steward_pid="$(read_pid "$proof_root/org-steward-lifecycle.pid")"
wait_blocked "$org_steward_pid" "$org_lifecycle_pid" 'cluster lifecycle queued on organisation lifecycle governance'
touch "$proof_root/release-org-lifecycle"
wait_worker "$org_lifecycle_worker" "$proof_root/org-lifecycle.log" 'public organisation lifecycle transition'
wait_worker "$org_steward_worker" "$proof_root/org-steward-lifecycle.log" 'final steward lifecycle refusal'
[ "$(tr -d '[:space:]' <"$proof_root/org-lifecycle.result")" = 'accepted|2' ] \
  && grep -qx 'V3002' "$proof_root/org-steward-lifecycle.log" || {
  echo 'organisation lifecycle race did not preserve its final steward' >&2; exit 1;
}
[ "$(run_sql "select state||'|'||revision from vortex_identity.identity_projections where identity_id='$steward_target_id';")" = 'active|3' ] || {
  echo 'failed organisation lifecycle race changed the final steward projection' >&2; exit 1;
}
[ "$(run_sql "select count(*) from vortex_identity.accepted_administration_receipts where cluster_id='$cluster_id' and operation_key='suspend_cluster_identity' and duplicate_key='$duplicate_org_steward_suspend';")" = 0 ] || {
  echo 'refused organisation lifecycle race wrote a lifecycle receipt' >&2; exit 1;
}

echo 'cluster identity lifecycle concurrency proof passed'
