#!/usr/bin/env bash

set -euo pipefail

run_uuid="${VORTEX_EVENT_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then
  IFS= read -r run_uuid </proc/sys/kernel/random/uuid
fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  echo 'VORTEX_EVENT_PROOF_RUN_ID must be a lowercase UUID v4' >&2
  exit 1
}

readonly run_uuid
readonly run_token="${run_uuid//-/}"
readonly fixture_token="${run_token:0:20}"
readonly fixture_name="event_${fixture_token}"
readonly tenant_id="11${run_uuid:2}"
readonly organization_id="12${run_uuid:2}"
readonly actor_id="13${run_uuid:2}"
readonly identity_id="14${run_uuid:2}"
readonly account_id="15${run_uuid:2}"
readonly module_root_id="16${run_uuid:2}"
readonly app_one="17${run_uuid:2}"
readonly app_two="18${run_uuid:2}"
readonly record_type_id="19${run_uuid:2}"
readonly storage_id="1a${run_uuid:2}"
readonly field_id="1b${run_uuid:2}"
readonly record_one="1c${run_uuid:2}"
readonly record_two="1d${run_uuid:2}"
readonly occurrence_one="1e${run_uuid:2}"
readonly occurrence_two="1f${run_uuid:2}"
readonly occurrence_three="20${run_uuid:2}"
readonly occurrence_four="21${run_uuid:2}"
readonly occurrence_detached="30${run_uuid:2}"
readonly steward_role_id="31${run_uuid:2}"
readonly steward_assignment_id="32${run_uuid:2}"
readonly steward_delegation_id="33${run_uuid:2}"
readonly installer_role_id="34${run_uuid:2}"
readonly installer_assignment_id="35${run_uuid:2}"
readonly physical_table="rt_${storage_id//-/}"
readonly proof_root="$(mktemp -d /tmp/vortex-event.XXXXXX)"
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"

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
  echo 'Event proof did not reach its transaction barrier' >&2
  return 1
}

read_backend_pid() {
  local candidate="$1"
  local backend_pid
  wait_for_file "$candidate"
  backend_pid="$(tr -d '[:space:]' <"$candidate")"
  [[ "$backend_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  printf '%s\n' "$backend_pid"
}

wait_for_database_blocker() {
  local blocked_pid="$1"
  local blocking_pid="$2"
  local deadline=$((SECONDS + 20))
  local state
  while ((SECONDS < deadline)); do
    state="$(run_sql "select case when $blocking_pid = any(pg_catalog.pg_blocking_pids($blocked_pid)) then 'blocked' else '' end;")"
    [ "$state" = 'blocked' ] && return 0
    sleep 0.1
  done
  echo 'Event proof did not observe the required record-row wait' >&2
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

cleanup_fixture() {
  [ "$fixture_claimed" = 1 ] || return 0
  run_sql "
    begin;
    set local session_replication_role = replica;
    delete from pgmq.q_vortex_event_occurrences
      where message ->> 'occurrenceId' in (
        '$occurrence_one','$occurrence_two','$occurrence_three','$occurrence_four',
        '$occurrence_detached'
      );
    delete from vortex_event.event_outbox where organization_id = '$organization_id';
    set local role vortex_record_owner;
    drop table if exists record_data.$physical_table;
    delete from vortex_record.field_storage_mappings where storage_contract_id = '$storage_id';
    delete from vortex_record.release_provisions where module_root_id = '$module_root_id';
    delete from vortex_record.storage_catalogue where storage_contract_id = '$storage_id';
    reset role;
    set local role vortex_module_owner;
    delete from vortex_module.installation_bindings where organization_id = '$organization_id';
    reset role;
    delete from vortex_definition.release_dependencies
      where root_id in ('$module_root_id','$app_one','$app_two');
    delete from vortex_definition.releases where root_id in ('$module_root_id','$app_one','$app_two');
    delete from vortex_definition.drafts where root_id in ('$module_root_id','$app_one','$app_two');
    delete from vortex_definition.roots where root_id in ('$module_root_id','$app_one','$app_two');
    do \$proof\$
    declare target record;
    begin
      for target in
        select candidate.table_name
        from information_schema.columns as candidate
        where candidate.table_schema = 'vortex_access'
          and candidate.column_name = 'organization_id'
        group by candidate.table_name
      loop
        execute pg_catalog.format(
          'delete from vortex_access.%I where organization_id = \$1',
          target.table_name
        ) using '$organization_id'::uuid;
      end loop;
    end
    \$proof\$;
    delete from vortex_identity.organization_accounts where organization_id = '$organization_id';
    delete from vortex_identity.identity_projections where identity_id = '$identity_id';
    delete from vortex_identity.organizations where organization_id = '$organization_id';
    delete from vortex_identity.tenants where tenant_id = '$tenant_id';
    commit;
  " >/dev/null
}

finalize() {
  local original_status=$?
  local cleanup_status=0
  touch "$proof_root"/*-release >/dev/null 2>&1 || true
  stop_owned_workers
  if [ "$original_status" -ne 0 ]; then
    echo 'Event proof failed; bounded worker diagnostics follow' >&2
    for log_path in "$proof_root"/*.log; do
      [ -f "$log_path" ] || continue
      printf '%s\n' "--- ${log_path##*/} ---" >&2
      tail -n 60 -- "$log_path" >&2
    done
  fi
  if cleanup_fixture; then :; else cleanup_status=$?; fi
  case "$proof_root" in
    /tmp/vortex-event.*) rm -rf -- "$proof_root" ;;
    *) cleanup_status=1 ;;
  esac
  if [ "$original_status" -ne 0 ]; then exit "$original_status"; fi
  exit "$cleanup_status"
}
trap finalize EXIT

sha() {
  printf "'sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(%s, 'UTF8')), 'hex')" "$1"
}

human_context() {
  local application_id="$1"
  local correlation_id="$2"
  printf "select vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind','human','identityAuthorityId','%s','tenantId','%s','organizationId','%s',
    'organizationAccountId','%s','identityId','%s','applicationRootId','%s',
    'sessionId','22%s','authenticationStrength','single_factor',
    'issuedAt',pg_catalog.statement_timestamp()-interval '1 minute',
    'expiresAt',pg_catalog.statement_timestamp()+interval '1 hour',
    'accessVersion',(select current_version from vortex_access.organization_access_versions
      where organization_id='%s'),'correlationId','%s',
    'accessTokenIssuedAt',pg_catalog.statement_timestamp()-interval '1 minute',
    'primaryAuthenticatedAt',pg_catalog.statement_timestamp()-interval '1 minute'));" \
    "$actor_id" "$tenant_id" "$organization_id" "$account_id" "$identity_id" \
    "$application_id" "${run_uuid:2}" "$organization_id" "$correlation_id"
}

occurrence() {
  local occurrence_id="$1"
  printf "pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'occurrenceId','%s','descriptor',pg_catalog.jsonb_build_object(
      'kind','standard','eventKind','created','recordTypeId','%s'),
    'payload',pg_catalog.jsonb_build_object('kind','created')))" \
    "$occurrence_id" "$record_type_id"
}

readonly module_content="pg_catalog.jsonb_build_object(
  'name','Event concurrency module','description','Neutral shared ordering proof.',
  'dependencies','[]'::jsonb,
  'recordTypes',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'recordTypeId','$record_type_id','key','item','singularLabel','Item','pluralLabel','Items',
    'titleFieldId','$field_id','storageContractId','$storage_id',
    'storageScope','organization_shared','ownershipMode','none',
    'fields',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'fieldId','$field_id','key','title','label','Title','type','text',
      'required',false,'unique',false,'filterable',true,'sortable',true,
      'personalData','none','publicDisplay','refused',
      'settings',pg_catalog.jsonb_build_object('maxLength',120))),
    'relationships','[]'::jsonb,'standardActions',pg_catalog.jsonb_build_array('create','read'),
    'customActionIds','[]'::jsonb)),
  'permissions','[]'::jsonb,'actions','[]'::jsonb,'events','[]'::jsonb,
  'rules','[]'::jsonb,'sharingConditions','[]'::jsonb,'extensionPoints','[]'::jsonb)"

run_sql "
  begin;
  insert into vortex_identity.tenants (
    tenant_id,short_name,display_name,state,created_at,created_by,state_changed_at,revision
  ) values ('$tenant_id','$fixture_name','Event concurrency','active',
    pg_catalog.statement_timestamp(),'$actor_id',pg_catalog.statement_timestamp(),1);
  insert into vortex_identity.organizations (
    organization_id,tenant_id,short_name,display_name,state,created_at,created_by,state_changed_at,revision
  ) values ('$organization_id','$tenant_id','$fixture_name','Event concurrency','active',
    pg_catalog.statement_timestamp(),'$actor_id',pg_catalog.statement_timestamp(),1);
  insert into vortex_identity.identity_projections (
    identity_id,state,created_at,state_changed_at,state_changed_by,state_change_correlation_id,revision
  ) values ('$identity_id','active',pg_catalog.statement_timestamp(),pg_catalog.statement_timestamp(),
    '$actor_id','23${run_uuid:2}',1);
  insert into vortex_identity.organization_accounts (
    organization_account_id,organization_id,identity_id,display_name,state,activated_at,changed_at,
    state_changed_at,state_changed_by,state_change_correlation_id,revision
  ) values ('$account_id','$organization_id','$identity_id','Event actor','active',
    pg_catalog.statement_timestamp()-interval '1 minute',pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(),'$actor_id','24${run_uuid:2}',1);
  select * from vortex_access.initialize_organization_access_version(
    '$organization_id','$actor_id','25${run_uuid:2}');
  select * from vortex_access.initialize_platform_permission_catalogue(
    '$organization_id','$actor_id','36${run_uuid:2}');
  select * from vortex_access.revise_platform_permission_catalogue_metadata(
    '$organization_id',1,'1.0.0','1.0.1','$actor_id','37${run_uuid:2}');
  select * from vortex_access.coordinate_organization_stewardship_adoption(
    '$organization_id','$account_id','$steward_role_id','event_concurrency_steward',
    'Event concurrency steward','Permanent proof stewardship.',
    '$steward_assignment_id','$steward_delegation_id','$identity_id','38${run_uuid:2}');
  select * from vortex_access.adopt_shipped_platform_permission_catalogue(
    '$organization_id',2,'1.1.0',
    'sha256:cb42d4b24ebead7fe9e4ba6358115ceb3ae752d3a0b4cbedc458dcb218013778',
    '$actor_id','39${run_uuid:2}');
  insert into vortex_access.organization_roles (
    organization_id,role_id,role_kind,role_key,live_revision,created_by,created_at
  ) values ('$organization_id','$installer_role_id','custom','application_installer',1,
    '$actor_id',pg_catalog.statement_timestamp());
  insert into vortex_access.organization_role_permission_entries (
    organization_id,role_id,role_revision,entry_ordinal,role_kind,
    role_application_root_id,application_root_id,owner_kind,owner_id,
    permission_id,registration_kind,registration_owner_id,
    accepted_registration_revision,catalogue_fingerprint,continuity_revision,
    meaning_fingerprint
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
    and continuity.owner_kind=entry.owner_kind
    and continuity.owner_id=entry.owner_id
    and continuity.permission_id=entry.permission_id
  where entry.organization_id='$organization_id'
    and entry.registration_kind='platform'
    and entry.registration_revision=3
    and entry.permission_id='7ecd3304-f16c-47d4-94db-0964980091ba';
  insert into vortex_access.organization_role_revisions (
    organization_id,role_id,revision,role_kind,lifecycle,
    privilege_classification,assignment_policy,policy_continuity_revision,
    authority_continuity_revision,role_key,label,description,
    changed_by,changed_at,change_correlation_id
  ) values ('$organization_id','$installer_role_id',1,'custom','active','privileged',
    'standing',1,1,'application_installer','Application installer',
    'Current Event lifecycle proof authority.','$actor_id',
    pg_catalog.statement_timestamp(),'3a${run_uuid:2}');
  insert into vortex_access.organization_role_assignments (
    organization_id,role_assignment_id,role_id,assignee_kind,
    organization_account_id,assignment_kind,revision,starts_at,state,
    granted_by,granted_at,grant_correlation_id,changed_by,changed_at,
    change_correlation_id
  ) values ('$organization_id','$installer_assignment_id','$installer_role_id',
    'organization_account','$account_id','standing',1,
    pg_catalog.statement_timestamp()-interval '1 minute','live','$actor_id',
    pg_catalog.statement_timestamp(),'3b${run_uuid:2}','$actor_id',
    pg_catalog.statement_timestamp(),'3b${run_uuid:2}');
  insert into vortex_definition.roots (root_id,organization_id,kind,key,created_at,created_by)
  values ('$module_root_id','$organization_id','module','example.event.concurrent',pg_catalog.statement_timestamp(),'$actor_id'),
    ('$app_one','$organization_id','application','example.event.one',pg_catalog.statement_timestamp(),'$actor_id'),
    ('$app_two','$organization_id','application','example.event.two',pg_catalog.statement_timestamp(),'$actor_id');
  insert into vortex_definition.drafts (
    root_id,draft_revision,draft_source,source_contract_version,source_fingerprint,updated_at,updated_by
  ) values
    ('$module_root_id',1,pg_catalog.jsonb_build_object('source_contract_version','2.0.0','kind','module','key','example.event.concurrent'),'2.0.0',$(sha "'$module_root_id:source'"),pg_catalog.statement_timestamp(),'$actor_id'),
    ('$app_one',1,pg_catalog.jsonb_build_object('source_contract_version','1.0.0','kind','application','key','example.event.one'),'1.0.0',$(sha "'$app_one:source'"),pg_catalog.statement_timestamp(),'$actor_id'),
    ('$app_two',1,pg_catalog.jsonb_build_object('source_contract_version','1.0.0','kind','application','key','example.event.two'),'1.0.0',$(sha "'$app_two:source'"),pg_catalog.statement_timestamp(),'$actor_id');
  commit;
" >/dev/null
fixture_claimed=1

run_sql "
  begin;
  delete from vortex_context.request_contexts where backend_pid=pg_catalog.pg_backend_pid();
  select vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind','system','tenantId','$tenant_id','organizationId','$organization_id',
    'sessionId','26${run_uuid:2}','issuedAt',pg_catalog.statement_timestamp()-interval '1 minute',
    'expiresAt',pg_catalog.statement_timestamp()+interval '1 hour','accessVersion',1,
    'correlationId','27${run_uuid:2}','systemActorId','$actor_id','authenticationStrength','service'));
  select * from vortex_definition.append_release('$module_root_id',1,$(sha "'$module_root_id:source'"),
    pg_catalog.jsonb_build_object(
      'releaseVersion','2.0.0','compilationOutput',pg_catalog.jsonb_build_object(
        'kind','module','validationContractVersion','2.0.0',
        'resolutionFingerprint',$(sha "'$module_root_id:resolution'"),
        'artifact',pg_catalog.jsonb_build_object('kind','module','rootId','$module_root_id',
          'definitionKey','example.event.concurrent','exactVersion','2.0.0',
          'contentFingerprint',$(sha "'$module_root_id:content'"),
          'resolutionFingerprint',$(sha "'$module_root_id:resolution'")),
        'canonical',pg_catalog.jsonb_build_object('envelope',pg_catalog.jsonb_build_object(
          'kind','module','key','example.event.concurrent','rootId','$module_root_id',
          'organizationId','$organization_id'),'content',$module_content)),
      'resolutionSnapshot',pg_catalog.jsonb_build_object('fingerprint',$(sha "'$module_root_id:resolution'"),
        'definitions',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('kind','module',
          'key','example.event.concurrent','rootId','$module_root_id','exactVersion','2.0.0'))),
      'contentFingerprint',$(sha "'$module_root_id:content'"),
      'resolutionFingerprint',$(sha "'$module_root_id:resolution'"),
      'validationContractVersion','2.0.0','comparisonFingerprint',$(sha "'$module_root_id:content'"),
      'impactReasons','[]'::jsonb,'releaseNote','Event concurrency module.','dependencies','[]'::jsonb));
  delete from vortex_context.request_contexts where backend_pid=pg_catalog.pg_backend_pid();
  commit;
" >/dev/null

for app_id in "$app_one" "$app_two"; do
  app_key='example.event.one'
  [ "$app_id" = "$app_two" ] && app_key='example.event.two'
  run_sql "
    begin;
    delete from vortex_context.request_contexts where backend_pid=pg_catalog.pg_backend_pid();
    select vortex_context.initialize(pg_catalog.jsonb_build_object(
      'callerKind','system','tenantId','$tenant_id','organizationId','$organization_id',
      'sessionId','28${run_uuid:2}','issuedAt',pg_catalog.statement_timestamp()-interval '1 minute',
      'expiresAt',pg_catalog.statement_timestamp()+interval '1 hour','accessVersion',1,
      'correlationId','29${run_uuid:2}','systemActorId','$actor_id','authenticationStrength','service'));
    select * from vortex_definition.append_release('$app_id',1,$(sha "'$app_id:source'"),
      pg_catalog.jsonb_build_object(
        'releaseVersion','1.0.0','compilationOutput',pg_catalog.jsonb_build_object(
          'kind','application','validationContractVersion','1.0.0',
          'resolutionFingerprint',$(sha "'$app_id:resolution'"),
          'artifact',pg_catalog.jsonb_build_object('kind','application','rootId','$app_id',
            'definitionKey','$app_key','exactVersion','1.0.0',
            'contentFingerprint',$(sha "'$app_id:content'"),
            'resolutionFingerprint',$(sha "'$app_id:resolution'")),
          'canonical',pg_catalog.jsonb_build_object('envelope',pg_catalog.jsonb_build_object(
            'kind','application','key','$app_key','rootId','$app_id',
            'organizationId','$organization_id'),'content',pg_catalog.jsonb_build_object(
              'name','Event concurrency application','events','[]'::jsonb))),
        'resolutionSnapshot',pg_catalog.jsonb_build_object('fingerprint',$(sha "'$app_id:resolution'"),
          'definitions',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('kind','application',
            'key','$app_key','rootId','$app_id','exactVersion','1.0.0'))),
        'contentFingerprint',$(sha "'$app_id:content'"),
        'resolutionFingerprint',$(sha "'$app_id:resolution'"),
        'validationContractVersion','1.0.0','comparisonFingerprint',$(sha "'$app_id:content'"),
        'impactReasons','[]'::jsonb,'releaseNote','Event concurrency application.',
        'dependencies',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'kind','module','key','example.event.concurrent','rootId','$module_root_id',
          'releaseRevision',1,'releaseVersion','2.0.0',
          'contentFingerprint',$(sha "'$module_root_id:content'"),
          'resolutionFingerprint',$(sha "'$module_root_id:resolution'")))));
    delete from vortex_context.request_contexts where backend_pid=pg_catalog.pg_backend_pid();
    commit;
  " >/dev/null
done

run_sql "
  begin;
  set local role vortex_module_owner;
  select * from vortex_record.provision_exact_module_storage('$module_root_id',1);
  insert into vortex_module.installation_bindings (
    organization_id,application_root_id,module_root_id,binding_revision,
    application_release_revision,module_release_revision,state,content_fingerprint,
    resolution_fingerprint,generator_contract_version,storage_contract_ids
  ) select '$organization_id',app.root_id,'$module_root_id',1,1,1,'active',
      release.content_fingerprint,release.resolution_fingerprint,'1.0.0',array['$storage_id'::uuid]
    from (values ('$app_one'::uuid),('$app_two'::uuid)) as app(root_id)
    cross join vortex_definition.releases as release
    where release.root_id='$module_root_id' and release.release_revision=1;
  reset role;
  $(human_context "$app_one" "2a${run_uuid:2}")
  set local role vortex_record_adapter;
  insert into record_data.$physical_table (
    organisation_id,module_root_id,record_type_id,storage_contract_id,record_id,
    application_root_id,definition_revision,owner_organisation_account_id,owner_group_id,
    lifecycle_state,concurrency_number,created_at,created_by,updated_at,updated_by,
    f_${field_id//-/}
  ) values
    ('$organization_id','$module_root_id','$record_type_id','$storage_id','$record_one',null,1,
      null,null,'active',1,pg_catalog.statement_timestamp(),'$account_id',
      pg_catalog.statement_timestamp(),'$account_id','One'),
    ('$organization_id','$module_root_id','$record_type_id','$storage_id','$record_two',null,1,
      null,null,'active',1,pg_catalog.statement_timestamp(),'$account_id',
      pg_catalog.statement_timestamp(),'$account_id','Two');
  reset role;
  delete from vortex_context.request_contexts where backend_pid=pg_catalog.pg_backend_pid();
  commit;
" >/dev/null

# Same shared record through different Applications: the second append must
# wait on the actual row, then continue the one organisation-shared sequence.
"${psql_command[@]}" >"$proof_root/same-one.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
$(human_context "$app_one" "2b${run_uuid:2}")
set local role vortex_record_adapter;
select pg_catalog.pg_backend_pid() \g '$proof_root/same-one.pid'
select vortex_event.append_record_occurrences('$storage_id','$record_one',$(occurrence "$occurrence_one"));
\! touch '$proof_root/same-ready'
\! deadline=600; while [ ! -f '$proof_root/same-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/same-release' ]
commit;
SQL
same_one_pid=$!
worker_pids+=("$same_one_pid")
wait_for_file "$proof_root/same-ready"
same_one_backend="$(read_backend_pid "$proof_root/same-one.pid")"

"${psql_command[@]}" >"$proof_root/same-two.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
$(human_context "$app_two" "2c${run_uuid:2}")
set local role vortex_record_adapter;
select pg_catalog.pg_backend_pid() \g '$proof_root/same-two.pid'
select vortex_event.append_record_occurrences('$storage_id','$record_one',$(occurrence "$occurrence_two"));
commit;
SQL
same_two_pid=$!
worker_pids+=("$same_two_pid")
same_two_backend="$(read_backend_pid "$proof_root/same-two.pid")"
wait_for_database_blocker "$same_two_backend" "$same_one_backend"
touch "$proof_root/same-release"
wait_owned_worker "$same_one_pid"
wait_owned_worker "$same_two_pid"
[ "$(run_sql "select string_agg(record_sequence::text,',' order by record_sequence) from vortex_event.event_outbox where organization_id='$organization_id' and record_id='$record_one';")" = '1,2' ]
[ "$(run_sql "select count(distinct envelope#>>'{installation,applicationRootId}') from vortex_event.event_outbox where organization_id='$organization_id' and record_id='$record_one';")" = '2' ]
[ "$(run_sql "select count(*) from vortex_event.event_outbox where organization_id='$organization_id' and record_id='$record_one' and sequence_application_root_id is null;")" = '2' ]

# A different record in the same Application and Module must not wait behind
# the first record's append; compatible lifecycle locks cannot serialize it.
"${psql_command[@]}" >"$proof_root/different-one.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
$(human_context "$app_one" "2d${run_uuid:2}")
set local role vortex_record_adapter;
select vortex_event.append_record_occurrences('$storage_id','$record_one',$(occurrence "$occurrence_three"));
\! touch '$proof_root/different-ready'
\! deadline=600; while [ ! -f '$proof_root/different-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/different-release' ]
commit;
SQL
different_one_pid=$!
worker_pids+=("$different_one_pid")
wait_for_file "$proof_root/different-ready"

run_sql "
  begin; set local lock_timeout='2s'; set local statement_timeout='10s';
  $(human_context "$app_one" "2e${run_uuid:2}")
  set local role vortex_record_adapter;
  select vortex_event.append_record_occurrences('$storage_id','$record_two',$(occurrence "$occurrence_four"));
  commit;
" >/dev/null
touch "$proof_root/different-release"
wait_owned_worker "$different_one_pid"
[ "$(run_sql "select record_sequence from vortex_event.event_outbox where occurrence_id='$occurrence_three';")" = '3' ]
[ "$(run_sql "select record_sequence from vortex_event.event_outbox where occurrence_id='$occurrence_four';")" = '1' ]

# A real lifecycle detach holds the exclusive canonical binding lock. The
# waiting append may continue only after commit, when it must reread the active
# installation and refuse rather than emit stale binding evidence.
"${psql_command[@]}" >"$proof_root/detach.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
$(human_context "$app_one" "3c${run_uuid:2}")
set local role vortex_request;
select pg_catalog.pg_backend_pid() \g '$proof_root/detach.pid'
select vortex_module.detach_application_installation(
  '$app_one',1,
  '[{"moduleRootId":"$module_root_id","bindingRevision":1}]'
) ->> 'state';
\! touch '$proof_root/detach-ready'
\! deadline=600; while [ ! -f '$proof_root/detach-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/detach-release' ]
commit;
SQL
detach_pid=$!
worker_pids+=("$detach_pid")
wait_for_file "$proof_root/detach-ready"
detach_backend="$(read_backend_pid "$proof_root/detach.pid")"

"${psql_command[@]}" >"$proof_root/detached-append.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
$(human_context "$app_one" "3d${run_uuid:2}")
set local role vortex_record_adapter;
select pg_catalog.pg_backend_pid() \g '$proof_root/detached-append.pid'
select vortex_event.append_record_occurrences(
  '$storage_id','$record_two',$(occurrence "$occurrence_detached")
);
commit;
SQL
detached_append_pid=$!
worker_pids+=("$detached_append_pid")
detached_append_backend="$(read_backend_pid "$proof_root/detached-append.pid")"
wait_for_database_blocker "$detached_append_backend" "$detach_backend"
touch "$proof_root/detach-release"
wait_owned_worker "$detach_pid"
if wait_owned_worker "$detached_append_pid"; then
  echo 'append unexpectedly used installation evidence made stale by detach' >&2
  exit 1
fi
grep -Fq 'ERROR:  Active Application installation is unavailable' \
  "$proof_root/detached-append.log" || {
  echo 'append did not safe-refuse after the serialized lifecycle detach' >&2
  exit 1
}
[ "$(run_sql "select state || ':' || binding_revision from vortex_module.installation_bindings where organization_id='$organization_id' and application_root_id='$app_one' and module_root_id='$module_root_id';")" = 'detached:2' ]
[ "$(run_sql "select count(*) from vortex_event.event_outbox where occurrence_id='$occurrence_detached';")" = '0' ]
[ "$(run_sql "select count(*) from pgmq.q_vortex_event_occurrences where message->>'occurrenceId'='$occurrence_detached';")" = '0' ]

echo 'Event append concurrency proof passed'
