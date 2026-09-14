#!/usr/bin/env bash
# #478: the protected ownership-transfer writer and the existing protected
# Group-retirement writer serialize on the real ownership target.  The proof
# covers both commit orders with two database sessions and observes the exact
# blocker through pg_blocking_pids; it does not introduce a proxy lock/table.

set -euo pipefail

run_uuid="${VORTEX_OWNERSHIP_TARGET_RETIREMENT_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then
  [ -r /proc/sys/kernel/random/uuid ] || {
    echo 'a Linux random UUID source is required for the ownership-target retirement proof' >&2
    exit 1
  }
  IFS= read -r run_uuid </proc/sys/kernel/random/uuid
fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  echo 'VORTEX_OWNERSHIP_TARGET_RETIREMENT_PROOF_RUN_ID must be a lowercase UUID v4' >&2
  exit 1
}

readonly run_uuid
readonly run_token="${run_uuid//-/}"
readonly fixture_short_name="owner_retire_${run_token:0:18}"
proof_root="$(mktemp -d /tmp/vortex-owner-target-retirement.XXXXXX)"
readonly proof_root
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"

readonly tenant_id="11${run_uuid:2}"
readonly organization_id="21${run_uuid:2}"
readonly identity_id="41${run_uuid:2}"
readonly account_id="51${run_uuid:2}"
readonly steward_role_id="61${run_uuid:2}"
readonly installer_role_id="62${run_uuid:2}"
readonly steward_assignment_id="71${run_uuid:2}"
readonly installer_assignment_id="72${run_uuid:2}"
readonly steward_delegation_id="81${run_uuid:2}"
readonly actor_id="91${run_uuid:2}"
readonly application_root_id="a1${run_uuid:2}"
readonly module_root_id="a2${run_uuid:2}"
readonly record_type_id="a3${run_uuid:2}"
readonly storage_contract_id="a4${run_uuid:2}"
readonly title_field_id="a5${run_uuid:2}"
readonly transfer_permission_id="a6${run_uuid:2}"
readonly transfer_role_id="a7${run_uuid:2}"
readonly transfer_assignment_id="a8${run_uuid:2}"
readonly source_group_id="b1${run_uuid:2}"
readonly transfer_first_target_id="b2${run_uuid:2}"
readonly retirement_first_target_id="b3${run_uuid:2}"
readonly transfer_first_record_id="c1${run_uuid:2}"
readonly retirement_first_record_id="c2${run_uuid:2}"
readonly transfer_first_command_id="d1${run_uuid:2}"
readonly retirement_first_command_id="d2${run_uuid:2}"
readonly transfer_first_activity_id="d3${run_uuid:2}"
readonly retirement_first_activity_id="d4${run_uuid:2}"
readonly transfer_first_occurrence_id="d5${run_uuid:2}"
readonly retirement_first_occurrence_id="d6${run_uuid:2}"
readonly transfer_first_retire_activity_id="d7${run_uuid:2}"
readonly retirement_first_retire_activity_id="d8${run_uuid:2}"
readonly identity_authority_id="e1${run_uuid:2}"
readonly physical_table="rt_${storage_contract_id//-/}"
readonly title_column="f_${title_field_id//-/}"

fixture_claimed=0
declare -a worker_pids=()
declare -A reaped_worker_pids=()

psql_command=(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1)
if [ -n "$database_url" ]; then psql_command+=("$database_url"); fi

run_sql() { "${psql_command[@]}" --command "$1"; }

wait_for_file() {
  local candidate="$1"
  local deadline=$((SECONDS + 20))
  while ((SECONDS < deadline)); do
    [ -f "$candidate" ] && return 0
    sleep 0.05
  done
  printf 'ownership-target retirement proof barrier timed out: %s\n' "$candidate" >&2
  return 1
}

read_backend_pid() {
  local candidate="$1"
  local backend_pid
  wait_for_file "$candidate"
  backend_pid="$(tr -d '[:space:]' <"$candidate")"
  [[ "$backend_pid" =~ ^[1-9][0-9]*$ ]] || {
    printf 'ownership-target retirement proof captured an invalid backend: %q\n' "$backend_pid" >&2
    return 1
  }
  printf '%s\n' "$backend_pid"
}

wait_for_database_blocker() {
  local blocked_pid="$1"
  local blocking_pid="$2"
  local label="$3"
  local deadline=$((SECONDS + 20))
  local state
  while ((SECONDS < deadline)); do
    state="$(run_sql "select case when $blocking_pid = any(pg_catalog.pg_blocking_pids($blocked_pid)) then 'blocked' else '' end;")"
    [ "$state" = 'blocked' ] && return 0
    sleep 0.1
  done
  printf 'ownership-target retirement proof did not observe %s\n' "$label" >&2
  run_sql "select pg_catalog.concat_ws('|',pid::text,wait_event_type,wait_event,
      pg_catalog.array_to_string(pg_catalog.pg_blocking_pids(pid),','))
    from pg_catalog.pg_stat_activity where pid in ($blocked_pid,$blocking_pid)
    order by pid;" >&2 || true
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
  for pid in "${worker_pids[@]:-}"; do
    [ -n "$pid" ] || continue
    if [ "${reaped_worker_pids[$pid]:-0}" != 1 ] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
  for pid in "${worker_pids[@]:-}"; do
    [ -n "$pid" ] || continue
    if [ "${reaped_worker_pids[$pid]:-0}" != 1 ]; then
      wait "$pid" >/dev/null 2>&1 || true
      reaped_worker_pids["$pid"]=1
    fi
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
        where tenant_id='$tenant_id' and short_name='$fixture_short_name'
          and created_by='$actor_id'
      ) or not exists (
        select 1 from vortex_identity.organizations
        where organization_id='$organization_id' and tenant_id='$tenant_id'
          and short_name='$fixture_short_name' and created_by='$actor_id'
      ) then
        raise exception 'ownership-target retirement proof fixture ownership mismatch';
      end if;
    end
    \$proof\$;
    set local role vortex_record_owner;
    drop table if exists record_data.$physical_table;
    delete from vortex_record.record_data_versions where organization_id='$organization_id';
    delete from vortex_record.field_storage_mappings where storage_contract_id='$storage_contract_id';
    delete from vortex_record.storage_catalogue where storage_contract_id='$storage_contract_id';
    delete from vortex_record.release_provisions where module_root_id='$module_root_id';
    reset role;
    set local role vortex_record_adapter;
    delete from vortex_record.save_command_receipts where organization_id='$organization_id';
    reset role;
    delete from pgmq.q_vortex_event_occurrences
      where message ->> 'occurrenceId' in ('$transfer_first_occurrence_id','$retirement_first_occurrence_id');
    delete from vortex_event.event_outbox where organization_id='$organization_id';
    set local role vortex_module_owner;
    delete from vortex_module.installation_bindings where organization_id='$organization_id';
    reset role;
    do \$proof\$
    declare target record;
    begin
      for target in
        select column_row.table_schema,column_row.table_name
        from information_schema.columns as column_row
        join information_schema.tables as table_row
          on table_row.table_schema=column_row.table_schema
          and table_row.table_name=column_row.table_name
          and table_row.table_type='BASE TABLE'
        where column_row.table_schema in ('vortex_access','vortex_activity','vortex_identity')
          and column_row.column_name='organization_id'
          and column_row.table_name <> 'organizations'
      loop
        execute pg_catalog.format('delete from %I.%I where organization_id = %L',
          target.table_schema,target.table_name,'$organization_id');
      end loop;
    end
    \$proof\$;
    delete from vortex_definition.release_dependencies
      where root_id in ('$application_root_id','$module_root_id');
    delete from vortex_definition.releases
      where root_id in ('$application_root_id','$module_root_id');
    delete from vortex_definition.drafts
      where root_id in ('$application_root_id','$module_root_id');
    delete from vortex_definition.roots
      where root_id in ('$application_root_id','$module_root_id');
    delete from vortex_identity.organization_accounts where organization_id='$organization_id';
    delete from vortex_identity.identity_projections where identity_id='$identity_id';
    delete from vortex_identity.organizations where organization_id='$organization_id';
    delete from vortex_identity.tenants where tenant_id='$tenant_id';
    commit;
  " >/dev/null
}

finalize() {
  local original_status=$?
  local cleanup_status=0
  local operation_status
  trap - EXIT INT TERM
  set +e
  touch "$proof_root/transfer-first-release" "$proof_root/retirement-first-release" >/dev/null 2>&1 || true
  stop_owned_workers
  if [ "$original_status" -ne 0 ]; then
    echo 'ownership-target retirement proof failed; bounded diagnostics follow' >&2
    for log_path in "$proof_root"/*.log; do
      [ -f "$log_path" ] || continue
      printf '%s\n' "--- ${log_path##*/} (last 80 lines) ---" >&2
      tail -n 80 -- "$log_path" >&2
    done
  fi
  cleanup_fixture
  operation_status=$?
  if [ "$operation_status" -ne 0 ]; then cleanup_status="$operation_status"; fi
  case "$proof_root" in
    /tmp/vortex-owner-target-retirement.*) rm -rf -- "$proof_root"; operation_status=$? ;;
    *) echo 'refusing to remove an unexpected ownership-target retirement proof directory' >&2; operation_status=1 ;;
  esac
  if [ "$operation_status" -ne 0 ] && [ "$cleanup_status" -eq 0 ]; then cleanup_status="$operation_status"; fi
  if [ "$original_status" -ne 0 ]; then exit "$original_status"; fi
  exit "$cleanup_status"
}
trap finalize EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

sha() {
  printf "'sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(%s,'UTF8')),'hex')" "$1"
}

current_version() {
  run_sql "select current_version from vortex_access.organization_access_versions where organization_id='$organization_id';"
}

readonly permissions_sql="pg_catalog.jsonb_build_array(
  pg_catalog.jsonb_build_object(
    'permissionId','$transfer_permission_id','key','ownership_target.transfer',
    'label','Transfer ownership','description','Transfer one compatible record to an active ownership target.',
    'recordTypeId','$record_type_id','recordScope','{\"routes\":[{\"kind\":\"all_records\"}]}'::jsonb,
    'fieldPolicy',pg_catalog.jsonb_build_object(
      'readableFieldIds',pg_catalog.jsonb_build_array('$title_field_id'),
      'changeableFieldIds','[]'::jsonb),
    'actionKind','transfer','administrative',false
  ))"

readonly module_content="pg_catalog.jsonb_build_object(
  'name','Ownership target concurrency','description','Neutral team-owned record fixture.',
  'dependencies','[]'::jsonb,
  'recordTypes',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'recordTypeId','$record_type_id','key','owned_record','singularLabel','Owned record',
    'pluralLabel','Owned records','titleFieldId','$title_field_id',
    'storageContractId','$storage_contract_id','storageScope','organization_shared',
    'ownershipMode','team','fields',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'fieldId','$title_field_id','key','title','type','text','required',false,
      'unique',false,'filterable',false,'sortable',false,
      'settings',pg_catalog.jsonb_build_object('maxLength',200))),
    'relationships','[]'::jsonb,
    'standardActions',pg_catalog.jsonb_build_array('create','read','update','delete'),
    'customActionIds','[]'::jsonb)),
  'permissions',$permissions_sql,
  'actions','[]'::jsonb,'events','[]'::jsonb,'rules','[]'::jsonb,
  'sharingConditions','[]'::jsonb,'extensionPoints','[]'::jsonb)"

schema_state="$(run_sql "
  select pg_catalog.concat_ws('|',
    pg_catalog.to_regprocedure('vortex_record.transfer_record_ownership(uuid,uuid,uuid,bigint,text,uuid,uuid,uuid)') is not null,
    pg_catalog.to_regprocedure('vortex_access.retire_organization_group_for_administration(uuid,bigint,uuid)') is not null,
    pg_catalog.has_function_privilege('vortex_runtime','vortex_record.transfer_record_ownership(uuid,uuid,uuid,bigint,text,uuid,uuid,uuid)','EXECUTE'),
    pg_catalog.has_function_privilege('vortex_request','vortex_access.retire_organization_group_for_administration(uuid,bigint,uuid)','EXECUTE'));
")"
[ "$schema_state" = 't|t|t|t' ] || {
  echo 'the ownership-transfer and Group-retirement migrations must already be applied' >&2
  exit 1
}

# One isolated, neutral fixture. Definitions and Access registrations use their
# owning writers; only the not-yet-public record-create path is seeded directly.
run_sql "
  begin;
  do \$proof\$
  begin
    if exists (select 1 from vortex_identity.tenants where tenant_id='$tenant_id')
      or exists (select 1 from vortex_record.storage_catalogue where storage_contract_id='$storage_contract_id')
      or pg_catalog.to_regclass('record_data.$physical_table') is not null then
      raise exception 'ownership-target retirement proof fixture scope already exists';
    end if;
  end
  \$proof\$;

  insert into vortex_identity.tenants (
    tenant_id,short_name,display_name,state,created_at,created_by,state_changed_at,revision
  ) values (
    '$tenant_id','$fixture_short_name','Ownership target retirement proof','active',
    pg_catalog.clock_timestamp(),'$actor_id',pg_catalog.clock_timestamp(),1
  );
  insert into vortex_identity.organizations (
    organization_id,tenant_id,short_name,display_name,state,created_at,created_by,state_changed_at,revision
  ) values (
    '$organization_id','$tenant_id','$fixture_short_name','Ownership target retirement proof','active',
    pg_catalog.clock_timestamp(),'$actor_id',pg_catalog.clock_timestamp(),1
  );
  select * from vortex_identity.ensure_identity_projection('$identity_id','e2${run_uuid:2}');
  insert into vortex_identity.organization_accounts (
    organization_account_id,organization_id,identity_id,display_name,state,activated_at,
    changed_at,state_changed_at,state_changed_by,state_change_correlation_id,revision
  ) values (
    '$account_id','$organization_id','$identity_id','Ownership transfer administrator','active',
    pg_catalog.clock_timestamp()-interval '1 minute',pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(),'$actor_id','e3${run_uuid:2}',1
  );

  select * from vortex_access.initialize_organization_access_version(
    '$organization_id','$actor_id','e4${run_uuid:2}');
  select * from vortex_access.initialize_platform_permission_catalogue(
    '$organization_id','$actor_id','e5${run_uuid:2}');
  select * from vortex_access.revise_platform_permission_catalogue_metadata(
    '$organization_id',1,'1.0.0','1.0.1','$actor_id','e6${run_uuid:2}');
  select * from vortex_access.coordinate_organization_stewardship_adoption(
    '$organization_id','$account_id','$steward_role_id',
    'owner_retire_steward_${run_token:0:12}','Ownership retirement steward',
    'Neutral authority for the ownership-target retirement proof.',
    '$steward_assignment_id','$steward_delegation_id','$identity_id','e7${run_uuid:2}');
  select * from vortex_access.adopt_shipped_platform_permission_catalogue(
    '$organization_id',2,'1.1.0',
    'sha256:cb42d4b24ebead7fe9e4ba6358115ceb3ae752d3a0b4cbedc458dcb218013778',
    '$actor_id','e8${run_uuid:2}');
  select * from vortex_access.coordinate_organization_group_change(
    'create_group','$organization_id','$source_group_id',null,
    'owner_source_${run_token:0:16}','Source owners','$actor_id','e9${run_uuid:2}');
  select * from vortex_access.coordinate_organization_group_change(
    'create_group','$organization_id','$transfer_first_target_id',null,
    'transfer_first_${run_token:0:16}','Transfer-first target','$actor_id','ea${run_uuid:2}');
  select * from vortex_access.coordinate_organization_group_change(
    'create_group','$organization_id','$retirement_first_target_id',null,
    'retire_first_${run_token:0:16}','Retirement-first target','$actor_id','eb${run_uuid:2}');

  insert into vortex_access.organization_roles (
    organization_id,role_id,role_kind,role_key,live_revision,created_by,created_at
  ) values (
    '$organization_id','$installer_role_id','custom','application_installer',1,
    '$actor_id',pg_catalog.statement_timestamp()
  );
  insert into vortex_access.organization_role_permission_entries (
    organization_id,role_id,role_revision,entry_ordinal,role_kind,role_application_root_id,
    application_root_id,owner_kind,owner_id,permission_id,registration_kind,
    registration_owner_id,accepted_registration_revision,catalogue_fingerprint,
    continuity_revision,meaning_fingerprint
  )
  select entry.organization_id,'$installer_role_id'::uuid,1,1,'custom',null,
    entry.application_root_id,entry.owner_kind,entry.owner_id,entry.permission_id,
    entry.registration_kind,entry.registration_owner_id,entry.registration_revision,
    registration.permission_catalogue_fingerprint,continuity.continuity_revision,
    entry.meaning_fingerprint
  from vortex_access.permission_catalogue_entries as entry
  join vortex_access.permission_registration_revisions as registration
    on registration.organization_id=entry.organization_id
    and registration.registration_kind=entry.registration_kind
    and registration.registration_owner_id=entry.registration_owner_id
    and registration.revision=entry.registration_revision
  join vortex_access.permission_continuities as continuity
    on continuity.organization_id=entry.organization_id
    and continuity.application_root_id is not distinct from entry.application_root_id
    and continuity.owner_kind=entry.owner_kind and continuity.owner_id=entry.owner_id
    and continuity.permission_id=entry.permission_id
  where entry.organization_id='$organization_id'
    and entry.registration_kind='platform' and entry.registration_revision=3
    and entry.permission_id='7ecd3304-f16c-47d4-94db-0964980091ba';
  insert into vortex_access.organization_role_revisions (
    organization_id,role_id,revision,role_kind,lifecycle,privilege_classification,
    assignment_policy,policy_continuity_revision,authority_continuity_revision,
    role_key,label,description,changed_by,changed_at,change_correlation_id
  ) values (
    '$organization_id','$installer_role_id',1,'custom','active','privileged','standing',
    1,1,'application_installer','Application installer',
    'Current storage lifecycle authority.','$actor_id',pg_catalog.statement_timestamp(),
    'ec${run_uuid:2}'
  );
  insert into vortex_access.organization_role_assignments (
    organization_id,role_assignment_id,role_id,assignee_kind,organization_account_id,
    assignment_kind,revision,starts_at,state,granted_by,granted_at,grant_correlation_id,
    changed_by,changed_at,change_correlation_id
  ) values (
    '$organization_id','$installer_assignment_id','$installer_role_id','organization_account',
    '$account_id','standing',1,pg_catalog.statement_timestamp()-interval '1 minute','live',
    '$actor_id',pg_catalog.statement_timestamp(),'ed${run_uuid:2}','$actor_id',
    pg_catalog.statement_timestamp(),'ed${run_uuid:2}'
  );

  insert into vortex_definition.roots (root_id,organization_id,kind,key,created_at,created_by)
  values
    ('$module_root_id','$organization_id','module','vortex.ownership_target.module',
      pg_catalog.clock_timestamp()-interval '1 minute','$actor_id'),
    ('$application_root_id','$organization_id','application','vortex.ownership_target.application',
      pg_catalog.clock_timestamp()-interval '1 minute','$actor_id');
  insert into vortex_definition.drafts (
    root_id,draft_revision,draft_source,source_contract_version,source_fingerprint,updated_at,updated_by
  ) values
    ('$module_root_id',1,pg_catalog.jsonb_build_object(
      'source_contract_version','2.0.0','kind','module','key','vortex.ownership_target.module'),
      '2.0.0',$(sha "'module:source:' || '$run_uuid'"),pg_catalog.statement_timestamp(),'$actor_id'),
    ('$application_root_id',1,pg_catalog.jsonb_build_object(
      'source_contract_version','1.0.0','kind','application','key','vortex.ownership_target.application'),
      '1.0.0',$(sha "'application:source:' || '$run_uuid'"),pg_catalog.statement_timestamp(),'$actor_id');
  set constraints all immediate;
  commit;
" >/dev/null
fixture_claimed=1

# Register the Module's one transfer permission, assign it to the actor, and
# provision the exact released Module through the production coordinators.
prepare_runtime_fixture() {
run_sql "
  begin;
  with module_release as (
    select pg_catalog.jsonb_build_object(
      'kind','module','definitionKey','vortex.ownership_target.module',
      'rootId','$module_root_id','releaseRevision',1,'releaseVersion','2.0.0',
      'validationContractVersion','2.0.0',
      'contentFingerprint',$(sha "'module:content:' || '$run_uuid'"),
      'resolutionFingerprint',$(sha "'module:resolution:' || '$run_uuid'")) as value
  ), application_release as (
    select pg_catalog.jsonb_build_object(
      'kind','application','definitionKey','vortex.ownership_target.application',
      'rootId','$application_root_id','releaseRevision',1,'releaseVersion','1.0.0',
      'validationContractVersion','1.0.0',
      'contentFingerprint',$(sha "'application:content:' || '$run_uuid'"),
      'resolutionFingerprint',$(sha "'application:resolution:' || '$run_uuid'")) as value
  ), entries as (
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'applicationRootId','$application_root_id','ownerKind','module','ownerId','$module_root_id',
      'permission',permission.value,'sourceRelease',module_release.value,
      'meaningFingerprint',$(sha "'meaning:' || (permission.value ->> 'permissionId')"))
      order by (permission.value ->> 'key') collate \"C\") as value
    from module_release,pg_catalog.jsonb_array_elements($permissions_sql) as permission(value)
  ), candidate as (
    select pg_catalog.jsonb_build_object(
      'contractVersion','1.0.0','organizationId','$organization_id',
      'applicationRootId','$application_root_id','applicationRelease',application_release.value,
      'applicationCatalogueFingerprint',$(sha "'catalogue:' || '$run_uuid'"),
      'applicationPermissionIds','[]'::jsonb,'entries',entries.value,
      'candidateFingerprint',$(sha "'candidate:' || '$run_uuid'")) as value,
      entries.value as entry_values
    from application_release,entries
  )
  select 1 from candidate,vortex_access.coordinate_application_access_change(
    'register',null,
    pg_catalog.jsonb_build_object(
      'contractVersion','1.0.0',
      'preparationBasis','{\"kind\":\"registration_candidate\"}'::jsonb,
      'permissionRegistration',candidate.value,
      'templates',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'template',pg_catalog.jsonb_build_object(
          'roleId','f1${run_uuid:2}','key','ownership_transfer_template',
          'name','Ownership transfer template','homePageId','f2${run_uuid:2}',
          'permissionKeys','[\"ownership_target.transfer\"]'::jsonb,
          'permissionSelection','{\"kind\":\"exact\"}'::jsonb),
        'sourceTemplateFingerprint',$(sha "'template:' || '$run_uuid'"),
        'sourcePermissions',candidate.entry_values,'livePermissions',candidate.entry_values)),
      'candidateFingerprint',$(sha "'preparation:' || '$run_uuid'")),
    '$organization_id','$application_root_id','$actor_id','f3${run_uuid:2}');

  select 1 from vortex_access.coordinate_organization_role_change(
    pg_catalog.jsonb_build_object(
      'contractVersion','1.0.0',
      'candidate',pg_catalog.jsonb_build_object(
        'operation','create_custom','organizationId','$organization_id',
        'roleId','$transfer_role_id','key','ownership_transfer_role',
        'label','Ownership transfer role',
        'description','Transfer a record to an active compatible target.',
        'privilegeClassification','standard',
        'assignmentPolicy','{\"kind\":\"standing\"}'::jsonb,
        'permissions',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'kind','exact','applicationRootId',entry.application_root_id,
          'ownerKind',entry.owner_kind,'ownerId',entry.owner_id,
          'permissionId',entry.permission_id,
          'acceptedRegistrationRevision',registration.revision,
          'catalogueFingerprint',registration.permission_catalogue_fingerprint,
          'continuityRevision',continuity.continuity_revision,
          'meaningFingerprint',entry.meaning_fingerprint)
          order by entry.application_root_id,entry.owner_kind collate \"C\",
            entry.owner_id,entry.permission_id)
        from vortex_access.permission_registrations as registration
        join vortex_access.permission_catalogue_entries as entry
          on entry.organization_id=registration.organization_id
          and entry.registration_kind=registration.registration_kind
          and entry.registration_owner_id=registration.registration_owner_id
          and entry.registration_revision=registration.revision
        join vortex_access.permission_continuities as continuity
          on continuity.organization_id=entry.organization_id
          and continuity.application_root_id is not distinct from entry.application_root_id
          and continuity.owner_kind=entry.owner_kind and continuity.owner_id=entry.owner_id
          and continuity.permission_id=entry.permission_id
        where registration.organization_id='$organization_id'
          and registration.registration_owner_id='$application_root_id')),
      'roleCandidateFingerprint',$(sha "'role:' || '$run_uuid'")),
    '$actor_id','f4${run_uuid:2}');
  select 1 from vortex_access.coordinate_organization_role_assignment_change(
    'grant','$organization_id','$transfer_assignment_id',null,'$transfer_role_id',1,
    'organization_account','$account_id',null,'standing',
    pg_catalog.clock_timestamp()-interval '1 minute',null,'$actor_id','f5${run_uuid:2}');
  commit;
" >/dev/null

run_sql "
  begin;
  delete from vortex_context.request_contexts where backend_pid=pg_catalog.pg_backend_pid();
  select vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind','human','identityAuthorityId','$identity_authority_id',
    'tenantId','$tenant_id','organizationId','$organization_id',
    'organizationAccountId','$account_id','identityId','$identity_id',
    'applicationRootId','$application_root_id','sessionId','f6${run_uuid:2}',
    'authenticationStrength','multi_factor',
    'issuedAt',pg_catalog.statement_timestamp(),
    'expiresAt',pg_catalog.statement_timestamp()+interval '1 hour',
    'accessVersion',(select current_version from vortex_access.organization_access_versions
      where organization_id='$organization_id'),
    'correlationId','f7${run_uuid:2}',
    'accessTokenIssuedAt',pg_catalog.statement_timestamp(),
    'primaryAuthenticatedAt',pg_catalog.statement_timestamp()));
  set local role vortex_request;
  select 1 from vortex_module.provision_module_installation_storage(
    '$application_root_id',1,'$module_root_id',1,null);
  reset role;
  delete from vortex_context.request_contexts where backend_pid=pg_catalog.pg_backend_pid();
  set local role vortex_module_owner;
  update vortex_module.installation_bindings set state='active'
  where organization_id='$organization_id' and application_root_id='$application_root_id'
    and module_root_id='$module_root_id';
  reset role;
  commit;
" >/dev/null

run_sql "
  begin;
  delete from vortex_context.request_contexts where backend_pid=pg_catalog.pg_backend_pid();
  select vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind','human','identityAuthorityId','$identity_authority_id',
    'tenantId','$tenant_id','organizationId','$organization_id',
    'organizationAccountId','$account_id','identityId','$identity_id',
    'applicationRootId','$application_root_id','sessionId','f8${run_uuid:2}',
    'authenticationStrength','multi_factor',
    'issuedAt',pg_catalog.statement_timestamp(),
    'expiresAt',pg_catalog.statement_timestamp()+interval '1 hour',
    'accessVersion',(select current_version from vortex_access.organization_access_versions
      where organization_id='$organization_id'),
    'correlationId','f9${run_uuid:2}',
    'accessTokenIssuedAt',pg_catalog.statement_timestamp(),
    'primaryAuthenticatedAt',pg_catalog.statement_timestamp()));
  set local role vortex_record_adapter;
  insert into record_data.$physical_table (
    organisation_id,module_root_id,record_type_id,storage_contract_id,record_id,
    application_root_id,definition_revision,owner_group_id,lifecycle_state,
    concurrency_number,created_at,created_by,updated_at,updated_by,deleted_at,deleted_by,
    $title_column
  ) values
    ('$organization_id','$module_root_id','$record_type_id','$storage_contract_id',
      '$transfer_first_record_id',null,1,'$source_group_id','active',1,
      pg_catalog.statement_timestamp(),'$account_id',pg_catalog.statement_timestamp(),
      '$account_id',null,null,'Transfer first'),
    ('$organization_id','$module_root_id','$record_type_id','$storage_contract_id',
      '$retirement_first_record_id',null,1,'$source_group_id','active',1,
      pg_catalog.statement_timestamp(),'$account_id',pg_catalog.statement_timestamp(),
      '$account_id',null,null,'Retirement first');
  reset role;
  delete from vortex_context.request_contexts where backend_pid=pg_catalog.pg_backend_pid();
  commit;
" >/dev/null

initial_access_version="$(current_version)"
[[ "$initial_access_version" =~ ^[1-9][0-9]*$ ]] || {
  printf 'ownership-target retirement proof captured invalid Access version: %q\n' "$initial_access_version" >&2
  exit 1
}
}

# Append the exact immutable Module and Application releases used by this run.
run_sql "
  begin;
  delete from vortex_context.request_contexts where backend_pid=pg_catalog.pg_backend_pid();
  select vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind','system','tenantId','$tenant_id','organizationId','$organization_id',
    'sessionId','ee${run_uuid:2}','issuedAt',pg_catalog.clock_timestamp()-interval '1 minute',
    'expiresAt',pg_catalog.clock_timestamp()+interval '5 minutes',
    'accessVersion',(select current_version from vortex_access.organization_access_versions
      where organization_id='$organization_id'),
    'correlationId','ef${run_uuid:2}','systemActorId','$actor_id',
    'authenticationStrength','service'));
  select * from vortex_definition.append_release(
    '$module_root_id',1,$(sha "'module:source:' || '$run_uuid'"),
    pg_catalog.jsonb_build_object(
      'releaseVersion','2.0.0',
      'compilationOutput',pg_catalog.jsonb_build_object(
        'kind','module','validationContractVersion','2.0.0',
        'resolutionFingerprint',$(sha "'module:resolution:' || '$run_uuid'"),
        'artifact',pg_catalog.jsonb_build_object(
          'kind','module','rootId','$module_root_id',
          'definitionKey','vortex.ownership_target.module','exactVersion','2.0.0',
          'contentFingerprint',$(sha "'module:content:' || '$run_uuid'"),
          'resolutionFingerprint',$(sha "'module:resolution:' || '$run_uuid'")),
        'canonical',pg_catalog.jsonb_build_object(
          'envelope',pg_catalog.jsonb_build_object(
            'kind','module','key','vortex.ownership_target.module',
            'rootId','$module_root_id','organizationId','$organization_id'),
          'content',$module_content)),
      'resolutionSnapshot',pg_catalog.jsonb_build_object(
        'fingerprint',$(sha "'module:resolution:' || '$run_uuid'"),
        'definitions',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'kind','module','key','vortex.ownership_target.module',
          'rootId','$module_root_id','exactVersion','2.0.0'))),
      'contentFingerprint',$(sha "'module:content:' || '$run_uuid'"),
      'resolutionFingerprint',$(sha "'module:resolution:' || '$run_uuid'"),
      'validationContractVersion','2.0.0',
      'comparisonFingerprint',$(sha "'module:content:' || '$run_uuid'"),
      'impactReasons','[]'::jsonb,'releaseNote','Ownership-target retirement proof Module.',
      'dependencies','[]'::jsonb));
  select * from vortex_definition.append_release(
    '$application_root_id',1,$(sha "'application:source:' || '$run_uuid'"),
    pg_catalog.jsonb_build_object(
      'releaseVersion','1.0.0',
      'compilationOutput',pg_catalog.jsonb_build_object(
        'kind','application','validationContractVersion','1.0.0',
        'resolutionFingerprint',$(sha "'application:resolution:' || '$run_uuid'"),
        'artifact',pg_catalog.jsonb_build_object(
          'kind','application','rootId','$application_root_id',
          'definitionKey','vortex.ownership_target.application','exactVersion','1.0.0',
          'contentFingerprint',$(sha "'application:content:' || '$run_uuid'"),
          'resolutionFingerprint',$(sha "'application:resolution:' || '$run_uuid'")),
        'canonical',pg_catalog.jsonb_build_object(
          'envelope',pg_catalog.jsonb_build_object(
            'kind','application','key','vortex.ownership_target.application',
            'rootId','$application_root_id','organizationId','$organization_id'),
          'content',pg_catalog.jsonb_build_object('permissions','[]'::jsonb))),
      'resolutionSnapshot',pg_catalog.jsonb_build_object(
        'fingerprint',$(sha "'application:resolution:' || '$run_uuid'"),
        'definitions',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'kind','application','key','vortex.ownership_target.application',
          'rootId','$application_root_id','exactVersion','1.0.0'))),
      'contentFingerprint',$(sha "'application:content:' || '$run_uuid'"),
      'resolutionFingerprint',$(sha "'application:resolution:' || '$run_uuid'"),
      'validationContractVersion','1.0.0',
      'comparisonFingerprint',$(sha "'application:content:' || '$run_uuid'"),
      'impactReasons','[]'::jsonb,
      'releaseNote','Ownership-target retirement proof Application.',
      'dependencies',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'kind','module','key','vortex.ownership_target.module','rootId','$module_root_id',
        'releaseRevision',1,'releaseVersion','2.0.0',
        'contentFingerprint',$(sha "'module:content:' || '$run_uuid'"),
        'resolutionFingerprint',$(sha "'module:resolution:' || '$run_uuid'")))));
  delete from vortex_context.request_contexts where backend_pid=pg_catalog.pg_backend_pid();
  commit;
" >/dev/null

prepare_runtime_fixture

# ---------------------------------------------------------------------------
# Schedule 1: transfer commits first. Its real target lock makes the protected
# retirement wait; after the transfer commits, retirement remains valid.
# ---------------------------------------------------------------------------
PGAPPNAME="vortex-owner-transfer-first-${run_token:0:8}" "${psql_command[@]}" \
  >"$proof_root/transfer-first.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s';
set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/transfer-first.pid'
set local role vortex_runtime;
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind','human','identityAuthorityId','$identity_authority_id',
  'tenantId','$tenant_id','organizationId','$organization_id',
  'organizationAccountId','$account_id','identityId','$identity_id',
  'applicationRootId','$application_root_id','sessionId','f8${run_uuid:2}',
  'authenticationStrength','multi_factor',
  'issuedAt',pg_catalog.statement_timestamp(),
  'expiresAt',pg_catalog.statement_timestamp()+interval '1 hour',
  'accessVersion',$initial_access_version,'correlationId','f9${run_uuid:2}',
  'accessTokenIssuedAt',pg_catalog.statement_timestamp(),
  'primaryAuthenticatedAt',pg_catalog.statement_timestamp()));
select pg_catalog.concat_ws('|',result ->> 'outcome',result ->> 'recordId',
  result ->> 'concurrencyNumber')
from (select vortex_record.transfer_record_ownership(
  '$transfer_first_command_id','$record_type_id','$transfer_first_record_id',1,
  'group','$transfer_first_target_id','$transfer_first_activity_id',
  '$transfer_first_occurrence_id') as result) as transfer_result
\g '$proof_root/transfer-first.result'
\! touch '$proof_root/transfer-first-ready'
\! deadline=600; while [ ! -f '$proof_root/transfer-first-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/transfer-first-release' ]
commit;
SQL
transfer_first_worker=$!
worker_pids+=("$transfer_first_worker")
wait_for_file "$proof_root/transfer-first-ready"
transfer_first_backend="$(read_backend_pid "$proof_root/transfer-first.pid")"

PGAPPNAME="vortex-owner-retire-second-${run_token:0:8}" "${psql_command[@]}" \
  >"$proof_root/transfer-first-retirement.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s';
set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/transfer-first-retirement.pid'
set local role vortex_runtime;
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind','human','identityAuthorityId','$identity_authority_id',
  'tenantId','$tenant_id','organizationId','$organization_id',
  'organizationAccountId','$account_id','identityId','$identity_id',
  'sessionId','fa${run_uuid:2}','authenticationStrength','multi_factor',
  'issuedAt',pg_catalog.statement_timestamp(),
  'expiresAt',pg_catalog.statement_timestamp()+interval '1 hour',
  'accessVersion',$initial_access_version,'correlationId','fb${run_uuid:2}',
  'accessTokenIssuedAt',pg_catalog.statement_timestamp(),
  'primaryAuthenticatedAt',pg_catalog.statement_timestamp()));
set local role vortex_request;
select pg_catalog.concat_ws('|',retired.outcome,
  retired.group_summary ->> 'state',retired.access_version::text)
from vortex_access.retire_organization_group_for_administration(
  '$transfer_first_target_id',1,'$transfer_first_retire_activity_id') as retired
\g '$proof_root/transfer-first-retirement.result'
commit;
SQL
transfer_first_retirement_worker=$!
worker_pids+=("$transfer_first_retirement_worker")
transfer_first_retirement_backend="$(read_backend_pid "$proof_root/transfer-first-retirement.pid")"
wait_for_database_blocker "$transfer_first_retirement_backend" "$transfer_first_backend" \
  'retirement waiting on the transfer target lock'

touch "$proof_root/transfer-first-release"
wait_owned_worker "$transfer_first_worker"
wait_owned_worker "$transfer_first_retirement_worker"

transfer_first_result="$(tr -d '[:space:]' <"$proof_root/transfer-first.result")"
[ "$transfer_first_result" = "transferred|$transfer_first_record_id|2" ] || {
  printf 'transfer-first operation returned unexpected result: %q\n' "$transfer_first_result" >&2
  exit 1
}
transfer_first_retirement_result="$(tr -d '[:space:]' <"$proof_root/transfer-first-retirement.result")"
[ "$transfer_first_retirement_result" = "completed|retired|$((initial_access_version + 1))" ] || {
  printf 'transfer-first retirement returned unexpected result: %q\n' "$transfer_first_retirement_result" >&2
  exit 1
}

transfer_first_state="$(run_sql "
  select pg_catalog.concat_ws('|',
    version.current_version::text,organization_group.state,organization_group.revision::text,
    stored.lifecycle_state,stored.owner_group_id::text,stored.concurrency_number::text,
    coalesce((select state from vortex_record.save_command_receipts
      where organization_id='$organization_id' and command_id='$transfer_first_command_id'),'missing'),
    coalesce((select action || ':' || outcome from vortex_activity.organization_activity_entries
      where organization_id='$organization_id' and activity_id='$transfer_first_activity_id'),'missing'),
    coalesce((select action || ':' || outcome from vortex_activity.organization_activity_entries
      where organization_id='$organization_id' and activity_id='$transfer_first_retire_activity_id'),'missing'),
    coalesce((select envelope #>> '{descriptor,eventKind}' from vortex_event.event_outbox
      where organization_id='$organization_id' and occurrence_id='$transfer_first_occurrence_id'),'missing'),
    (select count(*) from pgmq.q_vortex_event_occurrences
      where message ->> 'occurrenceId'='$transfer_first_occurrence_id')::text)
  from vortex_access.organization_access_versions as version
  join vortex_access.organization_groups as organization_group
    on organization_group.organization_id=version.organization_id
    and organization_group.group_id='$transfer_first_target_id'
  join record_data.$physical_table as stored
    on stored.organisation_id=version.organization_id
    and stored.record_id='$transfer_first_record_id'
  where version.organization_id='$organization_id';
")"
expected_transfer_first_state="$((initial_access_version + 1))|retired|2|active|$transfer_first_target_id|2|completed|transfer_record_ownership:completed|retire_group:completed|reassigned|1"
[ "$transfer_first_state" = "$expected_transfer_first_state" ] || {
  printf 'transfer-first schedule left unexpected persisted state: %q\n' "$transfer_first_state" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Schedule 2: retirement commits first. The real transfer waits behind the
# target update, rereads the retired Group and refuses without partial effects.
# ---------------------------------------------------------------------------
retirement_first_version="$(current_version)"
[[ "$retirement_first_version" =~ ^[1-9][0-9]*$ ]] || {
  printf 'retirement-first schedule captured invalid Access version: %q\n' "$retirement_first_version" >&2
  exit 1
}

PGAPPNAME="vortex-owner-retire-first-${run_token:0:8}" "${psql_command[@]}" \
  >"$proof_root/retirement-first.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s';
set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/retirement-first.pid'
set local role vortex_runtime;
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind','human','identityAuthorityId','$identity_authority_id',
  'tenantId','$tenant_id','organizationId','$organization_id',
  'organizationAccountId','$account_id','identityId','$identity_id',
  'sessionId','fc${run_uuid:2}','authenticationStrength','multi_factor',
  'issuedAt',pg_catalog.statement_timestamp(),
  'expiresAt',pg_catalog.statement_timestamp()+interval '1 hour',
  'accessVersion',$retirement_first_version,'correlationId','fd${run_uuid:2}',
  'accessTokenIssuedAt',pg_catalog.statement_timestamp(),
  'primaryAuthenticatedAt',pg_catalog.statement_timestamp()));
set local role vortex_request;
select pg_catalog.concat_ws('|',retired.outcome,
  retired.group_summary ->> 'state',retired.access_version::text)
from vortex_access.retire_organization_group_for_administration(
  '$retirement_first_target_id',1,'$retirement_first_retire_activity_id') as retired
\g '$proof_root/retirement-first.result'
\! touch '$proof_root/retirement-first-ready'
\! deadline=600; while [ ! -f '$proof_root/retirement-first-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/retirement-first-release' ]
commit;
SQL
retirement_first_worker=$!
worker_pids+=("$retirement_first_worker")
wait_for_file "$proof_root/retirement-first-ready"
retirement_first_backend="$(read_backend_pid "$proof_root/retirement-first.pid")"

PGAPPNAME="vortex-owner-transfer-second-${run_token:0:8}" "${psql_command[@]}" \
  >"$proof_root/retirement-first-transfer.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s';
set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/retirement-first-transfer.pid'
set local role vortex_runtime;
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind','human','identityAuthorityId','$identity_authority_id',
  'tenantId','$tenant_id','organizationId','$organization_id',
  'organizationAccountId','$account_id','identityId','$identity_id',
  'applicationRootId','$application_root_id','sessionId','fe${run_uuid:2}',
  'authenticationStrength','multi_factor',
  'issuedAt',pg_catalog.statement_timestamp(),
  'expiresAt',pg_catalog.statement_timestamp()+interval '1 hour',
  'accessVersion',$retirement_first_version,'correlationId','ff${run_uuid:2}',
  'accessTokenIssuedAt',pg_catalog.statement_timestamp(),
  'primaryAuthenticatedAt',pg_catalog.statement_timestamp()));
select pg_catalog.concat_ws('|',result ->> 'outcome',result ->> 'reasonCode',
  coalesce(result ->> 'concurrencyNumber',''))
from (select vortex_record.transfer_record_ownership(
  '$retirement_first_command_id','$record_type_id','$retirement_first_record_id',1,
  'group','$retirement_first_target_id','$retirement_first_activity_id',
  '$retirement_first_occurrence_id') as result) as transfer_result
\g '$proof_root/retirement-first-transfer.result'
commit;
SQL
retirement_first_transfer_worker=$!
worker_pids+=("$retirement_first_transfer_worker")
retirement_first_transfer_backend="$(read_backend_pid "$proof_root/retirement-first-transfer.pid")"
wait_for_database_blocker "$retirement_first_transfer_backend" "$retirement_first_backend" \
  'transfer waiting on the retirement target lock'

touch "$proof_root/retirement-first-release"
wait_owned_worker "$retirement_first_worker"
wait_owned_worker "$retirement_first_transfer_worker"

retirement_first_result="$(tr -d '[:space:]' <"$proof_root/retirement-first.result")"
[ "$retirement_first_result" = "completed|retired|$((retirement_first_version + 1))" ] || {
  printf 'retirement-first operation returned unexpected result: %q\n' "$retirement_first_result" >&2
  exit 1
}
retirement_first_transfer_result="$(tr -d '[:space:]' <"$proof_root/retirement-first-transfer.result")"
[ "$retirement_first_transfer_result" = 'refused|owner_unavailable|' ] || {
  printf 'retirement-first transfer returned unexpected result: %q\n' "$retirement_first_transfer_result" >&2
  exit 1
}

retirement_first_state="$(run_sql "
  select pg_catalog.concat_ws('|',
    version.current_version::text,organization_group.state,organization_group.revision::text,
    stored.lifecycle_state,stored.owner_group_id::text,stored.concurrency_number::text,
    (select count(*) from vortex_record.save_command_receipts
      where organization_id='$organization_id' and command_id='$retirement_first_command_id')::text,
    (select count(*) from vortex_activity.organization_activity_entries
      where organization_id='$organization_id' and activity_id='$retirement_first_activity_id')::text,
    (select count(*) from vortex_event.event_outbox
      where organization_id='$organization_id' and occurrence_id='$retirement_first_occurrence_id')::text,
    (select count(*) from pgmq.q_vortex_event_occurrences
      where message ->> 'occurrenceId'='$retirement_first_occurrence_id')::text,
    coalesce((select action || ':' || outcome from vortex_activity.organization_activity_entries
      where organization_id='$organization_id' and activity_id='$retirement_first_retire_activity_id'),'missing'))
  from vortex_access.organization_access_versions as version
  join vortex_access.organization_groups as organization_group
    on organization_group.organization_id=version.organization_id
    and organization_group.group_id='$retirement_first_target_id'
  join record_data.$physical_table as stored
    on stored.organisation_id=version.organization_id
    and stored.record_id='$retirement_first_record_id'
  where version.organization_id='$organization_id';
")"
expected_retirement_first_state="$((retirement_first_version + 1))|retired|2|active|$source_group_id|1|0|0|0|0|retire_group:completed"
[ "$retirement_first_state" = "$expected_retirement_first_state" ] || {
  printf 'retirement-first schedule left unexpected persisted state: %q\n' "$retirement_first_state" >&2
  exit 1
}

echo 'record ownership target retirement concurrency proof passed'
