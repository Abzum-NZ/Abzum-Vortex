#!/usr/bin/env bash

set -euo pipefail

run_uuid="${VORTEX_APPLICATION_ACCESS_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then
  [ -r /proc/sys/kernel/random/uuid ] || {
    echo 'a Linux random UUID source is required for the application-access proof' >&2
    exit 1
  }
  IFS= read -r run_uuid </proc/sys/kernel/random/uuid
fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  echo 'VORTEX_APPLICATION_ACCESS_PROOF_RUN_ID must be a lowercase UUID v4' >&2
  exit 1
}

readonly run_uuid
readonly run_token="${run_uuid//-/}"
readonly fixture_name_token="${run_token:0:24}"
readonly fixture_short_name="coord_${fixture_name_token}"
readonly application_key="proof.coordination.run_${run_token}"
proof_root="$(mktemp -d /tmp/vortex-application-access.XXXXXX)"
readonly proof_root
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id="91${run_uuid:2}"
readonly organization_id="92${run_uuid:2}"
readonly application_root_id="93${run_uuid:2}"
readonly permission_id="94${run_uuid:2}"
readonly role_id="95${run_uuid:2}"
readonly source_role_id="96${run_uuid:2}"
readonly replacement_source_role_id="97${run_uuid:2}"
readonly actor_id="99${run_uuid:2}"
readonly correlation_initialize="9a${run_uuid:2}"
readonly correlation_register="9b${run_uuid:2}"
readonly correlation_seed="9c${run_uuid:2}"
readonly correlation_update="9d${run_uuid:2}"
readonly correlation_withdraw="9e${run_uuid:2}"
readonly correlation_update_three="a1${run_uuid:2}"
readonly correlation_update_four="a2${run_uuid:2}"

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
  echo 'application-access proof did not reach its transaction barrier' >&2
  return 1
}

read_backend_pid() {
  local candidate="$1"
  local backend_pid
  wait_for_file "$candidate"
  backend_pid="$(tr -d '[:space:]' <"$candidate")"
  [[ "$backend_pid" =~ ^[1-9][0-9]*$ ]] || {
    printf 'application-access proof captured an invalid database backend identifier: %q\n' \
      "$backend_pid" >&2
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
  echo 'the competing coordinated operation did not wait on the Access-version lock' >&2
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
  local found=0
  echo 'application-access proof failed; bounded owned worker diagnostics follow' >&2
  for log_path in "$proof_root"/*.log; do
    [ -f "$log_path" ] || continue
    found=1
    printf '%s\n' "--- ${log_path##*/} (last 120 lines) ---" >&2
    tail -n 120 -- "$log_path" >&2
  done
  if [ "$found" -eq 0 ]; then
    echo 'no owned worker logs were created before failure' >&2
  fi
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
        where tenant_id = '$tenant_id'
          and short_name = '$fixture_short_name'
          and created_by = '$actor_id'
      ) or not exists (
        select 1 from vortex_identity.organizations
        where organization_id = '$organization_id'
          and tenant_id = '$tenant_id'
          and short_name = '$fixture_short_name'
          and created_by = '$actor_id'
      ) or not exists (
        select 1 from vortex_definition.roots
        where root_id = '$application_root_id'
          and organization_id = '$organization_id'
          and key = '$application_key'
          and created_by = '$actor_id'
      ) then
        raise exception 'Application-access proof fixture ownership marker mismatch';
      end if;
    end
    \$proof\$;
    delete from vortex_access.organization_role_permission_entries
      where organization_id = '$organization_id' and role_id = '$role_id';
    delete from vortex_access.organization_role_revisions
      where organization_id = '$organization_id' and role_id = '$role_id';
    delete from vortex_access.organization_roles
      where organization_id = '$organization_id' and role_id = '$role_id';
    delete from vortex_access.application_role_template_continuities
      where organization_id = '$organization_id'
        and application_root_id = '$application_root_id';
    delete from vortex_access.permission_continuities
      where organization_id = '$organization_id'
        and application_root_id = '$application_root_id';
    delete from vortex_access.permission_catalogue_entries
      where organization_id = '$organization_id'
        and registration_kind = 'application'
        and registration_owner_id = '$application_root_id';
    delete from vortex_access.permission_registrations
      where organization_id = '$organization_id'
        and registration_kind = 'application'
        and registration_owner_id = '$application_root_id';
    delete from vortex_access.permission_registration_revisions
      where organization_id = '$organization_id'
        and registration_kind = 'application'
        and registration_owner_id = '$application_root_id';
    delete from vortex_definition.releases where root_id = '$application_root_id';
    delete from vortex_definition.roots where root_id = '$application_root_id';
    delete from vortex_access.organization_access_versions
      where organization_id = '$organization_id';
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
  touch "$proof_root/update-release" "$proof_root/update-a-release"
  stop_owned_workers
  if [ "$original_status" -ne 0 ]; then emit_owned_failure_diagnostics; fi
  cleanup_fixture
  operation_status=$?
  if [ "$operation_status" -ne 0 ]; then
    echo "application-access proof fixture cleanup failed with status $operation_status" >&2
    cleanup_status="$operation_status"
  fi
  case "$proof_root" in
    /tmp/vortex-application-access.*) rm -rf -- "$proof_root"; operation_status=$? ;;
    *) echo "refusing to remove unexpected proof directory: $proof_root" >&2; operation_status=1 ;;
  esac
  if [ "$operation_status" -ne 0 ] && [ "$cleanup_status" -eq 0 ]; then
    cleanup_status="$operation_status"
  fi
  if [ "$original_status" -ne 0 ]; then
    [ "$cleanup_status" -eq 0 ] || echo 'cleanup also failed while preserving the proof failure' >&2
    exit "$original_status"
  fi
  exit "$cleanup_status"
}
trap finalize EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

permission_value="
  pg_catalog.jsonb_build_object(
    'permissionId', '$permission_id', 'key', 'proof.records.read',
    'label', 'View records', 'description', 'View proof records.',
    'actionKind', 'read', 'administrative', false
  )
"
release_one="
  pg_catalog.jsonb_build_object(
    'kind', 'application', 'definitionKey', '$application_key',
    'rootId', '$application_root_id', 'releaseRevision', 1,
    'releaseVersion', '1.0.0', 'validationContractVersion', '2.18.0',
    'contentFingerprint', 'sha256:' || pg_catalog.repeat('3', 64),
    'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('2', 64)
  )
"
release_two="
  pg_catalog.jsonb_build_object(
    'kind', 'application', 'definitionKey', '$application_key',
    'rootId', '$application_root_id', 'releaseRevision', 2,
    'releaseVersion', '2.0.0', 'validationContractVersion', '2.18.0',
    'contentFingerprint', 'sha256:' || pg_catalog.repeat('c', 64),
    'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('b', 64)
  )
"
release_three="
  pg_catalog.jsonb_build_object(
    'kind', 'application', 'definitionKey', '$application_key',
    'rootId', '$application_root_id', 'releaseRevision', 3,
    'releaseVersion', '3.0.0', 'validationContractVersion', '2.18.0',
    'contentFingerprint', 'sha256:' || pg_catalog.repeat('0', 64),
    'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('1', 64)
  )
"
release_four="
  pg_catalog.jsonb_build_object(
    'kind', 'application', 'definitionKey', '$application_key',
    'rootId', '$application_root_id', 'releaseRevision', 4,
    'releaseVersion', '4.0.0', 'validationContractVersion', '2.18.0',
    'contentFingerprint', 'sha256:' || pg_catalog.repeat('4', 64),
    'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('5', 64)
  )
"
candidate_one="
  pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0', 'organizationId', '$organization_id',
    'applicationRootId', '$application_root_id', 'applicationRelease', $release_one,
    'applicationCatalogueFingerprint', 'sha256:' || pg_catalog.repeat('5', 64),
    'applicationPermissionIds', pg_catalog.jsonb_build_array('$permission_id'),
    'entries', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'applicationRootId', '$application_root_id', 'ownerKind', 'application',
      'ownerId', '$application_root_id', 'permission', $permission_value,
      'sourceRelease', $release_one,
      'meaningFingerprint', 'sha256:' || pg_catalog.repeat('6', 64)
    )),
    'candidateFingerprint', 'sha256:' || pg_catalog.repeat('7', 64)
  )
"
candidate_two="
  pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0', 'organizationId', '$organization_id',
    'applicationRootId', '$application_root_id', 'applicationRelease', $release_two,
    'applicationCatalogueFingerprint', 'sha256:' || pg_catalog.repeat('d', 64),
    'applicationPermissionIds', pg_catalog.jsonb_build_array('$permission_id'),
    'entries', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'applicationRootId', '$application_root_id', 'ownerKind', 'application',
      'ownerId', '$application_root_id', 'permission', $permission_value,
      'sourceRelease', $release_two,
      'meaningFingerprint', 'sha256:' || pg_catalog.repeat('6', 64)
    )),
    'candidateFingerprint', 'sha256:' || pg_catalog.repeat('e', 64)
  )
"
candidate_three="
  pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0', 'organizationId', '$organization_id',
    'applicationRootId', '$application_root_id', 'applicationRelease', $release_three,
    'applicationCatalogueFingerprint', 'sha256:' || pg_catalog.repeat('2', 64),
    'applicationPermissionIds', pg_catalog.jsonb_build_array('$permission_id'),
    'entries', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'applicationRootId', '$application_root_id', 'ownerKind', 'application',
      'ownerId', '$application_root_id', 'permission', $permission_value,
      'sourceRelease', $release_three,
      'meaningFingerprint', 'sha256:' || pg_catalog.repeat('6', 64)
    )),
    'candidateFingerprint', 'sha256:' || pg_catalog.repeat('3', 64)
  )
"
candidate_four="
  pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0', 'organizationId', '$organization_id',
    'applicationRootId', '$application_root_id', 'applicationRelease', $release_four,
    'applicationCatalogueFingerprint', 'sha256:' || pg_catalog.repeat('6', 64),
    'applicationPermissionIds', pg_catalog.jsonb_build_array('$permission_id'),
    'entries', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'applicationRootId', '$application_root_id', 'ownerKind', 'application',
      'ownerId', '$application_root_id', 'permission', $permission_value,
      'sourceRelease', $release_four,
      'meaningFingerprint', 'sha256:' || pg_catalog.repeat('6', 64)
    )),
    'candidateFingerprint', 'sha256:' || pg_catalog.repeat('7', 64)
  )
"
prepared_one="
  pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0',
    'preparationBasis', pg_catalog.jsonb_build_object('kind', 'registration_candidate'),
    'permissionRegistration', $candidate_one,
    'templates', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'template', pg_catalog.jsonb_build_object(
        'roleId', '$source_role_id', 'key', 'records_reader', 'name', 'Records reader',
        'homePageId', '$source_role_id',
        'permissionKeys', pg_catalog.jsonb_build_array('proof.records.read'),
        'permissionSelection', pg_catalog.jsonb_build_object('kind', 'exact')
      ),
      'sourceTemplateFingerprint', 'sha256:' || pg_catalog.repeat('8', 64),
      'sourcePermissions', ($candidate_one) -> 'entries',
      'livePermissions', ($candidate_one) -> 'entries'
    )),
    'candidateFingerprint', 'sha256:' || pg_catalog.repeat('9', 64)
  )
"
prepared_two="
  pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0',
    'preparationBasis', pg_catalog.jsonb_build_object('kind', 'registration_candidate'),
    'permissionRegistration', $candidate_two,
    'templates', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'template', pg_catalog.jsonb_build_object(
        'roleId', '$replacement_source_role_id', 'key', 'replacement_records_reader',
        'name', 'Replacement records reader',
        'homePageId', '$replacement_source_role_id',
        'permissionKeys', pg_catalog.jsonb_build_array('proof.records.read'),
        'permissionSelection', pg_catalog.jsonb_build_object('kind', 'exact')
      ),
      'sourceTemplateFingerprint', 'sha256:' || pg_catalog.repeat('a', 64),
      'sourcePermissions', ($candidate_two) -> 'entries',
      'livePermissions', ($candidate_two) -> 'entries'
    )),
    'candidateFingerprint', 'sha256:' || pg_catalog.repeat('f', 64)
  )
"
prepared_three="
  pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0',
    'preparationBasis', pg_catalog.jsonb_build_object('kind', 'registration_candidate'),
    'permissionRegistration', $candidate_three,
    'templates', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'template', pg_catalog.jsonb_build_object(
        'roleId', '$replacement_source_role_id', 'key', 'replacement_records_reader',
        'name', 'Replacement records reader',
        'homePageId', '$replacement_source_role_id',
        'permissionKeys', pg_catalog.jsonb_build_array('proof.records.read'),
        'permissionSelection', pg_catalog.jsonb_build_object('kind', 'exact')
      ),
      'sourceTemplateFingerprint', 'sha256:' || pg_catalog.repeat('a', 64),
      'sourcePermissions', ($candidate_three) -> 'entries',
      'livePermissions', ($candidate_three) -> 'entries'
    )),
    'candidateFingerprint', 'sha256:' || pg_catalog.repeat('8', 64)
  )
"
prepared_four="
  pg_catalog.jsonb_build_object(
    'contractVersion', '1.0.0',
    'preparationBasis', pg_catalog.jsonb_build_object('kind', 'registration_candidate'),
    'permissionRegistration', $candidate_four,
    'templates', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'template', pg_catalog.jsonb_build_object(
        'roleId', '$replacement_source_role_id', 'key', 'replacement_records_reader',
        'name', 'Replacement records reader',
        'homePageId', '$replacement_source_role_id',
        'permissionKeys', pg_catalog.jsonb_build_array('proof.records.read'),
        'permissionSelection', pg_catalog.jsonb_build_object('kind', 'exact')
      ),
      'sourceTemplateFingerprint', 'sha256:' || pg_catalog.repeat('a', 64),
      'sourcePermissions', ($candidate_four) -> 'entries',
      'livePermissions', ($candidate_four) -> 'entries'
    )),
    'candidateFingerprint', 'sha256:' || pg_catalog.repeat('9', 64)
  )
"

run_sql "
  begin;
  do \$proof\$
  begin
    if exists (select 1 from vortex_identity.tenants where tenant_id = '$tenant_id')
      or exists (select 1 from vortex_identity.organizations where organization_id = '$organization_id')
      or exists (select 1 from vortex_definition.roots where root_id = '$application_root_id')
      or exists (select 1 from vortex_access.organization_access_versions where organization_id = '$organization_id')
      or exists (select 1 from vortex_access.organization_roles where organization_id = '$organization_id')
      or exists (
        select 1 from vortex_access.permission_registrations
        where organization_id = '$organization_id'
          and registration_owner_id = '$application_root_id'
      ) then
      raise exception 'Application-access proof fixture scope already exists';
    end if;
  end
  \$proof\$;
  insert into vortex_identity.tenants (
    tenant_id, short_name, display_name, state, created_at, created_by,
    state_changed_at, revision
  ) values (
    '$tenant_id', '$fixture_short_name', 'Coordination $fixture_name_token', 'active',
    pg_catalog.clock_timestamp(), '$actor_id', pg_catalog.clock_timestamp(), 1
  );
  insert into vortex_identity.organizations (
    organization_id, tenant_id, parent_organization_id, short_name, display_name,
    state, created_at, created_by, state_changed_at, revision
  ) values (
    '$organization_id', '$tenant_id', null, '$fixture_short_name',
    'Coordination $fixture_name_token', 'active', pg_catalog.clock_timestamp(), '$actor_id',
    pg_catalog.clock_timestamp(), 1
  );
  select * from vortex_access.initialize_organization_access_version(
    '$organization_id', '$actor_id', '$correlation_initialize'
  );
  insert into vortex_definition.roots (
    root_id, organization_id, kind, key, created_at, created_by
  ) values (
    '$application_root_id', '$organization_id', 'application', '$application_key',
    pg_catalog.clock_timestamp(), '$actor_id'
  );
  insert into vortex_definition.releases (
    root_id, release_revision, release_version, authored_source,
    authored_source_fingerprint, source_contract_version, compilation_output,
    resolution_snapshot, content_fingerprint, resolution_fingerprint,
    validation_contract_version, comparison_fingerprint, impact_reasons,
    release_note, published_at, published_by
  ) values
    (
      '$application_root_id', 1, '1.0.0',
      pg_catalog.jsonb_build_object('source_contract_version', '1.0.0',
        'kind', 'application', 'key', '$application_key', 'body', '{}'::jsonb),
      'sha256:' || pg_catalog.repeat('1', 64), '1.0.0',
      pg_catalog.jsonb_build_object('kind', 'application', 'canonical',
        pg_catalog.jsonb_build_object('content', pg_catalog.jsonb_build_object(
          'permissions', pg_catalog.jsonb_build_array($permission_value)
        ))),
      pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('2', 64)),
      'sha256:' || pg_catalog.repeat('3', 64), 'sha256:' || pg_catalog.repeat('2', 64),
      '2.18.0', 'sha256:' || pg_catalog.repeat('4', 64), '[]', 'Initial proof release',
      pg_catalog.clock_timestamp(), '$actor_id'
    ),
    (
      '$application_root_id', 2, '2.0.0',
      pg_catalog.jsonb_build_object('source_contract_version', '1.0.0',
        'kind', 'application', 'key', '$application_key', 'body', '{}'::jsonb),
      'sha256:' || pg_catalog.repeat('a', 64), '1.0.0',
      pg_catalog.jsonb_build_object('kind', 'application', 'canonical',
        pg_catalog.jsonb_build_object('content', pg_catalog.jsonb_build_object(
          'permissions', pg_catalog.jsonb_build_array($permission_value)
        ))),
      pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('b', 64)),
      'sha256:' || pg_catalog.repeat('c', 64), 'sha256:' || pg_catalog.repeat('b', 64),
      '2.18.0', 'sha256:' || pg_catalog.repeat('d', 64), '[]', 'Replacement-template proof release',
      pg_catalog.clock_timestamp(), '$actor_id'
    ),
    (
      '$application_root_id', 3, '3.0.0',
      pg_catalog.jsonb_build_object('source_contract_version', '1.0.0',
        'kind', 'application', 'key', '$application_key', 'body', '{}'::jsonb),
      'sha256:' || pg_catalog.repeat('e', 64), '1.0.0',
      pg_catalog.jsonb_build_object('kind', 'application', 'canonical',
        pg_catalog.jsonb_build_object('content', pg_catalog.jsonb_build_object(
          'permissions', pg_catalog.jsonb_build_array($permission_value)
        ))),
      pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('1', 64)),
      'sha256:' || pg_catalog.repeat('0', 64), 'sha256:' || pg_catalog.repeat('1', 64),
      '2.18.0', 'sha256:' || pg_catalog.repeat('2', 64), '[]', 'Winning update proof release',
      pg_catalog.clock_timestamp(), '$actor_id'
    ),
    (
      '$application_root_id', 4, '4.0.0',
      pg_catalog.jsonb_build_object('source_contract_version', '1.0.0',
        'kind', 'application', 'key', '$application_key', 'body', '{}'::jsonb),
      'sha256:' || pg_catalog.repeat('3', 64), '1.0.0',
      pg_catalog.jsonb_build_object('kind', 'application', 'canonical',
        pg_catalog.jsonb_build_object('content', pg_catalog.jsonb_build_object(
          'permissions', pg_catalog.jsonb_build_array($permission_value)
        ))),
      pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('5', 64)),
      'sha256:' || pg_catalog.repeat('4', 64), 'sha256:' || pg_catalog.repeat('5', 64),
      '2.18.0', 'sha256:' || pg_catalog.repeat('6', 64), '[]', 'Losing update proof release',
      pg_catalog.clock_timestamp(), '$actor_id'
    );
  update vortex_definition.roots set current_release_revision = 4
    where root_id = '$application_root_id';
  select * from vortex_access.coordinate_application_access_change(
    'register', null, $prepared_one, '$organization_id', '$application_root_id',
    '$actor_id', '$correlation_register'
  );
  insert into vortex_access.organization_roles (
    organization_id, role_id, role_kind, role_key, application_root_id,
    source_role_id, live_revision, created_by, created_at
  ) values (
    '$organization_id', '$role_id', 'application', 'records_reader',
    '$application_root_id', '$source_role_id', 1, '$actor_id', pg_catalog.clock_timestamp()
  );
  insert into vortex_access.organization_role_permission_entries (
    organization_id, role_id, role_revision, entry_ordinal, role_kind,
    role_application_root_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id,
    accepted_registration_revision, catalogue_fingerprint,
    continuity_revision, meaning_fingerprint
  )
  select '$organization_id', '$role_id', 1, 1, 'application', '$application_root_id',
    entry.application_root_id, entry.owner_kind, entry.owner_id, entry.permission_id,
    entry.registration_kind, entry.registration_owner_id, entry.registration_revision,
    registration.permission_catalogue_fingerprint, 1, entry.meaning_fingerprint
  from vortex_access.permission_catalogue_entries as entry
  join vortex_access.permission_registration_revisions as registration
    on registration.organization_id = entry.organization_id
    and registration.registration_kind = entry.registration_kind
    and registration.registration_owner_id = entry.registration_owner_id
    and registration.revision = entry.registration_revision
  where entry.organization_id = '$organization_id'
    and entry.registration_kind = 'application'
    and entry.registration_owner_id = '$application_root_id'
    and entry.registration_revision = 1;
  insert into vortex_access.organization_role_revisions (
    organization_id, role_id, revision, role_kind, application_root_id, lifecycle,
    privilege_classification, assignment_policy, policy_continuity_revision,
    authority_continuity_revision, role_key, label, description,
    source_definition_key, source_release_revision, source_release_version,
    source_validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, source_template_fingerprint,
    source_catalogue_fingerprint, accepted_registration_revision,
    template_continuity_revision, accepted_grant_fingerprint,
    changed_by, changed_at, change_correlation_id
  ) values (
    '$organization_id', '$role_id', 1, 'application', '$application_root_id', 'active',
    'standard', 'standing', 1, 1, 'records_reader', 'Records reader',
    'Read proof records.', '$application_key', 1, '1.0.0', '2.18.0',
    'sha256:' || pg_catalog.repeat('3', 64), 'sha256:' || pg_catalog.repeat('2', 64),
    'sha256:' || pg_catalog.repeat('8', 64), 'sha256:' || pg_catalog.repeat('5', 64),
    1, 1, 'sha256:' || pg_catalog.repeat('9', 64), '$actor_id',
    pg_catalog.clock_timestamp(), '$correlation_seed'
  );
  set constraints all immediate;
  commit;
" >/dev/null
fixture_claimed=1

baseline_access_version="$(run_sql "
  select current_version from vortex_access.organization_access_versions
  where organization_id = '$organization_id';
")"
[ "$baseline_access_version" = '2' ] || {
  echo 'application-access proof did not establish its expected baseline version' >&2
  exit 1
}

PGAPPNAME="vortex-application-access-update-$fixture_name_token" \
  "${psql_command[@]}" >"$proof_root/update.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/update.pid'
select 1 from vortex_access.organization_access_versions
where organization_id = '$organization_id' for update;
\! touch '$proof_root/update-ready'
\! deadline=600; while [ ! -f '$proof_root/update-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/update-release' ]
select outcome, operation, registration_revision, access_version
from vortex_access.coordinate_application_access_change(
  'update', 1, $prepared_two, '$organization_id', '$application_root_id',
  '$actor_id', '$correlation_update'
);
commit;
SQL
update_pid=$!
worker_pids+=("$update_pid")
wait_for_file "$proof_root/update-ready"
update_backend_pid="$(read_backend_pid "$proof_root/update.pid")"

PGAPPNAME="vortex-application-access-withdraw-$fixture_name_token" \
  "${psql_command[@]}" >"$proof_root/withdraw.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/withdraw.pid'
set local lock_timeout = '30s';
select * from vortex_access.coordinate_application_access_change(
  'withdraw', 1, null, '$organization_id', '$application_root_id',
  '$actor_id', '$correlation_withdraw'
);
commit;
SQL
withdraw_pid=$!
worker_pids+=("$withdraw_pid")
withdraw_backend_pid="$(read_backend_pid "$proof_root/withdraw.pid")"
wait_for_database_blocker "$withdraw_backend_pid" "$update_backend_pid"
touch "$proof_root/update-release"
wait_owned_worker "$update_pid"
grep -Fq 'changed|update|2|3' "$proof_root/update.log" || {
  echo 'the winning coordinated update did not return its exact committed result' >&2
  exit 1
}
if wait_owned_worker "$withdraw_pid"; then
  echo 'the stale competing coordinated withdrawal unexpectedly committed' >&2
  exit 1
fi
grep -q '40001' "$proof_root/withdraw.log" || {
  echo 'the stale competing withdrawal failed without its stable stale state' >&2
  exit 1
}

state="$(run_sql "
  select pg_catalog.concat_ws('|',
    version.current_version,
    registration.state,
    registration.revision,
    permission.state,
    permission.continuity_revision,
    permission.last_processed_registration_revision,
    template.state,
    template.continuity_revision,
    template.last_processed_registration_revision,
    role.live_revision,
    revision.lifecycle,
    revision.authority_continuity_revision,
    (select count(*) from vortex_access.organization_role_permission_entries as entry
      where entry.organization_id = '$organization_id'
        and entry.role_id = '$role_id' and entry.role_revision = 2),
    (select count(*) from vortex_access.permission_registration_revisions as history
      where history.organization_id = '$organization_id'
        and history.registration_kind = 'application'
        and history.registration_owner_id = '$application_root_id')
  )
  from vortex_access.organization_access_versions as version
  join vortex_access.permission_registrations as registration
    on registration.organization_id = version.organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = '$application_root_id'
  join vortex_access.permission_continuities as permission
    on permission.organization_id = version.organization_id
    and permission.application_root_id = '$application_root_id'
    and permission.permission_id = '$permission_id'
  join vortex_access.application_role_template_continuities as template
    on template.organization_id = version.organization_id
    and template.application_root_id = '$application_root_id'
    and template.source_role_id = '$source_role_id'
  join vortex_access.organization_roles as role
    on role.organization_id = version.organization_id and role.role_id = '$role_id'
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id and revision.revision = role.live_revision
  where version.organization_id = '$organization_id';
")"
[ "$state" = '3|active|2|available|1|2|unavailable|2|2|2|unavailable|1|0|2' ] || {
  printf 'coordinated race left inconsistent registration/continuity/role state: %q\n' "$state" >&2
  exit 1
}

PGAPPNAME="vortex-application-access-update-a-$fixture_name_token" \
  "${psql_command[@]}" >"$proof_root/update-a.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/update-a.pid'
select 1 from vortex_access.organization_access_versions
where organization_id = '$organization_id' for update;
\! touch '$proof_root/update-a-ready'
\! deadline=600; while [ ! -f '$proof_root/update-a-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/update-a-release' ]
select outcome, operation, registration_revision, access_version
from vortex_access.coordinate_application_access_change(
  'update', 2, $prepared_three, '$organization_id', '$application_root_id',
  '$actor_id', '$correlation_update_three'
);
commit;
SQL
update_a_pid=$!
worker_pids+=("$update_a_pid")
wait_for_file "$proof_root/update-a-ready"
update_a_backend_pid="$(read_backend_pid "$proof_root/update-a.pid")"

PGAPPNAME="vortex-application-access-update-b-$fixture_name_token" \
  "${psql_command[@]}" >"$proof_root/update-b.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/update-b.pid'
set local lock_timeout = '30s';
select * from vortex_access.coordinate_application_access_change(
  'update', 2, $prepared_four, '$organization_id', '$application_root_id',
  '$actor_id', '$correlation_update_four'
);
commit;
SQL
update_b_pid=$!
worker_pids+=("$update_b_pid")
update_b_backend_pid="$(read_backend_pid "$proof_root/update-b.pid")"
wait_for_database_blocker "$update_b_backend_pid" "$update_a_backend_pid"
touch "$proof_root/update-a-release"
wait_owned_worker "$update_a_pid"
grep -Fq 'changed|update|3|4' "$proof_root/update-a.log" || {
  echo 'the winning coordinated update did not return exact revision-three state' >&2
  exit 1
}
if wait_owned_worker "$update_b_pid"; then
  echo 'the stale competing coordinated update unexpectedly committed' >&2
  exit 1
fi
grep -q '40001' "$proof_root/update-b.log" || {
  echo 'the stale competing update failed without its stable stale state' >&2
  exit 1
}

state="$(run_sql "
  select pg_catalog.concat_ws('|',
    version.current_version,
    registration.state,
    registration.revision,
    registration.source_revision,
    permission.state,
    permission.continuity_revision,
    permission.last_processed_registration_revision,
    original_template.state,
    original_template.continuity_revision,
    original_template.last_processed_registration_revision,
    replacement_template.state,
    replacement_template.continuity_revision,
    replacement_template.last_processed_registration_revision,
    role.live_revision,
    revision.lifecycle,
    revision.authority_continuity_revision,
    (select count(*) from vortex_access.permission_registration_revisions as history
      where history.organization_id = '$organization_id'
        and history.registration_kind = 'application'
        and history.registration_owner_id = '$application_root_id'),
    (select count(*) from vortex_access.permission_catalogue_entries as entry
      where entry.organization_id = '$organization_id'
        and entry.registration_kind = 'application'
        and entry.registration_owner_id = '$application_root_id'),
    (select count(*) from vortex_access.permission_continuities as continuity
      where continuity.organization_id = '$organization_id'
        and continuity.application_root_id = '$application_root_id'),
    (select count(*) from vortex_access.application_role_template_continuities as continuity
      where continuity.organization_id = '$organization_id'
        and continuity.application_root_id = '$application_root_id'),
    (select count(*) from vortex_access.organization_roles as scoped_role
      where scoped_role.organization_id = '$organization_id'
        and scoped_role.role_kind = 'application'
        and scoped_role.application_root_id = '$application_root_id'),
    (select count(*) from vortex_access.organization_role_revisions as history
      where history.organization_id = '$organization_id'
        and history.role_id = '$role_id'),
    (select count(*) from vortex_access.organization_role_permission_entries as entry
      where entry.organization_id = '$organization_id'
        and entry.role_id = '$role_id'),
    vortex_access.application_access_current_transition_is_complete(
      '$organization_id', '$application_root_id', 3, 'active'
    ),
    vortex_access.application_access_current_state_matches_candidate(
      '$organization_id', '$application_root_id', 3, $prepared_three
    ),
    vortex_access.application_permission_registration_matches_candidate(
      '$organization_id', '$application_root_id', 3, $candidate_three
    ),
    vortex_access.application_permission_registration_matches_candidate(
      '$organization_id', '$application_root_id', 3, $candidate_four
    )
  )
  from vortex_access.organization_access_versions as version
  join vortex_access.permission_registrations as registration
    on registration.organization_id = version.organization_id
    and registration.registration_kind = 'application'
    and registration.registration_owner_id = '$application_root_id'
  join vortex_access.permission_continuities as permission
    on permission.organization_id = version.organization_id
    and permission.application_root_id = '$application_root_id'
    and permission.permission_id = '$permission_id'
  join vortex_access.application_role_template_continuities as original_template
    on original_template.organization_id = version.organization_id
    and original_template.application_root_id = '$application_root_id'
    and original_template.source_role_id = '$source_role_id'
  join vortex_access.application_role_template_continuities as replacement_template
    on replacement_template.organization_id = version.organization_id
    and replacement_template.application_root_id = '$application_root_id'
    and replacement_template.source_role_id = '$replacement_source_role_id'
  join vortex_access.organization_roles as role
    on role.organization_id = version.organization_id and role.role_id = '$role_id'
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id and revision.revision = role.live_revision
  where version.organization_id = '$organization_id';
")"
[ "$state" = '4|active|3|3|available|1|3|unavailable|2|3|available|1|3|2|unavailable|1|3|3|1|2|1|2|1|t|t|t|f' ] || {
  printf 'coordinated update race left duplicate or partial derived state: %q\n' "$state" >&2
  exit 1
}

echo 'application access coordination concurrency proof passed'
