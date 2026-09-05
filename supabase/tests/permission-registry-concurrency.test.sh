#!/usr/bin/env bash

set -euo pipefail

readonly proof_root="$(mktemp -d /tmp/vortex-permission-registry.XXXXXX)"
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id='61000000-0000-4000-8000-000000000232'
readonly organization_id='62000000-0000-4000-8000-000000000232'
readonly application_root_id='63000000-0000-4000-8000-000000000232'
readonly permission_id='64000000-0000-4000-8000-000000000232'
readonly actor_id='69000000-0000-4000-8000-000000000232'
readonly correlation_initial='67000000-0000-4000-8000-000000000232'
readonly correlation_a='67000000-0000-4000-8000-000000000233'
readonly correlation_b='67000000-0000-4000-8000-000000000234'

psql_command=(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1)
if [ -n "$database_url" ]; then
  psql_command+=("$database_url")
fi

run_sql() {
  "${psql_command[@]}" --command "$1"
}

cleanup() {
  local pid
  while read -r pid; do
    kill "$pid" >/dev/null 2>&1 || true
  done < <(jobs -pr)
  run_sql "
    begin;
    set local session_replication_role = replica;
    delete from vortex_access.permission_catalogue_entries
      where organization_id = '$organization_id';
    delete from vortex_access.permission_registrations
      where organization_id = '$organization_id';
    delete from vortex_access.permission_registration_revisions
      where organization_id = '$organization_id';
    delete from vortex_definition.releases where root_id = '$application_root_id';
    delete from vortex_definition.roots where root_id = '$application_root_id';
    delete from vortex_access.organization_access_versions
      where organization_id = '$organization_id';
    delete from vortex_identity.organizations where organization_id = '$organization_id';
    delete from vortex_identity.tenants where tenant_id = '$tenant_id';
    commit;
  " >/dev/null 2>&1 || true
  rm -rf "$proof_root"
}
trap cleanup EXIT

run_sql "
  insert into vortex_identity.tenants (
    tenant_id, short_name, display_name, state, created_at, created_by,
    state_changed_at, revision
  ) values (
    '$tenant_id', 'permission_concurrency', 'Permission concurrency', 'active',
    clock_timestamp(), '$actor_id', clock_timestamp(), 1
  );
  insert into vortex_identity.organizations (
    organization_id, tenant_id, parent_organization_id, short_name, display_name,
    state, created_at, created_by, state_changed_at, revision
  ) values (
    '$organization_id', '$tenant_id', null, 'permission_concurrency',
    'Permission concurrency', 'active', clock_timestamp(), '$actor_id',
    clock_timestamp(), 1
  );
  select * from vortex_access.initialize_organization_access_version(
    '$organization_id', '$actor_id', '$correlation_initial'
  );
  insert into vortex_definition.roots (
    root_id, organization_id, kind, key, created_at, created_by
  ) values (
    '$application_root_id', '$organization_id', 'application',
    'proof.concurrent_application', clock_timestamp(), '$actor_id'
  );
  insert into vortex_definition.releases (
    root_id, release_revision, release_version, authored_source,
    authored_source_fingerprint, source_contract_version, compilation_output,
    resolution_snapshot, content_fingerprint, resolution_fingerprint,
    validation_contract_version, comparison_fingerprint, impact_reasons,
    release_note, published_at, published_by
  ) values
  (
    '$application_root_id', 1, '1.0.0', '{}', 'sha256:' || repeat('1', 64), '1.0.0',
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
    '$application_root_id', 2, '1.1.0', '{}', 'sha256:' || repeat('5', 64), '1.0.0',
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
  select * from vortex_access.apply_application_permission_registration(
    'register', null,
    jsonb_build_object(
      'contractVersion', '1.0.0', 'organizationId', '$organization_id',
      'applicationRootId', '$application_root_id',
      'applicationRelease', jsonb_build_object(
        'kind', 'application', 'definitionKey', 'proof.concurrent_application',
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
          'kind', 'application', 'definitionKey', 'proof.concurrent_application',
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
" >/dev/null

candidate_update="
  jsonb_build_object(
    'contractVersion', '1.0.0', 'organizationId', '$organization_id',
    'applicationRootId', '$application_root_id',
    'applicationRelease', jsonb_build_object(
      'kind', 'application', 'definitionKey', 'proof.concurrent_application',
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
        'kind', 'application', 'definitionKey', 'proof.concurrent_application',
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

PGAPPNAME='vortex-permission-update-a' "${psql_command[@]}" >"$proof_root/a.log" 2>&1 <<SQL &
begin;
select registration_revision, access_version
from vortex_access.apply_application_permission_registration(
  'update', 1, $candidate_update, '$actor_id', '$correlation_a'
)
\g '$proof_root/a.result'
select pg_catalog.pg_sleep(1);
commit;
SQL
a_pid=$!

for _ in $(seq 1 200); do
  [ -f "$proof_root/a.result" ] && break
  sleep 0.05
done
[ -f "$proof_root/a.result" ] || {
  echo 'first permission update did not reach its transaction barrier' >&2
  exit 1
}

PGAPPNAME='vortex-permission-update-b' "${psql_command[@]}" >"$proof_root/b.log" 2>&1 <<SQL &
begin;
select registration_revision, access_version
from vortex_access.apply_application_permission_registration(
  'update', 1, $candidate_update, '$actor_id', '$correlation_b'
);
commit;
SQL
b_pid=$!

wait "$a_pid"
if wait "$b_pid"; then
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

echo 'permission-registry concurrency proof passed'
