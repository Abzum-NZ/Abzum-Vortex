#!/usr/bin/env bash

set -euo pipefail

run_uuid="${VORTEX_DELEGATION_CHANGE_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then
  [ -r /proc/sys/kernel/random/uuid ] || {
    echo 'a Linux random UUID source is required for the delegation proof' >&2
    exit 1
  }
  IFS= read -r run_uuid </proc/sys/kernel/random/uuid
fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  echo 'VORTEX_DELEGATION_CHANGE_PROOF_RUN_ID must be a lowercase UUID v4' >&2
  exit 1
}

readonly run_uuid
readonly run_token="${run_uuid//-/}"
readonly fixture_name_token="${run_token:0:20}"
readonly fixture_short_name="delegate_${fixture_name_token}"
proof_root="$(mktemp -d /tmp/vortex-delegation-change.XXXXXX)"
readonly proof_root
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id="b1${run_uuid:2}"
readonly organization_id="b2${run_uuid:2}"
readonly identity_id="b3${run_uuid:2}"
readonly account_id="b4${run_uuid:2}"
readonly group_one_id="b5${run_uuid:2}"
readonly group_two_id="b6${run_uuid:2}"
readonly application_root_id="b7${run_uuid:2}"
readonly permission_id="b8${run_uuid:2}"
readonly source_role_id="b9${run_uuid:2}"
readonly duplicate_delegation_id="c1${run_uuid:2}"
readonly transition_delegation_id="c2${run_uuid:2}"
readonly application_first_delegation_id="c3${run_uuid:2}"
readonly application_stale_delegation_id="c4${run_uuid:2}"
readonly group_first_delegation_id="c5${run_uuid:2}"
readonly group_stale_delegation_id="c6${run_uuid:2}"
readonly expiry_delegation_id="c7${run_uuid:2}"
readonly actor_id="d1${run_uuid:2}"
readonly application_key="proof.delegation_${fixture_name_token}"
readonly correlation_initialize="e1${run_uuid:2}"
readonly correlation_register="e2${run_uuid:2}"
readonly correlation_reactivate="e3${run_uuid:2}"
readonly correlation_r1_first="e4${run_uuid:2}"
readonly correlation_r1_second="e5${run_uuid:2}"
readonly correlation_r2_replace="e6${run_uuid:2}"
readonly correlation_r2_revoke="e7${run_uuid:2}"
readonly correlation_r3_grant="e8${run_uuid:2}"
readonly correlation_r3_withdraw="e9${run_uuid:2}"
readonly correlation_r3_withdraw_first="ea${run_uuid:2}"
readonly correlation_r3_stale_grant="eb${run_uuid:2}"
readonly correlation_r4_grant="ec${run_uuid:2}"
readonly correlation_r4_retire="ed${run_uuid:2}"
readonly correlation_r4_retire_first="ee${run_uuid:2}"
readonly correlation_r4_stale_grant="ef${run_uuid:2}"
readonly correlation_r5_replace="f1${run_uuid:2}"
readonly correlation_seed="f2${run_uuid:2}"
readonly correlation_platform="f3${run_uuid:2}"

fixture_claimed=0
declare -a worker_pids=()
declare -A reaped_worker_pids=()

psql_command=(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1)
if [ -n "$database_url" ]; then psql_command+=("$database_url"); fi

run_sql() { "${psql_command[@]}" --command "$1"; }

wait_for_file() {
  local candidate="$1"
  local deadline=$((SECONDS + 30))
  while ((SECONDS < deadline)); do
    [ -f "$candidate" ] && return 0
    sleep 0.05
  done
  echo 'delegation proof did not reach its transaction barrier' >&2
  return 1
}

read_backend_pid() {
  local candidate="$1"
  local backend_pid
  wait_for_file "$candidate"
  backend_pid="$(tr -d '[:space:]' <"$candidate")"
  [[ "$backend_pid" =~ ^[1-9][0-9]*$ ]] || {
    printf 'delegation proof captured an invalid backend identifier: %q\n' "$backend_pid" >&2
    return 1
  }
  printf '%s\n' "$backend_pid"
}

wait_for_database_blocker() {
  local blocked_pid="$1"
  local blocking_pid="$2"
  local deadline=$((SECONDS + 30))
  local state
  while ((SECONDS < deadline)); do
    state="$(run_sql "select case when $blocking_pid = any(pg_catalog.pg_blocking_pids($blocked_pid)) then 'blocked' else '' end;")"
    [ "$state" = 'blocked' ] && return 0
    sleep 0.1
  done
  echo 'delegation proof did not observe the required lock ordering' >&2
  return 1
}

wait_for_database_time() {
  local target="$1"
  local deadline=$((SECONDS + 25))
  local reached
  while ((SECONDS < deadline)); do
    reached="$(run_sql "select case when pg_catalog.clock_timestamp() >= '$target'::timestamptz then 'yes' else '' end;")"
    [ "$reached" = 'yes' ] && return 0
    sleep 0.05
  done
  echo 'delegation proof did not reach the fixed expiry' >&2
  return 1
}

wait_owned_worker() {
  local pid="$1"
  local status
  if wait "$pid"; then status=0; else status=$?; fi
  reaped_worker_pids["$pid"]=1
  return "$status"
}

stop_owned_workers() {
  local pid
  for pid in "${worker_pids[@]}"; do
    if [ "${reaped_worker_pids[$pid]:-0}" != 1 ] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
  for pid in "${worker_pids[@]}"; do
    if [ "${reaped_worker_pids[$pid]:-0}" != 1 ]; then
      wait "$pid" >/dev/null 2>&1 || true
      reaped_worker_pids["$pid"]=1
    fi
  done
}

emit_owned_failure_diagnostics() {
  local log_path
  echo 'delegation proof failed; bounded owned worker diagnostics follow' >&2
  for log_path in "$proof_root"/*.log; do
    [ -f "$log_path" ] || continue
    printf '%s\n' "--- ${log_path##*/} (last 120 lines) ---" >&2
    tail -n 120 -- "$log_path" >&2
  done
}

cleanup_fixture() {
  [ "$fixture_claimed" = 1 ] || return 0
  run_sql "
    begin;
    set local session_replication_role = replica;
    do \$proof\$
    begin
      if not exists (
        select 1 from vortex_identity.tenants
        where tenant_id = '$tenant_id' and short_name = '$fixture_short_name'
          and created_by = '$actor_id'
      ) or not exists (
        select 1 from vortex_identity.organizations
        where organization_id = '$organization_id' and tenant_id = '$tenant_id'
          and short_name = '$fixture_short_name' and created_by = '$actor_id'
      ) or not exists (
        select 1 from vortex_identity.organization_accounts
        where organization_id = '$organization_id'
          and organization_account_id = '$account_id'
          and identity_id = '$identity_id'
      ) then
        raise exception 'Delegation proof fixture ownership marker mismatch';
      end if;
    end
    \$proof\$;
    delete from vortex_access.organization_delegation_authorities
      where organization_id = '$organization_id';
    delete from vortex_access.application_role_template_continuities
      where organization_id = '$organization_id';
    delete from vortex_access.permission_continuities
      where organization_id = '$organization_id';
    delete from vortex_access.permission_catalogue_entries
      where organization_id = '$organization_id';
    delete from vortex_access.permission_registrations
      where organization_id = '$organization_id';
    delete from vortex_access.permission_registration_revisions
      where organization_id = '$organization_id';
    delete from vortex_access.organization_groups
      where organization_id = '$organization_id';
    delete from vortex_access.organization_access_versions
      where organization_id = '$organization_id';
    delete from vortex_identity.organization_accounts
      where organization_id = '$organization_id';
    delete from vortex_identity.identity_projections
      where identity_id = '$identity_id';
    delete from vortex_definition.releases where root_id = '$application_root_id';
    delete from vortex_definition.roots where root_id = '$application_root_id';
    delete from vortex_identity.organizations where organization_id = '$organization_id';
    delete from vortex_identity.tenants where tenant_id = '$tenant_id';
    commit;
  " >/dev/null
}

finalize() {
  local original_status=$?
  local cleanup_status=0
  local operation_status
  trap - EXIT INT TERM
  set +e
  touch "$proof_root/r1-release" "$proof_root/r2-release" \
    "$proof_root/r3a-release" "$proof_root/r3b-release" \
    "$proof_root/r4a-release" "$proof_root/r4b-release" \
    "$proof_root/r5-release"
  stop_owned_workers
  if [ "$original_status" -ne 0 ]; then emit_owned_failure_diagnostics; fi
  cleanup_fixture
  operation_status=$?
  if [ "$operation_status" -ne 0 ]; then cleanup_status="$operation_status"; fi
  case "$proof_root" in
    /tmp/vortex-delegation-change.*) rm -rf -- "$proof_root"; operation_status=$? ;;
    *) echo "refusing to remove unexpected proof directory: $proof_root" >&2; operation_status=1 ;;
  esac
  if [ "$operation_status" -ne 0 ] && [ "$cleanup_status" -eq 0 ]; then
    cleanup_status="$operation_status"
  fi
  if [ "$original_status" -ne 0 ]; then exit "$original_status"; fi
  exit "$cleanup_status"
}
trap finalize EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

permission_value="pg_catalog.jsonb_build_object(
  'permissionId','$permission_id','key','proof.records.read',
  'label','View records','description','View proof records.',
  'actionKind','read','administrative',false)"
release_one="pg_catalog.jsonb_build_object(
  'kind','application','definitionKey','$application_key',
  'rootId','$application_root_id','releaseRevision',1,
  'releaseVersion','1.0.0','validationContractVersion','2.18.0',
  'contentFingerprint','sha256:' || pg_catalog.repeat('3',64),
  'resolutionFingerprint','sha256:' || pg_catalog.repeat('2',64))"
release_two="pg_catalog.jsonb_build_object(
  'kind','application','definitionKey','$application_key',
  'rootId','$application_root_id','releaseRevision',2,
  'releaseVersion','2.0.0','validationContractVersion','2.18.0',
  'contentFingerprint','sha256:' || pg_catalog.repeat('c',64),
  'resolutionFingerprint','sha256:' || pg_catalog.repeat('b',64))"
candidate_one="pg_catalog.jsonb_build_object(
  'contractVersion','1.0.0','organizationId','$organization_id',
  'applicationRootId','$application_root_id','applicationRelease',$release_one,
  'applicationCatalogueFingerprint','sha256:' || pg_catalog.repeat('5',64),
  'applicationPermissionIds',pg_catalog.jsonb_build_array('$permission_id'),
  'entries',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'applicationRootId','$application_root_id','ownerKind','application',
    'ownerId','$application_root_id','permission',$permission_value,
    'sourceRelease',$release_one,
    'meaningFingerprint','sha256:' || pg_catalog.repeat('6',64))),
  'candidateFingerprint','sha256:' || pg_catalog.repeat('7',64))"
candidate_two="pg_catalog.jsonb_build_object(
  'contractVersion','1.0.0','organizationId','$organization_id',
  'applicationRootId','$application_root_id','applicationRelease',$release_two,
  'applicationCatalogueFingerprint','sha256:' || pg_catalog.repeat('d',64),
  'applicationPermissionIds',pg_catalog.jsonb_build_array('$permission_id'),
  'entries',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'applicationRootId','$application_root_id','ownerKind','application',
    'ownerId','$application_root_id','permission',$permission_value,
    'sourceRelease',$release_two,
    'meaningFingerprint','sha256:' || pg_catalog.repeat('6',64))),
  'candidateFingerprint','sha256:' || pg_catalog.repeat('e',64))"
prepared_one="pg_catalog.jsonb_build_object(
  'contractVersion','1.0.0',
  'preparationBasis',pg_catalog.jsonb_build_object('kind','registration_candidate'),
  'permissionRegistration',$candidate_one,
  'templates',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'template',pg_catalog.jsonb_build_object(
      'roleId','$source_role_id','key','records_reader','name','Records reader',
      'homePageId','$source_role_id',
      'permissionKeys',pg_catalog.jsonb_build_array('proof.records.read'),
      'permissionSelection',pg_catalog.jsonb_build_object('kind','exact')),
    'sourceTemplateFingerprint','sha256:' || pg_catalog.repeat('8',64),
    'sourcePermissions',($candidate_one)->'entries',
    'livePermissions',($candidate_one)->'entries')),
  'candidateFingerprint','sha256:' || pg_catalog.repeat('9',64))"
prepared_two="pg_catalog.jsonb_build_object(
  'contractVersion','1.0.0',
  'preparationBasis',pg_catalog.jsonb_build_object('kind','registration_candidate'),
  'permissionRegistration',$candidate_two,
  'templates',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'template',pg_catalog.jsonb_build_object(
      'roleId','$source_role_id','key','records_reader','name','Records reader',
      'homePageId','$source_role_id',
      'permissionKeys',pg_catalog.jsonb_build_array('proof.records.read'),
      'permissionSelection',pg_catalog.jsonb_build_object('kind','exact')),
    'sourceTemplateFingerprint','sha256:' || pg_catalog.repeat('8',64),
    'sourcePermissions',($candidate_two)->'entries',
    'livePermissions',($candidate_two)->'entries')),
  'candidateFingerprint','sha256:' || pg_catalog.repeat('f',64))"
app_scope="(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
  'kind','exact','applicationRootId',entry.application_root_id,
  'ownerKind',entry.owner_kind,'ownerId',entry.owner_id,
  'permissionId',entry.permission_id,
  'acceptedRegistrationRevision',entry.registration_revision,
  'catalogueFingerprint',registration.permission_catalogue_fingerprint,
  'continuityRevision',continuity.continuity_revision,
  'meaningFingerprint',entry.meaning_fingerprint)
  order by entry.application_root_id,entry.owner_kind collate \"C\",
    entry.owner_id,entry.permission_id)
 from vortex_access.permission_catalogue_entries entry
 join vortex_access.permission_registration_revisions registration
   on registration.organization_id=entry.organization_id
  and registration.registration_kind=entry.registration_kind
  and registration.registration_owner_id=entry.registration_owner_id
  and registration.revision=entry.registration_revision
 join vortex_access.permission_continuities continuity
   on continuity.organization_id=entry.organization_id
  and continuity.application_root_id is not distinct from entry.application_root_id
  and continuity.owner_kind=entry.owner_kind and continuity.owner_id=entry.owner_id
  and continuity.permission_id=entry.permission_id
 where entry.organization_id='$organization_id'
   and entry.registration_kind='application'
   and entry.registration_owner_id='$application_root_id'
   and continuity.state='available')"
platform_scope="(select pg_catalog.jsonb_agg(candidate.permission order by candidate.permission_id)
 from (select entry.permission_id,pg_catalog.jsonb_build_object(
   'kind','exact','ownerKind',entry.owner_kind,'ownerId',entry.owner_id,
   'permissionId',entry.permission_id,
   'acceptedRegistrationRevision',entry.registration_revision,
   'catalogueFingerprint',registration.permission_catalogue_fingerprint,
   'continuityRevision',continuity.continuity_revision,
   'meaningFingerprint',entry.meaning_fingerprint) as permission
 from vortex_access.permission_catalogue_entries entry
 join vortex_access.permission_registration_revisions registration
   on registration.organization_id=entry.organization_id
  and registration.registration_kind=entry.registration_kind
  and registration.registration_owner_id=entry.registration_owner_id
  and registration.revision=entry.registration_revision
 join vortex_access.permission_continuities continuity
   on continuity.organization_id=entry.organization_id
  and continuity.application_root_id is null
  and continuity.owner_kind=entry.owner_kind and continuity.owner_id=entry.owner_id
  and continuity.permission_id=entry.permission_id
 where entry.organization_id='$organization_id'
   and entry.registration_kind='platform' and continuity.state='available'
 order by entry.permission_id limit 1) candidate)"

"${psql_command[@]}" >/dev/null <<SQL
begin;
insert into vortex_identity.tenants (
  tenant_id,short_name,display_name,state,created_at,created_by,state_changed_at,revision
) values ('$tenant_id','$fixture_short_name','Delegation proof','active',
  pg_catalog.clock_timestamp(),'$actor_id',pg_catalog.clock_timestamp(),1);
insert into vortex_identity.organizations (
  organization_id,tenant_id,short_name,display_name,state,created_at,created_by,
  state_changed_at,revision
) values ('$organization_id','$tenant_id','$fixture_short_name','Delegation proof',
  'active',pg_catalog.clock_timestamp(),'$actor_id',pg_catalog.clock_timestamp(),1);
insert into vortex_identity.identity_projections (
  identity_id,state,created_at,state_changed_at,state_changed_by,
  state_change_correlation_id,revision
) values ('$identity_id','active',pg_catalog.clock_timestamp(),
  pg_catalog.clock_timestamp(),'$actor_id','$correlation_initialize',1);
insert into vortex_identity.organization_accounts (
  organization_account_id,organization_id,identity_id,display_name,state,
  activated_at,changed_at,state_changed_at,state_changed_by,
  state_change_correlation_id,revision
) values ('$account_id','$organization_id','$identity_id','Delegation account',
  'active',pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),
  pg_catalog.clock_timestamp(),'$actor_id','$correlation_initialize',1);
select * from vortex_access.initialize_organization_access_version(
  '$organization_id','$actor_id','$correlation_initialize');
select * from vortex_access.initialize_platform_permission_catalogue(
  '$organization_id','$actor_id','$correlation_platform');
insert into vortex_access.permission_continuities(
  organization_id,application_root_id,owner_kind,owner_id,permission_id,
  registration_kind,registration_owner_id,state,continuity_revision,
  meaning_fingerprint,last_processed_registration_revision,changed_at)
select entry.organization_id,null,entry.owner_kind,entry.owner_id,
  entry.permission_id,entry.registration_kind,entry.registration_owner_id,
  'available',1,entry.meaning_fingerprint,entry.registration_revision,
  pg_catalog.clock_timestamp()
from vortex_access.permission_catalogue_entries entry
where entry.organization_id='$organization_id'
  and entry.registration_kind='platform';
insert into vortex_access.organization_groups (
  organization_id,group_id,group_key,label,state,revision,created_by,created_at,
  changed_by,changed_at,change_correlation_id
) values
  ('$organization_id','$group_one_id','delegation_group_one','Delegation Group one',
   'active',1,'$actor_id',pg_catalog.clock_timestamp(),'$actor_id',
   pg_catalog.clock_timestamp(),'$correlation_seed'),
  ('$organization_id','$group_two_id','delegation_group_two','Delegation Group two',
   'active',1,'$actor_id',pg_catalog.clock_timestamp(),'$actor_id',
   pg_catalog.clock_timestamp(),'$correlation_seed');
insert into vortex_definition.roots (
  root_id,organization_id,kind,key,created_at,created_by
) values ('$application_root_id','$organization_id','application','$application_key',
  pg_catalog.clock_timestamp(),'$actor_id');
insert into vortex_definition.releases (
  root_id,release_revision,release_version,authored_source,
  authored_source_fingerprint,source_contract_version,compilation_output,
  resolution_snapshot,content_fingerprint,resolution_fingerprint,
  validation_contract_version,comparison_fingerprint,impact_reasons,
  release_note,published_at,published_by
) values
  ('$application_root_id',1,'1.0.0',
   pg_catalog.jsonb_build_object('source_contract_version','1.0.0','kind','application',
     'key','$application_key','body','{}'::jsonb),
   'sha256:'||pg_catalog.repeat('1',64),'1.0.0',
   pg_catalog.jsonb_build_object('kind','application','canonical',
     pg_catalog.jsonb_build_object('content',pg_catalog.jsonb_build_object(
       'permissions',pg_catalog.jsonb_build_array($permission_value)))),
   pg_catalog.jsonb_build_object('fingerprint','sha256:'||pg_catalog.repeat('2',64)),
   'sha256:'||pg_catalog.repeat('3',64),'sha256:'||pg_catalog.repeat('2',64),
   '2.18.0','sha256:'||pg_catalog.repeat('4',64),'[]','Initial release',
   pg_catalog.clock_timestamp(),'$actor_id'),
  ('$application_root_id',2,'2.0.0',
   pg_catalog.jsonb_build_object('source_contract_version','1.0.0','kind','application',
     'key','$application_key','body','{}'::jsonb),
   'sha256:'||pg_catalog.repeat('a',64),'1.0.0',
   pg_catalog.jsonb_build_object('kind','application','canonical',
     pg_catalog.jsonb_build_object('content',pg_catalog.jsonb_build_object(
       'permissions',pg_catalog.jsonb_build_array($permission_value)))),
   pg_catalog.jsonb_build_object('fingerprint','sha256:'||pg_catalog.repeat('b',64)),
   'sha256:'||pg_catalog.repeat('c',64),'sha256:'||pg_catalog.repeat('b',64),
   '2.18.0','sha256:'||pg_catalog.repeat('d',64),'[]','Reactivation release',
   pg_catalog.clock_timestamp(),'$actor_id');
update vortex_definition.roots set current_release_revision=2
where root_id='$application_root_id';
select * from vortex_access.coordinate_application_access_change(
  'register',null,$prepared_one,'$organization_id','$application_root_id',
  '$actor_id','$correlation_register');
set constraints all immediate;
commit;
SQL
fixture_claimed=1

# R1: two grants of one permanent identity serialize; exactly one commits.
before_r1="$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id='$organization_id';")"
PGAPPNAME="vortex-delegation-r1-holder-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r1-holder.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r1-holder.pid'
select 1 from vortex_identity.organization_accounts
where organization_id='$organization_id' and organization_account_id='$account_id' for update;
\! touch '$proof_root/r1-holder-ready'
\! deadline=600; while [ ! -f '$proof_root/r1-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/r1-release' ]
commit;
SQL
r1_holder=$!; worker_pids+=("$r1_holder"); wait_for_file "$proof_root/r1-holder-ready"
r1_holder_db="$(read_backend_pid "$proof_root/r1-holder.pid")"
PGAPPNAME="vortex-delegation-r1-first-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r1-first.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin; set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r1-first.pid'
select * from vortex_access.coordinate_organization_delegation_authority_change(
  'grant_delegation','$organization_id','$duplicate_delegation_id',null,
  'organization_account','$account_id',null,'organization_catalogue',null,null,
  pg_catalog.clock_timestamp(),null,'$actor_id','$correlation_r1_first');
commit;
SQL
r1_first=$!; worker_pids+=("$r1_first")
r1_first_db="$(read_backend_pid "$proof_root/r1-first.pid")"
wait_for_database_blocker "$r1_first_db" "$r1_holder_db"
PGAPPNAME="vortex-delegation-r1-second-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r1-second.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin; set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r1-second.pid'
select * from vortex_access.coordinate_organization_delegation_authority_change(
  'grant_delegation','$organization_id','$duplicate_delegation_id',null,
  'organization_account','$account_id',null,'organization_catalogue',null,null,
  pg_catalog.clock_timestamp(),null,'$actor_id','$correlation_r1_second');
commit;
SQL
r1_second=$!; worker_pids+=("$r1_second")
r1_second_db="$(read_backend_pid "$proof_root/r1-second.pid")"
wait_for_database_blocker "$r1_second_db" "$r1_first_db"
touch "$proof_root/r1-release"
wait_owned_worker "$r1_holder"; wait_owned_worker "$r1_first"
if wait_owned_worker "$r1_second"; then echo 'duplicate delegation grant unexpectedly committed' >&2; exit 1; fi
grep -q '40001' "$proof_root/r1-second.log" || { echo 'duplicate grant lacked 40001' >&2; exit 1; }
r1_state="$(run_sql "select pg_catalog.concat_ws('|',version.current_version,delegation.revision,delegation.state,(select count(*) from vortex_access.organization_delegation_authorities where organization_id='$organization_id' and delegation_authority_id='$duplicate_delegation_id') ) from vortex_access.organization_access_versions version join vortex_access.organization_delegation_authorities delegation on delegation.organization_id=version.organization_id and delegation.delegation_authority_id='$duplicate_delegation_id' where version.organization_id='$organization_id';")"
[ "$r1_state" = "$((before_r1+1))|1|live|1" ] || { printf 'duplicate grant race left unexpected state: %q\n' "$r1_state" >&2; exit 1; }

# Seed a separate live delegation for replace-versus-revoke.
run_sql "select * from vortex_access.coordinate_organization_delegation_authority_change('grant_delegation','$organization_id','$transition_delegation_id',null,'organization_account','$account_id',null,'organization_catalogue',null,null,pg_catalog.clock_timestamp(),null,'$actor_id','$correlation_seed');" >/dev/null

# R2: replacement owns governance first; queued revoke using the old revision is stale.
before_r2="$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id='$organization_id';")"
PGAPPNAME="vortex-delegation-r2-holder-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r2-holder.log" 2>&1 <<SQL &
begin; set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r2-holder.pid'
select 1 from vortex_access.organization_delegation_authorities
where organization_id='$organization_id' and delegation_authority_id='$transition_delegation_id' for update;
\! touch '$proof_root/r2-holder-ready'
\! deadline=600; while [ ! -f '$proof_root/r2-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/r2-release' ]
commit;
SQL
r2_holder=$!; worker_pids+=("$r2_holder"); wait_for_file "$proof_root/r2-holder-ready"
r2_holder_db="$(read_backend_pid "$proof_root/r2-holder.pid")"
PGAPPNAME="vortex-delegation-r2-replace-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r2-replace.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin; set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r2-replace.pid'
select * from vortex_access.coordinate_organization_delegation_authority_change(
  'replace_delegation_scope','$organization_id','$transition_delegation_id',1,
  null,null,null,'bounded',$app_scope,'sha256:'||pg_catalog.repeat('1',64),
  null,null,'$actor_id','$correlation_r2_replace');
commit;
SQL
r2_replace=$!; worker_pids+=("$r2_replace")
r2_replace_db="$(read_backend_pid "$proof_root/r2-replace.pid")"
wait_for_database_blocker "$r2_replace_db" "$r2_holder_db"
PGAPPNAME="vortex-delegation-r2-revoke-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r2-revoke.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin; set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r2-revoke.pid'
select * from vortex_access.coordinate_organization_delegation_authority_change(
  'revoke_delegation','$organization_id','$transition_delegation_id',1,
  null,null,null,null,null,null,null,null,'$actor_id','$correlation_r2_revoke');
commit;
SQL
r2_revoke=$!; worker_pids+=("$r2_revoke")
r2_revoke_db="$(read_backend_pid "$proof_root/r2-revoke.pid")"
wait_for_database_blocker "$r2_revoke_db" "$r2_replace_db"
touch "$proof_root/r2-release"
wait_owned_worker "$r2_holder"; wait_owned_worker "$r2_replace"
if wait_owned_worker "$r2_revoke"; then echo 'stale competing revoke unexpectedly committed' >&2; exit 1; fi
grep -q '40001' "$proof_root/r2-revoke.log" || { echo 'stale competing revoke lacked 40001' >&2; exit 1; }
r2_state="$(run_sql "select pg_catalog.concat_ws('|',version.current_version,delegation.revision,delegation.state,delegation.scope_kind) from vortex_access.organization_access_versions version join vortex_access.organization_delegation_authorities delegation on delegation.organization_id=version.organization_id and delegation.delegation_authority_id='$transition_delegation_id' where version.organization_id='$organization_id';")"
[ "$r2_state" = "$((before_r2+1))|2|live|bounded" ] || { printf 'replace-versus-revoke race left unexpected state: %q\n' "$r2_state" >&2; exit 1; }

# R3a: delegation wins governance, then withdrawal commits and leaves retained stale facts.
before_r3a="$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id='$organization_id';")"
PGAPPNAME="vortex-delegation-r3a-holder-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r3a-holder.log" 2>&1 <<SQL &
begin; set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r3a-holder.pid'
select 1 from vortex_identity.organization_accounts where organization_id='$organization_id' and organization_account_id='$account_id' for update;
\! touch '$proof_root/r3a-holder-ready'
\! deadline=600; while [ ! -f '$proof_root/r3a-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/r3a-release' ]
commit;
SQL
r3a_holder=$!; worker_pids+=("$r3a_holder"); wait_for_file "$proof_root/r3a-holder-ready"
r3a_holder_db="$(read_backend_pid "$proof_root/r3a-holder.pid")"
PGAPPNAME="vortex-delegation-r3a-grant-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r3a-grant.log" 2>&1 <<SQL &
begin; set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r3a-grant.pid'
select * from vortex_access.coordinate_organization_delegation_authority_change(
  'grant_delegation','$organization_id','$application_first_delegation_id',null,
  'organization_account','$account_id',null,'bounded',$app_scope,
  'sha256:'||pg_catalog.repeat('2',64),pg_catalog.clock_timestamp(),null,
  '$actor_id','$correlation_r3_grant');
commit;
SQL
r3a_grant=$!; worker_pids+=("$r3a_grant")
r3a_grant_db="$(read_backend_pid "$proof_root/r3a-grant.pid")"
wait_for_database_blocker "$r3a_grant_db" "$r3a_holder_db"
PGAPPNAME="vortex-delegation-r3a-withdraw-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r3a-withdraw.log" 2>&1 <<SQL &
begin; set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r3a-withdraw.pid'
select * from vortex_access.coordinate_application_access_change(
  'withdraw',1,null,'$organization_id','$application_root_id',
  '$actor_id','$correlation_r3_withdraw');
commit;
SQL
r3a_withdraw=$!; worker_pids+=("$r3a_withdraw")
r3a_withdraw_db="$(read_backend_pid "$proof_root/r3a-withdraw.pid")"
wait_for_database_blocker "$r3a_withdraw_db" "$r3a_grant_db"
touch "$proof_root/r3a-release"
wait_owned_worker "$r3a_holder"; wait_owned_worker "$r3a_grant"; wait_owned_worker "$r3a_withdraw"
r3a_state="$(run_sql "select pg_catalog.concat_ws('|',version.current_version,registration.state,delegation.state,continuity.state) from vortex_access.organization_access_versions version join vortex_access.permission_registrations registration on registration.organization_id=version.organization_id and registration.registration_owner_id='$application_root_id' join vortex_access.organization_delegation_authorities delegation on delegation.organization_id=version.organization_id and delegation.delegation_authority_id='$application_first_delegation_id' join vortex_access.permission_continuities continuity on continuity.organization_id=version.organization_id and continuity.application_root_id='$application_root_id' and continuity.permission_id='$permission_id' where version.organization_id='$organization_id';")"
[ "$r3a_state" = "$((before_r3a+2))|withdrawn|live|unavailable" ] || { printf 'delegation-first withdrawal race left unexpected state: %q\n' "$r3a_state" >&2; exit 1; }

run_sql "select * from vortex_access.coordinate_application_access_change('reactivate',2,$prepared_two,'$organization_id','$application_root_id','$actor_id','$correlation_reactivate');" >/dev/null

# R3b: withdrawal wins governance; queued grant rechecks and refuses stale authority.
before_r3b="$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id='$organization_id';")"
PGAPPNAME="vortex-delegation-r3b-holder-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r3b-holder.log" 2>&1 <<SQL &
begin; set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r3b-holder.pid'
select 1 from vortex_access.permission_registrations where organization_id='$organization_id' and registration_owner_id='$application_root_id' for update;
\! touch '$proof_root/r3b-holder-ready'
\! deadline=600; while [ ! -f '$proof_root/r3b-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/r3b-release' ]
commit;
SQL
r3b_holder=$!; worker_pids+=("$r3b_holder"); wait_for_file "$proof_root/r3b-holder-ready"
r3b_holder_db="$(read_backend_pid "$proof_root/r3b-holder.pid")"
PGAPPNAME="vortex-delegation-r3b-withdraw-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r3b-withdraw.log" 2>&1 <<SQL &
begin; set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r3b-withdraw.pid'
select * from vortex_access.coordinate_application_access_change(
  'withdraw',3,null,'$organization_id','$application_root_id',
  '$actor_id','$correlation_r3_withdraw_first');
commit;
SQL
r3b_withdraw=$!; worker_pids+=("$r3b_withdraw")
r3b_withdraw_db="$(read_backend_pid "$proof_root/r3b-withdraw.pid")"
wait_for_database_blocker "$r3b_withdraw_db" "$r3b_holder_db"
PGAPPNAME="vortex-delegation-r3b-grant-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r3b-grant.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin; set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r3b-grant.pid'
select * from vortex_access.coordinate_organization_delegation_authority_change(
  'grant_delegation','$organization_id','$application_stale_delegation_id',null,
  'organization_account','$account_id',null,'bounded',$app_scope,
  'sha256:'||pg_catalog.repeat('3',64),pg_catalog.clock_timestamp(),null,
  '$actor_id','$correlation_r3_stale_grant');
commit;
SQL
r3b_grant=$!; worker_pids+=("$r3b_grant")
r3b_grant_db="$(read_backend_pid "$proof_root/r3b-grant.pid")"
wait_for_database_blocker "$r3b_grant_db" "$r3b_withdraw_db"
touch "$proof_root/r3b-release"
wait_owned_worker "$r3b_holder"; wait_owned_worker "$r3b_withdraw"
if wait_owned_worker "$r3b_grant"; then echo 'source-first stale delegation unexpectedly committed' >&2; exit 1; fi
grep -Eq '23514|40001' "$proof_root/r3b-grant.log" || { echo 'source-first stale delegation lacked closed refusal' >&2; exit 1; }
r3b_state="$(run_sql "select pg_catalog.concat_ws('|',version.current_version,registration.state,(select count(*) from vortex_access.organization_delegation_authorities where organization_id='$organization_id' and delegation_authority_id='$application_stale_delegation_id')) from vortex_access.organization_access_versions version join vortex_access.permission_registrations registration on registration.organization_id=version.organization_id and registration.registration_owner_id='$application_root_id' where version.organization_id='$organization_id';")"
[ "$r3b_state" = "$((before_r3b+1))|withdrawn|0" ] || { printf 'source-first race left unexpected state: %q\n' "$r3b_state" >&2; exit 1; }

# R4a: Group delegation wins, then retirement retains an inactive-source fact.
before_r4a="$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id='$organization_id';")"
PGAPPNAME="vortex-delegation-r4a-holder-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r4a-holder.log" 2>&1 <<SQL &
begin; set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r4a-holder.pid'
select 1 from vortex_access.organization_groups where organization_id='$organization_id' and group_id='$group_one_id' for update;
\! touch '$proof_root/r4a-holder-ready'
\! deadline=600; while [ ! -f '$proof_root/r4a-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/r4a-release' ]
commit;
SQL
r4a_holder=$!; worker_pids+=("$r4a_holder"); wait_for_file "$proof_root/r4a-holder-ready"
r4a_holder_db="$(read_backend_pid "$proof_root/r4a-holder.pid")"
PGAPPNAME="vortex-delegation-r4a-grant-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r4a-grant.log" 2>&1 <<SQL &
begin; set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r4a-grant.pid'
select * from vortex_access.coordinate_organization_delegation_authority_change(
  'grant_delegation','$organization_id','$group_first_delegation_id',null,
  'group',null,'$group_one_id','organization_catalogue',null,null,
  pg_catalog.clock_timestamp(),null,'$actor_id','$correlation_r4_grant');
commit;
SQL
r4a_grant=$!; worker_pids+=("$r4a_grant")
r4a_grant_db="$(read_backend_pid "$proof_root/r4a-grant.pid")"
wait_for_database_blocker "$r4a_grant_db" "$r4a_holder_db"
PGAPPNAME="vortex-delegation-r4a-retire-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r4a-retire.log" 2>&1 <<SQL &
begin; set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r4a-retire.pid'
select * from vortex_access.coordinate_organization_group_change(
  'retire_group','$organization_id','$group_one_id',1,null,null,
  '$actor_id','$correlation_r4_retire');
commit;
SQL
r4a_retire=$!; worker_pids+=("$r4a_retire")
r4a_retire_db="$(read_backend_pid "$proof_root/r4a-retire.pid")"
wait_for_database_blocker "$r4a_retire_db" "$r4a_grant_db"
touch "$proof_root/r4a-release"
wait_owned_worker "$r4a_holder"; wait_owned_worker "$r4a_grant"; wait_owned_worker "$r4a_retire"
r4a_state="$(run_sql "select pg_catalog.concat_ws('|',version.current_version,organization_group.state,delegation.state) from vortex_access.organization_access_versions version join vortex_access.organization_groups organization_group on organization_group.organization_id=version.organization_id and organization_group.group_id='$group_one_id' join vortex_access.organization_delegation_authorities delegation on delegation.organization_id=version.organization_id and delegation.delegation_authority_id='$group_first_delegation_id' where version.organization_id='$organization_id';")"
[ "$r4a_state" = "$((before_r4a+2))|retired|live" ] || { printf 'delegation-first Group race left unexpected state: %q\n' "$r4a_state" >&2; exit 1; }

# R4b: Group retirement wins; queued grant sees the retired source and refuses.
before_r4b="$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id='$organization_id';")"
PGAPPNAME="vortex-delegation-r4b-holder-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r4b-holder.log" 2>&1 <<SQL &
begin; set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r4b-holder.pid'
select 1 from vortex_access.organization_groups where organization_id='$organization_id' and group_id='$group_two_id' for update;
\! touch '$proof_root/r4b-holder-ready'
\! deadline=600; while [ ! -f '$proof_root/r4b-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/r4b-release' ]
commit;
SQL
r4b_holder=$!; worker_pids+=("$r4b_holder"); wait_for_file "$proof_root/r4b-holder-ready"
r4b_holder_db="$(read_backend_pid "$proof_root/r4b-holder.pid")"
PGAPPNAME="vortex-delegation-r4b-retire-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r4b-retire.log" 2>&1 <<SQL &
begin; set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r4b-retire.pid'
select * from vortex_access.coordinate_organization_group_change(
  'retire_group','$organization_id','$group_two_id',1,null,null,
  '$actor_id','$correlation_r4_retire_first');
commit;
SQL
r4b_retire=$!; worker_pids+=("$r4b_retire")
r4b_retire_db="$(read_backend_pid "$proof_root/r4b-retire.pid")"
wait_for_database_blocker "$r4b_retire_db" "$r4b_holder_db"
PGAPPNAME="vortex-delegation-r4b-grant-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r4b-grant.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin; set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r4b-grant.pid'
select * from vortex_access.coordinate_organization_delegation_authority_change(
  'grant_delegation','$organization_id','$group_stale_delegation_id',null,
  'group',null,'$group_two_id','organization_catalogue',null,null,
  pg_catalog.clock_timestamp(),null,'$actor_id','$correlation_r4_stale_grant');
commit;
SQL
r4b_grant=$!; worker_pids+=("$r4b_grant")
r4b_grant_db="$(read_backend_pid "$proof_root/r4b-grant.pid")"
wait_for_database_blocker "$r4b_grant_db" "$r4b_retire_db"
touch "$proof_root/r4b-release"
wait_owned_worker "$r4b_holder"; wait_owned_worker "$r4b_retire"
if wait_owned_worker "$r4b_grant"; then echo 'retirement-first Group grant unexpectedly committed' >&2; exit 1; fi
grep -q '40001' "$proof_root/r4b-grant.log" || { echo 'retirement-first Group grant lacked 40001' >&2; exit 1; }
r4b_state="$(run_sql "select pg_catalog.concat_ws('|',version.current_version,organization_group.state,(select count(*) from vortex_access.organization_delegation_authorities where organization_id='$organization_id' and delegation_authority_id='$group_stale_delegation_id')) from vortex_access.organization_access_versions version join vortex_access.organization_groups organization_group on organization_group.organization_id=version.organization_id and organization_group.group_id='$group_two_id' where version.organization_id='$organization_id';")"
[ "$r4b_state" = "$((before_r4b+1))|retired|0" ] || { printf 'retirement-first Group race left unexpected state: %q\n' "$r4b_state" >&2; exit 1; }

# R5: replacement waits on governance while its fixed window expires.
before_r5="$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id='$organization_id';")"
PGAPPNAME="vortex-delegation-r5-holder-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r5-holder.log" 2>&1 <<SQL &
begin; set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r5-holder.pid'
select 1 from vortex_access.organization_access_versions where organization_id='$organization_id' for update;
\! touch '$proof_root/r5-holder-ready'
\! deadline=600; while [ ! -f '$proof_root/r5-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/r5-release' ]
commit;
SQL
r5_holder=$!; worker_pids+=("$r5_holder"); wait_for_file "$proof_root/r5-holder-ready"
r5_holder_db="$(read_backend_pid "$proof_root/r5-holder.pid")"
expiry_target="$(run_sql "select pg_catalog.clock_timestamp()+interval '15 seconds';")"
run_sql "with observed as (select pg_catalog.clock_timestamp() as value)
insert into vortex_access.organization_delegation_authorities(
  organization_id,delegation_authority_id,holder_kind,organization_account_id,
  group_id,scope_kind,bounded_permissions,scope_fingerprint,revision,starts_at,
  expires_at,state,granted_by,granted_at,grant_correlation_id,changed_by,
  changed_at,change_correlation_id)
select '$organization_id','$expiry_delegation_id','organization_account',
  '$account_id',null,'organization_catalogue',null,null,1,observed.value,
  '$expiry_target'::timestamptz,'live','$actor_id',observed.value,
  '$correlation_seed','$actor_id',observed.value,'$correlation_seed'
from observed;" >/dev/null
PGAPPNAME="vortex-delegation-r5-replace-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r5-replace.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin; set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r5-replace.pid'
select * from vortex_access.coordinate_organization_delegation_authority_change(
  'replace_delegation_scope','$organization_id','$expiry_delegation_id',1,
  null,null,null,'bounded',$platform_scope,'sha256:'||pg_catalog.repeat('4',64),
  null,null,'$actor_id','$correlation_r5_replace');
commit;
SQL
r5_replace=$!; worker_pids+=("$r5_replace")
r5_replace_db="$(read_backend_pid "$proof_root/r5-replace.pid")"
wait_for_database_blocker "$r5_replace_db" "$r5_holder_db"
[ "$(run_sql "select case when pg_catalog.clock_timestamp()<'$expiry_target'::timestamptz then 'pending' else '' end;")" = 'pending' ] || { echo 'delegation expired before its governance wait was observed' >&2; exit 1; }
wait_for_database_time "$expiry_target"
touch "$proof_root/r5-release"
wait_owned_worker "$r5_holder"
if wait_owned_worker "$r5_replace"; then echo 'post-lock expired replacement unexpectedly committed' >&2; exit 1; fi
grep -q '40001' "$proof_root/r5-replace.log" || { echo 'post-lock expired replacement lacked 40001' >&2; exit 1; }
r5_state="$(run_sql "select pg_catalog.concat_ws('|',version.current_version,delegation.revision,delegation.state,(delegation.expires_at<=pg_catalog.clock_timestamp())) from vortex_access.organization_access_versions version join vortex_access.organization_delegation_authorities delegation on delegation.organization_id=version.organization_id and delegation.delegation_authority_id='$expiry_delegation_id' where version.organization_id='$organization_id';")"
[ "$r5_state" = "$before_r5|1|live|t" ] || { printf 'expiry-during-governance race left unexpected state: %q\n' "$r5_state" >&2; exit 1; }

echo 'organization delegation authority change concurrency proof passed'
