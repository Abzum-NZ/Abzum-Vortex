#!/usr/bin/env bash
# #50 slice 2: the create_record lock protocol against ordinary create, under
# deterministic barriers, on the two resources whose acquisition order differs
# between the two paths. This script isolates the exact share-then-counter
# sequence used by the named path; it does not claim to execute the full
# named-action service. The full preflight and terminal writer are exercised by
# the real-service race in `record-save-postgres.integration.test.ts`.
#
# The unsynchronised twenty-iteration race in
# `tooling/supabase/record-save-postgres.integration.test.ts` cannot
# discriminate this: it never guarantees that the two sessions are holding the
# opposite resources at the same moment. These barriers force exactly that.
#
#   opposite order -- the named-action preflight takes `for share` on a concrete
#                     link target before any creation allocates a reference
#                     number (`prepare_named_action_command_totals` pass A, then
#                     `insert_named_action_record_internal`). Ordinary create
#                     does the reverse: `create_record_internal` allocates every
#                     counter in its field loop before its relationship loop
#                     reaches `write_relationship_value_internal`, which takes
#                     `for share` on the target. Session A is held holding the
#                     share and is then released to request the counter session
#                     B holds; B is then released to request the share A holds.
#                     `for share` is compatible with `for share`, so B must pass
#                     A, commit, and free the counter A is waiting for.
#
#   queued exclusive -- the same shape with a third session queued `for update`
#                     on that target between A's share and B's request. B's
#                     share now queues behind an exclusive waiter that is itself
#                     waiting on A, which is waiting on B: a wait-for cycle whose
#                     only soft edge is B's queue position. PostgreSQL must
#                     rearrange that queue rather than abort. This is the edge
#                     the prefix-order argument alone cannot settle.
#
# Either scenario reports `40P01` as a failure. Neither is retuned to pass and
# no assertion is relaxed: a deadlock here is a finding about the delivered lock
# order, not a flaky barrier.
#
# Fixture: identical in shape to `record-change-concurrency.test.sh` — the same
# direct tenant/organisation/account rows, the same release, permission
# catalogue, role, assignment and Module-coordinated storage — under its own
# identifier scope so the two suites never share a fixture.
set -euo pipefail

readonly proof_root="$(mktemp -d /tmp/vortex-named-action-create.XXXXXX)"
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id='c4810000-0000-4000-8000-000000000001'
readonly organization_id='c4810000-0000-4000-8000-000000000002'
readonly identity_id='c4810000-0000-4000-8000-000000000003'
readonly account_id='c4810000-0000-4000-8000-000000000004'
readonly actor_id='c4810000-0000-4000-8000-000000000005'
readonly application_root_id='c4810000-0000-4000-8000-000000000010'
readonly module_root_id='c4810000-0000-4000-8000-000000000011'
readonly record_type_id='c4810000-0000-4000-8000-000000000012'
readonly storage_contract_id='c4810000-0000-4000-8000-000000000013'
readonly field_one='c4810000-0000-4000-8000-000000000014'
readonly field_two='c4810000-0000-4000-8000-000000000015'
readonly permission_read='c4810000-0000-4000-8000-000000000016'
readonly permission_update='c4810000-0000-4000-8000-000000000017'
readonly field_reference='c4810000-0000-4000-8000-000000000030'
readonly permission_create='c4810000-0000-4000-8000-000000000031'
readonly field_link='c4810000-0000-4000-8000-000000000032'
readonly relationship_id='c4810000-0000-4000-8000-000000000033'
readonly permission_delete='c4810000-0000-4000-8000-000000000034'
readonly field_required_link='c4810000-0000-4000-8000-000000000035'
readonly relationship_required='c4810000-0000-4000-8000-000000000036'
readonly permission_restore='c4810000-0000-4000-8000-000000000037'
readonly permission_transfer='c4810000-0000-4000-8000-000000000038'
readonly role_id='c4810000-0000-4000-8000-000000000018'
readonly assignment_id='c4810000-0000-4000-8000-000000000019'
readonly steward_role_id='c4810000-0000-4000-8000-00000000001a'
readonly steward_assignment_id='c4810000-0000-4000-8000-00000000001b'
readonly steward_delegation_id='c4810000-0000-4000-8000-00000000001c'
readonly installer_role_id='c4810000-0000-4000-8000-00000000001d'
readonly installer_assignment_id='c4810000-0000-4000-8000-00000000001e'
readonly conflict_record_id='c4810000-0000-4000-8000-000000000020'
readonly base_save_command_one='c4810000-0000-4000-8000-000000000050'
readonly base_save_command_two='c4810000-0000-4000-8000-000000000051'
readonly base_save_activity_one='c4810000-0000-4000-8000-000000000052'
readonly base_save_activity_two='c4810000-0000-4000-8000-000000000053'
readonly base_save_event_one='c4810000-0000-4000-8000-000000000054'
readonly base_save_event_two='c4810000-0000-4000-8000-000000000055'
readonly same_command_record_id='c4810000-0000-4000-8000-000000000022'
readonly same_save_command='c4810000-0000-4000-8000-000000000056'
readonly same_save_activity_one='c4810000-0000-4000-8000-000000000057'
readonly same_save_event_one='c4810000-0000-4000-8000-000000000058'
readonly same_save_activity_two='c4810000-0000-4000-8000-000000000059'
readonly same_save_event_two='c4810000-0000-4000-8000-00000000005a'
readonly owner_group_id='c4810000-0000-4000-8000-000000000060'
readonly owner_membership_id='c4810000-0000-4000-8000-000000000061'
readonly transfer_target_a_group_id='c4810000-0000-4000-8000-000000000068'
readonly transfer_target_b_group_id='c4810000-0000-4000-8000-000000000069'
readonly group_save_command='c4810000-0000-4000-8000-000000000063'
readonly group_save_activity='c4810000-0000-4000-8000-000000000064'
readonly group_save_event='c4810000-0000-4000-8000-000000000065'
readonly revocation_record_id='c4810000-0000-4000-8000-000000000021'
readonly link_source_record_id='c4810000-0000-4000-8000-000000000040'
readonly link_target_record_id='c4810000-0000-4000-8000-000000000041'
readonly anchor_record_id='c4810000-0000-4000-8000-000000000042'
readonly link_add_source_record_id='c4810000-0000-4000-8000-000000000043'
readonly link_add_target_record_id='c4810000-0000-4000-8000-000000000044'
readonly restore_source_record_id='c4810000-0000-4000-8000-000000000045'
readonly restore_target_record_id='c4810000-0000-4000-8000-000000000046'
readonly transfer_record_id='c4810000-0000-4000-8000-000000000047'
readonly transfer_command_a='c4810000-0000-4000-8000-000000000070'
readonly transfer_activity_a='c4810000-0000-4000-8000-000000000071'
readonly transfer_occurrence_a='c4810000-0000-4000-8000-000000000072'
readonly transfer_command_b='c4810000-0000-4000-8000-000000000073'
readonly transfer_activity_b='c4810000-0000-4000-8000-000000000074'
readonly transfer_occurrence_b='c4810000-0000-4000-8000-000000000075'
readonly physical_table='rt_c4810000000040008000000000000013'
readonly column_one='f_c4810000000040008000000000000014'
readonly column_reference='f_c4810000000040008000000000000030'
readonly column_link='f_c4810000000040008000000000000032'
readonly column_required_link='f_c4810000000040008000000000000035'

fixture_claimed=0
declare -a worker_pids=()
declare -A reaped_worker_pids=()
declare -A worker_labels=()

psql_command=(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1)
if [ -n "$database_url" ]; then psql_command+=("$database_url"); fi
run_sql() { "${psql_command[@]}" --command "$1"; }

record_stage() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%S.%3NZ')" "$1" >>"$proof_root/timeline.log"
}

wait_for_file() {
  local candidate="$1" deadline=$((SECONDS + 20))
  while ((SECONDS < deadline)); do [ -f "$candidate" ] && return 0; sleep 0.05; done
  echo "named action create proof barrier timed out: $candidate" >&2
  return 1
}

read_backend_pid() {
  local candidate="$1" backend_pid
  wait_for_file "$candidate"
  backend_pid="$(tr -d '[:space:]' <"$candidate")"
  [[ "$backend_pid" =~ ^[1-9][0-9]*$ ]] || {
    printf 'named action create proof captured invalid backend: %q\n' "$backend_pid" >&2
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
  printf 'named action create proof did not observe %s blocked at the row lock\n' "$label" >&2
  run_sql "select pg_catalog.concat_ws('|', pid::text, wait_event_type, wait_event,
      pg_catalog.array_to_string(pg_catalog.pg_blocking_pids(pid), ','))
    from pg_catalog.pg_stat_activity where pid in ($blocked_pid, $blocking_pid)
    order by pid;" >&2 || true
  return 1
}

wait_owned_worker() {
  local pid="$1" label="${2:-worker}" status
  if wait "$pid"; then status=0; else status=$?; fi
  reaped_worker_pids["$pid"]=1
  record_stage "$label shell_pid=$pid exited status=$status"
  return "$status"
}

dump_active_workers() {
  local pid_path backend label
  record_stage 'failure diagnostics started'
  for pid_path in "$proof_root"/*.pid; do
    [ -f "$pid_path" ] || continue
    backend="$(tr -d '[:space:]' <"$pid_path")"
    label="${pid_path##*/}"; label="${label%.pid}"
    printf '%s backend_pid=%s shell_pid=%s\n' "$label" "$backend" \
      "${worker_labels[$label]:-unknown}" >&2
    [[ "$backend" =~ ^[1-9][0-9]*$ ]] || continue
    run_sql "select pg_catalog.concat_ws('|',
        pg_catalog.clock_timestamp()::text, pid::text, state, wait_event_type, wait_event,
        coalesce(pg_catalog.array_to_string(pg_catalog.pg_blocking_pids(pid), ','), ''),
        coalesce(xact_start::text, ''), coalesce(query_start::text, ''),
        pg_catalog.left(query, 240))
      from pg_catalog.pg_stat_activity where pid = $backend;" >&2 || true
  done
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
        raise exception 'named action create proof fixture ownership mismatch';
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
    set local role vortex_record_adapter;
    delete from vortex_record.save_command_receipts
      where organization_id = '$organization_id';
    reset role;
    delete from pgmq.q_vortex_event_occurrences
      where message ->> 'occurrenceId' in (
        '$base_save_event_one', '$base_save_event_two',
        '$same_save_event_one', '$same_save_event_two', '$group_save_event',
        '$transfer_occurrence_a', '$transfer_occurrence_b'
      );
    delete from vortex_event.event_outbox
      where organization_id = '$organization_id';
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
  if [ "$original_status" -ne 0 ]; then
    echo 'named action create concurrency proof failed; bounded diagnostics follow' >&2
    dump_active_workers
  fi
  touch "$proof_root/opposite-share-release" "$proof_root/opposite-counter-release" \
    "$proof_root/queued-share-release" "$proof_root/queued-counter-release" \
    "$proof_root/queued-exclusive-release" >/dev/null 2>&1 || true
  stop_owned_workers
  if [ "$original_status" -ne 0 ]; then
    if [ -f "$proof_root/timeline.log" ]; then
      printf '%s\n' '--- timeline.log ---' >&2
      tail -n 80 -- "$proof_root/timeline.log" >&2
    fi
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
    /tmp/vortex-named-action-create.*) rm -rf -- "$proof_root"; operation_status=$? ;;
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
    pg_catalog.to_regprocedure('vortex_record.create_record_internal(uuid,jsonb,uuid[],uuid)') is not null,
    pg_catalog.to_regprocedure('vortex_record.allocate_reference_number_internal(uuid,uuid,uuid,uuid,jsonb)') is not null,
    pg_catalog.to_regprocedure('vortex_record.share_lock_named_action_target_internal(jsonb,uuid,uuid)') is not null,
    pg_catalog.to_regprocedure('vortex_record.prepare_named_action_command_totals(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,text,uuid,bigint,uuid)') is not null,
    pg_catalog.to_regprocedure('vortex_record.insert_named_action_record_internal(uuid,jsonb,uuid[])') is not null,
    not pg_catalog.has_function_privilege('vortex_runtime', 'vortex_record.share_lock_named_action_target_internal(jsonb,uuid,uuid)', 'EXECUTE'),
    not pg_catalog.has_function_privilege('vortex_runtime', 'vortex_record.insert_named_action_record_internal(uuid,jsonb,uuid[])', 'EXECUTE')
  );
")"
[ "$schema_state" = 't|t|t|t|t|t|t' ] || {
  echo 'the create_record named-action migrations must already be applied to the proof database' >&2
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
    'sessionId','c4810000-0000-4000-8000-0000000000f1','authenticationStrength','single_factor',
    'issuedAt',pg_catalog.statement_timestamp(),
    'expiresAt',pg_catalog.statement_timestamp()+interval '1 hour',
    'accessVersion',%s,'correlationId','c4810000-0000-4000-8000-0000000000f2',
    'accessTokenIssuedAt',pg_catalog.statement_timestamp(),
    'primaryAuthenticatedAt',pg_catalog.statement_timestamp()));" \
    "$actor_id" "$tenant_id" "$organization_id" "$account_id" "$identity_id" \
    "$application_root_id" "$version_expression"
}

# A distinct verified human context for each competing protected request.
transfer_human_context() {
  local version_expression="$1" session_id="$2" correlation_id="$3"
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

readonly permissions_sql="pg_catalog.jsonb_build_array(
  pg_catalog.jsonb_build_object('permissionId','$permission_read','key','na_create.read',
    'label','Read','description','Read the concurrency record.','recordTypeId','$record_type_id',
    'recordScope','{\"routes\":[{\"kind\":\"all_records\"}]}'::jsonb,
    'fieldPolicy',pg_catalog.jsonb_build_object(
      'readableFieldIds',pg_catalog.jsonb_build_array('$field_one','$field_two','$field_reference','$field_link','$field_required_link'),
      'changeableFieldIds','[]'::jsonb),
    'actionKind','read','administrative',false),
  pg_catalog.jsonb_build_object('permissionId','$permission_update','key','na_create.update',
    'label','Update','description','Change the concurrency record.','recordTypeId','$record_type_id',
    'recordScope','{\"routes\":[{\"kind\":\"all_records\"}]}'::jsonb,
    'fieldPolicy',pg_catalog.jsonb_build_object(
      'readableFieldIds',pg_catalog.jsonb_build_array('$field_one','$field_two','$field_reference','$field_link','$field_required_link'),
      'changeableFieldIds',pg_catalog.jsonb_build_array('$field_one','$field_two','$field_link','$field_required_link')),
    'actionKind','update','administrative',false),
  pg_catalog.jsonb_build_object('permissionId','$permission_create','key','na_create.create',
    'label','Create','description','Create the reference concurrency record.','recordTypeId','$record_type_id',
    'recordScope','{\"routes\":[{\"kind\":\"all_records\"}]}'::jsonb,
    'fieldPolicy',pg_catalog.jsonb_build_object(
      'readableFieldIds',pg_catalog.jsonb_build_array('$field_one','$field_two','$field_reference','$field_link','$field_required_link'),
      'changeableFieldIds',pg_catalog.jsonb_build_array('$field_one','$field_two','$field_link','$field_required_link')),
    'actionKind','create','administrative',false),
  pg_catalog.jsonb_build_object('permissionId','$permission_delete','key','na_create.delete',
    'label','Delete','description','Delete the concurrency record.','recordTypeId','$record_type_id',
    'recordScope','{\"routes\":[{\"kind\":\"all_records\"}]}'::jsonb,
    'fieldPolicy',pg_catalog.jsonb_build_object(
      'readableFieldIds','[]'::jsonb,'changeableFieldIds','[]'::jsonb),
    'actionKind','delete','administrative',false),
  pg_catalog.jsonb_build_object('permissionId','$permission_restore','key','na_create.restore',
    'label','Restore','description','Restore the concurrency record.','recordTypeId','$record_type_id',
    'recordScope','{\"routes\":[{\"kind\":\"all_records\"}]}'::jsonb,
    'fieldPolicy',pg_catalog.jsonb_build_object(
      'readableFieldIds','[]'::jsonb,'changeableFieldIds','[]'::jsonb),
    'actionKind','restore','administrative',false),
  pg_catalog.jsonb_build_object('permissionId','$permission_transfer','key','na_create.transfer',
    'label','Transfer','description','Transfer ownership of the concurrency record.','recordTypeId','$record_type_id',
    'recordScope','{\"routes\":[{\"kind\":\"all_records\"}]}'::jsonb,
    'fieldPolicy',pg_catalog.jsonb_build_object(
      'readableFieldIds','[]'::jsonb,'changeableFieldIds','[]'::jsonb),
    'actionKind','transfer','administrative',false))"

readonly module_content="pg_catalog.jsonb_build_object(
  'name','Named action create concurrency','description','One record type for the change proof.',
  'dependencies','[]'::jsonb,
  'recordTypes',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'recordTypeId','$record_type_id','key','change_type','singularLabel','Change record',
    'pluralLabel','Change records','titleFieldId','$field_one',
    'storageContractId','$storage_contract_id','storageScope','organization_shared',
    'ownershipMode','team',
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
      raise exception 'named action create proof fixture scope already exists';
    end if;
  end
  \$proof\$;

  insert into vortex_identity.tenants (tenant_id, short_name, display_name, state, created_at, created_by, state_changed_at, revision)
  values ('$tenant_id','na_create','Named action create','active',pg_catalog.clock_timestamp(),'$actor_id',pg_catalog.clock_timestamp(),1);
  insert into vortex_identity.organizations (organization_id, tenant_id, short_name, display_name, state, created_at, created_by, state_changed_at, revision)
  values ('$organization_id','$tenant_id','na_create','Named action create','active',pg_catalog.clock_timestamp(),'$actor_id',pg_catalog.clock_timestamp(),1);
  select * from vortex_identity.ensure_identity_projection('$identity_id','c4810000-0000-4000-8000-0000000000a1');
  insert into vortex_identity.organization_accounts (organization_account_id, organization_id, identity_id, display_name, state, activated_at, changed_at, state_changed_at, state_changed_by, state_change_correlation_id, revision)
  values ('$account_id','$organization_id','$identity_id','Change actor','active',pg_catalog.clock_timestamp()-interval '1 minute',pg_catalog.clock_timestamp(),pg_catalog.clock_timestamp(),'$actor_id','c4810000-0000-4000-8000-0000000000a2',1);

  select * from vortex_access.initialize_organization_access_version('$organization_id','$actor_id','c4810000-0000-4000-8000-0000000000a3');
  select * from vortex_access.initialize_platform_permission_catalogue('$organization_id','$actor_id','c4810000-0000-4000-8000-0000000000a4');
  select * from vortex_access.revise_platform_permission_catalogue_metadata('$organization_id',1,'1.0.0','1.0.1','$actor_id','c4810000-0000-4000-8000-0000000000a5');
  select * from vortex_access.coordinate_organization_stewardship_adoption('$organization_id','$account_id','$steward_role_id','change_steward','Change steward','Permanent stewardship for the change proof.','$steward_assignment_id','$steward_delegation_id','$identity_id','c4810000-0000-4000-8000-0000000000a6');
  select * from vortex_access.adopt_shipped_platform_permission_catalogue('$organization_id',2,'1.1.0','sha256:cb42d4b24ebead7fe9e4ba6358115ceb3ae752d3a0b4cbedc458dcb218013778','$actor_id','c4810000-0000-4000-8000-0000000000a7');
  select * from vortex_access.coordinate_organization_group_change(
    'create_group','$organization_id','$owner_group_id',null,
    'na_create_owners','Record change owners','$actor_id',
    'c4810000-0000-4000-8000-000000000066');
  select * from vortex_access.coordinate_organization_group_change(
    'create_group','$organization_id','$transfer_target_a_group_id',null,
    'na_create_transfer_a','Record change transfer A','$actor_id',
    'c4810000-0000-4000-8000-00000000006a');
  select * from vortex_access.coordinate_organization_group_change(
    'create_group','$organization_id','$transfer_target_b_group_id',null,
    'na_create_transfer_b','Record change transfer B','$actor_id',
    'c4810000-0000-4000-8000-00000000006b');
  select * from vortex_access.coordinate_organization_group_membership_change(
    'add_membership','$organization_id','$owner_membership_id',null,
    '$owner_group_id','$account_id',pg_catalog.clock_timestamp()-interval '1 minute',
    null,null,'$actor_id','c4810000-0000-4000-8000-000000000067');

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
  values ('$organization_id','$installer_role_id',1,'custom','active','privileged','standing',1,1,'application_installer','Application installer','Current storage lifecycle authority.','$actor_id',pg_catalog.statement_timestamp(),'c4810000-0000-4000-8000-0000000000a8');
  insert into vortex_access.organization_role_assignments (organization_id, role_assignment_id, role_id, assignee_kind, organization_account_id, assignment_kind, revision, starts_at, state, granted_by, granted_at, grant_correlation_id, changed_by, changed_at, change_correlation_id)
  values ('$organization_id','$installer_assignment_id','$installer_role_id','organization_account','$account_id','standing',1,pg_catalog.statement_timestamp()-interval '1 minute','live','$actor_id',pg_catalog.statement_timestamp(),'c4810000-0000-4000-8000-0000000000a9','$actor_id',pg_catalog.statement_timestamp(),'c4810000-0000-4000-8000-0000000000a9');

  insert into vortex_definition.roots (root_id, organization_id, kind, key, created_at, created_by)
  values ('$module_root_id','$organization_id','module','vortex.named_action_create.module',pg_catalog.clock_timestamp()-interval '1 minute','$actor_id'),
         ('$application_root_id','$organization_id','application','vortex.named_action_create.application',pg_catalog.clock_timestamp()-interval '1 minute','$actor_id');
  insert into vortex_definition.drafts (root_id, draft_revision, draft_source, source_contract_version, source_fingerprint, updated_at, updated_by)
  values ('$module_root_id',1,pg_catalog.jsonb_build_object('source_contract_version','2.0.0','kind','module','key','vortex.named_action_create.module'),'2.0.0',$(sha "'module:source'"),pg_catalog.statement_timestamp(),'$actor_id'),
         ('$application_root_id',1,pg_catalog.jsonb_build_object('source_contract_version','1.0.0','kind','application','key','vortex.named_action_create.application'),'1.0.0',$(sha "'application:source'"),pg_catalog.statement_timestamp(),'$actor_id');
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
    'sessionId','c4810000-0000-4000-8000-0000000000b1',
    'issuedAt',pg_catalog.clock_timestamp()-interval '1 minute',
    'expiresAt',pg_catalog.clock_timestamp()+interval '5 minutes','accessVersion',1,
    'correlationId','c4810000-0000-4000-8000-0000000000b2','systemActorId','$actor_id',
    'authenticationStrength','service'));
  select * from vortex_definition.append_release('$module_root_id', 1, $(sha "'module:source'"),
    pg_catalog.jsonb_build_object(
      'releaseVersion','2.0.0',
      'compilationOutput',pg_catalog.jsonb_build_object(
        'kind','module','validationContractVersion','2.0.0',
        'resolutionFingerprint',$(sha "'module:resolution'"),
        'artifact',pg_catalog.jsonb_build_object('kind','module','rootId','$module_root_id',
          'definitionKey','vortex.named_action_create.module','exactVersion','2.0.0',
          'contentFingerprint',$(sha "'module:content'"),'resolutionFingerprint',$(sha "'module:resolution'")),
        'canonical',pg_catalog.jsonb_build_object(
          'envelope',pg_catalog.jsonb_build_object('kind','module','key','vortex.named_action_create.module',
            'rootId','$module_root_id','organizationId','$organization_id'),
          'content',$module_content)),
      'resolutionSnapshot',pg_catalog.jsonb_build_object('fingerprint',$(sha "'module:resolution'"),
        'definitions',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('kind','module',
          'key','vortex.named_action_create.module','rootId','$module_root_id','exactVersion','2.0.0'))),
      'contentFingerprint',$(sha "'module:content'"),'resolutionFingerprint',$(sha "'module:resolution'"),
      'validationContractVersion','2.0.0','comparisonFingerprint',$(sha "'module:content'"),
      'impactReasons','[]'::jsonb,'releaseNote','Named action create proof Module.','dependencies','[]'::jsonb));
  select * from vortex_definition.append_release('$application_root_id', 1, $(sha "'application:source'"),
    pg_catalog.jsonb_build_object(
      'releaseVersion','1.0.0',
      'compilationOutput',pg_catalog.jsonb_build_object(
        'kind','application','validationContractVersion','1.0.0',
        'resolutionFingerprint',$(sha "'application:resolution'"),
        'artifact',pg_catalog.jsonb_build_object('kind','application','rootId','$application_root_id',
          'definitionKey','vortex.named_action_create.application','exactVersion','1.0.0',
          'contentFingerprint',$(sha "'application:content'"),'resolutionFingerprint',$(sha "'application:resolution'")),
        'canonical',pg_catalog.jsonb_build_object(
          'envelope',pg_catalog.jsonb_build_object('kind','application','key','vortex.named_action_create.application',
            'rootId','$application_root_id','organizationId','$organization_id'),
          'content',pg_catalog.jsonb_build_object('permissions','[]'::jsonb))),
      'resolutionSnapshot',pg_catalog.jsonb_build_object('fingerprint',$(sha "'application:resolution'"),
        'definitions',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('kind','application',
          'key','vortex.named_action_create.application','rootId','$application_root_id','exactVersion','1.0.0'))),
      'contentFingerprint',$(sha "'application:content'"),'resolutionFingerprint',$(sha "'application:resolution'"),
      'validationContractVersion','1.0.0','comparisonFingerprint',$(sha "'application:content'"),
      'impactReasons','[]'::jsonb,'releaseNote','Named action create proof Application.',
      'dependencies',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'kind','module','key','vortex.named_action_create.module','rootId','$module_root_id',
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
    select pg_catalog.jsonb_build_object('kind','module','definitionKey','vortex.named_action_create.module',
      'rootId','$module_root_id','releaseRevision',1,'releaseVersion','2.0.0',
      'validationContractVersion','2.0.0','contentFingerprint',$(sha "'module:content'"),
      'resolutionFingerprint',$(sha "'module:resolution'")) as value
  ), application_release as (
    select pg_catalog.jsonb_build_object('kind','application','definitionKey','vortex.named_action_create.application',
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
        'template',pg_catalog.jsonb_build_object('roleId','c4810000-0000-4000-8000-0000000000c1',
          'key','change_template','name','Change template','homePageId','c4810000-0000-4000-8000-0000000000c2',
          'permissionKeys','[\"na_create.read\",\"na_create.update\",\"na_create.transfer\"]'::jsonb,
          'permissionSelection','{\"kind\":\"exact\"}'::jsonb),
        'sourceTemplateFingerprint',$(sha "'template'"),
        'sourcePermissions',candidate.entry_values,'livePermissions',candidate.entry_values)),
      'candidateFingerprint',$(sha "'preparation'")),
    '$organization_id','$application_root_id','$actor_id','c4810000-0000-4000-8000-0000000000c3');
  select 1 from vortex_access.coordinate_organization_role_change(
    pg_catalog.jsonb_build_object('contractVersion','1.0.0',
      'candidate',pg_catalog.jsonb_build_object('operation','create_custom','organizationId','$organization_id',
        'roleId','$role_id','key','na_create_role','label','Record change role',
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
    '$actor_id','c4810000-0000-4000-8000-0000000000c4');
  select 1 from vortex_access.coordinate_organization_role_assignment_change('grant','$organization_id',
    '$assignment_id',null,'$role_id',1,'organization_account','$account_id',null,'standing',
    pg_catalog.clock_timestamp()-interval '1 minute',null,'$actor_id','c4810000-0000-4000-8000-0000000000c5');
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
    application_root_id, definition_revision, owner_group_id, lifecycle_state, concurrency_number,
    created_at, created_by, updated_at, updated_by, deleted_at, deleted_by,
    $column_one, $column_reference,
    $column_link, $column_required_link
  ) values
    ('$organization_id','$module_root_id','$record_type_id','$storage_contract_id','$conflict_record_id',
      null,1,'$owner_group_id','active',1,pg_catalog.statement_timestamp(),'$account_id',pg_catalog.statement_timestamp(),'$account_id',null,null,'start','RC-EXIST-1',null,
      pg_catalog.jsonb_build_object('recordTypeId','$record_type_id','recordId','$anchor_record_id')),
    ('$organization_id','$module_root_id','$record_type_id','$storage_contract_id','$revocation_record_id',
      null,1,'$owner_group_id','active',1,pg_catalog.statement_timestamp(),'$account_id',pg_catalog.statement_timestamp(),'$account_id',null,null,'start','RC-EXIST-2',null,
      pg_catalog.jsonb_build_object('recordTypeId','$record_type_id','recordId','$anchor_record_id')),
    ('$organization_id','$module_root_id','$record_type_id','$storage_contract_id','$same_command_record_id',
      null,1,'$owner_group_id','active',1,pg_catalog.statement_timestamp(),'$account_id',pg_catalog.statement_timestamp(),'$account_id',null,null,'start','RC-EXIST-10',null,
      pg_catalog.jsonb_build_object('recordTypeId','$record_type_id','recordId','$anchor_record_id')),
    ('$organization_id','$module_root_id','$record_type_id','$storage_contract_id','$link_source_record_id',
      null,1,'$owner_group_id','active',1,pg_catalog.statement_timestamp(),'$account_id',pg_catalog.statement_timestamp(),'$account_id',null,null,
      'link source','RC-EXIST-3',pg_catalog.jsonb_build_object(
        'recordTypeId','$record_type_id','recordId','$link_target_record_id'),
      pg_catalog.jsonb_build_object('recordTypeId','$record_type_id','recordId','$anchor_record_id')),
    ('$organization_id','$module_root_id','$record_type_id','$storage_contract_id','$link_target_record_id',
      null,1,'$owner_group_id','active',1,pg_catalog.statement_timestamp(),'$account_id',pg_catalog.statement_timestamp(),'$account_id',null,null,
      'link target','RC-EXIST-4',null,
      pg_catalog.jsonb_build_object('recordTypeId','$record_type_id','recordId','$anchor_record_id')),
    ('$organization_id','$module_root_id','$record_type_id','$storage_contract_id','$anchor_record_id',
      null,1,'$owner_group_id','active',1,pg_catalog.statement_timestamp(),'$account_id',pg_catalog.statement_timestamp(),'$account_id',null,null,
      'anchor','RC-EXIST-5',null,
      pg_catalog.jsonb_build_object('recordTypeId','$record_type_id','recordId','$anchor_record_id')),
    ('$organization_id','$module_root_id','$record_type_id','$storage_contract_id','$link_add_source_record_id',
      null,1,'$owner_group_id','active',1,pg_catalog.statement_timestamp(),'$account_id',pg_catalog.statement_timestamp(),'$account_id',null,null,
      'link add source','RC-EXIST-6',null,
      pg_catalog.jsonb_build_object('recordTypeId','$record_type_id','recordId','$anchor_record_id')),
    ('$organization_id','$module_root_id','$record_type_id','$storage_contract_id','$link_add_target_record_id',
      null,1,'$owner_group_id','active',1,pg_catalog.statement_timestamp(),'$account_id',pg_catalog.statement_timestamp(),'$account_id',null,null,
      'link add target','RC-EXIST-7',null,
      pg_catalog.jsonb_build_object('recordTypeId','$record_type_id','recordId','$anchor_record_id')),
    ('$organization_id','$module_root_id','$record_type_id','$storage_contract_id','$restore_target_record_id',
      null,1,'$owner_group_id','active',1,pg_catalog.statement_timestamp(),'$account_id',pg_catalog.statement_timestamp(),'$account_id',null,null,
      'restore target','RC-EXIST-8',null,
      pg_catalog.jsonb_build_object('recordTypeId','$record_type_id','recordId','$anchor_record_id')),
    ('$organization_id','$module_root_id','$record_type_id','$storage_contract_id','$restore_source_record_id',
      null,1,'$owner_group_id','soft_deleted',1,pg_catalog.statement_timestamp(),'$account_id',pg_catalog.statement_timestamp(),'$account_id',
      pg_catalog.statement_timestamp(),'$account_id',
      'restore source','RC-EXIST-9',null,
      pg_catalog.jsonb_build_object('recordTypeId','$record_type_id','recordId','$restore_target_record_id')),
    ('$organization_id','$module_root_id','$record_type_id','$storage_contract_id','$transfer_record_id',
      null,1,'$owner_group_id','active',1,pg_catalog.statement_timestamp(),'$account_id',pg_catalog.statement_timestamp(),'$account_id',null,null,
      'transfer source','RC-EXIST-11',null,
      pg_catalog.jsonb_build_object('recordTypeId','$record_type_id','recordId','$anchor_record_id'));
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
      ('$same_command_record_id'::uuid,'$anchor_record_id'::uuid),
      ('$link_source_record_id'::uuid,'$anchor_record_id'::uuid),
      ('$link_target_record_id'::uuid,'$anchor_record_id'::uuid),
      ('$anchor_record_id'::uuid,'$anchor_record_id'::uuid),
      ('$link_add_source_record_id'::uuid,'$anchor_record_id'::uuid),
      ('$link_add_target_record_id'::uuid,'$anchor_record_id'::uuid),
      ('$restore_target_record_id'::uuid,'$anchor_record_id'::uuid),
      ('$restore_source_record_id'::uuid,'$restore_target_record_id'::uuid),
      ('$transfer_record_id'::uuid,'$anchor_record_id'::uuid)
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
    array['%s','%s']::uuid[], '%s'::uuid)" \
    "$record_type_id" "$field_one" "$title" "$field_required_link" \
    "$record_type_id" "$anchor_record_id" "$field_one" "$field_required_link" \
    "$owner_group_id"
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
        'sessionId','c4810000-0000-4000-8000-0000000000f1',
        'authenticationStrength','single_factor',
        'issuedAt',pg_catalog.statement_timestamp(),
        'expiresAt',pg_catalog.statement_timestamp()+interval '1 hour',
        'accessVersion',(
          select version.current_version from vortex_access.organization_access_versions as version
          where version.organization_id = '$organization_id'
        ),
        'correlationId','c4810000-0000-4000-8000-0000000000f2',
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


share_lock_statement() {
  printf "vortex_record.share_lock_named_action_target_internal(
    vortex_record.relationship_total_catalogue_internal(), '%s'::uuid, '%s'::uuid)" \
    "$record_type_id" "$link_target_record_id"
}

allocate_statement() {
  printf "vortex_record.allocate_reference_number_internal('%s'::uuid,'%s'::uuid,'%s'::uuid,null::uuid,
    pg_catalog.jsonb_build_object('prefix','RC-','digits',3))" \
    "$organization_id" "$storage_contract_id" "$field_reference"
}

linked_create_statement() {
  local title="$1"
  printf "vortex_record.create_record_internal('%s'::uuid,
    pg_catalog.jsonb_build_object('%s','%s',
      '%s',pg_catalog.jsonb_build_object('recordTypeId','%s','recordId','%s'),
      '%s',pg_catalog.jsonb_build_object('recordTypeId','%s','recordId','%s')),
    array['%s','%s','%s']::uuid[], '%s'::uuid)" \
    "$record_type_id" "$field_one" "$title" \
    "$field_link" "$record_type_id" "$link_target_record_id" \
    "$field_required_link" "$record_type_id" "$anchor_record_id" \
    "$field_one" "$field_link" "$field_required_link" \
    "$owner_group_id"
}

deadlock_free() {
  local label="$1" log_path
  for log_path in "${@:2}"; do
    [ -f "$log_path" ] || continue
    if grep -qiE 'deadlock detected|40P01' "$log_path"; then
      printf 'the %s scenario deadlocked; the delivered lock order is not safe\n' "$label" >&2
      tail -n 20 -- "$log_path" >&2
      return 1
    fi
  done
  return 0
}

# ----------------------------------------------------------------------------
# Scenario one: opposite resource order. The named-action share is taken first
# and released to request the counter; the ordinary create holds the counter and
# is released to request that same share.
# ----------------------------------------------------------------------------
access_version="$(current_version)"

"${psql_command[@]}" >"$proof_root/opposite-share.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/opposite-share.pid'
$(human_context "$access_version")
set local role vortex_record_adapter;
select $(share_lock_statement) \g '$proof_root/opposite-share.locked'
\! touch '$proof_root/opposite-share-ready'
\! deadline=600; while [ ! -f '$proof_root/opposite-share-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/opposite-share-release' ]
select $(allocate_statement) \g '$proof_root/opposite-share.reference'
reset role;
commit;
SQL
opposite_share_pid=$!; worker_pids+=("$opposite_share_pid")
worker_labels[opposite-share]="$opposite_share_pid"
record_stage "opposite-share launched shell_pid=$opposite_share_pid"
wait_for_file "$proof_root/opposite-share-ready"
opposite_share_backend="$(read_backend_pid "$proof_root/opposite-share.pid")"
record_stage "opposite-share ready backend_pid=$opposite_share_backend"
[ "$(tr -d '[:space:]' <"$proof_root/opposite-share.locked")" = 't' ] || {
  echo 'the named-action preflight did not take its link-target share lock' >&2; exit 1
}

"${psql_command[@]}" >"$proof_root/opposite-counter.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/opposite-counter.pid'
$(human_context "$access_version")
set local role vortex_record_adapter;
select $(allocate_statement) \g '$proof_root/opposite-counter.reference'
\! touch '$proof_root/opposite-counter-ready'
\! deadline=600; while [ ! -f '$proof_root/opposite-counter-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/opposite-counter-release' ]
select result ->> 'outcome'
from (select $(linked_create_statement 'opposite order create') as result) as created
\g '$proof_root/opposite-counter.result'
reset role;
commit;
SQL
opposite_counter_pid=$!; worker_pids+=("$opposite_counter_pid")
worker_labels[opposite-counter]="$opposite_counter_pid"
record_stage "opposite-counter launched shell_pid=$opposite_counter_pid"
wait_for_file "$proof_root/opposite-counter-ready"
opposite_counter_backend="$(read_backend_pid "$proof_root/opposite-counter.pid")"
record_stage "opposite-counter ready backend_pid=$opposite_counter_backend"

# Both opposite resources are now held. Release the share holder so it waits on
# the counter, then release the counter holder into the share it must pass.
touch "$proof_root/opposite-share-release"
record_stage 'opposite-share released toward counter'
wait_for_database_blocker "$opposite_share_backend" "$opposite_counter_backend" \
  'the named-action creation waiting for the ordinary counter'
touch "$proof_root/opposite-counter-release"
record_stage 'opposite-counter released toward share'

wait_owned_worker "$opposite_counter_pid" 'opposite-counter' || {
  echo 'the ordinary create did not complete through the held share lock' >&2; exit 1
}
wait_owned_worker "$opposite_share_pid" 'opposite-share' || {
  echo 'the named-action creation did not complete after the counter was released' >&2; exit 1
}
deadlock_free 'opposite order' "$proof_root/opposite-share.log" "$proof_root/opposite-counter.log" || exit 1
[ "$(tr -d '[:space:]' <"$proof_root/opposite-counter.result")" = 'completed' ] || {
  printf 'the ordinary create did not complete: %q\n' \
    "$(tr -d '[:space:]' <"$proof_root/opposite-counter.result")" >&2; exit 1
}
opposite_state="$(run_sql "select pg_catalog.concat_ws('|',
  (select pg_catalog.count(*)::text from record_data.$physical_table
    where $column_one = 'opposite order create'),
  (select pg_catalog.count(*)::text from vortex_record.relationship_edges as edge
    join record_data.$physical_table as created on created.record_id = edge.from_record_id
    where edge.relationship_id = '$relationship_id'
      and edge.to_record_id = '$link_target_record_id'
      and created.$column_one = 'opposite order create'));")"
[ "$opposite_state" = '1|1' ] || {
  printf 'the opposite-order scenario did not leave one created row and one edge: %q\n' \
    "$opposite_state" >&2; exit 1
}
echo "opposite order: share-then-counter and counter-then-share both committed, state is $opposite_state"

# ----------------------------------------------------------------------------
# Scenario two: the same opposite order with an exclusive waiter queued on the
# link target between the two. The only soft edge in the resulting wait-for
# cycle is the ordinary create's queue position behind that waiter.
# ----------------------------------------------------------------------------
access_version="$(current_version)"

"${psql_command[@]}" >"$proof_root/queued-share.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/queued-share.pid'
$(human_context "$access_version")
set local role vortex_record_adapter;
select $(share_lock_statement) \g '$proof_root/queued-share.locked'
\! touch '$proof_root/queued-share-ready'
\! deadline=600; while [ ! -f '$proof_root/queued-share-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/queued-share-release' ]
select $(allocate_statement) \g '$proof_root/queued-share.reference'
reset role;
commit;
SQL
queued_share_pid=$!; worker_pids+=("$queued_share_pid")
worker_labels[queued-share]="$queued_share_pid"
record_stage "queued-share launched shell_pid=$queued_share_pid"
wait_for_file "$proof_root/queued-share-ready"
queued_share_backend="$(read_backend_pid "$proof_root/queued-share.pid")"
record_stage "queued-share ready backend_pid=$queued_share_backend"

"${psql_command[@]}" >"$proof_root/queued-counter.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/queued-counter.pid'
$(human_context "$access_version")
set local role vortex_record_adapter;
select $(allocate_statement) \g '$proof_root/queued-counter.reference'
\! touch '$proof_root/queued-counter-ready'
\! deadline=600; while [ ! -f '$proof_root/queued-counter-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/queued-counter-release' ]
select result ->> 'outcome'
from (select $(linked_create_statement 'queued order create') as result) as created
\g '$proof_root/queued-counter.result'
reset role;
commit;
SQL
queued_counter_pid=$!; worker_pids+=("$queued_counter_pid")
worker_labels[queued-counter]="$queued_counter_pid"
record_stage "queued-counter launched shell_pid=$queued_counter_pid"
wait_for_file "$proof_root/queued-counter-ready"
queued_counter_backend="$(read_backend_pid "$proof_root/queued-counter.pid")"
record_stage "queued-counter ready backend_pid=$queued_counter_backend"

"${psql_command[@]}" >"$proof_root/queued-exclusive.log" 2>&1 <<SQL &
begin;
set local lock_timeout='30s'; set local statement_timeout='45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/queued-exclusive.pid'
$(human_context "$access_version")
set local role vortex_record_adapter;
\! touch '$proof_root/queued-exclusive-started'
select record_id from record_data.$physical_table
where record_id='$link_target_record_id' for update \g /dev/null
\! touch '$proof_root/queued-exclusive-held'
\! deadline=600; while [ ! -f '$proof_root/queued-exclusive-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/queued-exclusive-release' ]
reset role;
commit;
SQL
queued_exclusive_pid=$!; worker_pids+=("$queued_exclusive_pid")
worker_labels[queued-exclusive]="$queued_exclusive_pid"
record_stage "queued-exclusive launched shell_pid=$queued_exclusive_pid"
wait_for_file "$proof_root/queued-exclusive-started"
queued_exclusive_backend="$(read_backend_pid "$proof_root/queued-exclusive.pid")"
record_stage "queued-exclusive started backend_pid=$queued_exclusive_backend"
wait_for_database_blocker "$queued_exclusive_backend" "$queued_share_backend" \
  'the exclusive waiter queued behind the named-action share'

touch "$proof_root/queued-share-release"
record_stage 'queued-share released toward counter'
wait_for_database_blocker "$queued_share_backend" "$queued_counter_backend" \
  'the named-action creation waiting for the ordinary counter'
touch "$proof_root/queued-counter-release"
record_stage 'queued-counter released toward queued share'

wait_owned_worker "$queued_counter_pid" 'queued-counter' || {
  echo 'the ordinary create did not pass the queued exclusive waiter' >&2; exit 1
}
wait_owned_worker "$queued_share_pid" 'queued-share' || {
  echo 'the named-action creation did not complete behind the queued waiter' >&2; exit 1
}
touch "$proof_root/queued-exclusive-release"
record_stage 'queued-exclusive released'
wait_owned_worker "$queued_exclusive_pid" 'queued-exclusive' || {
  echo 'the exclusive waiter did not complete' >&2; exit 1
}
deadlock_free 'queued exclusive' "$proof_root/queued-share.log" \
  "$proof_root/queued-counter.log" "$proof_root/queued-exclusive.log" || exit 1
[ "$(tr -d '[:space:]' <"$proof_root/queued-counter.result")" = 'completed' ] || {
  printf 'the ordinary create did not complete behind the queued waiter: %q\n' \
    "$(tr -d '[:space:]' <"$proof_root/queued-counter.result")" >&2; exit 1
}
queued_state="$(run_sql "select pg_catalog.concat_ws('|',
  (select pg_catalog.count(*)::text from record_data.$physical_table
    where $column_one = 'queued order create'),
  (select pg_catalog.count(*)::text from vortex_record.relationship_edges as edge
    join record_data.$physical_table as created on created.record_id = edge.from_record_id
    where edge.relationship_id = '$relationship_id'
      and edge.to_record_id = '$link_target_record_id'
      and created.$column_one = 'queued order create'));")"
[ "$queued_state" = '1|1' ] || {
  printf 'the queued-exclusive scenario did not leave one created row and its edge: %q\n' \
    "$queued_state" >&2; exit 1
}
echo "queued exclusive: the ordinary create passed the queued waiter, state is $queued_state"

echo 'named action create concurrency proof passed'
