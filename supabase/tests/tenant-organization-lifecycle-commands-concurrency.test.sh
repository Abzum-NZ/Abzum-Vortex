#!/usr/bin/env bash
set -euo pipefail

run_uuid="${VORTEX_TENANT_LIFECYCLE_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then IFS= read -r run_uuid </proc/sys/kernel/random/uuid; fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  echo 'tenant lifecycle proof requires a lowercase UUID v4' >&2
  exit 1
}

readonly run_uuid run_token="${run_uuid//-/}"
readonly cluster_id="c1${run_uuid:2}" operator_id="91${run_uuid:2}"
readonly main_actor_id="41${run_uuid:2}" root_steward_id="42${run_uuid:2}"
readonly child_steward_id="43${run_uuid:2}" extra_identity_id="44${run_uuid:2}"
readonly expiring_identity_id="45${run_uuid:2}"
readonly child_id="21${run_uuid:2}" candidate_id="22${run_uuid:2}"
readonly attach_parent_id="23${run_uuid:2}" detached_child_id="24${run_uuid:2}"
readonly child_steward_account_id="51${run_uuid:2}" extra_account_id="52${run_uuid:2}"
readonly child_role_id="61${run_uuid:2}" child_assignment_id="71${run_uuid:2}"
readonly child_delegation_id="81${run_uuid:2}" expiring_assignment_id="31${run_uuid:2}"
readonly correlation_id="a1${run_uuid:2}"
readonly duplicate_child_reactivate="b1${run_uuid:2}" duplicate_root_archive="b2${run_uuid:2}"
readonly duplicate_root_reactivate="b3${run_uuid:2}" duplicate_candidate_suspend="b4${run_uuid:2}"
readonly duplicate_candidate_archive="b5${run_uuid:2}" duplicate_attach_archive="b6${run_uuid:2}"
readonly duplicate_attach_move="b7${run_uuid:2}" duplicate_expiring="b8${run_uuid:2}"
readonly duplicate_child_suspend="b9${run_uuid:2}" duplicate_child_reactivate_two="ba${run_uuid:2}"
readonly duplicate_root_suspend="bb${run_uuid:2}"

proof_root="$(mktemp -d /tmp/vortex-tenant-lifecycle.XXXXXX)"
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
  echo "tenant lifecycle proof missed barrier ${1##*/}" >&2
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
  echo "tenant lifecycle proof did not observe $description" >&2
  return 1
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  touch "$proof_root/release-child" "$proof_root/release-candidate" \
    "$proof_root/release-attach" "$proof_root/release-expiry" \
    "$proof_root/release-account" "$proof_root/release-request"
  for worker in "${workers[@]}"; do wait "$worker" >/dev/null 2>&1 || true; done
  if [ "$status" -ne 0 ]; then
    for log in "$proof_root"/*.log; do
      [ -f "$log" ] || continue
      printf '\nWorker log: %s\n' "${log##*/}" >&2
      cat "$log" >&2
    done
  fi
  if [ "$fixture_created" = 1 ]; then
    run_sql "
      begin;
      set local session_replication_role=replica;
      delete from vortex_context.request_contexts
        where context ->> 'tenantId' = '$tenant_id';
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
      delete from vortex_access.organization_access_versions
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_identity.organization_accounts
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_identity.tenant_administrator_assignments where tenant_id='$tenant_id';
      delete from vortex_identity.organizations where tenant_id='$tenant_id';
      delete from vortex_identity.tenants where tenant_id='$tenant_id';
      delete from vortex_identity.identity_projections where identity_id in (
        '$main_actor_id','$root_steward_id','$child_steward_id','$extra_identity_id','$expiring_identity_id'
      );
      commit;" >/dev/null
  fi
  case "$proof_root" in /tmp/vortex-tenant-lifecycle.*) rm -rf -- "$proof_root" ;; esac
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

provisioned="$(run_sql "
  select tenant_id::text||'|'||root_organization_id::text||'|'||organization_account_id::text
  from vortex_identity.provision_tenant(
    '$cluster_id','$operator_id','d1${run_uuid:2}',
    'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    'tl_${run_token:0:24}','Tenant lifecycle race','tl_root_${run_token:0:19}','Lifecycle root',
    '$main_actor_id','$root_steward_id','Root steward','en-NZ','Pacific/Auckland',
    'en-NZ','Pacific/Auckland','NZD','medium','auto');")"
IFS='|' read -r tenant_id root_id root_steward_account_id <<<"$provisioned"
readonly tenant_id root_id root_steward_account_id
[[ "$tenant_id|$root_id|$root_steward_account_id" =~ ^[0-9a-f-]+\|[0-9a-f-]+\|[0-9a-f-]+$ ]] || {
  echo 'tenant lifecycle proof could not provision its fixture' >&2
  exit 1
}
fixture_created=1

run_sql "
  insert into vortex_identity.identity_projections(identity_id,state,created_at,state_changed_at,state_changed_by,state_change_correlation_id,revision) values
    ('$child_steward_id','active',now()-interval '1 hour',now()-interval '1 hour','$operator_id','$correlation_id',1),
    ('$extra_identity_id','active',now()-interval '1 hour',now()-interval '1 hour','$operator_id','$correlation_id',1),
    ('$expiring_identity_id','active',now()-interval '1 hour',now()-interval '1 hour','$operator_id','$correlation_id',1);
  insert into vortex_identity.organizations(organization_id,tenant_id,parent_organization_id,short_name,display_name,state,created_at,created_by,state_changed_at,revision) values
    ('$child_id','$tenant_id','$root_id','child_${run_token:0:20}','Lifecycle child','active',now()-interval '1 hour','$operator_id',now()-interval '1 hour',1),
    ('$candidate_id','$tenant_id',null,'candidate_${run_token:0:16}','Transition candidate','active',now()-interval '1 hour','$operator_id',now()-interval '1 hour',1),
    ('$attach_parent_id','$tenant_id',null,'parent_${run_token:0:19}','Attachment parent','active',now()-interval '1 hour','$operator_id',now()-interval '1 hour',1),
    ('$detached_child_id','$tenant_id',null,'detached_${run_token:0:17}','Detached child','active',now()-interval '1 hour','$operator_id',now()-interval '1 hour',1);
  insert into vortex_identity.organization_accounts(organization_account_id,organization_id,identity_id,display_name,state,activated_at,changed_at,state_changed_at,state_changed_by,state_change_correlation_id,revision) values
    ('$child_steward_account_id','$child_id','$child_steward_id','Child steward','active',now()-interval '1 hour',now()-interval '1 hour',now()-interval '1 hour','$operator_id','$correlation_id',1),
    ('$extra_account_id','$child_id','$extra_identity_id','Extra account','active',now()-interval '1 hour',now()-interval '1 hour',now()-interval '1 hour','$operator_id','$correlation_id',1);
  select 1 from vortex_access.initialize_organization_access_version('$child_id','$operator_id','$correlation_id');
  select 1 from vortex_access.initialize_platform_permission_catalogue('$child_id','$operator_id','$correlation_id');
  select 1 from vortex_access.coordinate_organization_stewardship_adoption(
    '$child_id','$child_steward_account_id','$child_role_id','organization_steward',
    'Organisation steward','Permanent minimum organisation administration.',
    '$child_assignment_id','$child_delegation_id','$operator_id','$correlation_id');
  select 1 from vortex_access.initialize_organization_access_version('$candidate_id','$operator_id','$correlation_id');
  select 1 from vortex_access.initialize_organization_access_version('$attach_parent_id','$operator_id','$correlation_id');
  select 1 from vortex_access.initialize_organization_access_version('$detached_child_id','$operator_id','$correlation_id');
  insert into vortex_identity.tenant_administrator_assignments(
    assignment_id,tenant_id,identity_id,capability_keys,starts_at,expires_at,revision,
    granted_at,granted_by_actor_id,grant_correlation_id,changed_at,changed_by_actor_id,change_correlation_id
  ) values ('$expiring_assignment_id','$tenant_id','$expiring_identity_id',
    array['platform.tenant.organizations.lifecycle'],now()-interval '1 hour',
    clock_timestamp()+interval '1 day',1,now()-interval '1 hour','$operator_id',
    '$correlation_id',now()-interval '1 hour','$operator_id','$correlation_id');
  update vortex_identity.organizations set state='suspended',state_changed_at=clock_timestamp(),revision=2
    where organization_id in ('$root_id','$child_id');
  set constraints all immediate;" >/dev/null

# Child reactivation takes its own governance row and tenant serialisation first.
"${psql_command[@]}" >"$proof_root/child-reactivate.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/child-reactivate.pid'
select outcome||'|'||revision from vortex_identity.reactivate_tenant_organization(
  '$main_actor_id','$duplicate_child_reactivate','sha256:2222222222222222222222222222222222222222222222222222222222222222',
  '$tenant_id','$child_id',2) \g '$proof_root/child-reactivate.result'
\! touch '$proof_root/child-reactivate.ready'
\! while [ ! -f '$proof_root/release-child' ]; do sleep 0.05; done
commit;
SQL
w=$!; workers+=("$w"); wait_file "$proof_root/child-reactivate.ready"; child_pid="$(read_pid "$proof_root/child-reactivate.pid")"
"${psql_command[@]}" >"$proof_root/root-archive.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/root-archive.pid'
\set ON_ERROR_STOP off
select * from vortex_identity.archive_tenant_organization(
  '$main_actor_id','$duplicate_root_archive','sha256:3333333333333333333333333333333333333333333333333333333333333333',
  '$tenant_id','$root_id',2);
\echo :SQLSTATE
rollback;
SQL
w=$!; workers+=("$w"); root_archive_pid="$(read_pid "$proof_root/root-archive.pid")"
wait_blocked "$root_archive_pid" "$child_pid" 'archive queued behind child reactivation at tenant serialization'
touch "$proof_root/release-child"; wait "${workers[0]}"; wait "${workers[1]}"
[ "$(tr -d '[:space:]' <"$proof_root/child-reactivate.result")" = 'accepted|3' ] || { echo 'child reactivation failed' >&2; exit 1; }
grep -qx 'V3101' "$proof_root/root-archive.log" || { echo 'archive did not refuse the reactivated direct child' >&2; exit 1; }
[ "$(run_sql "select state||'|'||revision from vortex_identity.organizations where organization_id='$root_id';")" = 'suspended|2' ] || { echo 'archive changed suspended parent' >&2; exit 1; }
[ "$(run_sql "select outcome||'|'||revision from vortex_identity.reactivate_tenant_organization('$main_actor_id','$duplicate_root_reactivate','sha256:4444444444444444444444444444444444444444444444444444444444444444','$tenant_id','$root_id',2);")" = 'accepted|3' ] || { echo 'root reactivation preparation failed' >&2; exit 1; }

# Competing transitions on one organization serialize at its Access row.
"${psql_command[@]}" >"$proof_root/candidate-suspend.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/candidate-suspend.pid'
select outcome||'|'||revision from vortex_identity.suspend_tenant_organization(
  '$main_actor_id','$duplicate_candidate_suspend','sha256:5555555555555555555555555555555555555555555555555555555555555555',
  '$tenant_id','$candidate_id',1) \g '$proof_root/candidate-suspend.result'
\! touch '$proof_root/candidate-suspend.ready'
\! while [ ! -f '$proof_root/release-candidate' ]; do sleep 0.05; done
commit;
SQL
w=$!; workers+=("$w"); wait_file "$proof_root/candidate-suspend.ready"; candidate_pid="$(read_pid "$proof_root/candidate-suspend.pid")"
"${psql_command[@]}" >"$proof_root/candidate-archive.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/candidate-archive.pid'
\set ON_ERROR_STOP off
select * from vortex_identity.archive_tenant_organization(
  '$main_actor_id','$duplicate_candidate_archive','sha256:6666666666666666666666666666666666666666666666666666666666666666',
  '$tenant_id','$candidate_id',1);
\echo :SQLSTATE
rollback;
SQL
w=$!; workers+=("$w"); candidate_archive_pid="$(read_pid "$proof_root/candidate-archive.pid")"
wait_blocked "$candidate_archive_pid" "$candidate_pid" 'competing transition queued on organization governance'
touch "$proof_root/release-candidate"; wait "${workers[2]}"; wait "${workers[3]}"
[ "$(tr -d '[:space:]' <"$proof_root/candidate-suspend.result")" = 'accepted|2' ] || { echo 'winning transition failed' >&2; exit 1; }
grep -qx 'V3102' "$proof_root/candidate-archive.log" || { echo 'competing transition was not stale after wait' >&2; exit 1; }

# An accepted archive and a concurrent attachment cannot leave a live child below it.
"${psql_command[@]}" >"$proof_root/attach-archive.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/attach-archive.pid'
select outcome||'|'||revision from vortex_identity.archive_tenant_organization(
  '$main_actor_id','$duplicate_attach_archive','sha256:7777777777777777777777777777777777777777777777777777777777777777',
  '$tenant_id','$attach_parent_id',1) \g '$proof_root/attach-archive.result'
\! touch '$proof_root/attach-archive.ready'
\! while [ ! -f '$proof_root/release-attach' ]; do sleep 0.05; done
commit;
SQL
w=$!; workers+=("$w"); wait_file "$proof_root/attach-archive.ready"; attach_pid="$(read_pid "$proof_root/attach-archive.pid")"
"${psql_command[@]}" >"$proof_root/attach-move.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/attach-move.pid'
\set ON_ERROR_STOP off
select * from vortex_identity.reparent_tenant_organization(
  '$main_actor_id','$duplicate_attach_move','sha256:8888888888888888888888888888888888888888888888888888888888888888',
  '$tenant_id','$detached_child_id',1,'$attach_parent_id');
\echo :SQLSTATE
rollback;
SQL
w=$!; workers+=("$w"); attach_move_pid="$(read_pid "$proof_root/attach-move.pid")"
wait_blocked "$attach_move_pid" "$attach_pid" 'child attachment queued behind archive tenant serialization'
touch "$proof_root/release-attach"; wait "${workers[4]}"; wait "${workers[5]}"
grep -qx 'V3101' "$proof_root/attach-move.log" || { echo 'attachment to archived parent was not refused' >&2; exit 1; }
[ "$(run_sql "select state||'|'||revision from vortex_identity.organizations where organization_id='$attach_parent_id';")" = 'archived|2' ] || { echo 'archive/attachment race left invalid parent' >&2; exit 1; }
[ "$(run_sql "select coalesce(parent_organization_id::text,'root')||'|'||revision from vortex_identity.organizations where organization_id='$detached_child_id';")" = 'root|1' ] || { echo 'archive/attachment race moved child' >&2; exit 1; }

# Authority effective while queued at governance must be rechecked at fresh DB time.
# Deliberately exceed the old fixture expiry window before acquiring the expiry lock.
sleep 9
"${psql_command[@]}" >"$proof_root/expiry-holder.log" 2>&1 <<SQL &
begin; select pg_catalog.pg_backend_pid() \g '$proof_root/expiry-holder.pid'
select 1 from vortex_access.organization_access_versions where organization_id='$root_id' for update;
\! touch '$proof_root/expiry-holder.ready'
\! while [ ! -f '$proof_root/release-expiry' ]; do sleep 0.05; done
commit;
SQL
w=$!; workers+=("$w"); wait_file "$proof_root/expiry-holder.ready"; expiry_holder_pid="$(read_pid "$proof_root/expiry-holder.pid")"
"${psql_command[@]}" >"$proof_root/expiry-command.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/expiry-command.pid'
\set ON_ERROR_STOP off
select * from vortex_identity.suspend_tenant_organization(
  '$expiring_identity_id','$duplicate_expiring','sha256:9999999999999999999999999999999999999999999999999999999999999999',
  '$tenant_id','$root_id',3);
\echo :SQLSTATE
rollback;
SQL
w=$!; workers+=("$w"); expiry_command_pid="$(read_pid "$proof_root/expiry-command.pid")"
wait_blocked "$expiry_command_pid" "$expiry_holder_pid" 'lifecycle command queued at governance'
[ "$(run_sql "select case when starts_at<=clock_timestamp() and expires_at>clock_timestamp() then 'yes' else 'no' end from vortex_identity.tenant_administrator_assignments where assignment_id='$expiring_assignment_id';")" = yes ] || { echo 'authority was not effective while queued' >&2; exit 1; }
run_sql "update vortex_identity.tenant_administrator_assignments set expires_at=clock_timestamp()+interval '5 seconds' where assignment_id='$expiring_assignment_id';" >/dev/null
deadline=$((SECONDS+20)); authority_expired=''
while ((SECONDS<deadline)); do
  authority_expired="$(run_sql "select case when clock_timestamp()>=expires_at then 'yes' else '' end from vortex_identity.tenant_administrator_assignments where assignment_id='$expiring_assignment_id';")"
  [ "$authority_expired" = yes ] && break
  sleep 0.05
done
[ "$authority_expired" = yes ] || {
  echo 'database time did not pass queued lifecycle authority expiry' >&2
  run_sql "select 'contender=$expiry_command_pid blockers='||coalesce(array_to_string(pg_catalog.pg_blocking_pids($expiry_command_pid), ','), 'none');" >&2
  exit 1
}
still_blocked="$(run_sql "select case when pg_catalog.cardinality(pg_catalog.pg_blocking_pids($expiry_command_pid))>0 then 'yes' else '' end;")"
[ "$still_blocked" = yes ] || {
  echo 'expiring lifecycle authority was no longer blocked after database time passed expiry' >&2
  run_sql "select 'holder=$expiry_holder_pid contender=$expiry_command_pid blockers='||coalesce(array_to_string(pg_catalog.pg_blocking_pids($expiry_command_pid), ','), 'none');" >&2
  exit 1
}
touch "$proof_root/release-expiry"; wait "${workers[6]}"; wait "${workers[7]}"
grep -qx 'V3101' "$proof_root/expiry-command.log" || { echo 'expired queued authority was not refused' >&2; exit 1; }
[ "$(run_sql "select count(*) from vortex_identity.accepted_administration_receipts where duplicate_key='$duplicate_expiring';")" = 0 ] || { echo 'expired authority wrote a receipt' >&2; exit 1; }
[ "$(run_sql "select state||'|'||revision from vortex_identity.organizations where organization_id='$root_id';")" = 'active|3' ] || { echo 'expired queued authority changed root state' >&2; exit 1; }

# A supported account mutation, suspension, then reactivation queue in governance order.
child_access_version="$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id='$child_id';")"
"${psql_command[@]}" >"$proof_root/account-holder.log" 2>&1 <<SQL &
begin; select pg_catalog.pg_backend_pid() \g '$proof_root/account-holder.pid'
select 1 from vortex_identity.organization_accounts where organization_account_id='$extra_account_id' for update;
\! touch '$proof_root/account-holder.ready'
\! while [ ! -f '$proof_root/release-account' ]; do sleep 0.05; done
commit;
SQL
w=$!; workers+=("$w"); wait_file "$proof_root/account-holder.ready"; account_holder_pid="$(read_pid "$proof_root/account-holder.pid")"
"${psql_command[@]}" >"$proof_root/account-mutation.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='40s';
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind','human','identityAuthorityId','$operator_id','tenantId','$tenant_id',
  'organizationId','$child_id','organizationAccountId','$child_steward_account_id',
  'identityId','$child_steward_id','sessionId','e1${run_uuid:2}',
  'authenticationStrength','single_factor','issuedAt',statement_timestamp()-interval '1 minute',
  'expiresAt',statement_timestamp()+interval '5 minutes','accessVersion',$child_access_version,
  'correlationId','e2${run_uuid:2}'));
select pg_catalog.pg_backend_pid() \g '$proof_root/account-mutation.pid'
select state||'|'||revision||'|'||access_version from vortex_access.change_organization_account_state(
  '$extra_account_id',1,'suspended') \g '$proof_root/account-mutation.result'
commit;
SQL
w=$!; workers+=("$w"); account_mutation_pid="$(read_pid "$proof_root/account-mutation.pid")"
wait_blocked "$account_mutation_pid" "$account_holder_pid" 'supported account mutation holding governance while queued on account'
"${psql_command[@]}" >"$proof_root/child-suspend-two.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='40s';
select pg_catalog.pg_backend_pid() \g '$proof_root/child-suspend-two.pid'
select outcome||'|'||revision from vortex_identity.suspend_tenant_organization(
  '$main_actor_id','$duplicate_child_suspend','sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '$tenant_id','$child_id',3) \g '$proof_root/child-suspend-two.result'
commit;
SQL
w=$!; workers+=("$w"); child_suspend_pid="$(read_pid "$proof_root/child-suspend-two.pid")"
wait_blocked "$child_suspend_pid" "$account_mutation_pid" 'suspension queued behind supported account mutation'
"${psql_command[@]}" >"$proof_root/child-reactivate-two.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='40s';
select pg_catalog.pg_backend_pid() \g '$proof_root/child-reactivate-two.pid'
select outcome||'|'||revision from vortex_identity.reactivate_tenant_organization(
  '$main_actor_id','$duplicate_child_reactivate_two','sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  '$tenant_id','$child_id',4) \g '$proof_root/child-reactivate-two.result'
commit;
SQL
w=$!; workers+=("$w"); child_reactivate_pid="$(read_pid "$proof_root/child-reactivate-two.pid")"
wait_blocked "$child_reactivate_pid" "$child_suspend_pid" 'reactivation queued behind supported account mutation and lifecycle change'
touch "$proof_root/release-account"; wait "${workers[8]}"; wait "${workers[9]}"; wait "${workers[10]}"; wait "${workers[11]}"
[ "$(tr -d '[:space:]' <"$proof_root/account-mutation.result")" = "suspended|2|$((child_access_version+1))" ] || { echo 'supported account mutation failed' >&2; exit 1; }
[ "$(tr -d '[:space:]' <"$proof_root/child-suspend-two.result")" = 'accepted|4' ] || { echo 'queued child suspension failed' >&2; exit 1; }
[ "$(tr -d '[:space:]' <"$proof_root/child-reactivate-two.result")" = 'accepted|5' ] || { echo 'queued child reactivation failed' >&2; exit 1; }

# Request resolution takes the same Access row and rechecks after lifecycle commit.
"${psql_command[@]}" >"$proof_root/root-suspend.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/root-suspend.pid'
select outcome||'|'||revision from vortex_identity.suspend_tenant_organization(
  '$main_actor_id','$duplicate_root_suspend','sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  '$tenant_id','$root_id',3) \g '$proof_root/root-suspend.result'
\! touch '$proof_root/root-suspend.ready'
\! while [ ! -f '$proof_root/release-request' ]; do sleep 0.05; done
commit;
SQL
w=$!; workers+=("$w"); wait_file "$proof_root/root-suspend.ready"; root_suspend_pid="$(read_pid "$proof_root/root-suspend.pid")"
"${psql_command[@]}" >"$proof_root/request-resolver.log" 2>&1 <<SQL &
begin; set local role vortex_runtime; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/request-resolver.pid'
\set ON_ERROR_STOP off
select * from vortex_access.resolve_human_organization_scope('$root_steward_id','$root_id');
\echo :SQLSTATE
rollback;
SQL
w=$!; workers+=("$w"); resolver_pid="$(read_pid "$proof_root/request-resolver.pid")"
wait_blocked "$resolver_pid" "$root_suspend_pid" 'request resolution queued behind lifecycle governance'
touch "$proof_root/release-request"; wait "${workers[12]}"; wait "${workers[13]}"
[ "$(tr -d '[:space:]' <"$proof_root/root-suspend.result")" = 'accepted|4' ] || { echo 'request-order suspension failed' >&2; exit 1; }
grep -qx '42501' "$proof_root/request-resolver.log" || { echo 'request resolver did not recheck suspended organization' >&2; exit 1; }

invalid_count="$(run_sql "
  select count(*) from vortex_identity.organizations as parent
  where parent.tenant_id='$tenant_id' and parent.state in ('archived','removal_pending')
    and exists (select 1 from vortex_identity.organizations as child
      where child.tenant_id=parent.tenant_id and child.parent_organization_id=parent.organization_id
        and child.state in ('active','suspended'));")"
[ "$invalid_count" = 0 ] || { echo 'lifecycle races left an invalid hierarchy' >&2; exit 1; }
[ "$(run_sql "select count(*) from vortex_identity.accepted_administration_receipts where duplicate_key in ('$duplicate_root_archive','$duplicate_candidate_archive','$duplicate_attach_move','$duplicate_expiring');")" = 0 ] || { echo 'refused lifecycle race wrote a receipt' >&2; exit 1; }

echo 'tenant organization lifecycle command concurrency proof passed'
