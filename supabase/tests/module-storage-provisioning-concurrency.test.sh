#!/usr/bin/env bash

set -euo pipefail

readonly proof_root="$(mktemp -d /tmp/vortex-module-storage-provisioning.XXXXXX)"
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id='c4550000-0000-4000-8000-000000000001'
readonly organization_id='c4550000-0000-4000-8000-000000000002'
readonly identity_id='c4550000-0000-4000-8000-000000000003'
readonly organization_account_id='c4550000-0000-4000-8000-000000000004'
readonly actor_id='c4550000-0000-4000-8000-000000000005'
readonly application_root_id='c4550000-0000-4000-8000-000000000010'
readonly module_root_id='c4550000-0000-4000-8000-000000000011'
readonly record_type_id='c4550000-0000-4000-8000-000000000012'
readonly storage_contract_id='c4550000-0000-4000-8000-000000000013'
readonly field_id='c4550000-0000-4000-8000-000000000014'
readonly steward_role_id='c4550000-0000-4000-8000-000000000030'
readonly steward_assignment_id='c4550000-0000-4000-8000-000000000031'
readonly steward_delegation_id='c4550000-0000-4000-8000-000000000032'
readonly installer_role_id='c4550000-0000-4000-8000-000000000033'
readonly installer_assignment_id='c4550000-0000-4000-8000-000000000034'
readonly physical_table_token='rt_c4550000000040008000000000000013'
readonly physical_column_token='f_c4550000000040008000000000000014'

fixture_claimed=0
declare -a worker_pids=()
declare -A reaped_worker_pids=()

psql_command=(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1)
if [ -n "$database_url" ]; then
  psql_command+=("$database_url")
fi

run_sql() {
  "${psql_command[@]}" --command "$1"
}

wait_for_file() {
  local candidate="$1"
  local deadline=$((SECONDS + 20))

  while ((SECONDS < deadline)); do
    [ -f "$candidate" ] && return 0
    sleep 0.05
  done
  printf 'module storage proof did not reach barrier %s\n' "$candidate" >&2
  return 1
}

read_backend_pid() {
  local candidate="$1"
  local backend_pid

  wait_for_file "$candidate"
  backend_pid="$(tr -d '[:space:]' <"$candidate")"
  [[ "$backend_pid" =~ ^[1-9][0-9]*$ ]] || {
    printf 'module storage proof captured invalid backend id %q\n' "$backend_pid" >&2
    return 1
  }
  printf '%s\n' "$backend_pid"
}

wait_for_database_blocker() {
  local blocked_pid="$1"
  local blocking_pid="$2"
  local deadline=$((SECONDS + 20))
  local state

  while ((SECONDS < deadline)); do
    state="$(run_sql "
      select case
        when $blocking_pid = any(pg_catalog.pg_blocking_pids($blocked_pid)) then 'blocked'
        else ''
      end;
    ")"
    [ "$state" = 'blocked' ] && return 0
    sleep 0.1
  done
  echo 'the second first-install coordinator did not wait on the binding identity lock' >&2
  return 1
}

wait_owned_worker() {
  local pid="$1"
  local status

  if wait "$pid"; then
    status=0
  else
    status=$?
  fi
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
    do \$proof\$
    begin
      if not exists (
        select 1 from vortex_definition.roots
        where root_id = '$application_root_id'
          and organization_id = '$organization_id'
          and key = 'vortex.storage_concurrency.application'
          and created_by = '$actor_id'
      ) or not exists (
        select 1 from vortex_definition.roots
        where root_id = '$module_root_id'
          and key = 'vortex.storage_concurrency.module'
          and created_by = '$actor_id'
      ) then
        raise exception 'Module storage proof fixture ownership marker mismatch';
      end if;
    end
    \$proof\$;
    set local role vortex_module_owner;
    delete from vortex_module.installation_bindings
      where organization_id = '$organization_id'
        and application_root_id = '$application_root_id'
        and module_root_id = '$module_root_id';
    reset role;
    set local role vortex_record_owner;
    drop table if exists record_data.$physical_table_token;
    delete from vortex_record.relationship_edges
      where from_storage_contract_id = '$storage_contract_id'
         or to_storage_contract_id = '$storage_contract_id';
    delete from vortex_record.relationship_storage_mappings
      where module_root_id = '$module_root_id'
         or source_storage_contract_id = '$storage_contract_id';
    delete from vortex_record.field_storage_mappings
      where storage_contract_id = '$storage_contract_id';
    delete from vortex_record.storage_catalogue
      where storage_contract_id = '$storage_contract_id'
        and module_root_id = '$module_root_id';
    delete from vortex_record.release_provisions
      where module_root_id = '$module_root_id';
    reset role;
    do \$proof\$
    declare
      target record;
    begin
      for target in
        select c.table_name
        from information_schema.columns as c
        where c.table_schema = 'vortex_access'
          and c.column_name = 'organization_id'
        group by c.table_name
      loop
        execute pg_catalog.format(
          'delete from vortex_access.%I where organization_id = \$1',
          target.table_name
        ) using '$organization_id'::uuid;
      end loop;
    end
    \$proof\$;
    delete from vortex_definition.release_dependencies
      where root_id = '$application_root_id'
         or target_root_id = '$module_root_id';
    delete from vortex_definition.releases
      where root_id in ('$application_root_id', '$module_root_id');
    delete from vortex_definition.roots
      where root_id in ('$application_root_id', '$module_root_id');
    delete from vortex_identity.organization_accounts
      where organization_account_id = '$organization_account_id';
    delete from vortex_identity.identity_projections
      where identity_id = '$identity_id';
    delete from vortex_identity.organizations
      where organization_id = '$organization_id';
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
  touch "$proof_root/first-release" >/dev/null 2>&1 || true
  stop_owned_workers
  cleanup_fixture
  operation_status=$?
  if [ "$operation_status" -ne 0 ]; then
    echo "module storage proof fixture cleanup failed with status $operation_status" >&2
    cleanup_status="$operation_status"
  fi
  case "$proof_root" in
    /tmp/vortex-module-storage-provisioning.*)
      rm -r -- "$proof_root"
      operation_status=$?
      ;;
    *)
      echo "refusing to remove unexpected proof directory: $proof_root" >&2
      operation_status=1
      ;;
  esac
  if [ "$operation_status" -ne 0 ]; then
    [ "$cleanup_status" -ne 0 ] || cleanup_status="$operation_status"
  fi
  if [ "$original_status" -ne 0 ]; then
    [ "$cleanup_status" -eq 0 ] || echo 'cleanup also failed while preserving proof failure' >&2
    exit "$original_status"
  fi
  exit "$cleanup_status"
}
trap finalize EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

schema_state="$(run_sql "
  select pg_catalog.concat_ws('|',
    pg_catalog.to_regprocedure(
      'vortex_module.provision_module_installation_storage(uuid,bigint,uuid,bigint,bigint)'
    ) is not null,
    pg_catalog.to_regclass('vortex_record.storage_catalogue') is not null
  );
")"
[ "$schema_state" = 't|t' ] || {
  echo 'module storage migrations must already be applied to the proof database' >&2
  exit 1
}

run_sql "
  begin;
  do \$proof\$
  begin
    if exists (select 1 from vortex_identity.tenants where tenant_id = '$tenant_id')
      or exists (select 1 from vortex_identity.organizations where organization_id = '$organization_id')
      or exists (select 1 from vortex_identity.identity_projections where identity_id = '$identity_id')
      or exists (
        select 1 from vortex_identity.organization_accounts
        where organization_account_id = '$organization_account_id'
      )
      or exists (
        select 1 from vortex_definition.roots
        where root_id in ('$application_root_id', '$module_root_id')
      )
      or exists (
        select 1 from vortex_record.storage_catalogue
        where storage_contract_id = '$storage_contract_id'
      )
      or pg_catalog.to_regclass('record_data.$physical_table_token') is not null then
      raise exception 'Module storage proof fixture scope already exists';
    end if;
  end
  \$proof\$;

  insert into vortex_identity.tenants (
    tenant_id, short_name, display_name, state, created_at, created_by,
    state_changed_at, revision
  ) values (
    '$tenant_id', 'storage_concurrency', 'Storage concurrency', 'active',
    pg_catalog.statement_timestamp(), '$actor_id', pg_catalog.statement_timestamp(), 1
  );
  insert into vortex_identity.organizations (
    organization_id, tenant_id, parent_organization_id, short_name, display_name,
    state, created_at, created_by, state_changed_at, revision
  ) values (
    '$organization_id', '$tenant_id', null, 'storage_concurrency',
    'Storage concurrency', 'active', pg_catalog.statement_timestamp(), '$actor_id',
    pg_catalog.statement_timestamp(), 1
  );
  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values (
    '$identity_id', 'active', pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(), '$actor_id',
    'c4550000-0000-4000-8000-000000000020', 1
  );
  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name, state,
    activated_at, changed_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values (
    '$organization_account_id', '$organization_id', '$identity_id',
    'Storage concurrency steward', 'active', pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(), '$actor_id',
    'c4550000-0000-4000-8000-000000000021', 1
  );

  select * from vortex_access.initialize_organization_access_version(
    '$organization_id', '$actor_id', 'c4550000-0000-4000-8000-000000000022'
  );
  select * from vortex_access.initialize_platform_permission_catalogue(
    '$organization_id', '$actor_id', 'c4550000-0000-4000-8000-000000000023'
  );
  select * from vortex_access.revise_platform_permission_catalogue_metadata(
    '$organization_id', 1, '1.0.0', '1.0.1', '$actor_id',
    'c4550000-0000-4000-8000-000000000024'
  );
  select * from vortex_access.coordinate_organization_stewardship_adoption(
    '$organization_id', '$organization_account_id', '$steward_role_id',
    'storage_concurrency_steward', 'Storage concurrency steward',
    'Permanent test stewardship.', '$steward_assignment_id',
    '$steward_delegation_id', '$identity_id',
    'c4550000-0000-4000-8000-000000000025'
  );
  select * from vortex_access.adopt_shipped_platform_permission_catalogue(
    '$organization_id', 2, '1.1.0',
    'sha256:cb42d4b24ebead7fe9e4ba6358115ceb3ae752d3a0b4cbedc458dcb218013778',
    '$actor_id', 'c4550000-0000-4000-8000-000000000026'
  );

  insert into vortex_access.organization_roles (
    organization_id, role_id, role_kind, role_key, live_revision, created_by, created_at
  ) values (
    '$organization_id', '$installer_role_id', 'custom', 'application_installer', 1,
    '$actor_id', pg_catalog.statement_timestamp()
  );
  insert into vortex_access.organization_role_permission_entries (
    organization_id, role_id, role_revision, entry_ordinal, role_kind,
    role_application_root_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id,
    accepted_registration_revision, catalogue_fingerprint, continuity_revision,
    meaning_fingerprint
  )
  select entry.organization_id, '$installer_role_id'::uuid, 1, 1, 'custom', null,
    entry.application_root_id, entry.owner_kind, entry.owner_id, entry.permission_id,
    entry.registration_kind, entry.registration_owner_id, entry.registration_revision,
    registration.permission_catalogue_fingerprint, continuity.continuity_revision,
    entry.meaning_fingerprint
  from vortex_access.permission_catalogue_entries as entry
  join vortex_access.permission_registration_revisions as registration
    on registration.organization_id = entry.organization_id
    and registration.registration_kind = entry.registration_kind
    and registration.registration_owner_id = entry.registration_owner_id
    and registration.revision = entry.registration_revision
  join vortex_access.permission_continuities as continuity
    on continuity.organization_id = entry.organization_id
    and continuity.application_root_id is not distinct from entry.application_root_id
    and continuity.owner_kind = entry.owner_kind
    and continuity.owner_id = entry.owner_id
    and continuity.permission_id = entry.permission_id
  where entry.organization_id = '$organization_id'
    and entry.registration_kind = 'platform'
    and entry.registration_revision = 3
    and entry.permission_id = '7ecd3304-f16c-47d4-94db-0964980091ba';
  insert into vortex_access.organization_role_revisions (
    organization_id, role_id, revision, role_kind, lifecycle,
    privilege_classification, assignment_policy, policy_continuity_revision,
    authority_continuity_revision, role_key, label, description,
    changed_by, changed_at, change_correlation_id
  ) values (
    '$organization_id', '$installer_role_id', 1, 'custom', 'active', 'privileged',
    'standing', 1, 1, 'application_installer', 'Application installer',
    'Current storage lifecycle authority.', '$actor_id',
    pg_catalog.statement_timestamp(), 'c4550000-0000-4000-8000-000000000027'
  );
  insert into vortex_access.organization_role_assignments (
    organization_id, role_assignment_id, role_id, assignee_kind,
    organization_account_id, assignment_kind, revision, starts_at, state,
    granted_by, granted_at, grant_correlation_id, changed_by, changed_at,
    change_correlation_id
  ) values (
    '$organization_id', '$installer_assignment_id', '$installer_role_id',
    'organization_account', '$organization_account_id', 'standing', 1,
    pg_catalog.statement_timestamp() - interval '1 minute', 'live', '$actor_id',
    pg_catalog.statement_timestamp(), 'c4550000-0000-4000-8000-000000000028',
    '$actor_id', pg_catalog.statement_timestamp(),
    'c4550000-0000-4000-8000-000000000028'
  );

  insert into vortex_definition.roots (
    root_id, organization_id, kind, key, created_at, created_by
  ) values
    ('$application_root_id', '$organization_id', 'application',
      'vortex.storage_concurrency.application', pg_catalog.statement_timestamp(), '$actor_id'),
    ('$module_root_id', '$organization_id', 'module',
      'vortex.storage_concurrency.module', pg_catalog.statement_timestamp(), '$actor_id');
  insert into vortex_definition.releases (
    root_id, release_revision, release_version, authored_source,
    authored_source_fingerprint, source_contract_version, compilation_output,
    resolution_snapshot, content_fingerprint, resolution_fingerprint,
    validation_contract_version, comparison_fingerprint, impact_reasons,
    release_note, published_at, published_by
  ) values
  (
    '$module_root_id', 1, '2.0.0',
    pg_catalog.jsonb_build_object(
      'source_contract_version', '2.0.0', 'kind', 'module',
      'key', 'vortex.storage_concurrency.module'
    ),
    'sha256:' || pg_catalog.repeat('1', 64), '2.0.0',
    pg_catalog.jsonb_build_object(
      'kind', 'module', 'validationContractVersion', '2.0.0',
      'canonical', pg_catalog.jsonb_build_object(
        'envelope', pg_catalog.jsonb_build_object('rootId', '$module_root_id'),
        'content', pg_catalog.jsonb_build_object(
          'recordTypes', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'recordTypeId', '$record_type_id',
            'storageContractId', '$storage_contract_id',
            'storageScope', 'organization_shared', 'ownershipMode', 'group',
            'fields', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
              'fieldId', '$field_id', 'type', 'text', 'required', true,
              'unique', false, 'filterable', true, 'sortable', true,
              'settings', '{}'::jsonb
            )),
            'relationships', '[]'::jsonb
          ))
        )
      )
    ),
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('2', 64)),
    'sha256:' || pg_catalog.repeat('3', 64),
    'sha256:' || pg_catalog.repeat('2', 64), '2.0.0',
    'sha256:' || pg_catalog.repeat('4', 64), '[]'::jsonb,
    'Storage concurrency Module V2.', pg_catalog.statement_timestamp(), '$actor_id'
  ),
  (
    '$application_root_id', 1, '1.0.0',
    pg_catalog.jsonb_build_object(
      'source_contract_version', '1.0.0', 'kind', 'application',
      'key', 'vortex.storage_concurrency.application'
    ),
    'sha256:' || pg_catalog.repeat('5', 64), '1.0.0',
    pg_catalog.jsonb_build_object(
      'kind', 'application', 'validationContractVersion', '1.0.0',
      'canonical', pg_catalog.jsonb_build_object(
        'envelope', pg_catalog.jsonb_build_object('rootId', '$application_root_id'),
        'content', '{}'::jsonb
      )
    ),
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('6', 64)),
    'sha256:' || pg_catalog.repeat('7', 64),
    'sha256:' || pg_catalog.repeat('6', 64), '1.0.0',
    'sha256:' || pg_catalog.repeat('8', 64), '[]'::jsonb,
    'Storage concurrency Application V1.', pg_catalog.statement_timestamp(), '$actor_id'
  );
  insert into vortex_definition.release_dependencies (
    root_id, release_revision, dependency_kind, dependency_reference,
    dependency_version, dependency_content_fingerprint, evidence_fingerprint,
    target_root_id, target_release_revision, catalogue_item_id
  ) values (
    '$application_root_id', 1, 'module', 'vortex.storage_concurrency.module',
    '2.0.0', 'sha256:' || pg_catalog.repeat('3', 64),
    'sha256:' || pg_catalog.repeat('2', 64), '$module_root_id', 1, null
  );
  commit;
" >/dev/null
fixture_claimed=1

request_context="
  pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', '$actor_id'::uuid,
    'tenantId', '$tenant_id'::uuid,
    'organizationId', '$organization_id'::uuid,
    'organizationAccountId', '$organization_account_id'::uuid,
    'identityId', '$identity_id'::uuid,
    'sessionId', 'c4550000-0000-4000-8000-000000000040'::uuid,
    'authenticationStrength', 'single_factor',
    'issuedAt', pg_catalog.statement_timestamp(),
    'expiresAt', pg_catalog.statement_timestamp() + interval '1 hour',
    'accessVersion', (
      select current_version from vortex_access.organization_access_versions
      where organization_id = '$organization_id'
    ),
    'correlationId', 'c4550000-0000-4000-8000-000000000041'::uuid,
    'accessTokenIssuedAt', pg_catalog.statement_timestamp(),
    'primaryAuthenticatedAt', pg_catalog.statement_timestamp()
  )
"

PGAPPNAME='vortex-module-storage-first-a' \
  "${psql_command[@]}" >"$proof_root/first-a.log" 2>&1 <<SQL &
begin;
set local statement_timeout = '45s';
select vortex_context.initialize($request_context);
set local role vortex_request;
select pg_catalog.pg_backend_pid()
\g '$proof_root/first-a.pid'
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
  'vortex_module.binding:$organization_id:$application_root_id:$module_root_id', 0
));
\! touch '$proof_root/first-a-ready'
\! deadline=600; while [ ! -f '$proof_root/first-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/first-release' ]
select pg_catalog.concat_ws('|', state, changed, binding_revision)
from vortex_module.provision_module_installation_storage(
  '$application_root_id', 1, '$module_root_id', 1, null
)
\g '$proof_root/first-a.result'
commit;
SQL
first_a_pid=$!
worker_pids+=("$first_a_pid")
wait_for_file "$proof_root/first-a-ready"
first_a_backend_pid="$(read_backend_pid "$proof_root/first-a.pid")"

PGAPPNAME='vortex-module-storage-first-b' \
  "${psql_command[@]}" >"$proof_root/first-b.log" 2>&1 <<SQL &
begin;
set local statement_timeout = '45s';
select vortex_context.initialize($request_context);
set local role vortex_request;
select pg_catalog.pg_backend_pid()
\g '$proof_root/first-b.pid'
select pg_catalog.concat_ws('|', state, changed, binding_revision)
from vortex_module.provision_module_installation_storage(
  '$application_root_id', 1, '$module_root_id', 1, null
)
\g '$proof_root/first-b.result'
commit;
SQL
first_b_pid=$!
worker_pids+=("$first_b_pid")
first_b_backend_pid="$(read_backend_pid "$proof_root/first-b.pid")"
wait_for_database_blocker "$first_b_backend_pid" "$first_a_backend_pid"
touch "$proof_root/first-release"

if ! wait_owned_worker "$first_a_pid"; then
  echo 'the first storage coordinator failed' >&2
  sed -n '1,80p' "$proof_root/first-a.log" >&2
  exit 1
fi
if ! wait_owned_worker "$first_b_pid"; then
  echo 'the waiting storage coordinator failed' >&2
  sed -n '1,80p' "$proof_root/first-b.log" >&2
  exit 1
fi

first_a_result="$(tr -d '[:space:]' <"$proof_root/first-a.result")"
first_b_result="$(tr -d '[:space:]' <"$proof_root/first-b.result")"
[ "$first_a_result" = 'provisioned|t|1' ] || {
  printf 'the lock holder did not perform exactly one first provision: %q\n' "$first_a_result" >&2
  exit 1
}
[ "$first_b_result" = 'provisioned|f|1' ] || {
  printf 'the waiting coordinator did not replay the committed provision: %q\n' "$first_b_result" >&2
  exit 1
}

final_state="$(run_sql "
  select pg_catalog.concat_ws('|',
    (select pg_catalog.count(*) from vortex_module.installation_bindings
      where organization_id = '$organization_id'
        and application_root_id = '$application_root_id'
        and module_root_id = '$module_root_id'),
    (select pg_catalog.count(*) from vortex_record.storage_catalogue
      where storage_contract_id = '$storage_contract_id'
        and module_root_id = '$module_root_id'),
    (select pg_catalog.count(*) from vortex_record.field_storage_mappings
      where storage_contract_id = '$storage_contract_id'
        and field_id = '$field_id'),
    (select pg_catalog.count(*) from vortex_record.release_provisions
      where module_root_id = '$module_root_id' and release_revision = 1),
    pg_catalog.to_regclass('record_data.$physical_table_token') is not null,
    exists (
      select 1 from pg_catalog.pg_attribute
      where attrelid = 'record_data.$physical_table_token'::regclass
        and attname = '$physical_column_token'
        and attnum > 0 and not attisdropped
    ),
    (select binding_revision from vortex_module.installation_bindings
      where organization_id = '$organization_id'
        and application_root_id = '$application_root_id'
        and module_root_id = '$module_root_id')
  );
")"
[ "$final_state" = '1|1|1|1|t|t|1' ] || {
  printf 'concurrent first provisioning left duplicate or partial state: %q\n' "$final_state" >&2
  exit 1
}

echo 'Module storage provisioning concurrency proof passed'
