#!/usr/bin/env bash
# #49: the protected, recoverable parent delete composed with #48's concrete
# relationship totals, under real concurrency, through independent sessions on one
# provisioned installation.
#
#   reparent  -- a parent deletion and a reparenting of that parent's dependent
#                child contend on the same child row. The deletion's one
#                lifecycle traversal locks every affected child before it
#                revises the parent, so the two either serialize or the late
#                command returns a stale/conflict result. The winning delete is
#                finalized and committed in its original transaction. No partial row, edge,
#                cleared link, revision, journal effect, Activity or Event is
#                possible, and a prepared-but-unfinalized delete cannot commit.
#   totals    -- a parent deletion and a concurrent total-bearing save on a
#                SURVIVING parent of that deletion's cascade contend on the
#                surviving parent's row. Whichever waits re-reads the row it was
#                given and either applies against the revision it then sees or
#                returns a conflict. The delete is finalized and committed in
#                its original transaction; the surviving parent never keeps a total
#                written from a closure the other command has already changed.
#
# What enforces this, and how each guard is observable here:
#   * The traversal locks each incoming source row with `for update` and
#     re-checks that source's exact link field after the lock is granted
#     (20260913030000:1119-1160). Dropping that re-check lets the deletion act
#     on a link the reparenting already moved, and the reparent race then
#     observes a cleared or deleted child that no longer points at the parent.
#   * The delete-mode preparation locks every surviving affected record in the
#     canonical concrete identity order and then re-derives its closure,
#     refusing with `restart` if the signatures, the record keys or the
#     journalled deleted set changed while it waited. Dropping either the lock
#     loop or the re-read lets the totals race write a total computed from a
#     closure the concurrent save has already invalidated.
#   * `apply_relationship_total_parent_internal` re-locks each parent and
#     compares its stored revision with the prepared one (20260914013000:651-656),
#     so a surviving parent that moved while this command waited is a conflict,
#     never an overwrite.
#   * The deferred receipt invariant means a delete that prepared but did not
#     finalize cannot commit at all; both races take a successful preparation
#     through its terminal writer before commit.
#
# Fixture: the tenant, organisation, first account and definition roots are
# inserted directly, because no writer creates them. The releases come from
# vortex_definition.append_release, the permission catalogue from the
# coordinated Access registration, the role and assignment from their owning
# writers, and the storage from the Module coordinator. Binding activation (#43)
# and the record rows (#402) follow 475 and record-change-concurrency.test.sh.
set -euo pipefail

readonly proof_root="$(mktemp -d /tmp/vortex-parent-delete.XXXXXX)"
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id='c4950000-0000-4000-8000-000000000001'
readonly organization_id='c4950000-0000-4000-8000-000000000002'
readonly identity_id='c4950000-0000-4000-8000-000000000003'
readonly account_id='c4950000-0000-4000-8000-000000000004'
readonly actor_id='c4950000-0000-4000-8000-000000000005'
readonly application_root_id='c4950000-0000-4000-8000-000000000010'
readonly module_root_id='c4950000-0000-4000-8000-000000000011'

readonly parent_type_id='c4950000-0000-4000-8000-000000000020'
readonly line_type_id='c4950000-0000-4000-8000-000000000021'
readonly category_type_id='c4950000-0000-4000-8000-000000000022'
readonly parent_storage_id='c4950000-0000-4000-8000-000000000030'
readonly line_storage_id='c4950000-0000-4000-8000-000000000031'
readonly category_storage_id='c4950000-0000-4000-8000-000000000032'

readonly field_parent_title='c4950000-0000-4000-8000-000000000040'
readonly field_line_amount='c4950000-0000-4000-8000-000000000041'
readonly field_line_parent='c4950000-0000-4000-8000-000000000042'
readonly field_line_category='c4950000-0000-4000-8000-000000000043'
readonly field_category_title='c4950000-0000-4000-8000-000000000044'
readonly field_category_total='c4950000-0000-4000-8000-000000000045'

readonly relationship_line_parent='c4950000-0000-4000-8000-000000000050'
readonly relationship_line_category='c4950000-0000-4000-8000-000000000051'

readonly permission_parent_read='c4950000-0000-4000-8000-000000000060'
readonly permission_parent_update='c4950000-0000-4000-8000-000000000061'
readonly permission_parent_delete='c4950000-0000-4000-8000-000000000062'
readonly permission_parent_restore='c4950000-0000-4000-8000-000000000063'
readonly permission_line_read='c4950000-0000-4000-8000-000000000064'
readonly permission_line_update='c4950000-0000-4000-8000-000000000065'
readonly permission_line_delete='c4950000-0000-4000-8000-000000000066'
readonly permission_line_restore='c4950000-0000-4000-8000-000000000067'
readonly permission_category_read='c4950000-0000-4000-8000-000000000068'
readonly permission_category_update='c4950000-0000-4000-8000-000000000069'

readonly role_id='c4950000-0000-4000-8000-000000000070'
readonly assignment_id='c4950000-0000-4000-8000-000000000071'
readonly steward_role_id='c4950000-0000-4000-8000-000000000072'
readonly steward_assignment_id='c4950000-0000-4000-8000-000000000073'
readonly steward_delegation_id='c4950000-0000-4000-8000-000000000074'
readonly installer_role_id='c4950000-0000-4000-8000-000000000075'
readonly installer_assignment_id='c4950000-0000-4000-8000-000000000076'

# Reparent race: one parent being deleted, one alternative parent the child is
# concurrently moved to, and the dependent child itself.
readonly reparent_parent_id='c4950000-0000-4000-8000-000000000080'
readonly reparent_other_parent_id='c4950000-0000-4000-8000-000000000081'
readonly reparent_line_id='c4950000-0000-4000-8000-000000000082'
readonly reparent_command='c4950000-0000-4000-8000-000000000083'
readonly reparent_activity='c4950000-0000-4000-8000-000000000084'
readonly reparent_occurrence='c4950000-0000-4000-8000-000000000085'

# Totals race: one parent being deleted, its dependent child, and the surviving
# category whose total both commands want to write.
readonly totals_parent_id='c4950000-0000-4000-8000-000000000090'
readonly totals_line_id='c4950000-0000-4000-8000-000000000091'
readonly totals_category_id='c4950000-0000-4000-8000-000000000092'
readonly totals_rival_line_id='c4950000-0000-4000-8000-000000000093'
readonly totals_command='c4950000-0000-4000-8000-000000000094'
readonly totals_activity='c4950000-0000-4000-8000-000000000095'
readonly totals_occurrence='c4950000-0000-4000-8000-000000000096'

readonly parent_table='rt_c4950000000040008000000000000030'
readonly line_table='rt_c4950000000040008000000000000031'
readonly category_table='rt_c4950000000040008000000000000032'
readonly column_parent_title='f_c4950000000040008000000000000040'
readonly column_line_amount='f_c4950000000040008000000000000041'
readonly column_line_parent='f_c4950000000040008000000000000042'
readonly column_line_category='f_c4950000000040008000000000000043'
readonly column_category_title='f_c4950000000040008000000000000044'
readonly column_category_total='f_c4950000000040008000000000000045'

fixture_claimed=0
declare -a worker_pids=()
declare -A reaped_worker_pids=()

psql_command=(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1)
if [ -n "$database_url" ]; then psql_command+=("$database_url"); fi
run_sql() { "${psql_command[@]}" --command "$1"; }

wait_for_file() {
  local candidate="$1" deadline=$((SECONDS + 20))
  while ((SECONDS < deadline)); do [ -f "$candidate" ] && return 0; sleep 0.05; done
  echo "parent delete proof barrier timed out: $candidate" >&2
  return 1
}

read_backend_pid() {
  local candidate="$1" backend_pid
  wait_for_file "$candidate"
  backend_pid="$(tr -d '[:space:]' <"$candidate")"
  [[ "$backend_pid" =~ ^[1-9][0-9]*$ ]] || {
    printf 'parent delete proof captured invalid backend: %q\n' "$backend_pid" >&2
    return 1
  }
  printf '%s\n' "$backend_pid"
}

wait_for_database_blocker() {
  local blocked_pid="$1" blocking_pid="$2" label="${3:-parent delete}" deadline=$((SECONDS + 20)) state
  while ((SECONDS < deadline)); do
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
  printf 'parent delete proof did not observe %s blocked at the row lock\n' "$label" >&2
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
    delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
    set local role vortex_record_adapter;
    delete from vortex_record.delete_command_effects where organization_id = '$organization_id';
    delete from vortex_record.delete_command_receipts where organization_id = '$organization_id';
    delete from vortex_record.save_command_receipts where organization_id = '$organization_id';
    reset role;
    set local role vortex_record_owner;
    do \$cleanup\$
    begin
    delete from vortex_record.relationship_edges where from_organisation_id = '$organization_id';
      if pg_catalog.to_regclass('record_data.$line_table') is not null then
        execute 'delete from record_data.$line_table where organisation_id = ''$organization_id''';
      end if;
      if pg_catalog.to_regclass('record_data.$category_table') is not null then
        execute 'delete from record_data.$category_table where organisation_id = ''$organization_id''';
      end if;
      if pg_catalog.to_regclass('record_data.$parent_table') is not null then
        execute 'delete from record_data.$parent_table where organisation_id = ''$organization_id''';
      end if;
      execute 'drop table if exists record_data.$line_table';
      execute 'drop table if exists record_data.$category_table';
      execute 'drop table if exists record_data.$parent_table';
      delete from vortex_record.field_storage_mappings
      where storage_contract_id in ('$parent_storage_id','$line_storage_id','$category_storage_id');
      delete from vortex_record.relationship_storage_mappings
      where relationship_id in ('$relationship_line_parent','$relationship_line_category');
    delete from vortex_record.storage_catalogue
      where storage_contract_id in ('$parent_storage_id','$line_storage_id','$category_storage_id');
    delete from vortex_record.record_data_versions where organization_id = '$organization_id';
    delete from vortex_record.record_reference_counters where organization_id = '$organization_id';
    exception when others then
      raise warning 'parent delete proof owner cleanup: %', sqlerrm;
    end
    \$cleanup\$;
    reset role;
    set local role vortex_module_owner;
    delete from vortex_module.installation_bindings where organization_id = '$organization_id';
    reset role;
    delete from pgmq.q_vortex_event_occurrences
      where message ->> 'occurrenceId' in ('$reparent_occurrence','$totals_occurrence');
      delete from vortex_event.event_outbox where organization_id = '$organization_id';
      delete from vortex_activity.organization_activity_entries where organization_id = '$organization_id';
      delete from vortex_access.organization_role_assignments where organization_id = '$organization_id';
      delete from vortex_access.organization_role_revisions where organization_id = '$organization_id';
      delete from vortex_access.organization_role_permission_entries where organization_id = '$organization_id';
      delete from vortex_access.organization_roles where organization_id = '$organization_id';
      delete from vortex_access.permission_catalogue_entries where organization_id = '$organization_id';
      delete from vortex_access.permission_continuities where organization_id = '$organization_id';
      delete from vortex_access.permission_registration_revisions where organization_id = '$organization_id';
      delete from vortex_access.permission_registrations where organization_id = '$organization_id';
      delete from vortex_access.organization_access_versions where organization_id = '$organization_id';
      delete from vortex_definition.releases
      where root_id in ('$module_root_id','$application_root_id');
      delete from vortex_definition.drafts
      where root_id in ('$module_root_id','$application_root_id');
      delete from vortex_definition.roots
      where root_id in ('$module_root_id','$application_root_id');
      delete from vortex_identity.organization_accounts where organization_id = '$organization_id';
      delete from vortex_identity.organizations where organization_id = '$organization_id';
    delete from vortex_identity.tenants where tenant_id = '$tenant_id';
    commit;
  " >/dev/null
}

finalize() {
  local original_status=$? cleanup_status=0 operation_status
  trap - EXIT INT TERM
  set +e
  touch "$proof_root/reparent-release" "$proof_root/totals-release" >/dev/null 2>&1 || true
  stop_owned_workers
  if [ "$original_status" -ne 0 ]; then
    echo 'protected parent delete concurrency proof failed; bounded diagnostics follow' >&2
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
    /tmp/vortex-parent-delete.*) rm -rf -- "$proof_root"; operation_status=$? ;;
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
    pg_catalog.to_regprocedure('vortex_record.prepare_protected_parent_delete(uuid,uuid,uuid,bigint,uuid)') is not null,
    pg_catalog.to_regprocedure('vortex_record.finalize_protected_parent_delete(uuid,uuid,uuid,bigint,uuid,uuid,jsonb)') is not null,
    pg_catalog.to_regprocedure('vortex_record.prepare_relationship_total_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid,jsonb)') is not null,
    pg_catalog.to_regclass('vortex_record.delete_command_effects') is not null,
    pg_catalog.has_function_privilege('vortex_runtime', 'vortex_record.prepare_protected_parent_delete(uuid,uuid,uuid,bigint,uuid)', 'EXECUTE'),
    pg_catalog.has_function_privilege('vortex_runtime', 'vortex_record.finalize_protected_parent_delete(uuid,uuid,uuid,bigint,uuid,uuid,jsonb)', 'EXECUTE'),
    not pg_catalog.has_function_privilege('vortex_runtime', 'vortex_record.prepare_relationship_total_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid,jsonb)', 'EXECUTE')
  );
")"
[ "$schema_state" = 't|t|t|t|t|t|t' ] || {
  echo 'the #49 protected parent delete migration must already be applied to the proof database' >&2
  exit 1
}

sha() { printf "'sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(%s, 'UTF8')), 'hex')" "$1"; }

human_context() {
  local version_expression="$1" session_id="${2:-c4950000-0000-4000-8000-0000000000f1}"
  local correlation_id="${3:-c4950000-0000-4000-8000-0000000000f2}"
  printf "select vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind','human','identityAuthorityId','%s','tenantId','%s','organizationId','%s',
    'organizationAccountId','%s','identityId','%s','applicationRootId','%s',
    'sessionId','%s','authenticationStrength','single_factor',
    'issuedAt',pg_catalog.statement_timestamp(),
    'expiresAt',pg_catalog.statement_timestamp()+interval '1 hour',
    'accessVersion',%s,'correlationId','%s',
    'accessTokenIssuedAt',pg_catalog.statement_timestamp(),
    'primaryAuthenticatedAt',pg_catalog.statement_timestamp()));" \
    "$actor_id" "$tenant_id" "$organization_id" "$account_id" "$identity_id" \
    "$application_root_id" "$session_id" "$version_expression" "$correlation_id"
}

current_version() {
  run_sql "select current_version from vortex_access.organization_access_versions where organization_id='$organization_id';"
}

record_permission() {
  local permission_id="$1" key="$2" record_type="$3" action="$4" readable="$5" changeable="$6"
  printf "pg_catalog.jsonb_build_object('permissionId','%s','key','%s','label','%s',
    'description','Protected parent delete concurrency proof permission.',
    'recordTypeId','%s','recordScope','{\"routes\":[{\"kind\":\"all_records\"}]}'::jsonb,
    'fieldPolicy',pg_catalog.jsonb_build_object('readableFieldIds',%s,'changeableFieldIds',%s),
    'actionKind','%s','administrative',false)" \
    "$permission_id" "$key" "$key" "$record_type" "$readable" "$changeable" "$action"
}

readonly parent_fields="pg_catalog.jsonb_build_array('$field_parent_title')"
readonly line_fields="pg_catalog.jsonb_build_array('$field_line_amount','$field_line_parent','$field_line_category')"
readonly category_fields="pg_catalog.jsonb_build_array('$field_category_title','$field_category_total')"

readonly permissions_sql="pg_catalog.jsonb_build_array(
  $(record_permission "$permission_parent_read" 'parent_delete.parent.read' "$parent_type_id" 'read' "$parent_fields" "'[]'::jsonb"),
  $(record_permission "$permission_parent_update" 'parent_delete.parent.update' "$parent_type_id" 'update' "$parent_fields" "$parent_fields"),
  $(record_permission "$permission_parent_delete" 'parent_delete.parent.delete' "$parent_type_id" 'delete' "$parent_fields" "'[]'::jsonb"),
  $(record_permission "$permission_parent_restore" 'parent_delete.parent.restore' "$parent_type_id" 'restore' "$parent_fields" "'[]'::jsonb"),
  $(record_permission "$permission_line_read" 'parent_delete.line.read' "$line_type_id" 'read' "$line_fields" "'[]'::jsonb"),
  $(record_permission "$permission_line_update" 'parent_delete.line.update' "$line_type_id" 'update' "$line_fields" "$line_fields"),
  $(record_permission "$permission_line_delete" 'parent_delete.line.delete' "$line_type_id" 'delete' "$line_fields" "'[]'::jsonb"),
  $(record_permission "$permission_line_restore" 'parent_delete.line.restore' "$line_type_id" 'restore' "$line_fields" "'[]'::jsonb"),
  $(record_permission "$permission_category_read" 'parent_delete.category.read' "$category_type_id" 'read' "$category_fields" "'[]'::jsonb"),
  $(record_permission "$permission_category_update" 'parent_delete.category.update' "$category_type_id" 'update' "$category_fields" "pg_catalog.jsonb_build_array('$field_category_title')"))"

readonly module_content="pg_catalog.jsonb_build_object(
  'name','Protected parent delete concurrency',
  'description','One parent, one dependent line and one surviving total-bearing category.',
  'dependencies','[]'::jsonb,
  'recordTypes',pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'recordTypeId','$parent_type_id','key','parent','singularLabel','Parent','pluralLabel','Parents',
      'titleFieldId','$field_parent_title','storageContractId','$parent_storage_id',
      'storageScope','application_contained','ownershipMode','organization_account',
      'fields',pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('fieldId','$field_parent_title','key','title','type','text',
          'required',true,'unique',false,'filterable',false,'sortable',false,
          'settings',pg_catalog.jsonb_build_object('maxLength',200))),
      'relationships','[]'::jsonb,
      'standardActions',pg_catalog.jsonb_build_array('read','update','soft_delete','restore'),
      'customActionIds','[]'::jsonb),
    pg_catalog.jsonb_build_object(
      'recordTypeId','$category_type_id','key','category','singularLabel','Category','pluralLabel','Categories',
      'titleFieldId','$field_category_title','storageContractId','$category_storage_id',
      'storageScope','application_contained','ownershipMode','organization_account',
      'fields',pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('fieldId','$field_category_title','key','title','type','text',
          'required',true,'unique',false,'filterable',false,'sortable',false,
          'settings',pg_catalog.jsonb_build_object('maxLength',200)),
        pg_catalog.jsonb_build_object('fieldId','$field_category_total','key','line_total','type','total',
          'required',false,'unique',false,'filterable',false,'sortable',false,
          'settings',pg_catalog.jsonb_build_object('relationshipId','$relationship_line_category',
            'operation','sum','resultType','decimal_number','fieldId','$field_line_amount'))),
      'relationships','[]'::jsonb,
      'standardActions',pg_catalog.jsonb_build_array('read','update'),
      'customActionIds','[]'::jsonb),
    pg_catalog.jsonb_build_object(
      'recordTypeId','$line_type_id','key','line','singularLabel','Line','pluralLabel','Lines',
      'titleFieldId','$field_line_amount','storageContractId','$line_storage_id',
      'storageScope','application_contained','ownershipMode','inherited',
      'ownershipRelationshipId','$relationship_line_parent',
      'fields',pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('fieldId','$field_line_amount','key','amount','type','decimal_number',
          'required',true,'unique',false,'filterable',false,'sortable',false,
          'settings',pg_catalog.jsonb_build_object('digitsBeforeDecimal',10,'decimalPlaces',2)),
        pg_catalog.jsonb_build_object('fieldId','$field_line_parent','key','parent','type','link',
          'required',true,'unique',false,'filterable',false,'sortable',false,
          'settings',pg_catalog.jsonb_build_object(
            'target',pg_catalog.jsonb_build_object('state','resolved','moduleRootId','$module_root_id',
              'recordTypeId','$parent_type_id'),
            'onParentDelete','soft_delete_dependent')),
        pg_catalog.jsonb_build_object('fieldId','$field_line_category','key','category','type','link',
          'required',false,'unique',false,'filterable',false,'sortable',false,
          'settings',pg_catalog.jsonb_build_object(
            'target',pg_catalog.jsonb_build_object('state','resolved','moduleRootId','$module_root_id',
              'recordTypeId','$category_type_id'),
            'onParentDelete','empty_optional'))),
      'relationships',pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('relationshipId','$relationship_line_parent','key','line_parent',
          'fromRecordTypeId','$line_type_id','fromFieldId','$field_line_parent',
          'toRecordType',pg_catalog.jsonb_build_object('state','resolved','moduleRootId','$module_root_id',
            'recordTypeId','$parent_type_id'),
          'cardinality','many_to_one','onParentDelete','soft_delete_dependent'),
        pg_catalog.jsonb_build_object('relationshipId','$relationship_line_category','key','line_category',
          'fromRecordTypeId','$line_type_id','fromFieldId','$field_line_category',
          'toRecordType',pg_catalog.jsonb_build_object('state','resolved','moduleRootId','$module_root_id',
            'recordTypeId','$category_type_id'),
          'cardinality','many_to_one','onParentDelete','empty_optional')),
      'standardActions',pg_catalog.jsonb_build_array('read','update','soft_delete','restore'),
      'customActionIds','[]'::jsonb)),
  'permissions',$permissions_sql,
  'actions','[]'::jsonb,'events','[]'::jsonb,'rules','[]'::jsonb,
  'sharingConditions','[]'::jsonb,'extensionPoints','[]'::jsonb)"

# ----------------------------------------------------------------------------
# Identity, authority, definitions, storage and the race records.
# ----------------------------------------------------------------------------
run_sql "
  begin;
  do \$proof\$
  begin
    if exists (select 1 from vortex_identity.tenants where tenant_id = '$tenant_id')
      or exists (select 1 from vortex_record.storage_catalogue where storage_contract_id = '$parent_storage_id')
      or pg_catalog.to_regclass('record_data.$parent_table') is not null then
      raise exception 'parent delete proof fixture scope already exists';
    end if;
  end
  \$proof\$;

  insert into vortex_identity.tenants (tenant_id, short_name, display_name, state, created_at, created_by, state_changed_at, revision)
  values ('$tenant_id','parent_delete','Parent delete','active',pg_catalog.clock_timestamp(),'$actor_id',pg_catalog.clock_timestamp(),1);
  insert into vortex_identity.organizations (organization_id, tenant_id, short_name, display_name, state, created_at, created_by, state_changed_at, revision)
  values ('$organization_id','$tenant_id','parent_delete','Parent delete','active',pg_catalog.clock_timestamp(),'$actor_id',pg_catalog.clock_timestamp(),1);
  select * from vortex_identity.ensure_identity_projection('$identity_id','c4950000-0000-4000-8000-0000000000a1');
  insert into vortex_identity.organization_accounts (organization_account_id, organization_id, identity_id, display_name, state, activated_at, changed_at, state_changed_at, state_changed_by, state_change_correlation_id, revision)
  values ('$account_id','$organization_id','$identity_id','Delete actor','active',pg_catalog.clock_timestamp()-interval '1 minute',pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),'$actor_id','c4950000-0000-4000-8000-0000000000a2',1);

  select * from vortex_access.initialize_organization_access_version('$organization_id','$actor_id','c4950000-0000-4000-8000-0000000000a3');
  select * from vortex_access.initialize_platform_permission_catalogue('$organization_id','$actor_id','c4950000-0000-4000-8000-0000000000a4');
  select * from vortex_access.revise_platform_permission_catalogue_metadata('$organization_id',1,'1.0.0','1.0.1','$actor_id','c4950000-0000-4000-8000-0000000000a5');
  select * from vortex_access.coordinate_organization_stewardship_adoption('$organization_id','$account_id','$steward_role_id','delete_steward','Delete steward','Permanent stewardship for the parent delete proof.','$steward_assignment_id','$steward_delegation_id','$identity_id','c4950000-0000-4000-8000-0000000000a6');
  select * from vortex_access.adopt_shipped_platform_permission_catalogue('$organization_id',2,'1.1.0','sha256:cb42d4b24ebead7fe9e4ba6358115ceb3ae752d3a0b4cbedc458dcb218013778','$actor_id','c4950000-0000-4000-8000-0000000000a7');

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
  values ('$organization_id','$installer_role_id',1,'custom','active','privileged','standing',1,1,'application_installer','Application installer','Current storage lifecycle authority.','$actor_id',pg_catalog.statement_timestamp(),'c4950000-0000-4000-8000-0000000000a8');
  insert into vortex_access.organization_role_assignments (organization_id, role_assignment_id, role_id, assignee_kind, organization_account_id, assignment_kind, revision, starts_at, state, granted_by, granted_at, grant_correlation_id, changed_by, changed_at, change_correlation_id)
  values ('$organization_id','$installer_assignment_id','$installer_role_id','organization_account','$account_id','standing',1,pg_catalog.statement_timestamp()-interval '1 minute','live','$actor_id',pg_catalog.statement_timestamp(),'c4950000-0000-4000-8000-0000000000a9','$actor_id',pg_catalog.statement_timestamp(),'c4950000-0000-4000-8000-0000000000a9');

  insert into vortex_definition.roots (root_id, organization_id, kind, key, created_at, created_by)
  values ('$module_root_id','$organization_id','module','vortex.parent_delete.module',pg_catalog.clock_timestamp()-interval '1 minute','$actor_id'),
         ('$application_root_id','$organization_id','application','vortex.parent_delete.application',pg_catalog.clock_timestamp()-interval '1 minute','$actor_id');
  insert into vortex_definition.drafts (root_id, draft_revision, draft_source, source_contract_version, source_fingerprint, updated_at, updated_by)
  values ('$module_root_id',1,pg_catalog.jsonb_build_object('source_contract_version','2.0.0','kind','module','key','vortex.parent_delete.module'),'2.0.0',$(sha "'module:source'"),pg_catalog.statement_timestamp(),'$actor_id'),
         ('$application_root_id',1,pg_catalog.jsonb_build_object('source_contract_version','1.0.0','kind','application','key','vortex.parent_delete.application'),'1.0.0',$(sha "'application:source'"),pg_catalog.statement_timestamp(),'$actor_id');
  commit;
" >/dev/null
fixture_claimed=1

run_sql "
  begin;
  delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
  select vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind','system','tenantId','$tenant_id','organizationId','$organization_id',
    'sessionId','c4950000-0000-4000-8000-0000000000b1',
    'issuedAt',pg_catalog.clock_timestamp()-interval '1 minute',
    'expiresAt',pg_catalog.clock_timestamp()+interval '5 minutes','accessVersion',1,
    'correlationId','c4950000-0000-4000-8000-0000000000b2','systemActorId','$actor_id',
    'authenticationStrength','service'));
  select * from vortex_definition.append_release('$module_root_id', 1, $(sha "'module:source'"),
    pg_catalog.jsonb_build_object(
      'releaseVersion','2.0.0',
      'compilationOutput',pg_catalog.jsonb_build_object(
        'kind','module','validationContractVersion','2.0.0',
        'resolutionFingerprint',$(sha "'module:resolution'"),
        'artifact',pg_catalog.jsonb_build_object('kind','module','rootId','$module_root_id',
          'definitionKey','vortex.parent_delete.module','exactVersion','2.0.0',
          'contentFingerprint',$(sha "'module:content'"),'resolutionFingerprint',$(sha "'module:resolution'")),
        'canonical',pg_catalog.jsonb_build_object(
          'envelope',pg_catalog.jsonb_build_object('kind','module','key','vortex.parent_delete.module',
            'rootId','$module_root_id','organizationId','$organization_id'),
          'content',$module_content)),
      'resolutionSnapshot',pg_catalog.jsonb_build_object('fingerprint',$(sha "'module:resolution'"),
        'definitions',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('kind','module',
          'key','vortex.parent_delete.module','rootId','$module_root_id','exactVersion','2.0.0'))),
      'contentFingerprint',$(sha "'module:content'"),'resolutionFingerprint',$(sha "'module:resolution'"),
      'validationContractVersion','2.0.0','comparisonFingerprint',$(sha "'module:content'"),
      'impactReasons','[]'::jsonb,'releaseNote','Parent delete proof Module.','dependencies','[]'::jsonb));
  select * from vortex_definition.append_release('$application_root_id', 1, $(sha "'application:source'"),
    pg_catalog.jsonb_build_object(
      'releaseVersion','1.0.0',
      'compilationOutput',pg_catalog.jsonb_build_object(
        'kind','application','validationContractVersion','1.0.0',
        'resolutionFingerprint',$(sha "'application:resolution'"),
        'artifact',pg_catalog.jsonb_build_object('kind','application','rootId','$application_root_id',
          'definitionKey','vortex.parent_delete.application','exactVersion','1.0.0',
          'contentFingerprint',$(sha "'application:content'"),'resolutionFingerprint',$(sha "'application:resolution'")),
        'canonical',pg_catalog.jsonb_build_object(
          'envelope',pg_catalog.jsonb_build_object('kind','application','key','vortex.parent_delete.application',
            'rootId','$application_root_id','organizationId','$organization_id'),
          'content',pg_catalog.jsonb_build_object('permissions','[]'::jsonb))),
      'resolutionSnapshot',pg_catalog.jsonb_build_object('fingerprint',$(sha "'application:resolution'"),
        'definitions',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('kind','application',
          'key','vortex.parent_delete.application','rootId','$application_root_id','exactVersion','1.0.0'))),
      'contentFingerprint',$(sha "'application:content'"),'resolutionFingerprint',$(sha "'application:resolution'"),
      'validationContractVersion','1.0.0','comparisonFingerprint',$(sha "'application:content'"),
      'impactReasons','[]'::jsonb,'releaseNote','Parent delete proof Application.',
      'dependencies',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'kind','module','key','vortex.parent_delete.module','rootId','$module_root_id',
        'releaseRevision',1,'releaseVersion','2.0.0',
        'contentFingerprint',$(sha "'module:content'"),'resolutionFingerprint',$(sha "'module:resolution'")))));
  delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
  commit;
" >/dev/null

run_sql "
  begin;
  with release_value as (
    select pg_catalog.jsonb_build_object('kind','module','definitionKey','vortex.parent_delete.module',
      'rootId','$module_root_id','releaseRevision',1,'releaseVersion','2.0.0',
      'validationContractVersion','2.0.0','contentFingerprint',$(sha "'module:content'"),
      'resolutionFingerprint',$(sha "'module:resolution'")) as value
  ), application_release as (
    select pg_catalog.jsonb_build_object('kind','application','definitionKey','vortex.parent_delete.application',
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
        'template',pg_catalog.jsonb_build_object('roleId','c4950000-0000-4000-8000-0000000000c1',
          'key','delete_template','name','Delete template','homePageId','c4950000-0000-4000-8000-0000000000c2',
          'permissionKeys',(select pg_catalog.jsonb_agg(item.value #> '{permission,key}' order by item.ordinality)
            from pg_catalog.jsonb_array_elements(candidate.entry_values) with ordinality as item(value, ordinality)),
          'permissionSelection','{\"kind\":\"exact\"}'::jsonb),
        'sourceTemplateFingerprint',$(sha "'template'"),
        'sourcePermissions',candidate.entry_values,'livePermissions',candidate.entry_values)),
      'candidateFingerprint',$(sha "'preparation'")),
    '$organization_id','$application_root_id','$actor_id','c4950000-0000-4000-8000-0000000000c3');
  select 1 from vortex_access.coordinate_organization_role_change(
    pg_catalog.jsonb_build_object('contractVersion','1.0.0',
      'candidate',pg_catalog.jsonb_build_object('operation','create_custom','organizationId','$organization_id',
        'roleId','$role_id','key','parent_delete_role','label','Parent delete role',
        'description','Every declared action over the parent delete proof records.',
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
    '$actor_id','c4950000-0000-4000-8000-0000000000c4');
  select 1 from vortex_access.coordinate_organization_role_assignment_change('grant','$organization_id',
    '$assignment_id',null,'$role_id',1,'organization_account','$account_id',null,'standing',
    pg_catalog.clock_timestamp()-interval '1 minute',null,'$actor_id','c4950000-0000-4000-8000-0000000000c5');
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

# Every record the races act on is created through the owning create primitive,
# and the surviving category's pre-race total through the owning generated-value
# writer, so each carries its real scope, ownership, edges and revision.
run_sql "
  begin;
  delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
  $(human_context "(select current_version from vortex_access.organization_access_versions where organization_id='$organization_id')")
  create temporary table proof_records (label text primary key, record_id uuid) on commit drop;
  grant select, insert on proof_records to vortex_record_adapter;
  grant select on proof_records to vortex_record_owner;
  set local role vortex_record_adapter;
  insert into proof_records values
    ('reparent_parent', (vortex_record.create_record_internal('$parent_type_id'::uuid,
      pg_catalog.jsonb_build_object('$field_parent_title','Reparent parent'),
      array['$field_parent_title']::uuid[], null) ->> 'recordId')::uuid),
    ('reparent_other_parent', (vortex_record.create_record_internal('$parent_type_id'::uuid,
      pg_catalog.jsonb_build_object('$field_parent_title','Reparent other parent'),
      array['$field_parent_title']::uuid[], null) ->> 'recordId')::uuid),
    ('totals_parent', (vortex_record.create_record_internal('$parent_type_id'::uuid,
      pg_catalog.jsonb_build_object('$field_parent_title','Totals parent'),
      array['$field_parent_title']::uuid[], null) ->> 'recordId')::uuid),
    ('totals_category', (vortex_record.create_record_internal('$category_type_id'::uuid,
      pg_catalog.jsonb_build_object('$field_category_title','Totals category'),
      array['$field_category_title']::uuid[], null) ->> 'recordId')::uuid);
  insert into proof_records values
    ('reparent_line', (vortex_record.create_record_internal('$line_type_id'::uuid,
      pg_catalog.jsonb_build_object('$field_line_amount','5.00','$field_line_parent',
        pg_catalog.jsonb_build_object('recordTypeId','$parent_type_id',
          'recordId',(select record_id from proof_records where label='reparent_parent'))),
      array['$field_line_amount','$field_line_parent']::uuid[], null) ->> 'recordId')::uuid),
    ('totals_line', (vortex_record.create_record_internal('$line_type_id'::uuid,
      pg_catalog.jsonb_build_object('$field_line_amount','10.00','$field_line_parent',
        pg_catalog.jsonb_build_object('recordTypeId','$parent_type_id',
          'recordId',(select record_id from proof_records where label='totals_parent')),
        '$field_line_category',pg_catalog.jsonb_build_object('recordTypeId','$category_type_id',
          'recordId',(select record_id from proof_records where label='totals_category'))),
      array['$field_line_amount','$field_line_parent','$field_line_category']::uuid[], null) ->> 'recordId')::uuid),
    ('totals_rival_line', (vortex_record.create_record_internal('$line_type_id'::uuid,
      pg_catalog.jsonb_build_object('$field_line_amount','3.00','$field_line_parent',
        pg_catalog.jsonb_build_object('recordTypeId','$parent_type_id',
          'recordId',(select record_id from proof_records where label='reparent_other_parent')),
        '$field_line_category',pg_catalog.jsonb_build_object('recordTypeId','$category_type_id',
          'recordId',(select record_id from proof_records where label='totals_category'))),
      array['$field_line_amount','$field_line_parent','$field_line_category']::uuid[], null) ->> 'recordId')::uuid);
  -- Generated record identities remain adapter-managed under forced RLS.
  update record_data.$parent_table set record_id = '$reparent_parent_id'
    where record_id = (select record_id from proof_records where label='reparent_parent');
  update record_data.$parent_table set record_id = '$reparent_other_parent_id'
    where record_id = (select record_id from proof_records where label='reparent_other_parent');
  update record_data.$parent_table set record_id = '$totals_parent_id'
    where record_id = (select record_id from proof_records where label='totals_parent');
  update record_data.$category_table set record_id = '$totals_category_id'
    where record_id = (select record_id from proof_records where label='totals_category');
  update record_data.$line_table set record_id = '$reparent_line_id'
    where record_id = (select record_id from proof_records where label='reparent_line');
  update record_data.$line_table set record_id = '$totals_line_id'
    where record_id = (select record_id from proof_records where label='totals_line');
  update record_data.$line_table set record_id = '$totals_rival_line_id'
    where record_id = (select record_id from proof_records where label='totals_rival_line');
  -- Relationship-edge identities remain owner-managed fixture state.
  reset role;
  set local role vortex_record_owner;
  update vortex_record.relationship_edges as edge set
    from_record_id = mapped.new_id
  from (select record_id as old_id,
      case label
        when 'reparent_line' then '$reparent_line_id'::uuid
        when 'totals_line' then '$totals_line_id'::uuid
        when 'totals_rival_line' then '$totals_rival_line_id'::uuid
      end as new_id
    from proof_records where label in ('reparent_line','totals_line','totals_rival_line')) as mapped
  where edge.from_record_id = mapped.old_id;
  update vortex_record.relationship_edges as edge set
    to_record_id = mapped.new_id
  from (select record_id as old_id,
      case label
        when 'reparent_parent' then '$reparent_parent_id'::uuid
        when 'reparent_other_parent' then '$reparent_other_parent_id'::uuid
        when 'totals_parent' then '$totals_parent_id'::uuid
        when 'totals_category' then '$totals_category_id'::uuid
      end as new_id
    from proof_records
    where label in ('reparent_parent','reparent_other_parent','totals_parent','totals_category')) as mapped
  where edge.to_record_id = mapped.old_id;
  reset role;
  set local role vortex_record_adapter;
  update record_data.$line_table set
    $column_line_parent = case
      when $column_line_parent ->> 'recordId' = (select record_id::text from proof_records where label='reparent_parent')
        then pg_catalog.jsonb_build_object('recordTypeId','$parent_type_id','recordId','$reparent_parent_id')
      when $column_line_parent ->> 'recordId' = (select record_id::text from proof_records where label='reparent_other_parent')
        then pg_catalog.jsonb_build_object('recordTypeId','$parent_type_id','recordId','$reparent_other_parent_id')
      when $column_line_parent ->> 'recordId' = (select record_id::text from proof_records where label='totals_parent')
        then pg_catalog.jsonb_build_object('recordTypeId','$parent_type_id','recordId','$totals_parent_id')
      else $column_line_parent end,
    $column_line_category = case
      when $column_line_category ->> 'recordId' = (select record_id::text from proof_records where label='totals_category')
        then pg_catalog.jsonb_build_object('recordTypeId','$category_type_id','recordId','$totals_category_id')
      else $column_line_category end
  where organisation_id = '$organization_id';
  -- The category aggregates 10.00 + 3.00 before either race runs.
  select vortex_record.apply_relationship_total_parent_internal('$category_type_id'::uuid,
    '$totals_category_id'::uuid, 1,
    pg_catalog.jsonb_build_object('$field_category_total','13.00'));
  reset role;
  delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
  commit;
" >/dev/null

prepare_statement() {
  local command_id="$1" parent_id="$2" activity_id="$3" revision="${4:-1}"
  printf "vortex_record.prepare_protected_parent_delete('%s'::uuid,'%s'::uuid,'%s'::uuid,%s,'%s'::uuid)" \
    "$command_id" "$parent_type_id" "$parent_id" "$revision" "$activity_id"
}

finalized_delete_statement() {
  local command_id="$1" parent_id="$2" activity_id="$3" occurrence_id="$4"
  printf "with prepared as materialized (
      select %s as value
    ), parent_mutations as (
      select pg_catalog.coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'recordTypeId', item.value -> 'recordTypeId',
          'recordId', item.value -> 'recordId',
          'expectedConcurrencyNumber', item.value -> 'concurrencyNumber',
          'finalValues', case when item.value ->> 'recordId' = '%s'
            then pg_catalog.jsonb_build_object('%s','3.00')
            else '{}'::jsonb end)
        order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
      ) filter (where item.value ->> 'recordKey' <> 'root'), '[]'::jsonb) as value
      from prepared
      left join lateral pg_catalog.jsonb_array_elements(
        pg_catalog.coalesce(prepared.value -> 'records', '[]'::jsonb)
      ) as item(value) on true
    )
    select case when prepared.value ->> 'outcome' = 'prepared'
      then vortex_record.finalize_protected_parent_delete(
        '%s'::uuid,'%s'::uuid,'%s'::uuid,1,'%s'::uuid,'%s'::uuid,
        parent_mutations.value) ->> 'outcome'
      else prepared.value ->> 'outcome' end
    from prepared cross join parent_mutations" \
    "$(prepare_statement "$command_id" "$parent_id" "$activity_id")" \
    "$totals_category_id" "$field_category_total" \
    "$command_id" "$parent_type_id" "$parent_id" "$activity_id" "$occurrence_id"
}

reparent_statement() {
  printf "vortex_record.change_record_relationship_internal('%s'::uuid,'%s'::uuid,1,'%s'::uuid,
    pg_catalog.jsonb_build_object('recordTypeId','%s','recordId','%s'))" \
    "$line_type_id" "$reparent_line_id" "$relationship_line_parent" \
    "$parent_type_id" "$reparent_other_parent_id"
}

category_total_statement() {
  local revision="$1" value="$2"
  printf "vortex_record.apply_relationship_total_parent_internal('%s'::uuid,'%s'::uuid,%s,
    pg_catalog.jsonb_build_object('%s','%s'))" \
    "$category_type_id" "$totals_category_id" "$revision" "$field_category_total" "$value"
}

# Ground truth for one race, read under its own request context because the
# generated tables carry a scope policy.
race_state() {
  local parent_id="$1" line_id="$2" command_id="$3" activity_id="$4"
  run_sql "
    begin;
    do \$context\$
    begin
      delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
      perform vortex_context.initialize(pg_catalog.jsonb_build_object(
        'callerKind','human','identityAuthorityId','$actor_id','tenantId','$tenant_id',
        'organizationId','$organization_id','organizationAccountId','$account_id',
        'identityId','$identity_id','applicationRootId','$application_root_id',
        'sessionId','c4950000-0000-4000-8000-0000000000f1',
        'authenticationStrength','single_factor',
        'issuedAt',pg_catalog.statement_timestamp(),
        'expiresAt',pg_catalog.statement_timestamp()+interval '1 hour',
        'accessVersion',(select current_version from vortex_access.organization_access_versions
          where organization_id = '$organization_id'),
        'correlationId','c4950000-0000-4000-8000-0000000000f2',
        'accessTokenIssuedAt',pg_catalog.statement_timestamp(),
        'primaryAuthenticatedAt',pg_catalog.statement_timestamp()));
    end
    \$context\$;
    set local role vortex_record_adapter;
    select pg_catalog.concat_ws('|',
      (select lifecycle_state || ':' || concurrency_number::text from record_data.$parent_table
        where record_id = '$parent_id'),
      (select lifecycle_state || ':' || concurrency_number::text from record_data.$line_table
        where record_id = '$line_id'),
      (select coalesce($column_line_parent ->> 'recordId','none') from record_data.$line_table
        where record_id = '$line_id'),
      (select pg_catalog.count(*)::text from vortex_record.relationship_edges
        where relationship_id = '$relationship_line_parent' and from_record_id = '$line_id'),
      (select pg_catalog.count(*)::text from vortex_record.delete_command_receipts
        where organization_id = '$organization_id' and command_id = '$command_id'
          and state = 'pending'),
      (select pg_catalog.count(*)::text from vortex_record.delete_command_receipts
        where organization_id = '$organization_id' and command_id = '$command_id'
          and state = 'completed'),
      (select pg_catalog.count(*)::text from vortex_record.delete_command_effects
        where organization_id = '$organization_id' and command_id = '$command_id'),
      (select pg_catalog.count(*)::text from vortex_activity.organization_activity_entries
        where organization_id = '$organization_id' and activity_id = '$activity_id'),
      (select pg_catalog.count(*)::text from vortex_event.record_occurrences
        where organization_id = '$organization_id' and record_id = '$parent_id'));
    reset role;
    delete from vortex_context.request_contexts where backend_pid = pg_catalog.pg_backend_pid();
    commit;
  "
}

category_state() {
  run_sql "
    begin;
    set local role vortex_record_adapter;
    select pg_catalog.concat_ws('|', concurrency_number::text, $column_category_total::text)
    from record_data.$category_table where record_id = '$totals_category_id';
    reset role;
    commit;
  "
}

# ----------------------------------------------------------------------------
# Race one: a protected parent deletion and a reparenting of that parent's
# dependent child contend on the child row.
# ----------------------------------------------------------------------------
access_version="$(current_version)"

"${psql_command[@]}" >"$proof_root/reparent-holder.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/reparent-holder.pid'
$(human_context "$access_version")
set local role vortex_record_adapter;
select record_id from record_data.$line_table
where record_id='$reparent_line_id' for update \g /dev/null
reset role;
\! touch '$proof_root/reparent-holder-ready'
\! deadline=600; while [ ! -f '$proof_root/reparent-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/reparent-release' ]
rollback;
SQL
reparent_holder_pid=$!; worker_pids+=("$reparent_holder_pid")
wait_for_file "$proof_root/reparent-holder-ready"
reparent_holder_backend="$(read_backend_pid "$proof_root/reparent-holder.pid")"

# The deletion prepares, finalizes and commits in one transaction, exactly as
# the owning runtime boundary does; an unfinalized preparation could not commit.
"${psql_command[@]}" >"$proof_root/reparent-delete.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/reparent-delete.pid'
$(human_context "$access_version" 'c4950000-0000-4000-8000-0000000000f3' 'c4950000-0000-4000-8000-0000000000f4')
set local role vortex_runtime;
$(finalized_delete_statement "$reparent_command" "$reparent_parent_id" "$reparent_activity" "$reparent_occurrence")
  \g '$proof_root/reparent-delete.result'
reset role;
commit;
SQL
reparent_delete_pid=$!; worker_pids+=("$reparent_delete_pid")
reparent_delete_backend="$(read_backend_pid "$proof_root/reparent-delete.pid")"
if ! wait_for_database_blocker "$reparent_delete_backend" "$reparent_holder_backend" 'the parent deletion'; then
  if ! kill -0 "$reparent_delete_pid" >/dev/null 2>&1; then
    wait_owned_worker "$reparent_delete_pid" || true
    printf 'the parent deletion completed before the child lock; result=%q\n' \
      "$(tr -d '[:space:]' <"$proof_root/reparent-delete.result" 2>/dev/null || true)" >&2
  fi
  exit 1
fi

"${psql_command[@]}" >"$proof_root/reparent-move.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/reparent-move.pid'
$(human_context "$access_version" 'c4950000-0000-4000-8000-0000000000f5' 'c4950000-0000-4000-8000-0000000000f6')
set local role vortex_record_adapter;
select coalesce($(reparent_statement) ->> 'outcome','none') \g '$proof_root/reparent-move.result'
reset role;
commit;
SQL
reparent_move_pid=$!; worker_pids+=("$reparent_move_pid")
reparent_move_backend="$(read_backend_pid "$proof_root/reparent-move.pid")"
wait_for_database_blocker "$reparent_move_backend" "$reparent_holder_backend" 'the reparenting'
touch "$proof_root/reparent-release"

wait_owned_worker "$reparent_holder_pid" || { echo 'the reparent holder failed' >&2; exit 1; }
wait_owned_worker "$reparent_delete_pid" || { echo 'the racing parent deletion failed' >&2; exit 1; }
wait_owned_worker "$reparent_move_pid" || { echo 'the racing reparenting failed' >&2; exit 1; }

reparent_delete_result="$(tr -d '[:space:]' <"$proof_root/reparent-delete.result")"
reparent_move_result="$(tr -d '[:space:]' <"$proof_root/reparent-move.result")"
[[ "$reparent_delete_result" = 'completed' ]] || {
  printf 'the parent deletion did not reach its terminal writer: %q\n' "$reparent_delete_result" >&2; exit 1
}
[[ "$reparent_move_result" = 'completed' || "$reparent_move_result" = 'conflict' || "$reparent_move_result" = 'refused' ]] || {
  printf 'the reparenting neither serialized nor failed stale: %q\n' "$reparent_move_result" >&2; exit 1
}
# Both safe serial orders end in one completed delete command, one Activity,
# one Event and no pending receipt. If the delete won the child lock, the child
# was deleted with its parent; if the move won, the re-check preserved the child
# under its new parent. In either order the child has exactly one current edge.
reparent_state="$(race_state "$reparent_parent_id" "$reparent_line_id" "$reparent_command" "$reparent_activity" | tr -d '[:space:]')"
case "$reparent_state" in
  "soft_deleted:2|soft_deleted:2|$reparent_parent_id|1|0|1|2|1|1") ;;
  "soft_deleted:2|active:2|$reparent_other_parent_id|1|0|1|1|1|1") ;;
  *) printf 'the reparent race left partial state: %q\n' "$reparent_state" >&2; exit 1 ;;
esac
echo "reparent race: delete=$reparent_delete_result move=$reparent_move_result state=$reparent_state"

# ----------------------------------------------------------------------------
# Race two: a protected parent deletion and a concurrent total-bearing write on
# a SURVIVING parent of that deletion's cascade contend on the category row.
# ----------------------------------------------------------------------------
access_version="$(current_version)"

"${psql_command[@]}" >"$proof_root/totals-holder.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/totals-holder.pid'
$(human_context "$access_version")
set local role vortex_record_adapter;
select record_id from record_data.$category_table
where record_id='$totals_category_id' for update \g /dev/null
reset role;
\! touch '$proof_root/totals-holder-ready'
\! deadline=600; while [ ! -f '$proof_root/totals-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/totals-release' ]
rollback;
SQL
totals_holder_pid=$!; worker_pids+=("$totals_holder_pid")
wait_for_file "$proof_root/totals-holder-ready"
totals_holder_backend="$(read_backend_pid "$proof_root/totals-holder.pid")"

# The deletion must wait for the surviving parent's row before it can prepare a
# total for it, then it finalizes and commits in that same transaction. This is
# exactly the lock the rival write already wants.
"${psql_command[@]}" >"$proof_root/totals-delete.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/totals-delete.pid'
$(human_context "$access_version" 'c4950000-0000-4000-8000-0000000000f7' 'c4950000-0000-4000-8000-0000000000f8')
set local role vortex_runtime;
$(finalized_delete_statement "$totals_command" "$totals_parent_id" "$totals_activity" "$totals_occurrence")
  \g '$proof_root/totals-delete.result'
reset role;
commit;
SQL
totals_delete_pid=$!; worker_pids+=("$totals_delete_pid")
totals_delete_backend="$(read_backend_pid "$proof_root/totals-delete.pid")"
if ! wait_for_database_blocker "$totals_delete_backend" "$totals_holder_backend" 'the totals parent deletion'; then
  if ! kill -0 "$totals_delete_pid" >/dev/null 2>&1; then
    wait_owned_worker "$totals_delete_pid" || true
    printf 'the totals deletion completed before the surviving parent lock; result=%q\n' \
      "$(tr -d '[:space:]' <"$proof_root/totals-delete.result" 2>/dev/null || true)" >&2
  fi
  exit 1
fi

# The rival total-bearing write carries the revision it read before the race.
"${psql_command[@]}" >"$proof_root/totals-rival.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/totals-rival.pid'
$(human_context "$access_version" 'c4950000-0000-4000-8000-0000000000f9' 'c4950000-0000-4000-8000-0000000000fa')
set local role vortex_record_adapter;
select coalesce(( select 'applied' from ( select $(category_total_statement 2 '3.00') ) as applied ),'applied')
  \g '$proof_root/totals-rival.result'
reset role;
commit;
SQL
totals_rival_pid=$!; worker_pids+=("$totals_rival_pid")
totals_rival_backend="$(read_backend_pid "$proof_root/totals-rival.pid")"
wait_for_database_blocker "$totals_rival_backend" "$totals_holder_backend" 'the rival total write'
touch "$proof_root/totals-release"

wait_owned_worker "$totals_holder_pid" || { echo 'the totals holder failed' >&2; exit 1; }
totals_delete_status=0; wait_owned_worker "$totals_delete_pid" || totals_delete_status=$?
totals_rival_status=0; wait_owned_worker "$totals_rival_pid" || totals_rival_status=$?

totals_delete_result="$(tr -d '[:space:]' <"$proof_root/totals-delete.result" 2>/dev/null || true)"
[ "$totals_delete_status" -eq 0 ] || {
  echo 'the racing totals deletion failed outside its own refusal contract' >&2; exit 1
}
[[ "$totals_delete_result" = 'completed' ]] || {
  printf 'the totals deletion did not reach its terminal writer: %q\n' "$totals_delete_result" >&2; exit 1
}
# The rival write either applied against the revision it carried or raised the
# engine's own stale-revision refusal. Both are safe; silently overwriting is
# not. The category starts at revision 2 after the owning setup writer. Whether
# the rival or the delete obtains its lock first, exactly one real change to
# 3.00 occurs and the category ends at revision 3.
category_after="$(category_state | tr -d '[:space:]')"
if [ "$category_after" != '3|3.00' ]; then
  printf 'the totals race left the surviving parent in an unexpected state: %q\n' "$category_after" >&2
  exit 1
fi
if [ "$totals_rival_status" -ne 0 ] && ! grep -Eq '40001|Relationship total parent revision changed' "$proof_root/totals-rival.log"; then
  echo 'the rival total write failed for a reason other than the engine stale-revision refusal' >&2
  exit 1
fi
# The completed deletion persists its exact journal, Activity and Event and no
# pending receipt. The deleted parent and dependent both advance exactly once.
totals_state="$(race_state "$totals_parent_id" "$totals_line_id" "$totals_command" "$totals_activity" | tr -d '[:space:]')"
case "$totals_state" in
  "soft_deleted:2|soft_deleted:2|$totals_parent_id|1|0|1|2|1|1") ;;
  *) printf 'the totals race left partial delete state: %q\n' "$totals_state" >&2; exit 1 ;;
esac
echo "totals race: delete=$totals_delete_result rival_status=$totals_rival_status category=$category_after state=$totals_state"

echo 'protected parent delete concurrency proof passed'
