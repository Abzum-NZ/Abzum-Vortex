#!/usr/bin/env bash

set -euo pipefail

run_uuid="${VORTEX_PERMISSION_REGISTRY_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then
  [ -r /proc/sys/kernel/random/uuid ] || {
    echo 'a Linux random UUID source is required for the permission-registry proof' >&2
    exit 1
  }
  IFS= read -r run_uuid </proc/sys/kernel/random/uuid
fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  echo 'VORTEX_PERMISSION_REGISTRY_PROOF_RUN_ID must be a lowercase UUID v4' >&2
  exit 1
}

readonly run_uuid
readonly run_token="${run_uuid//-/}"
readonly fixture_name_token="${run_token:0:28}"
readonly fixture_short_name="permission_${fixture_name_token}"
readonly application_key="proof.concurrent_application.run_${run_token}"
proof_root="$(mktemp -d /tmp/vortex-permission-registry.XXXXXX)"
readonly proof_root
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id="61${run_uuid:2}"
readonly organization_id="62${run_uuid:2}"
readonly application_root_id="63${run_uuid:2}"
readonly permission_id="64${run_uuid:2}"
readonly correlation_initial="65${run_uuid:2}"
readonly correlation_a="66${run_uuid:2}"
readonly correlation_b="67${run_uuid:2}"
readonly actor_id="69${run_uuid:2}"
readonly correlation_platform_initialize="6a${run_uuid:2}"
readonly correlation_platform_revision="6b${run_uuid:2}"
readonly correlation_platform_replay="6c${run_uuid:2}"

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
        raise exception 'Permission proof fixture ownership marker mismatch';
      end if;
    end
    \$proof\$;
    delete from vortex_access.permission_catalogue_entries
      where organization_id = '$organization_id'
        and registration_kind = 'platform'
        and registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8';
    delete from vortex_access.permission_registrations
      where organization_id = '$organization_id'
        and registration_kind = 'platform'
        and registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8';
    delete from vortex_access.permission_registration_revisions
      where organization_id = '$organization_id'
        and registration_kind = 'platform'
        and registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8';
    delete from vortex_access.permission_catalogue_entries
      where organization_id = '$organization_id'
        and application_root_id = '$application_root_id';
    delete from vortex_access.permission_registrations
      where organization_id = '$organization_id'
        and registration_owner_id = '$application_root_id';
    delete from vortex_access.permission_registration_revisions
      where organization_id = '$organization_id'
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
  stop_owned_workers
  cleanup_fixture
  operation_status=$?
  if [ "$operation_status" -ne 0 ]; then
    echo "permission-registry proof fixture cleanup failed with status $operation_status" >&2
    cleanup_status="$operation_status"
  fi
  case "$proof_root" in
    /tmp/vortex-permission-registry.*)
      rm -rf -- "$proof_root"
      operation_status=$?
      ;;
    *)
      echo "refusing to remove unexpected proof directory: $proof_root" >&2
      operation_status=1
      ;;
  esac
  if [ "$operation_status" -ne 0 ]; then
    echo "permission-registry proof directory cleanup failed with status $operation_status" >&2
    [ "$cleanup_status" -ne 0 ] || cleanup_status="$operation_status"
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

run_sql "
  begin;
  do \$proof\$
  begin
    if exists (
      select 1 from vortex_identity.tenants
      where tenant_id = '$tenant_id' or short_name = '$fixture_short_name'
    ) or exists (
      select 1 from vortex_identity.organizations
      where organization_id = '$organization_id'
         or (tenant_id = '$tenant_id' and short_name = '$fixture_short_name')
    ) or exists (
      select 1 from vortex_definition.roots
      where root_id = '$application_root_id'
         or (organization_id = '$organization_id' and key = '$application_key')
    ) or exists (
      select 1 from vortex_access.organization_access_versions
      where organization_id = '$organization_id'
    ) or exists (
      select 1 from vortex_access.permission_registrations
      where organization_id = '$organization_id'
        and registration_owner_id = '$application_root_id'
    ) or exists (
      select 1 from vortex_access.permission_registration_revisions
      where organization_id = '$organization_id'
        and registration_owner_id = '$application_root_id'
    ) or exists (
      select 1 from vortex_access.permission_catalogue_entries
      where organization_id = '$organization_id'
        and application_root_id = '$application_root_id'
    ) or exists (
      select 1 from vortex_access.permission_registrations
      where organization_id = '$organization_id'
        and registration_kind = 'platform'
    ) or exists (
      select 1 from vortex_access.permission_registration_revisions
      where organization_id = '$organization_id'
        and registration_kind = 'platform'
    ) or exists (
      select 1 from vortex_access.permission_catalogue_entries
      where organization_id = '$organization_id'
        and registration_kind = 'platform'
    ) then
      raise exception 'Permission proof fixture scope already exists';
    end if;
  end
  \$proof\$;
  insert into vortex_identity.tenants (
    tenant_id, short_name, display_name, state, created_at, created_by,
    state_changed_at, revision
  ) values (
    '$tenant_id', '$fixture_short_name', 'Permission concurrency $fixture_name_token', 'active',
    clock_timestamp(), '$actor_id', clock_timestamp(), 1
  );
  insert into vortex_identity.organizations (
    organization_id, tenant_id, parent_organization_id, short_name, display_name,
    state, created_at, created_by, state_changed_at, revision
  ) values (
    '$organization_id', '$tenant_id', null, '$fixture_short_name',
    'Permission concurrency $fixture_name_token', 'active', clock_timestamp(), '$actor_id',
    clock_timestamp(), 1
  );
  select * from vortex_access.initialize_organization_access_version(
    '$organization_id', '$actor_id', '$correlation_initial'
  );
  insert into vortex_definition.roots (
    root_id, organization_id, kind, key, created_at, created_by
  ) values (
    '$application_root_id', '$organization_id', 'application',
    '$application_key', clock_timestamp(), '$actor_id'
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
    jsonb_build_object(
      'source_contract_version', '1.0.0', 'kind', 'application',
      'key', '$application_key', 'body', '{}'::jsonb
    ),
    'sha256:' || repeat('1', 64), '1.0.0',
    jsonb_build_object(
      'kind', 'application', 'canonical', jsonb_build_object(
        'content', jsonb_build_object('permissions', jsonb_build_array(jsonb_build_object(
          'permissionId', '$permission_id', 'key', 'proof.records.read',
          'label', 'View records', 'description', 'View proof records.',
          'actionKind', 'read', 'administrative', false
        )))
      )
    ),
    jsonb_build_object('fingerprint', 'sha256:' || repeat('2', 64)),
    'sha256:' || repeat('3', 64), 'sha256:' || repeat('2', 64), '2.15.0',
    'sha256:' || repeat('4', 64), '[]', 'Initial proof release', clock_timestamp(), '$actor_id'
  ),
  (
    '$application_root_id', 2, '1.1.0',
    jsonb_build_object(
      'source_contract_version', '1.0.0', 'kind', 'application',
      'key', '$application_key', 'body', '{}'::jsonb
    ),
    'sha256:' || repeat('5', 64), '1.0.0',
    jsonb_build_object(
      'kind', 'application', 'canonical', jsonb_build_object(
        'content', jsonb_build_object('permissions', jsonb_build_array(jsonb_build_object(
          'permissionId', '$permission_id', 'key', 'proof.records.read',
          'label', 'View records', 'description', 'View proof records.',
          'actionKind', 'read', 'administrative', false
        )))
      )
    ),
    jsonb_build_object('fingerprint', 'sha256:' || repeat('6', 64)),
    'sha256:' || repeat('7', 64), 'sha256:' || repeat('6', 64), '2.15.0',
    'sha256:' || repeat('8', 64), '[]', 'Updated proof release', clock_timestamp(), '$actor_id'
  );
  update vortex_definition.roots set current_release_revision = 2
    where root_id = '$application_root_id';
  select * from vortex_access.apply_application_permission_registration_v1_internal(
    'register', null,
    jsonb_build_object(
      'contractVersion', '1.0.0', 'organizationId', '$organization_id',
      'applicationRootId', '$application_root_id',
      'applicationRelease', jsonb_build_object(
        'kind', 'application', 'definitionKey', '$application_key',
        'rootId', '$application_root_id', 'releaseRevision', 1,
        'releaseVersion', '1.0.0', 'validationContractVersion', '2.15.0',
        'contentFingerprint', 'sha256:' || repeat('3', 64),
        'resolutionFingerprint', 'sha256:' || repeat('2', 64)
      ),
      'applicationCatalogueFingerprint', 'sha256:' || repeat('9', 64),
      'applicationPermissionIds', jsonb_build_array('$permission_id'),
      'entries', jsonb_build_array(jsonb_build_object(
        'applicationRootId', '$application_root_id', 'ownerKind', 'application',
        'ownerId', '$application_root_id',
        'permission', jsonb_build_object(
          'permissionId', '$permission_id', 'key', 'proof.records.read',
          'label', 'View records', 'description', 'View proof records.',
          'actionKind', 'read', 'administrative', false
        ),
        'sourceRelease', jsonb_build_object(
          'kind', 'application', 'definitionKey', '$application_key',
          'rootId', '$application_root_id', 'releaseRevision', 1,
          'releaseVersion', '1.0.0', 'validationContractVersion', '2.15.0',
          'contentFingerprint', 'sha256:' || repeat('3', 64),
          'resolutionFingerprint', 'sha256:' || repeat('2', 64)
        ),
        'meaningFingerprint', 'sha256:' || repeat('a', 64)
      )),
      'candidateFingerprint', 'sha256:' || repeat('b', 64)
    ),
    '$actor_id', '$correlation_initial'
  );
  commit;
" >/dev/null
fixture_claimed=1

candidate_update="
  jsonb_build_object(
    'contractVersion', '1.0.0', 'organizationId', '$organization_id',
    'applicationRootId', '$application_root_id',
    'applicationRelease', jsonb_build_object(
      'kind', 'application', 'definitionKey', '$application_key',
      'rootId', '$application_root_id', 'releaseRevision', 2,
      'releaseVersion', '1.1.0', 'validationContractVersion', '2.15.0',
      'contentFingerprint', 'sha256:' || repeat('7', 64),
      'resolutionFingerprint', 'sha256:' || repeat('6', 64)
    ),
    'applicationCatalogueFingerprint', 'sha256:' || repeat('c', 64),
    'applicationPermissionIds', jsonb_build_array('$permission_id'),
    'entries', jsonb_build_array(jsonb_build_object(
      'applicationRootId', '$application_root_id', 'ownerKind', 'application',
      'ownerId', '$application_root_id',
      'permission', jsonb_build_object(
        'permissionId', '$permission_id', 'key', 'proof.records.read',
        'label', 'View records', 'description', 'View proof records.',
        'actionKind', 'read', 'administrative', false
      ),
      'sourceRelease', jsonb_build_object(
        'kind', 'application', 'definitionKey', '$application_key',
        'rootId', '$application_root_id', 'releaseRevision', 2,
        'releaseVersion', '1.1.0', 'validationContractVersion', '2.15.0',
        'contentFingerprint', 'sha256:' || repeat('7', 64),
        'resolutionFingerprint', 'sha256:' || repeat('6', 64)
      ),
      'meaningFingerprint', 'sha256:' || repeat('a', 64)
    )),
    'candidateFingerprint', 'sha256:' || repeat('d', 64)
  )
"

PGAPPNAME="vortex-permission-update-a-$fixture_name_token" "${psql_command[@]}" >"$proof_root/a.log" 2>&1 <<SQL &
begin;
select registration_revision, access_version
from vortex_access.apply_application_permission_registration_v1_internal(
  'update', 1, $candidate_update, '$actor_id', '$correlation_a'
)
\g '$proof_root/a.result'
select pg_catalog.pg_sleep(1);
commit;
SQL
a_pid=$!
worker_pids+=("$a_pid")

for _ in $(seq 1 200); do
  [ -f "$proof_root/a.result" ] && break
  sleep 0.05
done
[ -f "$proof_root/a.result" ] || {
  echo 'first permission update did not reach its transaction barrier' >&2
  exit 1
}

PGAPPNAME="vortex-permission-update-b-$fixture_name_token" "${psql_command[@]}" >"$proof_root/b.log" 2>&1 <<SQL &
begin;
select registration_revision, access_version
from vortex_access.apply_application_permission_registration_v1_internal(
  'update', 1, $candidate_update, '$actor_id', '$correlation_b'
);
commit;
SQL
b_pid=$!
worker_pids+=("$b_pid")

if wait_owned_worker "$a_pid"; then
  a_status=0
else
  a_status=$?
  echo 'winning permission update worker failed' >&2
  sed -n '1,40p' "$proof_root/a.log" >&2
  exit "$a_status"
fi
if wait_owned_worker "$b_pid"; then
  echo 'competing stale permission update unexpectedly succeeded' >&2
  exit 1
fi

[ "$(tr -d '[:space:]' <"$proof_root/a.result")" = '2|3' ] || {
  echo 'winning permission update did not append exactly one revision and Access version' >&2
  exit 1
}
grep -q 'Application permission registration revision is stale or unavailable' "$proof_root/b.log" || {
  echo 'competing permission update did not return the closed stale-revision failure' >&2
  exit 1
}
[ "$(run_sql "select revision from vortex_access.permission_registrations where organization_id = '$organization_id' and registration_owner_id = '$application_root_id';")" = '2' ] || {
  echo 'concurrent permission updates did not retain exactly one winner' >&2
  exit 1
}
[ "$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id = '$organization_id';")" = '3' ] || {
  echo 'losing permission update incorrectly changed the Access version' >&2
  exit 1
}
[ "$(run_sql "select count(*) from vortex_access.permission_registration_revisions where organization_id = '$organization_id' and registration_owner_id = '$application_root_id';")" = '2' ] || {
  echo 'losing permission update left partial history' >&2
  exit 1
}

[ "$(run_sql "select registration_revision::text || '|' || access_version::text from vortex_access.initialize_platform_permission_catalogue('$organization_id', '$actor_id', '$correlation_platform_initialize');")" = '1|4' ] || {
  echo 'platform catalogue initialization did not create exact revision one and one Access increment' >&2
  exit 1
}

PGAPPNAME="vortex-platform-metadata-$fixture_name_token" "${psql_command[@]}" >"$proof_root/platform-metadata.log" 2>&1 <<SQL &
begin;
select registration_revision, access_version
from vortex_access.revise_platform_permission_catalogue_metadata(
  '$organization_id', 1, '1.0.0', '1.0.1',
  '$actor_id', '$correlation_platform_revision'
)
\g '$proof_root/platform-metadata.result'
select pg_catalog.pg_sleep(10);
commit;
SQL
platform_metadata_pid=$!
worker_pids+=("$platform_metadata_pid")

for _ in $(seq 1 200); do
  [ -f "$proof_root/platform-metadata.result" ] && break
  sleep 0.05
done
[ -f "$proof_root/platform-metadata.result" ] || {
  echo 'platform metadata revision did not reach its transaction barrier' >&2
  exit 1
}

PGAPPNAME="vortex-platform-initialize-$fixture_name_token" "${psql_command[@]}" >"$proof_root/platform-initialize.log" 2>&1 <<SQL &
begin;
select registration_revision, access_version
from vortex_access.initialize_platform_permission_catalogue(
  '$organization_id', '$actor_id', '$correlation_platform_replay'
)
\g '$proof_root/platform-initialize.result'
commit;
SQL
platform_initialize_pid=$!
worker_pids+=("$platform_initialize_pid")

platform_initializer_blocked=0
for _ in $(seq 1 200); do
  if [ "$(run_sql "select count(*) from pg_catalog.pg_stat_activity where application_name = 'vortex-platform-initialize-$fixture_name_token' and wait_event_type = 'Lock';")" = '1' ]; then
    platform_initializer_blocked=1
    break
  fi
  sleep 0.05
done
[ "$platform_initializer_blocked" = 1 ] || {
  echo 'concurrent platform initializer did not wait behind the metadata revision lock' >&2
  exit 1
}

if wait_owned_worker "$platform_metadata_pid"; then
  platform_metadata_status=0
else
  platform_metadata_status=$?
  echo 'platform metadata revision worker failed' >&2
  sed -n '1,40p' "$proof_root/platform-metadata.log" >&2
  exit "$platform_metadata_status"
fi
if wait_owned_worker "$platform_initialize_pid"; then
  platform_initialize_status=0
else
  platform_initialize_status=$?
  echo 'concurrent platform initializer replay failed to converge' >&2
  sed -n '1,40p' "$proof_root/platform-initialize.log" >&2
  exit "$platform_initialize_status"
fi

[ "$(tr -d '[:space:]' <"$proof_root/platform-metadata.result")" = '2|5' ] || {
  echo 'platform metadata revision did not append exactly one revision and Access version' >&2
  exit 1
}
[ "$(tr -d '[:space:]' <"$proof_root/platform-initialize.result")" = '2|5' ] || {
  echo 'concurrent platform initializer did not return the converged revision and Access version' >&2
  exit 1
}
[ "$(run_sql "select revision::text || '|' || source_version from vortex_access.permission_registrations where organization_id = '$organization_id' and registration_kind = 'platform' and registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8';")" = '2|1.0.1' ] || {
  echo 'platform initializer and metadata revision did not converge on exact revision two' >&2
  exit 1
}
[ "$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id = '$organization_id';")" = '5' ] || {
  echo 'platform initializer replay incorrectly added another Access increment' >&2
  exit 1
}
[ "$(run_sql "select count(*) from vortex_access.permission_registration_revisions where organization_id = '$organization_id' and registration_kind = 'platform' and registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8';")" = '2' ] || {
  echo 'platform convergence left duplicate or missing registration history' >&2
  exit 1
}
[ "$(run_sql "select count(*) from vortex_access.permission_catalogue_entries where organization_id = '$organization_id' and registration_kind = 'platform' and registration_owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8';")" = '26' ] || {
  echo 'platform convergence left duplicate or incomplete catalogue snapshots' >&2
  exit 1
}

echo 'permission-registry concurrency proof passed'
