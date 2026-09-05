#!/usr/bin/env bash

set -euo pipefail

run_uuid="${VORTEX_ROLE_ASSIGNMENT_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then
  [ -r /proc/sys/kernel/random/uuid ] || {
    echo 'a Linux random UUID source is required for the role-assignment proof' >&2
    exit 1
  }
  IFS= read -r run_uuid </proc/sys/kernel/random/uuid
fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  echo 'VORTEX_ROLE_ASSIGNMENT_PROOF_RUN_ID must be a lowercase UUID v4' >&2
  exit 1
}

readonly run_uuid
readonly run_token="${run_uuid//-/}"
readonly fixture_name_token="${run_token:0:24}"
readonly fixture_short_name="assign_${fixture_name_token}"
readonly application_a_key="proof.assignment_a.run_${run_token}"
readonly application_b_key="proof.assignment_b.run_${run_token}"
proof_root="$(mktemp -d /tmp/vortex-role-assignment.XXXXXX)"
readonly proof_root
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id="81${run_uuid:2}"
readonly organization_id="82${run_uuid:2}"
readonly identity_id="83${run_uuid:2}"
readonly account_id="84${run_uuid:2}"
readonly application_a_root_id="85${run_uuid:2}"
readonly application_b_root_id="86${run_uuid:2}"
readonly permission_a_one_id="87${run_uuid:2}"
readonly permission_a_two_id="88${run_uuid:2}"
readonly permission_b_id="89${run_uuid:2}"
readonly role_a_id="8a${run_uuid:2}"
readonly role_b_id="8b${run_uuid:2}"
readonly source_role_a_id="8c${run_uuid:2}"
readonly source_role_b_id="8d${run_uuid:2}"
readonly assignment_duplicate_id="8e${run_uuid:2}"
readonly assignment_expiry_id="8f${run_uuid:2}"
readonly assignment_stale_role_id="90${run_uuid:2}"
readonly assignment_grant_first_id="91${run_uuid:2}"
readonly assignment_withdraw_first_id="92${run_uuid:2}"
readonly actor_id="93${run_uuid:2}"
readonly correlation_initialize="94${run_uuid:2}"
readonly correlation_register_a="95${run_uuid:2}"
readonly correlation_register_b="96${run_uuid:2}"
readonly correlation_grant_a="97${run_uuid:2}"
readonly correlation_grant_b="98${run_uuid:2}"
readonly correlation_revoke_a="99${run_uuid:2}"
readonly correlation_revoke_b="9a${run_uuid:2}"
readonly correlation_expiry="9b${run_uuid:2}"
readonly correlation_narrow="9c${run_uuid:2}"
readonly correlation_stale_role="9d${run_uuid:2}"
readonly correlation_grant_first="9e${run_uuid:2}"
readonly correlation_withdraw_after="9f${run_uuid:2}"
readonly correlation_withdraw_first="a0${run_uuid:2}"
readonly correlation_grant_after="a1${run_uuid:2}"
readonly correlation_revoke_inactive="a2${run_uuid:2}"

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
  echo 'role-assignment proof did not reach its transaction barrier' >&2
  return 1
}

read_backend_pid() {
  local candidate="$1"
  local backend_pid
  wait_for_file "$candidate"
  backend_pid="$(tr -d '[:space:]' <"$candidate")"
  [[ "$backend_pid" =~ ^[1-9][0-9]*$ ]] || {
    printf 'role-assignment proof captured an invalid backend identifier: %q\n' \
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
  echo 'the competing role-assignment operation did not wait on the governance lock' >&2
  return 1
}

wait_for_database_time() {
  local target="$1"
  local deadline=$((SECONDS + 20))
  while ((SECONDS < deadline)); do
    [ "$(run_sql "select case when pg_catalog.clock_timestamp() >= '$target'::timestamptz then 'reached' else '' end;")" = 'reached' ] && return 0
    sleep 0.05
  done
  echo 'database clock did not reach the bounded assignment expiry' >&2
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
        select 1 from vortex_identity.identity_projections
        where identity_id = '$identity_id' and state_changed_by = '$actor_id'
      ) or not exists (
        select 1 from vortex_identity.organization_accounts
        where organization_id = '$organization_id'
          and organization_account_id = '$account_id'
          and identity_id = '$identity_id'
      ) or (
        select pg_catalog.count(*) from vortex_definition.roots
        where root_id in ('$application_a_root_id', '$application_b_root_id')
          and organization_id = '$organization_id'
          and created_by = '$actor_id'
          and (
            (root_id = '$application_a_root_id' and key = '$application_a_key')
            or (root_id = '$application_b_root_id' and key = '$application_b_key')
          )
      ) <> 2 then
        raise exception 'Role-assignment proof fixture ownership marker mismatch';
      end if;
    end
    \$proof\$;
    delete from vortex_access.organization_role_assignments
      where organization_id = '$organization_id';
    delete from vortex_access.organization_role_permission_entries
      where organization_id = '$organization_id'
        and role_id in ('$role_a_id', '$role_b_id');
    delete from vortex_access.organization_role_revisions
      where organization_id = '$organization_id'
        and role_id in ('$role_a_id', '$role_b_id');
    delete from vortex_access.organization_roles
      where organization_id = '$organization_id'
        and role_id in ('$role_a_id', '$role_b_id');
    delete from vortex_access.application_role_template_continuities
      where organization_id = '$organization_id'
        and application_root_id in ('$application_a_root_id', '$application_b_root_id');
    delete from vortex_access.permission_continuities
      where organization_id = '$organization_id'
        and application_root_id in ('$application_a_root_id', '$application_b_root_id');
    delete from vortex_access.permission_catalogue_entries
      where organization_id = '$organization_id'
        and registration_kind = 'application'
        and registration_owner_id in ('$application_a_root_id', '$application_b_root_id');
    delete from vortex_access.permission_registrations
      where organization_id = '$organization_id'
        and registration_kind = 'application'
        and registration_owner_id in ('$application_a_root_id', '$application_b_root_id');
    delete from vortex_access.permission_registration_revisions
      where organization_id = '$organization_id'
        and registration_kind = 'application'
        and registration_owner_id in ('$application_a_root_id', '$application_b_root_id');
    delete from vortex_definition.releases
      where root_id in ('$application_a_root_id', '$application_b_root_id');
    delete from vortex_definition.roots
      where root_id in ('$application_a_root_id', '$application_b_root_id');
    delete from vortex_access.organization_access_versions
      where organization_id = '$organization_id';
    delete from vortex_identity.organization_accounts
      where organization_id = '$organization_id'
        and organization_account_id = '$account_id';
    delete from vortex_identity.identity_projections where identity_id = '$identity_id';
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
  touch "$proof_root/duplicate-release" "$proof_root/revoke-release" \
    "$proof_root/expiry-release" "$proof_root/narrow-release" \
    "$proof_root/grant-first-release" "$proof_root/withdraw-first-release"
  stop_owned_workers
  cleanup_fixture
  operation_status=$?
  if [ "$operation_status" -ne 0 ]; then
    echo "role-assignment proof fixture cleanup failed with status $operation_status" >&2
    cleanup_status="$operation_status"
  fi
  case "$proof_root" in
    /tmp/vortex-role-assignment.*) rm -rf -- "$proof_root"; operation_status=$? ;;
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

permission_a_one="pg_catalog.jsonb_build_object(
  'permissionId', '$permission_a_one_id', 'key', 'proof.assignment.alpha',
  'label', 'Read alpha', 'description', 'Read alpha proof records.',
  'actionKind', 'read', 'administrative', false
)"
permission_a_two="pg_catalog.jsonb_build_object(
  'permissionId', '$permission_a_two_id', 'key', 'proof.assignment.beta',
  'label', 'Read beta', 'description', 'Read beta proof records.',
  'actionKind', 'read', 'administrative', false
)"
permission_b="pg_catalog.jsonb_build_object(
  'permissionId', '$permission_b_id', 'key', 'proof.assignment.gamma',
  'label', 'Read gamma', 'description', 'Read gamma proof records.',
  'actionKind', 'read', 'administrative', false
)"
release_a_one="pg_catalog.jsonb_build_object(
  'kind', 'application', 'definitionKey', '$application_a_key',
  'rootId', '$application_a_root_id', 'releaseRevision', 1,
  'releaseVersion', '1.0.0', 'validationContractVersion', '2.18.0',
  'contentFingerprint', 'sha256:' || pg_catalog.repeat('1', 64),
  'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('2', 64)
)"
release_a_two="pg_catalog.jsonb_build_object(
  'kind', 'application', 'definitionKey', '$application_a_key',
  'rootId', '$application_a_root_id', 'releaseRevision', 2,
  'releaseVersion', '2.0.0', 'validationContractVersion', '2.18.0',
  'contentFingerprint', 'sha256:' || pg_catalog.repeat('3', 64),
  'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('4', 64)
)"
release_b_one="pg_catalog.jsonb_build_object(
  'kind', 'application', 'definitionKey', '$application_b_key',
  'rootId', '$application_b_root_id', 'releaseRevision', 1,
  'releaseVersion', '1.0.0', 'validationContractVersion', '2.18.0',
  'contentFingerprint', 'sha256:' || pg_catalog.repeat('5', 64),
  'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('6', 64)
)"
entry_a_one="pg_catalog.jsonb_build_object(
  'applicationRootId', '$application_a_root_id', 'ownerKind', 'application',
  'ownerId', '$application_a_root_id', 'permission', $permission_a_one,
  'sourceRelease', $release_a_one,
  'meaningFingerprint', 'sha256:' || pg_catalog.repeat('7', 64)
)"
entry_a_two="pg_catalog.jsonb_build_object(
  'applicationRootId', '$application_a_root_id', 'ownerKind', 'application',
  'ownerId', '$application_a_root_id', 'permission', $permission_a_two,
  'sourceRelease', $release_a_one,
  'meaningFingerprint', 'sha256:' || pg_catalog.repeat('8', 64)
)"
entry_a_one_updated="pg_catalog.jsonb_build_object(
  'applicationRootId', '$application_a_root_id', 'ownerKind', 'application',
  'ownerId', '$application_a_root_id', 'permission', $permission_a_one,
  'sourceRelease', $release_a_two,
  'meaningFingerprint', 'sha256:' || pg_catalog.repeat('7', 64)
)"
entry_b="pg_catalog.jsonb_build_object(
  'applicationRootId', '$application_b_root_id', 'ownerKind', 'application',
  'ownerId', '$application_b_root_id', 'permission', $permission_b,
  'sourceRelease', $release_b_one,
  'meaningFingerprint', 'sha256:' || pg_catalog.repeat('9', 64)
)"
candidate_a_one="pg_catalog.jsonb_build_object(
  'contractVersion', '1.0.0', 'organizationId', '$organization_id',
  'applicationRootId', '$application_a_root_id', 'applicationRelease', $release_a_one,
  'applicationCatalogueFingerprint', 'sha256:' || pg_catalog.repeat('a', 64),
  'applicationPermissionIds', pg_catalog.jsonb_build_array(
    '$permission_a_one_id', '$permission_a_two_id'
  ),
  'entries', pg_catalog.jsonb_build_array($entry_a_one, $entry_a_two),
  'candidateFingerprint', 'sha256:' || pg_catalog.repeat('b', 64)
)"
candidate_a_two="pg_catalog.jsonb_build_object(
  'contractVersion', '1.0.0', 'organizationId', '$organization_id',
  'applicationRootId', '$application_a_root_id', 'applicationRelease', $release_a_two,
  'applicationCatalogueFingerprint', 'sha256:' || pg_catalog.repeat('c', 64),
  'applicationPermissionIds', pg_catalog.jsonb_build_array('$permission_a_one_id'),
  'entries', pg_catalog.jsonb_build_array($entry_a_one_updated),
  'candidateFingerprint', 'sha256:' || pg_catalog.repeat('d', 64)
)"
candidate_b_one="pg_catalog.jsonb_build_object(
  'contractVersion', '1.0.0', 'organizationId', '$organization_id',
  'applicationRootId', '$application_b_root_id', 'applicationRelease', $release_b_one,
  'applicationCatalogueFingerprint', 'sha256:' || pg_catalog.repeat('e', 64),
  'applicationPermissionIds', pg_catalog.jsonb_build_array('$permission_b_id'),
  'entries', pg_catalog.jsonb_build_array($entry_b),
  'candidateFingerprint', 'sha256:' || pg_catalog.repeat('f', 64)
)"
prepared_a_one="pg_catalog.jsonb_build_object(
  'contractVersion', '1.0.0',
  'preparationBasis', pg_catalog.jsonb_build_object('kind', 'registration_candidate'),
  'permissionRegistration', $candidate_a_one,
  'templates', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'template', pg_catalog.jsonb_build_object(
      'roleId', '$source_role_a_id', 'key', 'alpha_beta_reader',
      'name', 'Alpha beta reader', 'homePageId', '$source_role_a_id',
      'permissionKeys', pg_catalog.jsonb_build_array(
        'proof.assignment.alpha', 'proof.assignment.beta'
      ),
      'permissionSelection', pg_catalog.jsonb_build_object('kind', 'exact')
    ),
    'sourceTemplateFingerprint', 'sha256:' || pg_catalog.repeat('1', 64),
    'sourcePermissions', ($candidate_a_one) -> 'entries',
    'livePermissions', ($candidate_a_one) -> 'entries'
  )),
  'candidateFingerprint', 'sha256:' || pg_catalog.repeat('2', 64)
)"
prepared_a_two="pg_catalog.jsonb_build_object(
  'contractVersion', '1.0.0',
  'preparationBasis', pg_catalog.jsonb_build_object('kind', 'registration_candidate'),
  'permissionRegistration', $candidate_a_two,
  'templates', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'template', pg_catalog.jsonb_build_object(
      'roleId', '$source_role_a_id', 'key', 'alpha_reader',
      'name', 'Alpha reader', 'homePageId', '$source_role_a_id',
      'permissionKeys', pg_catalog.jsonb_build_array('proof.assignment.alpha'),
      'permissionSelection', pg_catalog.jsonb_build_object('kind', 'exact')
    ),
    'sourceTemplateFingerprint', 'sha256:' || pg_catalog.repeat('3', 64),
    'sourcePermissions', ($candidate_a_two) -> 'entries',
    'livePermissions', ($candidate_a_two) -> 'entries'
  )),
  'candidateFingerprint', 'sha256:' || pg_catalog.repeat('4', 64)
)"
prepared_b_one="pg_catalog.jsonb_build_object(
  'contractVersion', '1.0.0',
  'preparationBasis', pg_catalog.jsonb_build_object('kind', 'registration_candidate'),
  'permissionRegistration', $candidate_b_one,
  'templates', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'template', pg_catalog.jsonb_build_object(
      'roleId', '$source_role_b_id', 'key', 'gamma_reader',
      'name', 'Gamma reader', 'homePageId', '$source_role_b_id',
      'permissionKeys', pg_catalog.jsonb_build_array('proof.assignment.gamma'),
      'permissionSelection', pg_catalog.jsonb_build_object('kind', 'exact')
    ),
    'sourceTemplateFingerprint', 'sha256:' || pg_catalog.repeat('5', 64),
    'sourcePermissions', ($candidate_b_one) -> 'entries',
    'livePermissions', ($candidate_b_one) -> 'entries'
  )),
  'candidateFingerprint', 'sha256:' || pg_catalog.repeat('6', 64)
)"

run_sql "
  begin;
  do \$proof\$
  begin
    if exists (select 1 from vortex_identity.tenants where tenant_id = '$tenant_id')
      or exists (select 1 from vortex_identity.organizations where organization_id = '$organization_id')
      or exists (select 1 from vortex_identity.identity_projections where identity_id = '$identity_id')
      or exists (select 1 from vortex_access.organization_access_versions where organization_id = '$organization_id')
      or exists (
        select 1 from vortex_definition.roots
        where root_id in ('$application_a_root_id', '$application_b_root_id')
      ) then
      raise exception 'Role-assignment proof fixture scope already exists';
    end if;
  end
  \$proof\$;
  insert into vortex_identity.tenants (
    tenant_id, short_name, display_name, state, created_at, created_by,
    state_changed_at, revision
  ) values (
    '$tenant_id', '$fixture_short_name', 'Assignment $fixture_name_token', 'active',
    pg_catalog.clock_timestamp(), '$actor_id', pg_catalog.clock_timestamp(), 1
  );
  insert into vortex_identity.organizations (
    organization_id, tenant_id, parent_organization_id, short_name, display_name,
    state, created_at, created_by, state_changed_at, revision
  ) values (
    '$organization_id', '$tenant_id', null, '$fixture_short_name',
    'Assignment $fixture_name_token', 'active', pg_catalog.clock_timestamp(), '$actor_id',
    pg_catalog.clock_timestamp(), 1
  );
  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values (
    '$identity_id', 'active', pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    '$actor_id', '$correlation_initialize', 1
  );
  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name, state,
    activated_at, changed_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values (
    '$account_id', '$organization_id', '$identity_id', 'Assignment account', 'active',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), '$actor_id', '$correlation_initialize', 1
  );
  select * from vortex_access.initialize_organization_access_version(
    '$organization_id', '$actor_id', '$correlation_initialize'
  );
  insert into vortex_definition.roots (
    root_id, organization_id, kind, key, created_at, created_by
  ) values
    ('$application_a_root_id', '$organization_id', 'application', '$application_a_key',
      pg_catalog.clock_timestamp(), '$actor_id'),
    ('$application_b_root_id', '$organization_id', 'application', '$application_b_key',
      pg_catalog.clock_timestamp(), '$actor_id');
  insert into vortex_definition.releases (
    root_id, release_revision, release_version, authored_source,
    authored_source_fingerprint, source_contract_version, compilation_output,
    resolution_snapshot, content_fingerprint, resolution_fingerprint,
    validation_contract_version, comparison_fingerprint, impact_reasons,
    release_note, published_at, published_by
  ) values
    (
      '$application_a_root_id', 1, '1.0.0',
      pg_catalog.jsonb_build_object('source_contract_version', '1.0.0',
        'kind', 'application', 'key', '$application_a_key', 'body', '{}'::jsonb),
      'sha256:' || pg_catalog.repeat('7', 64), '1.0.0',
      pg_catalog.jsonb_build_object('kind', 'application', 'canonical',
        pg_catalog.jsonb_build_object('content', pg_catalog.jsonb_build_object(
          'permissions', pg_catalog.jsonb_build_array($permission_a_one, $permission_a_two)
        ))),
      pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('2', 64)),
      'sha256:' || pg_catalog.repeat('1', 64), 'sha256:' || pg_catalog.repeat('2', 64),
      '2.18.0', 'sha256:' || pg_catalog.repeat('9', 64), '[]', 'Initial A release',
      pg_catalog.clock_timestamp(), '$actor_id'
    ),
    (
      '$application_a_root_id', 2, '2.0.0',
      pg_catalog.jsonb_build_object('source_contract_version', '1.0.0',
        'kind', 'application', 'key', '$application_a_key', 'body', '{}'::jsonb),
      'sha256:' || pg_catalog.repeat('a', 64), '1.0.0',
      pg_catalog.jsonb_build_object('kind', 'application', 'canonical',
        pg_catalog.jsonb_build_object('content', pg_catalog.jsonb_build_object(
          'permissions', pg_catalog.jsonb_build_array($permission_a_one)
        ))),
      pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('4', 64)),
      'sha256:' || pg_catalog.repeat('3', 64), 'sha256:' || pg_catalog.repeat('4', 64),
      '2.18.0', 'sha256:' || pg_catalog.repeat('c', 64), '[]', 'Narrowed A release',
      pg_catalog.clock_timestamp(), '$actor_id'
    ),
    (
      '$application_b_root_id', 1, '1.0.0',
      pg_catalog.jsonb_build_object('source_contract_version', '1.0.0',
        'kind', 'application', 'key', '$application_b_key', 'body', '{}'::jsonb),
      'sha256:' || pg_catalog.repeat('d', 64), '1.0.0',
      pg_catalog.jsonb_build_object('kind', 'application', 'canonical',
        pg_catalog.jsonb_build_object('content', pg_catalog.jsonb_build_object(
          'permissions', pg_catalog.jsonb_build_array($permission_b)
        ))),
      pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('6', 64)),
      'sha256:' || pg_catalog.repeat('5', 64), 'sha256:' || pg_catalog.repeat('6', 64),
      '2.18.0', 'sha256:' || pg_catalog.repeat('f', 64), '[]', 'Initial B release',
      pg_catalog.clock_timestamp(), '$actor_id'
    );
  update vortex_definition.roots set current_release_revision = 2
    where root_id = '$application_a_root_id';
  update vortex_definition.roots set current_release_revision = 1
    where root_id = '$application_b_root_id';
  select * from vortex_access.coordinate_application_access_change(
    'register', null, $prepared_a_one, '$organization_id', '$application_a_root_id',
    '$actor_id', '$correlation_register_a'
  );
  select * from vortex_access.coordinate_application_access_change(
    'register', null, $prepared_b_one, '$organization_id', '$application_b_root_id',
    '$actor_id', '$correlation_register_b'
  );
  insert into vortex_access.organization_roles (
    organization_id, role_id, role_kind, role_key, application_root_id,
    source_role_id, live_revision, created_by, created_at
  ) values
    ('$organization_id', '$role_a_id', 'application', 'alpha_beta_reader',
      '$application_a_root_id', '$source_role_a_id', 1, '$actor_id', pg_catalog.clock_timestamp()),
    ('$organization_id', '$role_b_id', 'application', 'gamma_reader',
      '$application_b_root_id', '$source_role_b_id', 1, '$actor_id', pg_catalog.clock_timestamp());
  insert into vortex_access.organization_role_permission_entries (
    organization_id, role_id, role_revision, entry_ordinal, role_kind,
    role_application_root_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id,
    accepted_registration_revision, catalogue_fingerprint,
    continuity_revision, meaning_fingerprint
  )
  select '$organization_id', '$role_a_id', 1,
    pg_catalog.row_number() over (order by entry.permission_id), 'application',
    '$application_a_root_id', entry.application_root_id, entry.owner_kind,
    entry.owner_id, entry.permission_id, entry.registration_kind,
    entry.registration_owner_id, entry.registration_revision,
    registration.permission_catalogue_fingerprint, 1, entry.meaning_fingerprint
  from vortex_access.permission_catalogue_entries as entry
  join vortex_access.permission_registration_revisions as registration
    on registration.organization_id = entry.organization_id
    and registration.registration_kind = entry.registration_kind
    and registration.registration_owner_id = entry.registration_owner_id
    and registration.revision = entry.registration_revision
  where entry.organization_id = '$organization_id'
    and entry.registration_kind = 'application'
    and entry.registration_owner_id = '$application_a_root_id'
    and entry.registration_revision = 1;
  insert into vortex_access.organization_role_permission_entries (
    organization_id, role_id, role_revision, entry_ordinal, role_kind,
    role_application_root_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id,
    accepted_registration_revision, catalogue_fingerprint,
    continuity_revision, meaning_fingerprint
  )
  select '$organization_id', '$role_b_id', 1, 1, 'application',
    '$application_b_root_id', entry.application_root_id, entry.owner_kind,
    entry.owner_id, entry.permission_id, entry.registration_kind,
    entry.registration_owner_id, entry.registration_revision,
    registration.permission_catalogue_fingerprint, 1, entry.meaning_fingerprint
  from vortex_access.permission_catalogue_entries as entry
  join vortex_access.permission_registration_revisions as registration
    on registration.organization_id = entry.organization_id
    and registration.registration_kind = entry.registration_kind
    and registration.registration_owner_id = entry.registration_owner_id
    and registration.revision = entry.registration_revision
  where entry.organization_id = '$organization_id'
    and entry.registration_kind = 'application'
    and entry.registration_owner_id = '$application_b_root_id'
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
  ) values
    (
      '$organization_id', '$role_a_id', 1, 'application', '$application_a_root_id',
      'active', 'standard', 'standing', 1, 1, 'alpha_beta_reader',
      'Alpha beta reader', 'Read alpha and beta proof records.',
      '$application_a_key', 1, '1.0.0', '2.18.0',
      'sha256:' || pg_catalog.repeat('1', 64), 'sha256:' || pg_catalog.repeat('2', 64),
      'sha256:' || pg_catalog.repeat('1', 64), 'sha256:' || pg_catalog.repeat('a', 64),
      1, 1, 'sha256:' || pg_catalog.repeat('2', 64), '$actor_id',
      pg_catalog.clock_timestamp(), '$correlation_register_a'
    ),
    (
      '$organization_id', '$role_b_id', 1, 'application', '$application_b_root_id',
      'active', 'standard', 'standing', 1, 1, 'gamma_reader',
      'Gamma reader', 'Read gamma proof records.',
      '$application_b_key', 1, '1.0.0', '2.18.0',
      'sha256:' || pg_catalog.repeat('5', 64), 'sha256:' || pg_catalog.repeat('6', 64),
      'sha256:' || pg_catalog.repeat('5', 64), 'sha256:' || pg_catalog.repeat('e', 64),
      1, 1, 'sha256:' || pg_catalog.repeat('6', 64), '$actor_id',
      pg_catalog.clock_timestamp(), '$correlation_register_b'
    );
  set constraints all immediate;
  commit;
" >/dev/null
fixture_claimed=1

baseline_access_version="$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id = '$organization_id';")"
[ "$baseline_access_version" = '3' ] || {
  echo 'role-assignment proof did not establish the expected Access baseline' >&2
  exit 1
}

# Duplicate grant: the first transaction owns governance; the second waits and then
# fails on the permanent assignment identity without another Access increment.
PGAPPNAME="vortex-assignment-duplicate-a-$fixture_name_token" \
  "${psql_command[@]}" >"$proof_root/duplicate-a.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/duplicate-a.pid'
select 1 from vortex_access.organization_access_versions
where organization_id = '$organization_id' for update;
\! touch '$proof_root/duplicate-ready'
\! deadline=600; while [ ! -f '$proof_root/duplicate-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/duplicate-release' ]
select outcome, operation, revision, access_version
from vortex_access.coordinate_organization_role_assignment_change(
  'grant', '$organization_id', '$assignment_duplicate_id', null,
  '$role_a_id', 1, 'organization_account', '$account_id', null, 'standing',
  pg_catalog.clock_timestamp(), null, '$actor_id', '$correlation_grant_a'
);
commit;
SQL
duplicate_a_pid=$!
worker_pids+=("$duplicate_a_pid")
wait_for_file "$proof_root/duplicate-ready"
duplicate_a_backend_pid="$(read_backend_pid "$proof_root/duplicate-a.pid")"

PGAPPNAME="vortex-assignment-duplicate-b-$fixture_name_token" \
  "${psql_command[@]}" >"$proof_root/duplicate-b.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/duplicate-b.pid'
set local lock_timeout = '30s';
select * from vortex_access.coordinate_organization_role_assignment_change(
  'grant', '$organization_id', '$assignment_duplicate_id', null,
  '$role_a_id', 1, 'organization_account', '$account_id', null, 'standing',
  pg_catalog.clock_timestamp(), null, '$actor_id', '$correlation_grant_b'
);
commit;
SQL
duplicate_b_pid=$!
worker_pids+=("$duplicate_b_pid")
duplicate_b_backend_pid="$(read_backend_pid "$proof_root/duplicate-b.pid")"
wait_for_database_blocker "$duplicate_b_backend_pid" "$duplicate_a_backend_pid"
touch "$proof_root/duplicate-release"
wait_owned_worker "$duplicate_a_pid"
grep -Fq 'changed|grant|1|4' "$proof_root/duplicate-a.log" || {
  echo 'the winning duplicate grant did not return exact committed state' >&2
  exit 1
}
if wait_owned_worker "$duplicate_b_pid"; then
  echo 'the duplicate assignment identity unexpectedly committed twice' >&2
  exit 1
fi
grep -q '23505' "$proof_root/duplicate-b.log" || {
  echo 'the duplicate grant failed without its stable identity conflict' >&2
  exit 1
}

state="$(run_sql "select pg_catalog.concat_ws('|', version.current_version, assignment.revision, assignment.state, pg_catalog.count(*) over ()) from vortex_access.organization_access_versions as version join vortex_access.organization_role_assignments as assignment on assignment.organization_id = version.organization_id where version.organization_id = '$organization_id' and assignment.role_assignment_id = '$assignment_duplicate_id';")"
[ "$state" = '4|1|live|1' ] || {
  printf 'duplicate grant left unexpected state: %q\n' "$state" >&2
  exit 1
}

# Competing revocation: exactly one expected revision can become terminal.
PGAPPNAME="vortex-assignment-revoke-a-$fixture_name_token" \
  "${psql_command[@]}" >"$proof_root/revoke-a.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/revoke-a.pid'
select 1 from vortex_access.organization_access_versions
where organization_id = '$organization_id' for update;
\! touch '$proof_root/revoke-ready'
\! deadline=600; while [ ! -f '$proof_root/revoke-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/revoke-release' ]
select outcome, operation, revision, access_version
from vortex_access.coordinate_organization_role_assignment_change(
  'revoke', '$organization_id', '$assignment_duplicate_id', 1,
  null, null, null, null, null, null, null, null,
  '$actor_id', '$correlation_revoke_a'
);
commit;
SQL
revoke_a_pid=$!
worker_pids+=("$revoke_a_pid")
wait_for_file "$proof_root/revoke-ready"
revoke_a_backend_pid="$(read_backend_pid "$proof_root/revoke-a.pid")"

PGAPPNAME="vortex-assignment-revoke-b-$fixture_name_token" \
  "${psql_command[@]}" >"$proof_root/revoke-b.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/revoke-b.pid'
set local lock_timeout = '30s';
select * from vortex_access.coordinate_organization_role_assignment_change(
  'revoke', '$organization_id', '$assignment_duplicate_id', 1,
  null, null, null, null, null, null, null, null,
  '$actor_id', '$correlation_revoke_b'
);
commit;
SQL
revoke_b_pid=$!
worker_pids+=("$revoke_b_pid")
revoke_b_backend_pid="$(read_backend_pid "$proof_root/revoke-b.pid")"
wait_for_database_blocker "$revoke_b_backend_pid" "$revoke_a_backend_pid"
touch "$proof_root/revoke-release"
wait_owned_worker "$revoke_a_pid"
grep -Fq 'changed|revoke|2|5' "$proof_root/revoke-a.log" || {
  echo 'the winning revocation did not return exact terminal state' >&2
  exit 1
}
if wait_owned_worker "$revoke_b_pid"; then
  echo 'the same assignment unexpectedly revoked twice' >&2
  exit 1
fi
grep -q '40001' "$proof_root/revoke-b.log" || {
  echo 'the stale competing revocation failed without stable stale state' >&2
  exit 1
}

# A grant whose expiry crosses while it waits on governance must be refused using
# the database clock observed after the lock, with no fact or Access change.
expiry_at="$(run_sql "select (pg_catalog.clock_timestamp() + interval '5 seconds')::text;")"
PGAPPNAME="vortex-assignment-expiry-holder-$fixture_name_token" \
  "${psql_command[@]}" >"$proof_root/expiry-holder.log" 2>&1 <<SQL &
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/expiry-holder.pid'
select 1 from vortex_access.organization_access_versions
where organization_id = '$organization_id' for update;
\! touch '$proof_root/expiry-ready'
\! deadline=600; while [ ! -f '$proof_root/expiry-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/expiry-release' ]
commit;
SQL
expiry_holder_pid=$!
worker_pids+=("$expiry_holder_pid")
wait_for_file "$proof_root/expiry-ready"
expiry_holder_backend_pid="$(read_backend_pid "$proof_root/expiry-holder.pid")"

PGAPPNAME="vortex-assignment-expiry-grant-$fixture_name_token" \
  "${psql_command[@]}" >"$proof_root/expiry-grant.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/expiry-grant.pid'
set local lock_timeout = '30s';
select * from vortex_access.coordinate_organization_role_assignment_change(
  'grant', '$organization_id', '$assignment_expiry_id', null,
  '$role_a_id', 1, 'organization_account', '$account_id', null, 'standing',
  pg_catalog.clock_timestamp(), '$expiry_at'::timestamptz,
  '$actor_id', '$correlation_expiry'
);
commit;
SQL
expiry_grant_pid=$!
worker_pids+=("$expiry_grant_pid")
expiry_grant_backend_pid="$(read_backend_pid "$proof_root/expiry-grant.pid")"
wait_for_database_blocker "$expiry_grant_backend_pid" "$expiry_holder_backend_pid"
[ "$(run_sql "select case when pg_catalog.clock_timestamp() < '$expiry_at'::timestamptz then 'pending' else '' end;")" = 'pending' ] || {
  echo 'the assignment expiry elapsed before the governance wait was observed' >&2
  exit 1
}
wait_for_database_time "$expiry_at"
touch "$proof_root/expiry-release"
wait_owned_worker "$expiry_holder_pid"
if wait_owned_worker "$expiry_grant_pid"; then
  echo 'a grant that expired during its governance wait unexpectedly committed' >&2
  exit 1
fi
grep -q '40001' "$proof_root/expiry-grant.log" || {
  echo 'the expired waiting grant failed without stable stale-window state' >&2
  exit 1
}
[ "$(run_sql "select pg_catalog.concat_ws('|', current_version, (select count(*) from vortex_access.organization_role_assignments where organization_id = '$organization_id' and role_assignment_id = '$assignment_expiry_id')) from vortex_access.organization_access_versions where organization_id = '$organization_id';")" = '5|0' ] || {
  echo 'the expired waiting grant changed a fact or Access version' >&2
  exit 1
}

# A real B2 narrowing wins governance and advances the same-policy active role.
# The waiting grant must reject its exact reviewed role revision, not merely recheck mode.
PGAPPNAME="vortex-assignment-narrow-$fixture_name_token" \
  "${psql_command[@]}" >"$proof_root/narrow.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/narrow.pid'
select 1 from vortex_access.organization_access_versions
where organization_id = '$organization_id' for update;
\! touch '$proof_root/narrow-ready'
\! deadline=600; while [ ! -f '$proof_root/narrow-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/narrow-release' ]
select outcome, operation, registration_revision, access_version
from vortex_access.coordinate_application_access_change(
  'update', 1, $prepared_a_two, '$organization_id', '$application_a_root_id',
  '$actor_id', '$correlation_narrow'
);
commit;
SQL
narrow_pid=$!
worker_pids+=("$narrow_pid")
wait_for_file "$proof_root/narrow-ready"
narrow_backend_pid="$(read_backend_pid "$proof_root/narrow.pid")"

PGAPPNAME="vortex-assignment-stale-role-$fixture_name_token" \
  "${psql_command[@]}" >"$proof_root/stale-role.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/stale-role.pid'
set local lock_timeout = '30s';
select * from vortex_access.coordinate_organization_role_assignment_change(
  'grant', '$organization_id', '$assignment_stale_role_id', null,
  '$role_a_id', 1, 'organization_account', '$account_id', null, 'standing',
  pg_catalog.clock_timestamp(), null, '$actor_id', '$correlation_stale_role'
);
commit;
SQL
stale_role_pid=$!
worker_pids+=("$stale_role_pid")
stale_role_backend_pid="$(read_backend_pid "$proof_root/stale-role.pid")"
wait_for_database_blocker "$stale_role_backend_pid" "$narrow_backend_pid"
touch "$proof_root/narrow-release"
wait_owned_worker "$narrow_pid"
grep -Fq 'changed|update|2|6' "$proof_root/narrow.log" || {
  echo 'the winning B2 narrowing did not return exact revision state' >&2
  exit 1
}
if wait_owned_worker "$stale_role_pid"; then
  echo 'a grant using a stale reviewed role revision unexpectedly committed' >&2
  exit 1
fi
grep -q '40001' "$proof_root/stale-role.log" || {
  echo 'the stale-role grant failed without stable stale evidence' >&2
  exit 1
}
state="$(run_sql "select pg_catalog.concat_ws('|', version.current_version, role.live_revision, revision.lifecycle, revision.assignment_policy, (select count(*) from vortex_access.organization_role_permission_entries where organization_id = '$organization_id' and role_id = '$role_a_id' and role_revision = role.live_revision), (select count(*) from vortex_access.organization_role_assignments where organization_id = '$organization_id' and role_assignment_id = '$assignment_stale_role_id')) from vortex_access.organization_access_versions as version join vortex_access.organization_roles as role on role.organization_id = version.organization_id and role.role_id = '$role_a_id' join vortex_access.organization_role_revisions as revision on revision.organization_id = role.organization_id and revision.role_id = role.role_id and revision.revision = role.live_revision where version.organization_id = '$organization_id';")"
[ "$state" = '6|2|active|standing|1|0' ] || {
  printf 'same-mode role revision race left unexpected state: %q\n' "$state" >&2
  exit 1
}

# Grant wins before withdrawal: a separate role-row holder lets the real grant
# statement acquire governance first and wait on its next required lock. The later
# withdrawal then waits behind that real statement, preserving Access chronology.
PGAPPNAME="vortex-assignment-grant-role-holder-$fixture_name_token" \
  "${psql_command[@]}" >"$proof_root/grant-role-holder.log" 2>&1 <<SQL &
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/grant-role-holder.pid'
select 1 from vortex_access.organization_roles
where organization_id = '$organization_id' and role_id = '$role_a_id' for update;
\! touch '$proof_root/grant-role-holder-ready'
\! deadline=600; while [ ! -f '$proof_root/grant-first-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/grant-first-release' ]
commit;
SQL
grant_role_holder_pid=$!
worker_pids+=("$grant_role_holder_pid")
wait_for_file "$proof_root/grant-role-holder-ready"
grant_role_holder_backend_pid="$(read_backend_pid "$proof_root/grant-role-holder.pid")"

PGAPPNAME="vortex-assignment-grant-first-$fixture_name_token" \
  "${psql_command[@]}" >"$proof_root/grant-first.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/grant-first.pid'
select outcome, operation, revision, access_version
from vortex_access.coordinate_organization_role_assignment_change(
  'grant', '$organization_id', '$assignment_grant_first_id', null,
  '$role_a_id', 2, 'organization_account', '$account_id', null, 'standing',
  pg_catalog.clock_timestamp(), null, '$actor_id', '$correlation_grant_first'
);
commit;
SQL
grant_first_pid=$!
worker_pids+=("$grant_first_pid")
grant_first_backend_pid="$(read_backend_pid "$proof_root/grant-first.pid")"
wait_for_database_blocker "$grant_first_backend_pid" "$grant_role_holder_backend_pid"

PGAPPNAME="vortex-assignment-withdraw-after-$fixture_name_token" \
  "${psql_command[@]}" >"$proof_root/withdraw-after.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/withdraw-after.pid'
set local lock_timeout = '30s';
select outcome, operation, registration_revision, access_version
from vortex_access.coordinate_application_access_change(
  'withdraw', 2, null, '$organization_id', '$application_a_root_id',
  '$actor_id', '$correlation_withdraw_after'
);
commit;
SQL
withdraw_after_pid=$!
worker_pids+=("$withdraw_after_pid")
withdraw_after_backend_pid="$(read_backend_pid "$proof_root/withdraw-after.pid")"
wait_for_database_blocker "$withdraw_after_backend_pid" "$grant_first_backend_pid"
touch "$proof_root/grant-first-release"
wait_owned_worker "$grant_role_holder_pid"
wait_owned_worker "$grant_first_pid"
wait_owned_worker "$withdraw_after_pid"
grep -Fq 'changed|grant|1|7' "$proof_root/grant-first.log" || {
  echo 'grant-first ordering did not commit its exact assignment result' >&2
  exit 1
}
grep -Fq 'changed|withdraw|3|8' "$proof_root/withdraw-after.log" || {
  echo 'withdraw-after ordering did not commit its exact B2 result' >&2
  exit 1
}
state="$(run_sql "select pg_catalog.concat_ws('|', version.current_version, role.live_revision, revision.lifecycle, assignment.revision, assignment.state) from vortex_access.organization_access_versions as version join vortex_access.organization_roles as role on role.organization_id = version.organization_id and role.role_id = '$role_a_id' join vortex_access.organization_role_revisions as revision on revision.organization_id = role.organization_id and revision.role_id = role.role_id and revision.revision = role.live_revision join vortex_access.organization_role_assignments as assignment on assignment.organization_id = version.organization_id and assignment.role_assignment_id = '$assignment_grant_first_id' where version.organization_id = '$organization_id';")"
[ "$state" = '8|3|unavailable|1|live' ] || {
  printf 'grant-first/withdraw-after ordering left unexpected state: %q\n' "$state" >&2
  exit 1
}

preserved_grant="$(run_sql "
  select pg_catalog.concat_ws('|', role_id, assignee_kind,
    organization_account_id, group_id, assignment_kind, starts_at, expires_at,
    granted_by, granted_at, grant_correlation_id)
  from vortex_access.organization_role_assignments
  where organization_id = '$organization_id'
    and role_assignment_id = '$assignment_grant_first_id';
")"
inactive_revoke="$(run_sql "
  select pg_catalog.concat_ws('|', outcome, operation, revision, access_version)
  from vortex_access.coordinate_organization_role_assignment_change(
    'revoke', '$organization_id', '$assignment_grant_first_id', 1,
    null, null, null, null, null, null, null, null,
    '$actor_id', '$correlation_revoke_inactive'
  );
")"
[ "$inactive_revoke" = 'changed|revoke|2|9' ] || {
  printf 'revocation after role withdrawal returned unexpected state: %q\n' "$inactive_revoke" >&2
  exit 1
}
after_revoke="$(run_sql "
  select pg_catalog.concat_ws('|', version.current_version, assignment.revision,
    assignment.state, assignment.changed_by, assignment.change_correlation_id,
    assignment.revoked_by, assignment.revocation_correlation_id)
  from vortex_access.organization_access_versions as version
  join vortex_access.organization_role_assignments as assignment
    on assignment.organization_id = version.organization_id
  where version.organization_id = '$organization_id'
    and assignment.role_assignment_id = '$assignment_grant_first_id';
")"
[ "$after_revoke" = "9|2|revoked|$actor_id|$correlation_revoke_inactive|$actor_id|$correlation_revoke_inactive" ] || {
  printf 'revocation after role withdrawal did not change Access exactly once: %q\n' "$after_revoke" >&2
  exit 1
}
[ "$(run_sql "
  select pg_catalog.concat_ws('|', role_id, assignee_kind,
    organization_account_id, group_id, assignment_kind, starts_at, expires_at,
    granted_by, granted_at, grant_correlation_id)
  from vortex_access.organization_role_assignments
  where organization_id = '$organization_id'
    and role_assignment_id = '$assignment_grant_first_id';
")" = "$preserved_grant" ] || {
  echo 'revocation after role withdrawal changed original assignment provenance' >&2
  exit 1
}

# Withdrawal wins for the independent role: the waiting grant rechecks the role
# after governance and refuses; only the withdrawal changes Access.
PGAPPNAME="vortex-assignment-withdraw-first-$fixture_name_token" \
  "${psql_command[@]}" >"$proof_root/withdraw-first.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/withdraw-first.pid'
select 1 from vortex_access.organization_access_versions
where organization_id = '$organization_id' for update;
\! touch '$proof_root/withdraw-first-ready'
\! deadline=600; while [ ! -f '$proof_root/withdraw-first-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/withdraw-first-release' ]
select outcome, operation, registration_revision, access_version
from vortex_access.coordinate_application_access_change(
  'withdraw', 1, null, '$organization_id', '$application_b_root_id',
  '$actor_id', '$correlation_withdraw_first'
);
commit;
SQL
withdraw_first_pid=$!
worker_pids+=("$withdraw_first_pid")
wait_for_file "$proof_root/withdraw-first-ready"
withdraw_first_backend_pid="$(read_backend_pid "$proof_root/withdraw-first.pid")"

PGAPPNAME="vortex-assignment-grant-after-$fixture_name_token" \
  "${psql_command[@]}" >"$proof_root/grant-after.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/grant-after.pid'
set local lock_timeout = '30s';
select * from vortex_access.coordinate_organization_role_assignment_change(
  'grant', '$organization_id', '$assignment_withdraw_first_id', null,
  '$role_b_id', 1, 'organization_account', '$account_id', null, 'standing',
  pg_catalog.clock_timestamp(), null, '$actor_id', '$correlation_grant_after'
);
commit;
SQL
grant_after_pid=$!
worker_pids+=("$grant_after_pid")
grant_after_backend_pid="$(read_backend_pid "$proof_root/grant-after.pid")"
wait_for_database_blocker "$grant_after_backend_pid" "$withdraw_first_backend_pid"
touch "$proof_root/withdraw-first-release"
wait_owned_worker "$withdraw_first_pid"
if wait_owned_worker "$grant_after_pid"; then
  echo 'the grant waiting behind withdrawal unexpectedly committed' >&2
  exit 1
fi
grep -Fq 'changed|withdraw|2|10' "$proof_root/withdraw-first.log" || {
  echo 'withdraw-first ordering did not commit its exact B2 result' >&2
  exit 1
}
grep -q '40001' "$proof_root/grant-after.log" || {
  echo 'the grant after withdrawal failed without stable stale evidence' >&2
  exit 1
}
state="$(run_sql "select pg_catalog.concat_ws('|', version.current_version, role.live_revision, revision.lifecycle, (select count(*) from vortex_access.organization_role_assignments where organization_id = '$organization_id' and role_assignment_id = '$assignment_withdraw_first_id')) from vortex_access.organization_access_versions as version join vortex_access.organization_roles as role on role.organization_id = version.organization_id and role.role_id = '$role_b_id' join vortex_access.organization_role_revisions as revision on revision.organization_id = role.organization_id and revision.role_id = role.role_id and revision.revision = role.live_revision where version.organization_id = '$organization_id';")"
[ "$state" = '10|2|unavailable|0' ] || {
  printf 'withdraw-first/grant-after ordering left unexpected state: %q\n' "$state" >&2
  exit 1
}

echo 'organization role-assignment change concurrency proof passed'
