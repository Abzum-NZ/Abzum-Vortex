#!/usr/bin/env bash
# #401/#402: the fixed change adapter and private reference allocator under real
# concurrency, through two sessions on one provisioned record table.
#
#   conflict   -- two changes carrying the same expected concurrency number. The
#                 second blocks on the row lock the first holds, and once the
#                 first commits it returns {"outcome":"conflict"} rather than
#                 overwriting it. Exactly one write lands.
#   revocation -- a change waits at that same lock while the role-assignment
#                 writer revokes the acting account's own authority and commits.
#                 When the lock is released the change is refused and writes
#                 nothing.
#   reference  -- two creates enter the same published reference-number scope.
#                 The second waits on the first counter row and receives the
#                 next exact value after the first commits; neither duplicates
#                 or derives a number with max()+1.
#   link/delete -- a link clear and deletion of its target wait on one source
#                 row lock, then serialize. Both can complete, or the link clear
#                 returns a stale conflict after delete clears it; no partial
#                 edge/value/lifecycle state is possible.
#
# What enforces this, established by targeted mutation on fresh clusters:
#   * The adapter locks the target row before it reads any other fact, and
#     compares the stored concurrency number with the expected one after that
#     lock is granted. Dropping the comparison lets the second change overwrite
#     the first, and this proof fails naming the row it found.
#   * Dropping the lock itself means the second session never waits, so the
#     proof never observes it blocked and fails at that barrier.
#   * Every decision the change makes is evaluated after the lock, so an
#     authority change that commits while the change waits is seen by it. The
#     revocation advances the organisation's Access version, and the context the
#     waiting change carries is then stale.
#
# Fixture: the tenant, organisation, first account and definition roots are
# inserted directly, because no writer creates them. The releases come from
# vortex_definition.append_release, the permission catalogue from the
# coordinated Access registration, the role and assignment from their owning
# writers, and the storage from the Module coordinator. Binding activation
# (#43) and the record rows (#402) are direct writes, as they are in 475.
set -euo pipefail

readonly proof_root="$(mktemp -d /tmp/vortex-record-change.XXXXXX)"
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id='c4760000-0000-4000-8000-000000000001'
readonly organization_id='c4760000-0000-4000-8000-000000000002'
readonly identity_id='c4760000-0000-4000-8000-000000000003'
readonly account_id='c4760000-0000-4000-8000-000000000004'
readonly actor_id='c4760000-0000-4000-8000-000000000005'
readonly application_root_id='c4760000-0000-4000-8000-000000000010'
readonly module_root_id='c4760000-0000-4000-8000-000000000011'
readonly record_type_id='c4760000-0000-4000-8000-000000000012'
readonly storage_contract_id='c4760000-0000-4000-8000-000000000013'
readonly field_one='c4760000-0000-4000-8000-000000000014'
readonly field_two='c4760000-0000-4000-8000-000000000015'
readonly permission_read='c4760000-0000-4000-8000-000000000016'
readonly permission_update='c4760000-0000-4000-8000-000000000017'
readonly field_reference='c4760000-0000-4000-8000-000000000030'
readonly permission_create='c4760000-0000-4000-8000-000000000031'
readonly field_link='c4760000-0000-4000-8000-000000000032'
readonly relationship_id='c4760000-0000-4000-8000-000000000033'
readonly permission_delete='c4760000-0000-4000-8000-000000000034'
readonly field_required_link='c4760000-0000-4000-8000-000000000035'
readonly relationship_required='c4760000-0000-4000-8000-000000000036'
readonly permission_restore='c4760000-0000-4000-8000-000000000037'
readonly role_id='c4760000-0000-4000-8000-000000000018'
readonly assignment_id='c4760000-0000-4000-8000-000000000019'
readonly steward_role_id='c4760000-0000-4000-8000-00000000001a'
readonly steward_assignment_id='c4760000-0000-4000-8000-00000000001b'
readonly steward_delegation_id='c4760000-0000-4000-8000-00000000001c'
readonly installer_role_id='c4760000-0000-4000-8000-00000000001d'
readonly installer_assignment_id='c4760000-0000-4000-8000-00000000001e'
readonly conflict_record_id='c4760000-0000-4000-8000-000000000020'
readonly revocation_record_id='c4760000-0000-4000-8000-000000000021'
readonly link_source_record_id='c4760000-0000-4000-8000-000000000040'
readonly link_target_record_id='c4760000-0000-4000-8000-000000000041'
readonly anchor_record_id='c4760000-0000-4000-8000-000000000042'
readonly link_add_source_record_id='c4760000-0000-4000-8000-000000000043'
readonly link_add_target_record_id='c4760000-0000-4000-8000-000000000044'
readonly restore_source_record_id='c4760000-0000-4000-8000-000000000045'
readonly restore_target_record_id='c4760000-0000-4000-8000-000000000046'
readonly physical_table='rt_c4760000000040008000000000000013'
readonly column_one='f_c4760000000040008000000000000014'
readonly column_reference='f_c4760000000040008000000000000030'
readonly column_link='f_c4760000000040008000000000000032'
readonly column_required_link='f_c4760000000040008000000000000035'

fixture_claimed=0
declare -a worker_pids=()
declare -A reaped_worker_pids=()

psql_command=(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1)
if [ -n "$database_url" ]; then psql_command+=("$database_url"); fi
run_sql() { "${psql_command[@]}" --command "$1"; }

wait_for_file() {
  local candidate="$1" deadline=$((SECONDS + 20))
  while ((SECONDS < deadline)); do [ -f "$candidate" ] && return 0; sleep 0.05; done
  echo "record change proof barrier timed out: $candidate" >&2
  return 1
}

read_backend_pid() {
  local candidate="$1" backend_pid
  wait_for_file "$candidate"
  backend_pid="$(tr -d '[:space:]' <"$candidate")"
  [[ "$backend_pid" =~ ^[1-9][0-9]*$ ]] || {
    printf 'record change proof captured invalid backend: %q\n' "$backend_pid" >&2
    return 1
  }
  printf '%s\n' "$backend_pid"
}

wait_for_database_blocker() {
  local blocked_pid="$1" blocking_pid="$2" label="${3:-record change}" deadline=$((SECONDS + 20)) state
  while ((SECONDS < deadline)); do
    # PostgreSQL may queue the second waiter behind the first waiter for the
    # same tuple. Follow the direct-blocker chain so the proof recognises that
    # both commands are waiting on the holder without assuming queue order.
    state="$(run_sql "with recursive blockers(pid) as (
        select blocker from pg_catalog.unnest(pg_catalog.pg_blocking_pids($blocked_pid)) as blocker
        union
        select next_blocker
        from blockers
        cross join lateral pg_catalog.unnest(pg_catalog.pg_blocking_pids(blockers.pid)) as next_blocker
      )
      select case when exists (select 1 from blockers where pid = $blocking_pid)
        then 'blocked' else '' end;")"
    [ "$state" = 'blocked' ] && return 0
    sleep 0.1
  done
  printf 'record change proof did not observe %s blocked at the row lock\n' "$label" >&2
  run_sql "select pg_catalog.concat_ws('|', pid::text, wait_event_type, wait_event,
      pg_catalog.array_to_string(pg_catalog.pg_blocking_pids(pid), ','))
    from pg_catalog.pg_stat_activity where pid in ($blocked_pid, $blocking_pid)
    order by pid;" >&2 || true
  return 1
}

wait_owned_worker() {
  local pid="$1" status
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
    do \$cleanup\$
    begin
      if not exists (
        select 1 from vortex_identity.organizations
        where organization_id = '$organization_id' and tenant_id = '$tenant_id'
          and created_by = '$actor_id'
      ) then
        raise exception 'record change proof fixture ownership mismatch';
      end if;
    end
    \$cleanup\$;
    set local role vortex_record_owner;
    drop table if exists record_data.$physical_table;
    delete from vortex_record.record_reference_counters
      where organization_id = '$organization_id';
    delete from vortex_record.record_data_versions
      where organization_id = '$organization_id';
    delete from vortex_record.relationship_edges
      where from_storage_contract_id = '$storage_contract_id'
         or to_storage_contract_id = '$storage_contract_id';
    delete from vortex_record.relationship_storage_mappings
      where module_root_id = '$module_root_id';
    delete from vortex_record.field_storage_mappings
      where storage_contract_id = '$storage_contract_id';
    delete from vortex_record.storage_catalogue
      where storage_contract_id = '$storage_contract_id';
    delete from vortex_record.release_provisions where module_root_id = '$module_root_id';
    reset role;
    set local role vortex_module_owner;
    delete from vortex_module.installation_bindings where organization_id = '$organization_id';
    reset role;
    do \$cleanup\$
    declare
      target record;
    begin
      for target in
        select column_row.table_schema, column_row.table_name
        from information_schema.columns as column_row
        join information_schema.tables as table_row
          on table_row.table_schema = column_row.table_schema
          and table_row.table_name = column_row.table_name
          and table_row.table_type = 'BASE TABLE'
        where column_row.table_schema in ('vortex_access', 'vortex_activity', 'vortex_identity')
          and column_row.column_name = 'organization_id'
          and column_row.table_name <> 'organizations'
      loop
        execute pg_catalog.format('delete from %I.%I where organization_id = %L',
          target.table_schema, target.table_name, '$organization_id');
      end loop;
    end
    \$cleanup\$;
    delete from vortex_definition.release_dependencies
      where root_id in ('$application_root_id', '$module_root_id');
    delete from vortex_definition.releases
      where root_id in ('$application_root_id', '$module_root_id');
    delete from vortex_definition.drafts
      where root_id in ('$application_root_id', '$module_root_id');
    delete from vortex_definition.roots
      where root_id in ('$application_root_id', '$module_root_id');
    delete from vortex_identity.organization_accounts where organization_id = '$organization_id';
    delete from vortex_identity.identity_projections where identity_id = '$identity_id';
    delete from vortex_identity.organizations where organization_id = '$organization_id';
    delete from vortex_identity.tenants where tenant_id = '$tenant_id';
    commit;
  " >/dev/null
}

finalize() {
  local original_status=$? cleanup_status=0 operation_status
  trap - EXIT INT TERM
  set +e
  touch "$proof_root/conflict-release" "$proof_root/revocation-release" \
    "$proof_root/reference-release" >/dev/null 2>&1 || true
  touch "$proof_root/link-delete-release" >/dev/null 2>&1 || true
  touch "$proof_root/link-add-release" "$proof_root/restore-target-release" >/dev/null 2>&1 || true
  stop_owned_workers
  if [ "$original_status" -ne 0 ]; then
    echo 'record change concurrency proof failed; bounded diagnostics follow' >&2
    for log_path in "$proof_root"/*.log; do
      [ -f "$log_path" ] || continue
      printf '%s\n' "--- ${log_path##*/} ---" >&2
      tail -n 40 -- "$log_path" >&2
    done
  fi
  cleanup_fixture
  operation_status=$?
  if [ "$operation_status" -ne 0 ]; then cleanup_status="$operation_status"; fi
  case "$proof_root" in
    /tmp/vortex-record-change.*) rm -rf -- "$proof_root"; operation_status=$? ;;
    *) echo 'refusing to remove unexpected proof directory' >&2; operation_status=1 ;;
  esac
  if [ "$operation_status" -ne 0 ] && [ "$cleanup_status" -eq 0 ]; then cleanup_status="$operation_status"; fi
  if [ "$original_status" -ne 0 ]; then exit "$original_status"; fi
  exit "$cleanup_status"
}
trap finalize EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

schema_state="$(run_sql "
  select pg_catalog.concat_ws('|',
    pg_catalog.to_regprocedure('vortex_record.change_record(uuid,uuid,bigint,jsonb,uuid[])') is not null,
    pg_catalog.to_regprocedure('vortex_record.read_record(uuid,uuid)') is not null,
    pg_catalog.to_regprocedure('vortex_record.create_record_internal(uuid,jsonb,uuid[],uuid)') is not null
  );
")"
[ "$schema_state" = 't|t|t' ] || {
  echo 'the record adapter migrations must already be applied to the proof database' >&2
  exit 1
}

sha() { printf "'sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(%s, 'UTF8')), 'hex')" "$1"; }

# One verified human request context for the current transaction, at a chosen
# Access version.
human_context() {
  local version_expression="$1"
  printf "select vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind','human','identityAuthorityId','%s','tenantId','%s','organizationId','%s',
    'organizationAccountId','%s','identityId','%s','applicationRootId','%s',
    'sessionId','c4760000-0000-4000-8000-0000000000f1','authenticationStrength','single_factor',
    'issuedAt',pg_catalog.statement_timestamp(),
    'expiresAt',pg_catalog.statement_timestamp()+interval '1 hour',
    'accessVersion',%s,'correlationId','c4760000-0000-4000-8000-0000000000f2',
    'accessTokenIssuedAt',pg_catalog.statement_timestamp(),
    'primaryAuthenticatedAt',pg_catalog.statement_timestamp()));" \
    "$actor_id" "$tenant_id" "$organization_id" "$account_id" "$identity_id" \
    "$application_root_id" "$version_expression"
}

current_version() {
  run_sql "select current_version from vortex_access.organization_access_versions where organization_id='$organization_id';"
}

readonly permissions_sql="pg_catalog.jsonb_build_array(
  pg_catalog.jsonb_build_object('permissionId','$permission_read','key','record_change.read',
    'label','Read','description','Read the concurrency record.','recordTypeId','$record_type_id',
    'recordScope','{\"routes\":[{\"kind\":\"all_records\"}]}'::jsonb,
    'fieldPolicy',pg_catalog.jsonb_build_object(
      'readableFieldIds',pg_catalog.jsonb_build_array('$field_one','$field_two','$field_reference','$field_link','$field_required_link'),
      'changeableFieldIds','[]'::jsonb),
    'actionKind','read','administrative',false),
  pg_catalog.jsonb_build_object('permissionId','$permission_update','key','record_change.update',
    'label','Update','description','Change the concurrency record.','recordTypeId','$record_type_id',
    'recordScope','{\"routes\":[{\"kind\":\"all_records\"}]}'::jsonb,
    'fieldPolicy',pg_catalog.jsonb_build_object(
      'readableFieldIds',pg_catalog.jsonb_build_array('$field_one','$field_two','$field_reference','$field_link','$field_required_link'),
      'changeableFieldIds',pg_catalog.jsonb_build_array('$field_one','$field_two','$field_link','$field_required_link')),
    'actionKind','update','administrative',false),
  pg_catalog.jsonb_build_object('permissionId','$permission_create','key','record_change.create',
    'label','Create','description','Create the reference concurrency record.','recordTypeId','$record_type_id',
    'recordScope','{\"routes\":[{\"kind\":\"all_records\"}]}'::jsonb,
    'fieldPolicy',pg_catalog.jsonb_build_object(
      'readableFieldIds',pg_catalog.jsonb_build_array('$field_one','$field_two','$field_reference','$field_link','$field_required_link'),
      'changeableFieldIds',pg_catalog.jsonb_build_array('$field_one','$field_two','$field_link','$field_required_link')),
    'actionKind','create','administrative',false),
  pg_catalog.jsonb_build_object('permissionId','$permission_delete','key','record_change.delete',
    'label','Delete','description','Delete the concurrency record.','recordTypeId','$record_type_id',
    'recordScope','{\"routes\":[{\"kind\":\"all_records\"}]}'::jsonb,
    'fieldPolicy',pg_catalog.jsonb_build_object(
      'readableFieldIds','[]'::jsonb,'changeableFieldIds','[]'::jsonb),
    'actionKind','delete','administrative',false),
  pg_catalog.jsonb_build_object('permissionId','$permission_restore','key','record_change.restore',
    'label','Restore','description','Restore the concurrency record.','recordTypeId','$record_type_id',
    'recordScope','{\"routes\":[{\"kind\":\"all_records\"}]}'::jsonb,
    'fieldPolicy',pg_catalog.jsonb_build_object(
      'readableFieldIds','[]'::jsonb,'changeableFieldIds','[]'::jsonb),
    'actionKind','restore','administrative',false))"

readonly module_content="pg_catalog.jsonb_build_object(
  'name','Record change concurrency','description','One record type for the change proof.',
  'dependencies','[]'::jsonb,
  'recordTypes',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'recordTypeId','$record_type_id','key','change_type','singularLabel','Change record',
    'pluralLabel','Change records','titleFieldId','$field_one',
    'storageContractId','$storage_contract_id','storageScope','organization_shared',
    'ownershipMode','none',
    'fields',pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('fieldId','$field_one','key','first','type','text',
        'required',false,'unique',false,'filterable',false,'sortable',false,
        'settings',pg_catalog.jsonb_build_object('maxLength',200)),
      pg_catalog.jsonb_build_object('fieldId','$field_two','key','second','type','text',
        'required',false,'unique',false,'filterable',false,'sortable',false,
        'settings',pg_catalog.jsonb_build_object('maxLength',200)),
      pg_catalog.jsonb_build_object('fieldId','$field_reference','key','reference','type','reference_number',
        'required',true,'unique',true,'filterable',true,'sortable',true,
        'settings',pg_catalog.jsonb_build_object('prefix','RC-','digits',3)),
      pg_catalog.jsonb_build_object('fieldId','$field_link','key','parent','type','link',
        'required',false,'unique',false,'filterable',false,'sortable',false,
        'settings',pg_catalog.jsonb_build_object(
          'target',pg_catalog.jsonb_build_object('state','resolved','moduleRootId','$module_root_id',
            'recordTypeId','$record_type_id'),
          'onParentDelete','empty_optional')),
      pg_catalog.jsonb_build_object('fieldId','$field_required_link','key','required_parent','type','link',
        'required',true,'unique',false,'filterable',false,'sortable',false,
        'settings',pg_catalog.jsonb_build_object(
          'target',pg_catalog.jsonb_build_object('state','resolved','moduleRootId','$module_root_id',
            'recordTypeId','$record_type_id'),
          'onParentDelete','refuse'))),
    'relationships',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'relationshipId','$relationship_id','key','self_parent',
      'fromRecordTypeId','$record_type_id','fromFieldId','$field_link',
      'toRecordType',pg_catalog.jsonb_build_object('state','resolved','moduleRootId','$module_root_id',
        'recordTypeId','$record_type_id'),
      'cardinality','many_to_one','onParentDelete','empty_optional'),
      pg_catalog.jsonb_build_object(
        'relationshipId','$relationship_required','key','required_parent',
        'fromRecordTypeId','$record_type_id','fromFieldId','$field_required_link',
        'toRecordType',pg_catalog.jsonb_build_object('state','resolved','moduleRootId','$module_root_id',
          'recordTypeId','$record_type_id'),
        'cardinality','many_to_one','onParentDelete','refuse')),
    'standardActions',pg_catalog.jsonb_build_array('create','read','update','delete','restore'),
    'customActionIds','[]'::jsonb)),
  'permissions',$permissions_sql,
  'actions','[]'::jsonb,'events','[]'::jsonb,'rules','[]'::jsonb,
  'sharingConditions','[]'::jsonb,'extensionPoints','[]'::jsonb)"

# ----------------------------------------------------------------------------
# Identity, authority, definitions, storage and the two records.
# ----------------------------------------------------------------------------
run_sql "
  begin;
  do \$proof\$
  begin
    if exists (select 1 from vortex_identity.tenants where tenant_id = '$tenant_id')
      or exists (select 1 from vortex_record.storage_catalogue where storage_contract_id = '$storage_contract_id')
      or pg_catalog.to_regclass('record_data.$physical_table') is not null then
      raise exception 'record change proof fixture scope already exists';
    end if;
  end
  \$proof\$;

  insert into vortex_identity.tenants (tenant_id, short_name, display_name, state, created_at, created_by, state_changed_at, revision)
  values ('$tenant_id','record_change','Record change','active',pg_catalog.clock_timestamp(),'$actor_id',pg_catalog.clock_timestamp(),1);
  insert into vortex_identity.organizations (organization_id, tenant_id, short_name, display_name, state, created_at, created_by, state_changed_at, revision)
  values ('$organization_id','$tenant_id','record_change','Record change','active',pg_catalog.clock_timestamp(),'$actor_id',pg_catalog.clock_timestamp(),1);
  select * from vortex_identity.ensure_identity_projection('$identity_id','c4760000-0000-4000-8000-0000000000a1');
  insert into vortex_identity.organization_accounts (organization_account_id, organization_id, identity_id, display_name, state, activated_at, changed_at, state_changed_at, state_changed_by, state_change_correlation_id, revision)
  values ('$account_id','$organization_id','$identity_id','Change actor','active',pg_catalog.clock_timestamp()-interval '1 minute',pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),'$actor_id','c4760000-0000-4000-8000-0000000000a2',1);

  select * from vortex_access.initialize_organization_access_version('$organization_id','$actor_id','c4760000-0000-4000-8000-0000000000a3');
  select * from vortex_access.initialize_platform_permission_catalogue('$organization_id','$actor_id','c4760000-0000-4000-8000-0000000000a4');
  select * from vortex_access.revise_platform_permission_catalogue_metadata('$organization_id',1,'1.0.0','1.0.1','$actor_id','c4760000-0000-4000-8000-0000000000a5');
  select * from vortex_access.coordinate_organization_stewardship_adoption('$organization_id','$account_id','$steward_role_id','change_steward','Change steward','Permanent stewardship for the change proof.','$steward_assignment_id','$steward_delegation_id','$identity_id','c4760000-0000-4000-8000-0000000000a6');
  select * from vortex_access.adopt_shipped_platform_permission_catalogue('$organization_id',2,'1.1.0','sha256:cb42d4b24ebead7fe9e4ba6358115ceb3ae752d3a0b4cbedc458dcb218013778','$actor_id','c4760000-0000-4000-8000-0000000000a7');

  insert into vortex_access.organization_roles (organization_id, role_id, role_kind, role_key, live_revision, created_by, created_at)
  values ('$organization_id','$installer_role_id','custom','application_installer',1,'$actor_id',pg_catalog.statement_timestamp());
  insert into vortex_access.organization_role_permission_entries (organization_id, role_id, role_revision, entry_ordinal, role_kind, role_application_root_id, application_root_id, owner_kind, owner_id, permission_id, registration_kind, registration_owner_id, accepted_registration_revision, catalogue_fingerprint, continuity_revision, meaning_fingerprint)
  select entry.organization_id, '$installer_role_id'::uuid, 1, 1, 'custom', null, entry.application_root_id, entry.owner_kind, entry.owner_id, entry.permission_id, entry.registration_kind, entry.registration_owner_id, entry.registration_revision, registration.permission_catalogue_fingerprint, continuity.continuity_revision, entry.meaning_fingerprint
  from vortex_access.permission_catalogue_entries as entry
  join vortex_access.permission_registration_revisions as registration
    on registration.organization_id = entry.organization_id and registration.registration_kind = entry.registration_kind
    and registration.registration_owner_id = entry.registration_owner_id and registration.revision = entry.registration_revision
  join vortex_access.permission_continuities as continuity
    on continuity.organization_id = entry.organization_id
    and continuity.application_root_id is not distinct from entry.application_root_id
    and continuity.owner_kind = entry.owner_kind and continuity.owner_id = entry.owner_id
    and continuity.permission_id = entry.permission_id
  where entry.organization_id = '$organization_id' and entry.registration_kind = 'platform'
    and entry.registration_revision = 3 and entry.permission_id = '7ecd3304-f16c-47d4-94db-0964980091ba';
  insert into vortex_access.organization_role_revisions (organization_id, role_id, revision, role_kind, lifecycle, privilege_classification, assignment_policy, policy_continuity_revision, authority_continuity_revision, role_key, label, description, changed_by, changed_at, change_correlation_id)
  values ('$organization_id','$installer_role_id',1,'custom','active','privileged','standing',1,1,'application_installer','Application installer','Current storage lifecycle authority.','$actor_id',pg_catalog.statement_timestamp(),'c4760000-0000-4000-8000-0000000000a8');
  insert into vortex_access.organization_role_assignments (organization_id, role_assignment_id, role_id, assignee_kind, organization_account_id, assignment_kind, revision, starts_at, state, granted_by, granted_at, grant_correlation_id, changed_by, changed_at, change_correlation_id)
  values ('$organization_id','$installer_assignment_id','$installer_role_id','organization_account','$account_id','standing',1,pg_catalog.statement_timestamp()-interval '1 minute','live','$actor_id',pg_catalog.statement_timestamp(),'c4760000-0000-4000-8000-0000000000a9','$actor_id',pg_catalog.statement_timestamp(),'c4760000-0000-4000-8000-0000000000a9');

  insert into vortex_definition.roots (root_id, organization_id, kind, key, created_at, created_by)
  values ('$module_root_id','$organization_id','module','vortex.record_change.module',pg_catalog.clock_timestamp()-interval '1 minute','$actor_id'),
         ('$application_root_id','$organization_id','application','vortex.record_change.application',pg_catalog.clock_timestamp()-interval '1 minute','$actor_id');
  insert into vortex_definition.drafts (root_id, draft_revision, draft_source, source_contract_version, source_fingerprint, updated_at, updated_by)
  values ('$module_root_id',1,pg_catalog.jsonb_build_object('source_contract_version','2.0.0','kind','module','key','vortex.record_change.module'),'2.0.0',$(sha "'module:source'"),pg_catalog.statement_timestamp(),'$actor_id'),
         ('$application_root_id',1,pg_catalog.jsonb_build_object('source_contract_version','1.0.0','kind','application','key','vortex.record_change.application'),'1.0.0',$(sha "'application:source'"),pg_catalog.statement_timestamp(),'$actor_id');
  commit;
" >/dev/null
fixture_claimed=1

# The releases, appended by the only writer of release evidence, under a system
# context for the fixture's own organisation.
run_sql "
  begin;
  delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
  select vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind','system','tenantId','$tenant_id','organizationId','$organization_id',
    'sessionId','c4760000-0000-4000-8000-0000000000b1',
    'issuedAt',pg_catalog.clock_timestamp()-interval '1 minute',
    'expiresAt',pg_catalog.clock_timestamp()+interval '5 minutes','accessVersion',1,
    'correlationId','c4760000-0000-4000-8000-0000000000b2','systemActorId','$actor_id',
    'authenticationStrength','service'));
  select * from vortex_definition.append_release('$module_root_id', 1, $(sha "'module:source'"),
    pg_catalog.jsonb_build_object(
      'releaseVersion','2.0.0',
      'compilationOutput',pg_catalog.jsonb_build_object(
        'kind','module','validationContractVersion','2.0.0',
        'resolutionFingerprint',$(sha "'module:resolution'"),
        'artifact',pg_catalog.jsonb_build_object('kind','module','rootId','$module_root_id',
          'definitionKey','vortex.record_change.module','exactVersion','2.0.0',
          'contentFingerprint',$(sha "'module:content'"),'resolutionFingerprint',$(sha "'module:resolution'")),
        'canonical',pg_catalog.jsonb_build_object(
          'envelope',pg_catalog.jsonb_build_object('kind','module','key','vortex.record_change.module',
            'rootId','$module_root_id','organizationId','$organization_id'),
          'content',$module_content)),
      'resolutionSnapshot',pg_catalog.jsonb_build_object('fingerprint',$(sha "'module:resolution'"),
        'definitions',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('kind','module',
          'key','vortex.record_change.module','rootId','$module_root_id','exactVersion','2.0.0'))),
      'contentFingerprint',$(sha "'module:content'"),'resolutionFingerprint',$(sha "'module:resolution'"),
      'validationContractVersion','2.0.0','comparisonFingerprint',$(sha "'module:content'"),
      'impactReasons','[]'::jsonb,'releaseNote','Record change proof Module.','dependencies','[]'::jsonb));
  select * from vortex_definition.append_release('$application_root_id', 1, $(sha "'application:source'"),
    pg_catalog.jsonb_build_object(
      'releaseVersion','1.0.0',
      'compilationOutput',pg_catalog.jsonb_build_object(
        'kind','application','validationContractVersion','1.0.0',
        'resolutionFingerprint',$(sha "'application:resolution'"),
        'artifact',pg_catalog.jsonb_build_object('kind','application','rootId','$application_root_id',
          'definitionKey','vortex.record_change.application','exactVersion','1.0.0',
          'contentFingerprint',$(sha "'application:content'"),'resolutionFingerprint',$(sha "'application:resolution'")),
        'canonical',pg_catalog.jsonb_build_object(
          'envelope',pg_catalog.jsonb_build_object('kind','application','key','vortex.record_change.application',
            'rootId','$application_root_id','organizationId','$organization_id'),
          'content',pg_catalog.jsonb_build_object('permissions','[]'::jsonb))),
      'resolutionSnapshot',pg_catalog.jsonb_build_object('fingerprint',$(sha "'application:resolution'"),
        'definitions',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('kind','application',
          'key','vortex.record_change.application','rootId','$application_root_id','exactVersion','1.0.0'))),
      'contentFingerprint',$(sha "'application:content'"),'resolutionFingerprint',$(sha "'application:resolution'"),
      'validationContractVersion','1.0.0','comparisonFingerprint',$(sha "'application:content'"),
      'impactReasons','[]'::jsonb,'releaseNote','Record change proof Application.',
      'dependencies',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'kind','module','key','vortex.record_change.module','rootId','$module_root_id',
        'releaseRevision',1,'releaseVersion','2.0.0',
        'contentFingerprint',$(sha "'module:content'"),'resolutionFingerprint',$(sha "'module:resolution'")))));
  delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
  commit;
" >/dev/null

# The permission catalogue, the role and its assignment, each through its owning
# writer; then real storage through the Module coordinator.
run_sql "
  begin;
  with release_value as (
    select pg_catalog.jsonb_build_object('kind','module','definitionKey','vortex.record_change.module',
      'rootId','$module_root_id','releaseRevision',1,'releaseVersion','2.0.0',
      'validationContractVersion','2.0.0','contentFingerprint',$(sha "'module:content'"),
      'resolutionFingerprint',$(sha "'module:resolution'")) as value
  ), application_release as (
    select pg_catalog.jsonb_build_object('kind','application','definitionKey','vortex.record_change.application',
      'rootId','$application_root_id','releaseRevision',1,'releaseVersion','1.0.0',
      'validationContractVersion','1.0.0','contentFingerprint',$(sha "'application:content'"),
      'resolutionFingerprint',$(sha "'application:resolution'")) as value
  ), entries as (
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'applicationRootId','$application_root_id','ownerKind','module','ownerId','$module_root_id',
        'permission',permission.value,'sourceRelease',release_value.value,
        'meaningFingerprint',$(sha "'meaning:' || (permission.value ->> 'permissionId')"))
      order by (permission.value ->> 'key') collate \"C\", (permission.value ->> 'permissionId') collate \"C\") as value
    from release_value, pg_catalog.jsonb_array_elements($permissions_sql) as permission(value)
  ), candidate as (
    select pg_catalog.jsonb_build_object('contractVersion','1.0.0','organizationId','$organization_id',
      'applicationRootId','$application_root_id','applicationRelease',application_release.value,
      'applicationCatalogueFingerprint',$(sha "'catalogue'"),
      'applicationPermissionIds','[]'::jsonb,
      'entries',entries.value,'candidateFingerprint',$(sha "'candidate'")) as value,
      entries.value as entry_values
    from application_release, entries
  )
  select 1 from candidate, vortex_access.coordinate_application_access_change('register', null,
    pg_catalog.jsonb_build_object('contractVersion','1.0.0',
      'preparationBasis','{\"kind\":\"registration_candidate\"}'::jsonb,
      'permissionRegistration',candidate.value,
      'templates',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'template',pg_catalog.jsonb_build_object('roleId','c4760000-0000-4000-8000-0000000000c1',
          'key','change_template','name','Change template','homePageId','c4760000-0000-4000-8000-0000000000c2',
          'permissionKeys','[\"record_change.read\",\"record_change.update\"]'::jsonb,
          'permissionSelection','{\"kind\":\"exact\"}'::jsonb),
        'sourceTemplateFingerprint',$(sha "'template'"),
        'sourcePermissions',candidate.entry_values,'livePermissions',candidate.entry_values)),
      'candidateFingerprint',$(sha "'preparation'")),
    '$organization_id','$application_root_id','$actor_id','c4760000-0000-4000-8000-0000000000c3');
  select 1 from vortex_access.coordinate_organization_role_change(
    pg_catalog.jsonb_build_object('contractVersion','1.0.0',
      'candidate',pg_catalog.jsonb_build_object('operation','create_custom','organizationId','$organization_id',
        'roleId','$role_id','key','record_change_role','label','Record change role',
        'description','Read and change the concurrency record.',
        'privilegeClassification','standard','assignmentPolicy','{\"kind\":\"standing\"}'::jsonb,
        'permissions',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'kind','exact','applicationRootId',entry.application_root_id,'ownerKind',entry.owner_kind,
            'ownerId',entry.owner_id,'permissionId',entry.permission_id,
            'acceptedRegistrationRevision',registration.revision,
            'catalogueFingerprint',registration.permission_catalogue_fingerprint,
            'continuityRevision',continuity.continuity_revision,'meaningFingerprint',entry.meaning_fingerprint)
          order by entry.application_root_id, entry.owner_kind collate \"C\", entry.owner_id, entry.permission_id)
          from vortex_access.permission_registrations as registration
          join vortex_access.permission_catalogue_entries as entry
            on entry.organization_id = registration.organization_id
            and entry.registration_kind = registration.registration_kind
            and entry.registration_owner_id = registration.registration_owner_id
            and entry.registration_revision = registration.revision
          join vortex_access.permission_continuities as continuity
            on continuity.organization_id = entry.organization_id
            and continuity.application_root_id is not distinct from entry.application_root_id
            and continuity.owner_kind = entry.owner_kind and continuity.owner_id = entry.owner_id
            and continuity.permission_id = entry.permission_id
          where registration.organization_id = '$organization_id'
            and registration.registration_owner_id = '$application_root_id')),
      'roleCandidateFingerprint',$(sha "'role'")),
    '$actor_id','c4760000-0000-4000-8000-0000000000c4');
  select 1 from vortex_access.coordinate_organization_role_assignment_change('grant','$organization_id',
    '$assignment_id',null,'$role_id',1,'organization_account','$account_id',null,'standing',
    pg_catalog.clock_timestamp()-interval '1 minute',null,'$actor_id','c4760000-0000-4000-8000-0000000000c5');
  commit;
" >/dev/null

run_sql "
  begin;
  delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
  $(human_context "(select current_version from vortex_access.organization_access_versions where organization_id='$organization_id')")
  set local role vortex_request;
  select 1 from vortex_module.provision_module_installation_storage('$application_root_id',1,'$module_root_id',1,null);
  reset role;
  delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
  set local role vortex_module_owner;
  update vortex_module.installation_bindings set state = 'active' where organization_id = '$organization_id';
  reset role;
  commit;
" >/dev/null

# The two records the races act on, written as the adapter owner because the
# create adapter is #402.
run_sql "
  begin;
  delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
  $(human_context "(select current_version from vortex_access.organization_access_versions where organization_id='$organization_id')")
  set local role vortex_record_adapter;
  insert into record_data.$physical_table (
    organisation_id, module_root_id, record_type_id, storage_contract_id, record_id,
    application_root_id, definition_revision, lifecycle_state, concurrency_number,
    created_at, created_by, updated_at, updated_by, deleted_at, deleted_by,
    $column_one, $column_reference,
    $column_link, $column_required_link
  ) values
    ('$organization_id','$module_root_id','$record_type_id','$storage_contract_id','$conflict_record_id',
      null,1,'active',1,pg_catalog.statement_timestamp(),'$account_id',pg_catalog.statement_timestamp(),'$account_id',null,null,'start','RC-EXIST-1',null,
      pg_catalog.jsonb_build_object('recordTypeId','$record_type_id','recordId','$anchor_record_id')),
    ('$organization_id','$module_root_id','$record_type_id','$storage_contract_id','$revocation_record_id',
      null,1,'active',1,pg_catalog.statement_timestamp(),'$account_id',pg_catalog.statement_timestamp(),'$account_id',null,null,'start','RC-EXIST-2',null,
      pg_catalog.jsonb_build_object('recordTypeId','$record_type_id','recordId','$anchor_record_id')),
    ('$organization_id','$module_root_id','$record_type_id','$storage_contract_id','$link_source_record_id',
      null,1,'active',1,pg_catalog.statement_timestamp(),'$account_id',pg_catalog.statement_timestamp(),'$account_id',null,null,
      'link source','RC-EXIST-3',pg_catalog.jsonb_build_object(
        'recordTypeId','$record_type_id','recordId','$link_target_record_id'),
      pg_catalog.jsonb_build_object('recordTypeId','$record_type_id','recordId','$anchor_record_id')),
    ('$organization_id','$module_root_id','$record_type_id','$storage_contract_id','$link_target_record_id',
      null,1,'active',1,pg_catalog.statement_timestamp(),'$account_id',pg_catalog.statement_timestamp(),'$account_id',null,null,
      'link target','RC-EXIST-4',null,
      pg_catalog.jsonb_build_object('recordTypeId','$record_type_id','recordId','$anchor_record_id')),
    ('$organization_id','$module_root_id','$record_type_id','$storage_contract_id','$anchor_record_id',
      null,1,'active',1,pg_catalog.statement_timestamp(),'$account_id',pg_catalog.statement_timestamp(),'$account_id',null,null,
      'anchor','RC-EXIST-5',null,
      pg_catalog.jsonb_build_object('recordTypeId','$record_type_id','recordId','$anchor_record_id')),
    ('$organization_id','$module_root_id','$record_type_id','$storage_contract_id','$link_add_source_record_id',
      null,1,'active',1,pg_catalog.statement_timestamp(),'$account_id',pg_catalog.statement_timestamp(),'$account_id',null,null,
      'link add source','RC-EXIST-6',null,
      pg_catalog.jsonb_build_object('recordTypeId','$record_type_id','recordId','$anchor_record_id')),
    ('$organization_id','$module_root_id','$record_type_id','$storage_contract_id','$link_add_target_record_id',
      null,1,'active',1,pg_catalog.statement_timestamp(),'$account_id',pg_catalog.statement_timestamp(),'$account_id',null,null,
      'link add target','RC-EXIST-7',null,
      pg_catalog.jsonb_build_object('recordTypeId','$record_type_id','recordId','$anchor_record_id')),
    ('$organization_id','$module_root_id','$record_type_id','$storage_contract_id','$restore_target_record_id',
      null,1,'active',1,pg_catalog.statement_timestamp(),'$account_id',pg_catalog.statement_timestamp(),'$account_id',null,null,
      'restore target','RC-EXIST-8',null,
      pg_catalog.jsonb_build_object('recordTypeId','$record_type_id','recordId','$anchor_record_id')),
    ('$organization_id','$module_root_id','$record_type_id','$storage_contract_id','$restore_source_record_id',
      null,1,'soft_deleted',1,pg_catalog.statement_timestamp(),'$account_id',pg_catalog.statement_timestamp(),'$account_id',
      pg_catalog.statement_timestamp(),'$account_id',
      'restore source','RC-EXIST-9',null,
      pg_catalog.jsonb_build_object('recordTypeId','$record_type_id','recordId','$restore_target_record_id'));
  insert into vortex_record.relationship_edges (
    relationship_id, from_organisation_id, to_organisation_id,
    from_application_root_id, to_application_root_id,
    from_storage_contract_id, from_record_id, to_storage_contract_id, to_record_id
  ) values (
    '$relationship_id','$organization_id','$organization_id',null,null,
    '$storage_contract_id','$link_source_record_id','$storage_contract_id','$link_target_record_id'
  );
  insert into vortex_record.relationship_edges (
    relationship_id, from_organisation_id, to_organisation_id,
    from_application_root_id, to_application_root_id,
    from_storage_contract_id, from_record_id, to_storage_contract_id, to_record_id
  ) select '$relationship_required','$organization_id','$organization_id',null,null,
      '$storage_contract_id', source_id, '$storage_contract_id', target_id
    from (values
      ('$conflict_record_id'::uuid,'$anchor_record_id'::uuid),
      ('$revocation_record_id'::uuid,'$anchor_record_id'::uuid),
      ('$link_source_record_id'::uuid,'$anchor_record_id'::uuid),
      ('$link_target_record_id'::uuid,'$anchor_record_id'::uuid),
      ('$anchor_record_id'::uuid,'$anchor_record_id'::uuid),
      ('$link_add_source_record_id'::uuid,'$anchor_record_id'::uuid),
      ('$link_add_target_record_id'::uuid,'$anchor_record_id'::uuid),
      ('$restore_target_record_id'::uuid,'$anchor_record_id'::uuid),
      ('$restore_source_record_id'::uuid,'$restore_target_record_id'::uuid)
    ) as required_edge(source_id, target_id);
  reset role;
  delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
  commit;
" >/dev/null

change_statement() {
  local record_id="$1" value="$2"
  printf "vortex_record.change_record('%s'::uuid,'%s'::uuid,1,
    pg_catalog.jsonb_build_object('%s','%s'), array['%s']::uuid[])" \
    "$record_type_id" "$record_id" "$field_one" "$value" "$field_one"
}

create_statement() {
  local title="$1"
  printf "vortex_record.create_record_internal('%s'::uuid,
    pg_catalog.jsonb_build_object('%s','%s','%s',pg_catalog.jsonb_build_object(
      'recordTypeId','%s','recordId','%s')),
    array['%s','%s']::uuid[], null)" \
    "$record_type_id" "$field_one" "$title" "$field_required_link" \
    "$record_type_id" "$anchor_record_id" "$field_one" "$field_required_link"
}

relationship_clear_statement() {
  printf "vortex_record.change_record_relationship_internal('%s'::uuid,'%s'::uuid,1,
    '%s'::uuid,'null'::jsonb)" "$record_type_id" "$link_source_record_id" "$relationship_id"
}

relationship_add_statement() {
  local source_id="$1" target_id="$2"
  printf "vortex_record.change_record_relationship_internal('%s'::uuid,'%s'::uuid,1,
    '%s'::uuid,pg_catalog.jsonb_build_object('recordTypeId','%s','recordId','%s'))" \
    "$record_type_id" "$source_id" "$relationship_id" "$record_type_id" "$target_id"
}

delete_target_statement() {
  local target_id="${1:-$link_target_record_id}"
  printf "vortex_record.soft_delete_record_internal('%s'::uuid,'%s'::uuid,1)" \
    "$record_type_id" "$target_id"
}

restore_statement() {
  local source_id="$1"
  printf "vortex_record.restore_record_internal('%s'::uuid,'%s'::uuid,1)" \
    "$record_type_id" "$source_id"
}

# Ground truth for one row. The generated table's scope policy reads the request
# context, so this needs one of its own; the context is established inside a DO
# block so that only the row state reaches standard output.
row_state() {
  local record_id="$1"
  run_sql "
    begin;
    do \$context\$
    begin
      delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
      perform vortex_context.initialize(pg_catalog.jsonb_build_object(
        'callerKind','human','identityAuthorityId','$actor_id','tenantId','$tenant_id',
        'organizationId','$organization_id','organizationAccountId','$account_id',
        'identityId','$identity_id','applicationRootId','$application_root_id',
        'sessionId','c4760000-0000-4000-8000-0000000000f1',
        'authenticationStrength','single_factor',
        'issuedAt',pg_catalog.statement_timestamp(),
        'expiresAt',pg_catalog.statement_timestamp()+interval '1 hour',
        'accessVersion',(
          select version.current_version from vortex_access.organization_access_versions as version
          where version.organization_id = '$organization_id'
        ),
        'correlationId','c4760000-0000-4000-8000-0000000000f2',
        'accessTokenIssuedAt',pg_catalog.statement_timestamp(),
        'primaryAuthenticatedAt',pg_catalog.statement_timestamp()));
    end
    \$context\$;
    set local role vortex_record_adapter;
    select pg_catalog.concat_ws('|', concurrency_number::text, $column_one)
    from record_data.$physical_table where record_id = '$record_id';
    reset role;
    commit;
  "
}

link_delete_state() {
  run_sql "
    begin;
    delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
    $(human_context "(select current_version from vortex_access.organization_access_versions where organization_id='$organization_id')")
    set local role vortex_record_adapter;
    select pg_catalog.concat_ws('|', target.lifecycle_state, target.concurrency_number::text,
      source.lifecycle_state, source.concurrency_number::text,
      (source.$column_link is null)::text,
      (select pg_catalog.count(*)::text from vortex_record.relationship_edges as edge
       where edge.relationship_id='$relationship_id' and edge.from_record_id='$link_source_record_id'))
    from record_data.$physical_table as target
    cross join record_data.$physical_table as source
    where target.record_id='$link_target_record_id' and source.record_id='$link_source_record_id';
    reset role;
    commit;
  "
}

target_race_state() {
  local source_id="$1" target_id="$2" relationship="$3"
  run_sql "
    begin;
    delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
    $(human_context "(select current_version from vortex_access.organization_access_versions where organization_id='$organization_id')")
    set local role vortex_record_adapter;
    select pg_catalog.concat_ws('|', source.lifecycle_state, source.concurrency_number::text,
      (source.$column_link is null)::text, target.lifecycle_state, target.concurrency_number::text,
      (select pg_catalog.count(*)::text from vortex_record.relationship_edges as edge
       where edge.relationship_id='$relationship' and edge.from_record_id='$source_id'))
    from record_data.$physical_table as source
    cross join record_data.$physical_table as target
    where source.record_id='$source_id' and target.record_id='$target_id';
    reset role;
    commit;
  "
}

# ----------------------------------------------------------------------------
# Race zero: two creates in one published reference-number scope. The first
# transaction holds the new counter row uncommitted so the second must wait for
# that exact database lock before it can allocate the next value.
# ----------------------------------------------------------------------------
access_version="$(current_version)"

"${psql_command[@]}" >"$proof_root/reference-first.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/reference-first.pid'
$(human_context "$access_version")
set local role vortex_record_adapter;
select pg_catalog.concat_ws('|', result ->> 'outcome',
  result -> 'values' ->> '$field_reference')
from (select $(create_statement 'first reference') as result) as created
\g '$proof_root/reference-first.result'
reset role;
\! touch '$proof_root/reference-first-ready'
\! deadline=600; while [ ! -f '$proof_root/reference-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/reference-release' ]
commit;
SQL
reference_first_pid=$!; worker_pids+=("$reference_first_pid")
wait_for_file "$proof_root/reference-first-ready"
reference_first_backend="$(read_backend_pid "$proof_root/reference-first.pid")"

"${psql_command[@]}" >"$proof_root/reference-second.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/reference-second.pid'
$(human_context "$access_version")
set local role vortex_record_adapter;
select pg_catalog.concat_ws('|', result ->> 'outcome',
  result -> 'values' ->> '$field_reference')
from (select $(create_statement 'second reference') as result) as created
\g '$proof_root/reference-second.result'
reset role;
commit;
SQL
reference_second_pid=$!; worker_pids+=("$reference_second_pid")
reference_second_backend="$(read_backend_pid "$proof_root/reference-second.pid")"
wait_for_database_blocker "$reference_second_backend" "$reference_first_backend" 'the second reference create'
touch "$proof_root/reference-release"

wait_owned_worker "$reference_first_pid" || { echo 'the first reference create failed' >&2; exit 1; }
wait_owned_worker "$reference_second_pid" || { echo 'the waiting reference create failed' >&2; exit 1; }

reference_first_result="$(tr -d '[:space:]' <"$proof_root/reference-first.result")"
reference_second_result="$(tr -d '[:space:]' <"$proof_root/reference-second.result")"
[ "$reference_first_result" = 'completed|RC-001' ] || {
  printf 'the first reference allocation was not exact: %q\n' "$reference_first_result" >&2; exit 1
}
[ "$reference_second_result" = 'completed|RC-002' ] || {
  printf 'the waiting reference allocation was not exact: %q\n' "$reference_second_result" >&2; exit 1
}
reference_state="$(run_sql "select pg_catalog.concat_ws('|', pg_catalog.count(*)::text,
  pg_catalog.count(distinct $column_reference)::text, pg_catalog.min($column_reference),
  pg_catalog.max($column_reference)) from record_data.$physical_table
  where $column_one in ('first reference','second reference');")"
[ "$reference_state" = '2|2|RC-001|RC-002' ] || {
  printf 'concurrent reference rows were not unique and exact: %q\n' "$reference_state" >&2; exit 1
}
echo "reference race: two rows received RC-001 and RC-002 under one locked scope"

# ----------------------------------------------------------------------------
# Race one: a link clear and deletion of that link's target contend on the same
# source row. Once the fixture lock is released, database row locking either
# serializes both operations or makes the late link command stale.
# ----------------------------------------------------------------------------
access_version="$(current_version)"

"${psql_command[@]}" >"$proof_root/link-delete-holder.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/link-delete-holder.pid'
$(human_context "$access_version")
set local role vortex_record_adapter;
select record_id from record_data.$physical_table
where record_id='$link_source_record_id' for update \g /dev/null
reset role;
\! touch '$proof_root/link-delete-holder-ready'
\! deadline=600; while [ ! -f '$proof_root/link-delete-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/link-delete-release' ]
rollback;
SQL
link_holder_pid=$!; worker_pids+=("$link_holder_pid")
wait_for_file "$proof_root/link-delete-holder-ready"
link_holder_backend="$(read_backend_pid "$proof_root/link-delete-holder.pid")"

"${psql_command[@]}" >"$proof_root/link-clear.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/link-clear.pid'
$(human_context "$access_version")
set local role vortex_record_adapter;
select $(relationship_clear_statement) ->> 'outcome' \g '$proof_root/link-clear.result'
reset role;
commit;
SQL
link_clear_pid=$!; worker_pids+=("$link_clear_pid")
link_clear_backend="$(read_backend_pid "$proof_root/link-clear.pid")"
wait_for_database_blocker "$link_clear_backend" "$link_holder_backend" 'the link clear'

"${psql_command[@]}" >"$proof_root/link-delete.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/link-delete.pid'
$(human_context "$access_version")
set local role vortex_record_adapter;
select $(delete_target_statement) ->> 'outcome' \g '$proof_root/link-delete.result'
reset role;
commit;
SQL
link_delete_pid=$!; worker_pids+=("$link_delete_pid")
link_delete_backend="$(read_backend_pid "$proof_root/link-delete.pid")"
if ! wait_for_database_blocker "$link_delete_backend" "$link_holder_backend" 'the target delete'; then
  if ! kill -0 "$link_delete_pid" >/dev/null 2>&1; then
    wait_owned_worker "$link_delete_pid" || true
    printf 'target delete completed before the source lock; result=%q\n' \
      "$(tr -d '[:space:]' <"$proof_root/link-delete.result" 2>/dev/null || true)" >&2
  fi
  exit 1
fi
touch "$proof_root/link-delete-release"

wait_owned_worker "$link_holder_pid" || { echo 'the link/delete holder failed' >&2; exit 1; }
wait_owned_worker "$link_clear_pid" || { echo 'the racing link clear failed' >&2; exit 1; }
wait_owned_worker "$link_delete_pid" || { echo 'the racing target delete failed' >&2; exit 1; }

link_clear_result="$(tr -d '[:space:]' <"$proof_root/link-clear.result")"
link_delete_result="$(tr -d '[:space:]' <"$proof_root/link-delete.result")"
[[ "$link_clear_result" = 'completed' || "$link_clear_result" = 'conflict' ]] || {
  printf 'the link clear neither serialized nor failed stale: %q\n' "$link_clear_result" >&2; exit 1
}
[ "$link_delete_result" = 'completed' ] || {
  printf 'the target delete did not complete safely: %q\n' "$link_delete_result" >&2; exit 1
}
link_state="$(link_delete_state | tr -d '[:space:]')"
[ "$link_state" = 'soft_deleted|2|active|2|true|0' ] || {
  printf 'the link/delete race left partial state: %q\n' "$link_state" >&2; exit 1
}
echo "link/delete race: link=$link_clear_result delete=$link_delete_result state=$link_state"

# ----------------------------------------------------------------------------
# Race two: deleting a target wins the target-row lock before a new link add.
# The waiting add must re-read the locked target and refuse; it cannot install a
# value/edge that points at the now-deleted row.
# ----------------------------------------------------------------------------
access_version="$(current_version)"

"${psql_command[@]}" >"$proof_root/link-add-holder.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/link-add-holder.pid'
$(human_context "$access_version")
set local role vortex_record_adapter;
select record_id from record_data.$physical_table
where record_id='$link_add_target_record_id' for update \g /dev/null
reset role;
\! touch '$proof_root/link-add-holder-ready'
\! deadline=600; while [ ! -f '$proof_root/link-add-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/link-add-release' ]
rollback;
SQL
link_add_holder_pid=$!; worker_pids+=("$link_add_holder_pid")
wait_for_file "$proof_root/link-add-holder-ready"
link_add_holder_backend="$(read_backend_pid "$proof_root/link-add-holder.pid")"

"${psql_command[@]}" >"$proof_root/link-add-delete.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/link-add-delete.pid'
$(human_context "$access_version")
set local role vortex_record_adapter;
select $(delete_target_statement "$link_add_target_record_id") ->> 'outcome'
\g '$proof_root/link-add-delete.result'
reset role;
commit;
SQL
link_add_delete_pid=$!; worker_pids+=("$link_add_delete_pid")
link_add_delete_backend="$(read_backend_pid "$proof_root/link-add-delete.pid")"
wait_for_database_blocker "$link_add_delete_backend" "$link_add_holder_backend" 'the link-add target delete'

"${psql_command[@]}" >"$proof_root/link-add.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/link-add.pid'
$(human_context "$access_version")
set local role vortex_record_adapter;
select pg_catalog.concat_ws('|', result ->> 'outcome', result ->> 'reasonCode')
from (select $(relationship_add_statement "$link_add_source_record_id" "$link_add_target_record_id") as result) as changed
\g '$proof_root/link-add.result'
reset role;
commit;
SQL
link_add_pid=$!; worker_pids+=("$link_add_pid")
link_add_backend="$(read_backend_pid "$proof_root/link-add.pid")"
wait_for_database_blocker "$link_add_backend" "$link_add_holder_backend" 'the link add'
touch "$proof_root/link-add-release"

wait_owned_worker "$link_add_holder_pid" || { echo 'the link-add holder failed' >&2; exit 1; }
wait_owned_worker "$link_add_delete_pid" || { echo 'the link-add target delete failed' >&2; exit 1; }
wait_owned_worker "$link_add_pid" || { echo 'the waiting link add failed' >&2; exit 1; }

link_add_delete_result="$(tr -d '[:space:]' <"$proof_root/link-add-delete.result")"
link_add_result="$(tr -d '[:space:]' <"$proof_root/link-add.result")"
[ "$link_add_delete_result" = 'completed' ] || {
  printf 'the earlier target delete did not complete: %q\n' "$link_add_delete_result" >&2; exit 1
}
[ "$link_add_result" = 'refused|relationship_unavailable' ] || {
  printf 'the waiting link add did not refuse the deleted target: %q\n' "$link_add_result" >&2; exit 1
}
link_add_state="$(target_race_state "$link_add_source_record_id" "$link_add_target_record_id" "$relationship_id" | tr -d '[:space:]')"
[ "$link_add_state" = 'active|1|true|soft_deleted|2|0' ] || {
  printf 'the link-add/delete race left partial state: %q\n' "$link_add_state" >&2; exit 1
}
echo "link-add/delete race: add=$link_add_result delete=$link_add_delete_result state=$link_add_state"

# ----------------------------------------------------------------------------
# Race three: a restore waits behind deletion of its required target. The
# restore must recheck that locked target and refuse without reviving its row.
# ----------------------------------------------------------------------------
access_version="$(current_version)"

"${psql_command[@]}" >"$proof_root/restore-target-holder.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/restore-target-holder.pid'
$(human_context "$access_version")
set local role vortex_record_adapter;
select record_id from record_data.$physical_table
where record_id='$restore_target_record_id' for update \g /dev/null
reset role;
\! touch '$proof_root/restore-target-holder-ready'
\! deadline=600; while [ ! -f '$proof_root/restore-target-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/restore-target-release' ]
rollback;
SQL
restore_holder_pid=$!; worker_pids+=("$restore_holder_pid")
wait_for_file "$proof_root/restore-target-holder-ready"
restore_holder_backend="$(read_backend_pid "$proof_root/restore-target-holder.pid")"

"${psql_command[@]}" >"$proof_root/restore-target-delete.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/restore-target-delete.pid'
$(human_context "$access_version")
set local role vortex_record_adapter;
select $(delete_target_statement "$restore_target_record_id") ->> 'outcome'
\g '$proof_root/restore-target-delete.result'
reset role;
commit;
SQL
restore_delete_pid=$!; worker_pids+=("$restore_delete_pid")
restore_delete_backend="$(read_backend_pid "$proof_root/restore-target-delete.pid")"
wait_for_database_blocker "$restore_delete_backend" "$restore_holder_backend" 'the restore target delete'

"${psql_command[@]}" >"$proof_root/restore-target.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/restore-target.pid'
$(human_context "$access_version")
set local role vortex_record_adapter;
select pg_catalog.concat_ws('|', result ->> 'outcome', result ->> 'reasonCode')
from (select $(restore_statement "$restore_source_record_id") as result) as restored
\g '$proof_root/restore-target.result'
reset role;
commit;
SQL
restore_pid=$!; worker_pids+=("$restore_pid")
restore_backend="$(read_backend_pid "$proof_root/restore-target.pid")"
wait_for_database_blocker "$restore_backend" "$restore_holder_backend" 'the restore waiting on its target'
touch "$proof_root/restore-target-release"

wait_owned_worker "$restore_holder_pid" || { echo 'the restore-target holder failed' >&2; exit 1; }
wait_owned_worker "$restore_delete_pid" || { echo 'the restore-target delete failed' >&2; exit 1; }
wait_owned_worker "$restore_pid" || { echo 'the waiting restore failed' >&2; exit 1; }

restore_delete_result="$(tr -d '[:space:]' <"$proof_root/restore-target-delete.result")"
restore_result="$(tr -d '[:space:]' <"$proof_root/restore-target.result")"
[ "$restore_delete_result" = 'completed' ] || {
  printf 'the earlier required target delete did not complete: %q\n' "$restore_delete_result" >&2; exit 1
}
[ "$restore_result" = 'refused|record_unavailable' ] || {
  printf 'restore did not refuse its deleted required target: %q\n' "$restore_result" >&2; exit 1
}
restore_state="$(target_race_state "$restore_source_record_id" "$restore_target_record_id" "$relationship_required" | tr -d '[:space:]')"
[ "$restore_state" = 'soft_deleted|1|true|soft_deleted|2|1' ] || {
  printf 'the restore/target-delete race left partial state: %q\n' "$restore_state" >&2; exit 1
}
echo "restore/target-delete race: restore=$restore_result delete=$restore_delete_result state=$restore_state"

# ----------------------------------------------------------------------------
# Race four: two changes, one expected number.
# ----------------------------------------------------------------------------
access_version="$(current_version)"

"${psql_command[@]}" >"$proof_root/conflict-first.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/conflict-first.pid'
$(human_context "$access_version")
set local role vortex_record_adapter;
select $(change_statement "$conflict_record_id" 'first writer') ->> 'outcome'
\g '$proof_root/conflict-first.result'
reset role;
\! touch '$proof_root/conflict-first-ready'
\! deadline=600; while [ ! -f '$proof_root/conflict-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/conflict-release' ]
commit;
SQL
first_pid=$!; worker_pids+=("$first_pid")
wait_for_file "$proof_root/conflict-first-ready"
first_backend="$(read_backend_pid "$proof_root/conflict-first.pid")"

"${psql_command[@]}" >"$proof_root/conflict-second.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/conflict-second.pid'
$(human_context "$access_version")
set local role vortex_record_adapter;
select $(change_statement "$conflict_record_id" 'second writer') ->> 'outcome'
\g '$proof_root/conflict-second.result'
reset role;
commit;
SQL
second_pid=$!; worker_pids+=("$second_pid")
second_backend="$(read_backend_pid "$proof_root/conflict-second.pid")"
wait_for_database_blocker "$second_backend" "$first_backend" 'the second record change'
touch "$proof_root/conflict-release"

wait_owned_worker "$first_pid" || { echo 'the first change failed' >&2; exit 1; }
wait_owned_worker "$second_pid" || { echo 'the waiting change failed' >&2; exit 1; }

first_result="$(tr -d '[:space:]' <"$proof_root/conflict-first.result")"
second_result="$(tr -d '[:space:]' <"$proof_root/conflict-second.result")"
[ "$first_result" = 'allowed' ] || {
  printf 'the lock holder did not write: %q\n' "$first_result" >&2; exit 1
}
[ "$second_result" = 'conflict' ] || {
  printf 'the waiting change did not report a conflict: %q\n' "$second_result" >&2; exit 1
}

conflict_state="$(row_state "$conflict_record_id")"
[ "$conflict_state" = '2|first writer' ] || {
  printf 'exactly one write did not land: %q\n' "$conflict_state" >&2; exit 1
}
echo "conflict race: second change returned conflict, row is $conflict_state"

# ----------------------------------------------------------------------------
# Race five: the acting account's own role assignment is revoked while a change
# waits at the row lock.
# ----------------------------------------------------------------------------
access_version="$(current_version)"

"${psql_command[@]}" >"$proof_root/revocation-holder.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/revocation-holder.pid'
$(human_context "$access_version")
set local role vortex_record_adapter;
select record_id from record_data.$physical_table
where record_id = '$revocation_record_id' for update \g /dev/null
reset role;
\! touch '$proof_root/revocation-holder-ready'
\! deadline=600; while [ ! -f '$proof_root/revocation-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/revocation-release' ]
rollback;
SQL
holder_pid=$!; worker_pids+=("$holder_pid")
wait_for_file "$proof_root/revocation-holder-ready"
holder_backend="$(read_backend_pid "$proof_root/revocation-holder.pid")"

"${psql_command[@]}" >"$proof_root/revocation-change.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/revocation-change.pid'
$(human_context "$access_version")
set local role vortex_record_adapter;
select $(change_statement "$revocation_record_id" 'stale writer') ->> 'outcome'
\g '$proof_root/revocation-change.result'
reset role;
commit;
SQL
change_pid=$!; worker_pids+=("$change_pid")
change_backend="$(read_backend_pid "$proof_root/revocation-change.pid")"
wait_for_database_blocker "$change_backend" "$holder_backend" 'the revocation-race change'

run_sql "
  select 1 from vortex_access.coordinate_organization_role_assignment_change('revoke','$organization_id',
    '$assignment_id',1,null,null,null,null,null,null,null,null,'$actor_id','c4760000-0000-4000-8000-0000000000d1');
" >/dev/null
touch "$proof_root/revocation-release"

wait_owned_worker "$holder_pid" || { echo 'the lock holder failed' >&2; exit 1; }
if wait_owned_worker "$change_pid"; then
  echo 'the change racing its own revoked authority committed' >&2
  exit 1
fi

grep -qE 'ERROR: +42501' "$proof_root/revocation-change.log" || {
  echo 'the racing change was not refused by a protected 42501 refusal' >&2
  tail -n 20 "$proof_root/revocation-change.log" >&2
  exit 1
}

revocation_state="$(row_state "$revocation_record_id")"
[ "$revocation_state" = '1|start' ] || {
  printf 'the refused change wrote something: %q\n' "$revocation_state" >&2; exit 1
}
assignment_state="$(run_sql "select state from vortex_access.organization_role_assignments where organization_id='$organization_id' and role_assignment_id='$assignment_id';")"
[ "$assignment_state" = 'revoked' ] || {
  printf 'the revocation did not commit: %q\n' "$assignment_state" >&2; exit 1
}
echo "revocation race: the waiting change was refused, row is $revocation_state"

echo 'record change concurrency proof passed'
