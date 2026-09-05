#!/usr/bin/env bash

set -euo pipefail

run_uuid="${VORTEX_ROLE_CHANGE_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then
  [ -r /proc/sys/kernel/random/uuid ] || {
    echo 'a Linux random UUID source is required for the role-change proof' >&2
    exit 1
  }
  IFS= read -r run_uuid </proc/sys/kernel/random/uuid
fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  echo 'VORTEX_ROLE_CHANGE_PROOF_RUN_ID must be a lowercase UUID v4' >&2
  exit 1
}

readonly run_uuid
readonly run_token="${run_uuid//-/}"
readonly fixture_name_token="${run_token:0:24}"
readonly fixture_short_name="role_${fixture_name_token}"
readonly application_key="proof.role_change.run_${run_token}"
proof_root="$(mktemp -d /tmp/vortex-role-change.XXXXXX)"
readonly proof_root
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id="a1${run_uuid:2}"
readonly organization_id="a2${run_uuid:2}"
readonly identity_id="a3${run_uuid:2}"
readonly account_id="a4${run_uuid:2}"
readonly application_root_id="a5${run_uuid:2}"
readonly permission_id="a6${run_uuid:2}"
readonly custom_role_id="a7${run_uuid:2}"
readonly application_role_id="a8${run_uuid:2}"
readonly source_role_id="a9${run_uuid:2}"
readonly assignment_a_id="aa${run_uuid:2}"
readonly assignment_b_id="ab${run_uuid:2}"
readonly policy_id="ac${run_uuid:2}"
readonly actor_id="ad${run_uuid:2}"
readonly correlation_initialize="ae${run_uuid:2}"
readonly correlation_platform="af${run_uuid:2}"
readonly correlation_register="b0${run_uuid:2}"
readonly correlation_app_seed="b1${run_uuid:2}"
readonly correlation_grant_a="b2${run_uuid:2}"
readonly correlation_mode_change="b3${run_uuid:2}"
readonly correlation_metadata="b4${run_uuid:2}"
readonly correlation_grant_b="b5${run_uuid:2}"
readonly correlation_grant_b_retry="b6${run_uuid:2}"
readonly correlation_update="b7${run_uuid:2}"
readonly correlation_stale_accept="b8${run_uuid:2}"
readonly correlation_accept="b9${run_uuid:2}"
readonly correlation_withdraw="ba${run_uuid:2}"

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
  echo 'role-change proof did not reach its transaction barrier' >&2
  return 1
}

read_backend_pid() {
  local candidate="$1"
  local backend_pid
  wait_for_file "$candidate"
  backend_pid="$(tr -d '[:space:]' <"$candidate")"
  [[ "$backend_pid" =~ ^[1-9][0-9]*$ ]] || {
    printf 'role-change proof captured an invalid backend identifier: %q\n' "$backend_pid" >&2
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
    state="$(run_sql "select case when $blocking_pid = any(pg_catalog.pg_blocking_pids($blocked_pid)) then 'blocked' else '' end;")"
    [ "$state" = 'blocked' ] && return 0
    sleep 0.1
  done
  echo 'role-change proof did not observe the required lock ordering' >&2
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
  echo 'role-change proof failed; bounded owned worker diagnostics follow' >&2
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
        where tenant_id = '$tenant_id' and short_name = '$fixture_short_name'
          and created_by = '$actor_id'
      ) or not exists (
        select 1 from vortex_identity.organizations
        where organization_id = '$organization_id' and tenant_id = '$tenant_id'
          and short_name = '$fixture_short_name' and created_by = '$actor_id'
      ) or not exists (
        select 1 from vortex_identity.organization_accounts
        where organization_id = '$organization_id'
          and organization_account_id = '$account_id' and identity_id = '$identity_id'
      ) or not exists (
        select 1 from vortex_definition.roots
        where root_id = '$application_root_id' and organization_id = '$organization_id'
          and key = '$application_key' and created_by = '$actor_id'
      ) then
        raise exception 'Role-change proof fixture ownership marker mismatch';
      end if;
    end
    \$proof\$;
    delete from vortex_access.organization_role_activations where organization_id = '$organization_id';
    delete from vortex_access.organization_role_assignments where organization_id = '$organization_id';
    delete from vortex_access.organization_role_permission_entries where organization_id = '$organization_id';
    delete from vortex_access.organization_role_revisions where organization_id = '$organization_id';
    delete from vortex_access.organization_role_activation_policy_revisions where organization_id = '$organization_id';
    delete from vortex_access.organization_roles where organization_id = '$organization_id';
    delete from vortex_access.application_role_template_continuities where organization_id = '$organization_id';
    delete from vortex_access.permission_continuities where organization_id = '$organization_id';
    delete from vortex_access.permission_catalogue_entries where organization_id = '$organization_id';
    delete from vortex_access.permission_registrations where organization_id = '$organization_id';
    delete from vortex_access.permission_registration_revisions where organization_id = '$organization_id';
    delete from vortex_definition.releases where root_id = '$application_root_id';
    delete from vortex_definition.roots where root_id = '$application_root_id';
    delete from vortex_access.organization_access_versions where organization_id = '$organization_id';
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
  local operation_status
  trap - EXIT INT TERM
  set +e
  touch "$proof_root/grant-first-release" "$proof_root/role-first-release" \
    "$proof_root/update-first-release" "$proof_root/accept-first-release"
  stop_owned_workers
  if [ "$original_status" -ne 0 ]; then emit_owned_failure_diagnostics; fi
  cleanup_fixture
  operation_status=$?
  if [ "$operation_status" -ne 0 ]; then cleanup_status="$operation_status"; fi
  case "$proof_root" in
    /tmp/vortex-role-change.*) rm -rf -- "$proof_root"; operation_status=$? ;;
    *) echo "refusing to remove unexpected proof directory: $proof_root" >&2; operation_status=1 ;;
  esac
  if [ "$operation_status" -ne 0 ] && [ "$cleanup_status" -eq 0 ]; then
    cleanup_status="$operation_status"
  fi
  if [ "$original_status" -ne 0 ]; then exit "$original_status"; fi
  exit "$cleanup_status"
}
trap finalize EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

permission_one="pg_catalog.jsonb_build_object(
  'permissionId', '$permission_id', 'key', 'proof.role_change.read',
  'label', 'Read proof records', 'description', 'Read role-change proof records.',
  'actionKind', 'read', 'administrative', false
)"
permission_two="pg_catalog.jsonb_build_object(
  'permissionId', '$permission_id', 'key', 'proof.role_change.read',
  'label', 'Update proof records', 'description', 'Update role-change proof records.',
  'actionKind', 'update', 'administrative', false
)"
release_one="pg_catalog.jsonb_build_object(
  'kind', 'application', 'definitionKey', '$application_key',
  'rootId', '$application_root_id', 'releaseRevision', 1,
  'releaseVersion', '1.0.0', 'validationContractVersion', '2.18.0',
  'contentFingerprint', 'sha256:' || pg_catalog.repeat('1', 64),
  'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('2', 64)
)"
release_two="pg_catalog.jsonb_build_object(
  'kind', 'application', 'definitionKey', '$application_key',
  'rootId', '$application_root_id', 'releaseRevision', 2,
  'releaseVersion', '2.0.0', 'validationContractVersion', '2.18.0',
  'contentFingerprint', 'sha256:' || pg_catalog.repeat('3', 64),
  'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('4', 64)
)"
entry_one="pg_catalog.jsonb_build_object(
  'applicationRootId', '$application_root_id', 'ownerKind', 'application',
  'ownerId', '$application_root_id', 'permission', $permission_one,
  'sourceRelease', $release_one,
  'meaningFingerprint', 'sha256:' || pg_catalog.repeat('5', 64)
)"
entry_two="pg_catalog.jsonb_build_object(
  'applicationRootId', '$application_root_id', 'ownerKind', 'application',
  'ownerId', '$application_root_id', 'permission', $permission_two,
  'sourceRelease', $release_two,
  'meaningFingerprint', 'sha256:' || pg_catalog.repeat('6', 64)
)"
candidate_one="pg_catalog.jsonb_build_object(
  'contractVersion', '1.0.0', 'organizationId', '$organization_id',
  'applicationRootId', '$application_root_id', 'applicationRelease', $release_one,
  'applicationCatalogueFingerprint', 'sha256:' || pg_catalog.repeat('7', 64),
  'applicationPermissionIds', pg_catalog.jsonb_build_array('$permission_id'),
  'entries', pg_catalog.jsonb_build_array($entry_one),
  'candidateFingerprint', 'sha256:' || pg_catalog.repeat('8', 64)
)"
candidate_two="pg_catalog.jsonb_build_object(
  'contractVersion', '1.0.0', 'organizationId', '$organization_id',
  'applicationRootId', '$application_root_id', 'applicationRelease', $release_two,
  'applicationCatalogueFingerprint', 'sha256:' || pg_catalog.repeat('9', 64),
  'applicationPermissionIds', pg_catalog.jsonb_build_array('$permission_id'),
  'entries', pg_catalog.jsonb_build_array($entry_two),
  'candidateFingerprint', 'sha256:' || pg_catalog.repeat('a', 64)
)"
template_one="pg_catalog.jsonb_build_object(
  'template', pg_catalog.jsonb_build_object(
    'roleId', '$source_role_id', 'key', 'proof_reader', 'name', 'Proof reader',
    'homePageId', '$source_role_id',
    'permissionKeys', pg_catalog.jsonb_build_array('proof.role_change.read'),
    'permissionSelection', pg_catalog.jsonb_build_object('kind', 'exact')
  ),
  'sourceTemplateFingerprint', 'sha256:' || pg_catalog.repeat('b', 64),
  'sourcePermissions', pg_catalog.jsonb_build_array($entry_one),
  'livePermissions', pg_catalog.jsonb_build_array($entry_one)
)"
template_two="pg_catalog.jsonb_build_object(
  'template', pg_catalog.jsonb_build_object(
    'roleId', '$source_role_id', 'key', 'proof_reader', 'name', 'Proof reader',
    'homePageId', '$source_role_id',
    'permissionKeys', pg_catalog.jsonb_build_array('proof.role_change.read'),
    'permissionSelection', pg_catalog.jsonb_build_object('kind', 'exact')
  ),
  'sourceTemplateFingerprint', 'sha256:' || pg_catalog.repeat('b', 64),
  'sourcePermissions', pg_catalog.jsonb_build_array($entry_two),
  'livePermissions', pg_catalog.jsonb_build_array($entry_two)
)"
prepared_register_one="pg_catalog.jsonb_build_object(
  'contractVersion', '1.0.0',
  'preparationBasis', pg_catalog.jsonb_build_object('kind', 'registration_candidate'),
  'permissionRegistration', $candidate_one,
  'templates', pg_catalog.jsonb_build_array($template_one),
  'candidateFingerprint', 'sha256:' || pg_catalog.repeat('c', 64)
)"
prepared_register_two="pg_catalog.jsonb_build_object(
  'contractVersion', '1.0.0',
  'preparationBasis', pg_catalog.jsonb_build_object('kind', 'registration_candidate'),
  'permissionRegistration', $candidate_two,
  'templates', pg_catalog.jsonb_build_array($template_two),
  'candidateFingerprint', 'sha256:' || pg_catalog.repeat('d', 64)
)"
prepared_current_one="pg_catalog.jsonb_build_object(
  'contractVersion', '1.0.0',
  'preparationBasis', pg_catalog.jsonb_build_object(
    'kind', 'current_active_registration', 'registrationRevision', 1
  ),
  'permissionRegistration', $candidate_one,
  'templates', pg_catalog.jsonb_build_array($template_one),
  'candidateFingerprint', 'sha256:' || pg_catalog.repeat('e', 64)
)"
prepared_current_two="pg_catalog.jsonb_build_object(
  'contractVersion', '1.0.0',
  'preparationBasis', pg_catalog.jsonb_build_object(
    'kind', 'current_active_registration', 'registrationRevision', 2
  ),
  'permissionRegistration', $candidate_two,
  'templates', pg_catalog.jsonb_build_array($template_two),
  'candidateFingerprint', 'sha256:' || pg_catalog.repeat('f', 64)
)"
role_permission_one="pg_catalog.jsonb_build_object(
  'kind', 'exact', 'applicationRootId', '$application_root_id',
  'ownerKind', 'application', 'ownerId', '$application_root_id',
  'permissionId', '$permission_id', 'acceptedRegistrationRevision', 1,
  'catalogueFingerprint', 'sha256:' || pg_catalog.repeat('7', 64),
  'continuityRevision', 1,
  'meaningFingerprint', 'sha256:' || pg_catalog.repeat('5', 64)
)"
role_permission_two="pg_catalog.jsonb_build_object(
  'kind', 'exact', 'applicationRootId', '$application_root_id',
  'ownerKind', 'application', 'ownerId', '$application_root_id',
  'permissionId', '$permission_id', 'acceptedRegistrationRevision', 2,
  'catalogueFingerprint', 'sha256:' || pg_catalog.repeat('9', 64),
  'continuityRevision', 2,
  'meaningFingerprint', 'sha256:' || pg_catalog.repeat('6', 64)
)"
app_evidence_one="pg_catalog.jsonb_build_object(
  'contractVersion', '1.0.0',
  'candidate', pg_catalog.jsonb_build_object(
    'operation', 'accept_new_application_role', 'organizationId', '$organization_id',
    'roleId', '$application_role_id', 'key', 'proof_reader', 'label', 'Proof reader',
    'description', 'Application role for the concurrency proof.',
    'privilegeClassification', 'standard',
    'assignmentPolicy', pg_catalog.jsonb_build_object('kind', 'standing'),
    'preparedTemplates', $prepared_current_one, 'sourceRoleId', '$source_role_id',
    'templateContinuityRevision', 1,
    'permissions', pg_catalog.jsonb_build_array($role_permission_one)
  ),
  'acceptedGrantFingerprint', 'sha256:' || pg_catalog.repeat('1', 64),
  'roleCandidateFingerprint', 'sha256:' || pg_catalog.repeat('2', 64)
)"
stale_app_evidence="pg_catalog.jsonb_set(
  $app_evidence_one,
  '{candidate}',
  ($app_evidence_one -> 'candidate') || pg_catalog.jsonb_build_object(
    'operation', 'accept_application_role_revision', 'expectedRoleRevision', 1
  )
)"

"${psql_command[@]}" >/dev/null <<SQL
begin;
insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by, state_changed_at, revision
) values ('$tenant_id', '$fixture_short_name', 'Role change proof', 'active',
  pg_catalog.statement_timestamp(), '$actor_id', pg_catalog.statement_timestamp(), 1);
insert into vortex_identity.organizations (
  organization_id, tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values ('$organization_id', '$tenant_id', '$fixture_short_name', 'Role change proof',
  'active', pg_catalog.statement_timestamp(), '$actor_id', pg_catalog.statement_timestamp(), 1);
insert into vortex_identity.identity_projections (
  identity_id, state, created_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values ('$identity_id', 'active', pg_catalog.statement_timestamp(),
  pg_catalog.statement_timestamp(), '$actor_id', '$correlation_initialize', 1);
insert into vortex_identity.organization_accounts (
  organization_account_id, organization_id, identity_id, display_name, state,
  activated_at, changed_at, state_changed_at, state_changed_by,
  state_change_correlation_id, revision
) values ('$account_id', '$organization_id', '$identity_id', 'Role change account',
  'active', pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp(),
  pg_catalog.statement_timestamp(), '$actor_id', '$correlation_initialize', 1);
select * from vortex_access.initialize_organization_access_version(
  '$organization_id', '$actor_id', '$correlation_initialize'
);
select * from vortex_access.initialize_platform_permission_catalogue(
  '$organization_id', '$actor_id', '$correlation_platform'
);
insert into vortex_access.permission_continuities (
  organization_id, application_root_id, owner_kind, owner_id, permission_id,
  registration_kind, registration_owner_id, state, continuity_revision,
  meaning_fingerprint, last_processed_registration_revision, changed_at
)
select entry.organization_id, null, entry.owner_kind, entry.owner_id, entry.permission_id,
  entry.registration_kind, entry.registration_owner_id, 'available', 1,
  entry.meaning_fingerprint, entry.registration_revision, pg_catalog.statement_timestamp()
from vortex_access.permission_catalogue_entries as entry
where entry.organization_id = '$organization_id' and entry.registration_kind = 'platform';
insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, live_revision, created_by, created_at
) values ('$organization_id', '$custom_role_id', 'custom', 'proof_custom', 1,
  '$actor_id', pg_catalog.statement_timestamp());
insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  application_root_id, owner_kind, owner_id, permission_id, registration_kind,
  registration_owner_id, accepted_registration_revision, catalogue_fingerprint,
  continuity_revision, meaning_fingerprint
)
select entry.organization_id, '$custom_role_id', 1, 1, 'custom', null,
  entry.owner_kind, entry.owner_id, entry.permission_id, entry.registration_kind,
  entry.registration_owner_id, entry.registration_revision,
  registration.permission_catalogue_fingerprint, 1, entry.meaning_fingerprint
from vortex_access.permission_catalogue_entries as entry
join vortex_access.permission_registration_revisions as registration
  on registration.organization_id = entry.organization_id
  and registration.registration_kind = entry.registration_kind
  and registration.registration_owner_id = entry.registration_owner_id
  and registration.revision = entry.registration_revision
where entry.organization_id = '$organization_id' and entry.registration_kind = 'platform'
order by entry.permission_id limit 1;
insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, lifecycle, privilege_classification,
  assignment_policy, policy_continuity_revision, authority_continuity_revision,
  role_key, label, description, changed_by, changed_at, change_correlation_id
) values ('$organization_id', '$custom_role_id', 1, 'custom', 'active', 'privileged',
  'standing', 1, 1, 'proof_custom', 'Proof custom', 'Custom role for concurrency.',
  '$actor_id', pg_catalog.statement_timestamp(), '$correlation_initialize');
insert into vortex_definition.roots (
  root_id, organization_id, kind, key, created_at, created_by
) values ('$application_root_id', '$organization_id', 'application', '$application_key',
  pg_catalog.statement_timestamp(), '$actor_id');
insert into vortex_definition.releases (
  root_id, release_revision, release_version, authored_source,
  authored_source_fingerprint, source_contract_version, compilation_output,
  resolution_snapshot, content_fingerprint, resolution_fingerprint,
  validation_contract_version, comparison_fingerprint, impact_reasons,
  release_note, published_at, published_by
) values
  ('$application_root_id', 1, '1.0.0',
   pg_catalog.jsonb_build_object('source_contract_version','1.0.0','kind','application','key','$application_key','body',pg_catalog.jsonb_build_object()),
   'sha256:' || pg_catalog.repeat('1',64), '1.0.0',
   pg_catalog.jsonb_build_object('kind','application','canonical',pg_catalog.jsonb_build_object('content',pg_catalog.jsonb_build_object('permissions',pg_catalog.jsonb_build_array($permission_one)))),
   pg_catalog.jsonb_build_object('fingerprint','sha256:' || pg_catalog.repeat('2',64)),
   'sha256:' || pg_catalog.repeat('1',64), 'sha256:' || pg_catalog.repeat('2',64),
   '2.18.0', 'sha256:' || pg_catalog.repeat('3',64), '[]', 'Initial proof release',
   pg_catalog.statement_timestamp(), '$actor_id'),
  ('$application_root_id', 2, '2.0.0',
   pg_catalog.jsonb_build_object('source_contract_version','1.0.0','kind','application','key','$application_key','body',pg_catalog.jsonb_build_object()),
   'sha256:' || pg_catalog.repeat('3',64), '1.0.0',
   pg_catalog.jsonb_build_object('kind','application','canonical',pg_catalog.jsonb_build_object('content',pg_catalog.jsonb_build_object('permissions',pg_catalog.jsonb_build_array($permission_two)))),
   pg_catalog.jsonb_build_object('fingerprint','sha256:' || pg_catalog.repeat('4',64)),
   'sha256:' || pg_catalog.repeat('3',64), 'sha256:' || pg_catalog.repeat('4',64),
   '2.18.0', 'sha256:' || pg_catalog.repeat('5',64), '[]', 'Changed proof release',
   pg_catalog.statement_timestamp(), '$actor_id');
select * from vortex_access.coordinate_application_access_change(
  'register', null, $prepared_register_one, '$organization_id', '$application_root_id',
  '$actor_id', '$correlation_register'
);
select * from vortex_access.coordinate_organization_role_change(
  $app_evidence_one, '$actor_id', '$correlation_app_seed'
);
set constraints all immediate;
commit;
SQL
fixture_claimed=1

# R1: grant wins governance while blocked on the role. The reviewed empty
# manifest then refuses after the grant commits and cannot orphan its new policy.
before_r1="$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id='$organization_id';")"
PGAPPNAME="vortex-role-change-r1-holder-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r1-holder.log" 2>&1 <<SQL &
begin;
set lock_timeout = '30s';
set statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r1-holder.pid'
select 1 from vortex_access.organization_roles where organization_id='$organization_id' and role_id='$custom_role_id' for update;
\! touch '$proof_root/r1-holder-ready'
\! deadline=600; while [ ! -f '$proof_root/grant-first-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/grant-first-release' ]
commit;
SQL
r1_holder=$!; worker_pids+=("$r1_holder"); wait_for_file "$proof_root/r1-holder-ready"
r1_holder_db="$(read_backend_pid "$proof_root/r1-holder.pid")"

PGAPPNAME="vortex-role-change-r1-grant-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r1-grant.log" 2>&1 <<SQL &
\set VERBOSITY verbose
set lock_timeout = '30s';
set statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r1-grant.pid'
select outcome, operation, revision, access_version from vortex_access.coordinate_organization_role_assignment_change(
  'grant','$organization_id','$assignment_a_id',null,'$custom_role_id',1,
  'organization_account','$account_id',null,'standing',pg_catalog.clock_timestamp(),null,
  '$actor_id','$correlation_grant_a');
SQL
r1_grant=$!; worker_pids+=("$r1_grant")
r1_grant_db="$(read_backend_pid "$proof_root/r1-grant.pid")"
wait_for_database_blocker "$r1_grant_db" "$r1_holder_db"

PGAPPNAME="vortex-role-change-r1-role-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r1-role.log" 2>&1 <<SQL &
\set VERBOSITY verbose
set lock_timeout = '30s';
set statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r1-role.pid'
select * from vortex_access.coordinate_organization_role_change(
  pg_catalog.jsonb_build_object(
    'contractVersion','1.0.0',
    'candidate',pg_catalog.jsonb_build_object(
      'operation','revise_metadata_policy','organizationId','$organization_id',
      'roleId','$custom_role_id','expectedRoleRevision',1,'key','proof_custom',
      'label','Proof custom','description','Custom role for concurrency.',
      'privilegeClassification','privileged',
      'assignmentPolicy',pg_catalog.jsonb_build_object(
        'kind','activation_required','activationPolicy',pg_catalog.jsonb_build_object(
          'selection','new','policy',pg_catalog.jsonb_build_object(
            'activationPolicyId','$policy_id','revision',1,
            'maximumActivationDurationSeconds',3600,'reasonRequired',true,
            'recentAuthentication',pg_catalog.jsonb_build_object('kind','none'),
            'independentApprovalRequired',false)))),
    'newActivationPolicyFingerprint','sha256:' || pg_catalog.repeat('1',64),
    'roleCandidateFingerprint','sha256:' || pg_catalog.repeat('2',64),
    'affectedAssignmentManifest',pg_catalog.jsonb_build_object(
      'organizationId','$organization_id','roleId','$custom_role_id',
      'roleCandidateFingerprint','sha256:' || pg_catalog.repeat('2',64),
      'assignments',pg_catalog.jsonb_build_array(),
      'manifestFingerprint','sha256:' || pg_catalog.repeat('3',64))),
  '$actor_id','$correlation_mode_change');
SQL
r1_role=$!; worker_pids+=("$r1_role")
r1_role_db="$(read_backend_pid "$proof_root/r1-role.pid")"
wait_for_database_blocker "$r1_role_db" "$r1_grant_db"
touch "$proof_root/grant-first-release"
wait_owned_worker "$r1_holder"; wait_owned_worker "$r1_grant"
if wait_owned_worker "$r1_role"; then echo 'stale empty manifest unexpectedly committed' >&2; exit 1; fi
grep -q '40001' "$proof_root/r1-role.log" || { echo 'stale manifest lacked 40001' >&2; exit 1; }
[ "$(run_sql "select count(*) from vortex_access.organization_role_activation_policy_revisions where organization_id='$organization_id' and role_id='$custom_role_id';")" = 0 ] || {
  echo 'stale manifest left an orphan policy' >&2; exit 1;
}
r1_state="$(run_sql "select pg_catalog.concat_ws('|',version.current_version,role.live_revision,(select count(*) from vortex_access.organization_role_assignments where organization_id='$organization_id' and role_assignment_id='$assignment_a_id'),(select count(*) from vortex_access.organization_role_revisions where organization_id='$organization_id' and role_id='$custom_role_id')) from vortex_access.organization_access_versions version join vortex_access.organization_roles role on role.organization_id=version.organization_id and role.role_id='$custom_role_id' where version.organization_id='$organization_id';")"
[ "$r1_state" = "$((before_r1 + 1))|1|1|1" ] || { printf 'grant-first race left unexpected state: %q\n' "$r1_state" >&2; exit 1; }

# R2: metadata change owns governance first; a same-mode grant reviewed against
# the old role revision refuses, then succeeds only after a fresh review.
before_r2="$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id='$organization_id';")"
PGAPPNAME="vortex-role-change-r2-holder-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r2-holder.log" 2>&1 <<SQL &
begin;
set lock_timeout = '30s';
set statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r2-holder.pid'
select 1 from vortex_access.organization_roles where organization_id='$organization_id' and role_id='$custom_role_id' for update;
\! touch '$proof_root/r2-holder-ready'
\! deadline=600; while [ ! -f '$proof_root/role-first-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/role-first-release' ]
commit;
SQL
r2_holder=$!; worker_pids+=("$r2_holder"); wait_for_file "$proof_root/r2-holder-ready"
r2_holder_db="$(read_backend_pid "$proof_root/r2-holder.pid")"

PGAPPNAME="vortex-role-change-r2-role-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r2-role.log" 2>&1 <<SQL &
\set VERBOSITY verbose
set lock_timeout = '30s';
set statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r2-role.pid'
select outcome, operation, access_version from vortex_access.coordinate_organization_role_change(
  pg_catalog.jsonb_build_object('contractVersion','1.0.0','candidate',pg_catalog.jsonb_build_object(
    'operation','revise_metadata_policy','organizationId','$organization_id','roleId','$custom_role_id',
    'expectedRoleRevision',1,'key','proof_custom','label','Proof custom revised',
    'description','Custom role for concurrency.','privilegeClassification','privileged',
    'assignmentPolicy',pg_catalog.jsonb_build_object('kind','standing')),
    'roleCandidateFingerprint','sha256:' || pg_catalog.repeat('4',64)),
  '$actor_id','$correlation_metadata');
SQL
r2_role=$!; worker_pids+=("$r2_role")
r2_role_db="$(read_backend_pid "$proof_root/r2-role.pid")"
wait_for_database_blocker "$r2_role_db" "$r2_holder_db"

PGAPPNAME="vortex-role-change-r2-grant-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r2-grant.log" 2>&1 <<SQL &
\set VERBOSITY verbose
set lock_timeout = '30s';
set statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r2-grant.pid'
select * from vortex_access.coordinate_organization_role_assignment_change(
  'grant','$organization_id','$assignment_b_id',null,'$custom_role_id',1,
  'organization_account','$account_id',null,'standing',pg_catalog.clock_timestamp(),null,
  '$actor_id','$correlation_grant_b');
SQL
r2_grant=$!; worker_pids+=("$r2_grant")
r2_grant_db="$(read_backend_pid "$proof_root/r2-grant.pid")"
wait_for_database_blocker "$r2_grant_db" "$r2_role_db"
touch "$proof_root/role-first-release"
wait_owned_worker "$r2_holder"; wait_owned_worker "$r2_role"
if wait_owned_worker "$r2_grant"; then echo 'stale same-mode grant unexpectedly committed' >&2; exit 1; fi
grep -q '40001' "$proof_root/r2-grant.log" || { echo 'stale grant lacked 40001' >&2; exit 1; }
retry="$(run_sql "select pg_catalog.concat_ws('|',outcome,operation,revision) from vortex_access.coordinate_organization_role_assignment_change('grant','$organization_id','$assignment_b_id',null,'$custom_role_id',2,'organization_account','$account_id',null,'standing',pg_catalog.clock_timestamp(),null,'$actor_id','$correlation_grant_b_retry');")"
[ "$retry" = 'changed|grant|1' ] || { printf 'fresh grant retry failed: %q\n' "$retry" >&2; exit 1; }
r2_state="$(run_sql "select pg_catalog.concat_ws('|',version.current_version,role.live_revision,revision.label,revision.policy_continuity_revision,revision.authority_continuity_revision,(select count(*) from vortex_access.organization_role_permission_entries where organization_id='$organization_id' and role_id='$custom_role_id' and role_revision=2),(select count(*) from vortex_access.organization_role_assignments where organization_id='$organization_id' and role_id='$custom_role_id' and state='live')) from vortex_access.organization_access_versions version join vortex_access.organization_roles role on role.organization_id=version.organization_id and role.role_id='$custom_role_id' join vortex_access.organization_role_revisions revision on revision.organization_id=role.organization_id and revision.role_id=role.role_id and revision.revision=role.live_revision where version.organization_id='$organization_id';")"
[ "$r2_state" = "$((before_r2 + 2))|2|Proof custom revised|1|1|1|2" ] || { printf 'role-first race or fresh retry left unexpected state: %q\n' "$r2_state" >&2; exit 1; }

# R3: B2 meaning update wins governance and changes the role revision. The stale
# application acceptance waits behind it and then refuses without partial state.
before_r3="$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id='$organization_id';")"
PGAPPNAME="vortex-role-change-r3-holder-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r3-holder.log" 2>&1 <<SQL &
begin;
set lock_timeout = '30s';
set statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r3-holder.pid'
select 1 from vortex_access.organization_roles where organization_id='$organization_id' and role_id='$application_role_id' for update;
\! touch '$proof_root/r3-holder-ready'
\! deadline=600; while [ ! -f '$proof_root/update-first-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/update-first-release' ]
commit;
SQL
r3_holder=$!; worker_pids+=("$r3_holder"); wait_for_file "$proof_root/r3-holder-ready"
r3_holder_db="$(read_backend_pid "$proof_root/r3-holder.pid")"

PGAPPNAME="vortex-role-change-r3-update-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r3-update.log" 2>&1 <<SQL &
\set VERBOSITY verbose
set lock_timeout = '30s';
set statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r3-update.pid'
select outcome, operation, registration_revision, access_version from vortex_access.coordinate_application_access_change(
  'update',1,$prepared_register_two,'$organization_id','$application_root_id','$actor_id','$correlation_update');
SQL
r3_update=$!; worker_pids+=("$r3_update")
r3_update_db="$(read_backend_pid "$proof_root/r3-update.pid")"
wait_for_database_blocker "$r3_update_db" "$r3_holder_db"

PGAPPNAME="vortex-role-change-r3-accept-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r3-accept.log" 2>&1 <<SQL &
\set VERBOSITY verbose
set lock_timeout = '30s';
set statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r3-accept.pid'
select * from vortex_access.coordinate_organization_role_change(
  $stale_app_evidence, '$actor_id','$correlation_stale_accept');
SQL
r3_accept=$!; worker_pids+=("$r3_accept")
r3_accept_db="$(read_backend_pid "$proof_root/r3-accept.pid")"
wait_for_database_blocker "$r3_accept_db" "$r3_update_db"
touch "$proof_root/update-first-release"
wait_owned_worker "$r3_holder"; wait_owned_worker "$r3_update"
if wait_owned_worker "$r3_accept"; then echo 'stale application acceptance unexpectedly committed' >&2; exit 1; fi
grep -q '40001' "$proof_root/r3-accept.log" || { echo 'stale acceptance lacked 40001' >&2; exit 1; }
r3_state="$(run_sql "select pg_catalog.concat_ws('|',version.current_version,registration.revision,role.live_revision,revision.lifecycle,(select count(*) from vortex_access.organization_role_revisions where organization_id='$organization_id' and role_id='$application_role_id'),(select count(*) from vortex_access.organization_role_permission_entries where organization_id='$organization_id' and role_id='$application_role_id' and role_revision=2)) from vortex_access.organization_access_versions version join vortex_access.permission_registrations registration on registration.organization_id=version.organization_id and registration.registration_kind='application' and registration.registration_owner_id='$application_root_id' join vortex_access.organization_roles role on role.organization_id=version.organization_id and role.role_id='$application_role_id' join vortex_access.organization_role_revisions revision on revision.organization_id=role.organization_id and revision.role_id=role.role_id and revision.revision=role.live_revision where version.organization_id='$organization_id';")"
[ "$r3_state" = "$((before_r3 + 1))|2|2|acceptance_required|2|0" ] || { printf 'update-first race left unexpected state: %q\n' "$r3_state" >&2; exit 1; }

# R4: refreshed acceptance owns governance first and waits only on the role.
# Withdrawal queues behind it, so both commit in exact Access order.
app_evidence_two="pg_catalog.jsonb_build_object(
  'contractVersion','1.0.0','candidate',pg_catalog.jsonb_build_object(
    'operation','accept_application_role_revision','organizationId','$organization_id',
    'roleId','$application_role_id','expectedRoleRevision',2,'key','proof_reader',
    'label','Proof reader','description','Application role for the concurrency proof.',
    'privilegeClassification','standard','assignmentPolicy',pg_catalog.jsonb_build_object('kind','standing'),
    'preparedTemplates',$prepared_current_two,'sourceRoleId','$source_role_id',
    'templateContinuityRevision',1,'permissions',pg_catalog.jsonb_build_array($role_permission_two)),
  'acceptedGrantFingerprint','sha256:' || pg_catalog.repeat('5',64),
  'roleCandidateFingerprint','sha256:' || pg_catalog.repeat('6',64),
  'affectedAssignmentManifest',pg_catalog.jsonb_build_object(
    'organizationId','$organization_id','roleId','$application_role_id',
    'roleCandidateFingerprint','sha256:' || pg_catalog.repeat('6',64),
    'assignments',pg_catalog.jsonb_build_array(),
    'manifestFingerprint','sha256:' || pg_catalog.repeat('7',64)))"

PGAPPNAME="vortex-role-change-r4-holder-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r4-holder.log" 2>&1 <<SQL &
begin;
set lock_timeout = '30s';
set statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r4-holder.pid'
select 1 from vortex_access.organization_roles where organization_id='$organization_id' and role_id='$application_role_id' for update;
\! touch '$proof_root/r4-holder-ready'
\! deadline=600; while [ ! -f '$proof_root/accept-first-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/accept-first-release' ]
commit;
SQL
r4_holder=$!; worker_pids+=("$r4_holder"); wait_for_file "$proof_root/r4-holder-ready"
r4_holder_db="$(read_backend_pid "$proof_root/r4-holder.pid")"

PGAPPNAME="vortex-role-change-r4-accept-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r4-accept.log" 2>&1 <<SQL &
\set VERBOSITY verbose
set lock_timeout = '30s';
set statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r4-accept.pid'
select outcome, operation, access_version from vortex_access.coordinate_organization_role_change(
  $app_evidence_two,'$actor_id','$correlation_accept');
SQL
r4_accept=$!; worker_pids+=("$r4_accept")
r4_accept_db="$(read_backend_pid "$proof_root/r4-accept.pid")"
wait_for_database_blocker "$r4_accept_db" "$r4_holder_db"

PGAPPNAME="vortex-role-change-r4-withdraw-$fixture_name_token" "${psql_command[@]}" >"$proof_root/r4-withdraw.log" 2>&1 <<SQL &
\set VERBOSITY verbose
set lock_timeout = '30s';
set statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/r4-withdraw.pid'
select outcome, operation, registration_revision, access_version from vortex_access.coordinate_application_access_change(
  'withdraw',2,null,'$organization_id','$application_root_id','$actor_id','$correlation_withdraw');
SQL
r4_withdraw=$!; worker_pids+=("$r4_withdraw")
r4_withdraw_db="$(read_backend_pid "$proof_root/r4-withdraw.pid")"
wait_for_database_blocker "$r4_withdraw_db" "$r4_accept_db"
before_r4="$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id='$organization_id';")"
touch "$proof_root/accept-first-release"
wait_owned_worker "$r4_holder"; wait_owned_worker "$r4_accept"; wait_owned_worker "$r4_withdraw"
grep -q 'changed|accept_application_role_revision' "$proof_root/r4-accept.log" || { echo 'accept-first writer did not commit' >&2; exit 1; }
grep -q 'changed|withdraw|3' "$proof_root/r4-withdraw.log" || { echo 'withdraw-after writer did not commit' >&2; exit 1; }
after_r4="$(run_sql "select pg_catalog.concat_ws('|',version.current_version,role.live_revision,revision.lifecycle,(select count(*) from vortex_access.organization_role_revisions where organization_id='$organization_id' and role_id='$application_role_id'),(select count(*) from vortex_access.organization_role_permission_entries where organization_id='$organization_id' and role_id='$application_role_id' and role_revision=3)) from vortex_access.organization_access_versions version join vortex_access.organization_roles role on role.organization_id=version.organization_id and role.role_id='$application_role_id' join vortex_access.organization_role_revisions revision on revision.organization_id=role.organization_id and revision.role_id=role.role_id and revision.revision=role.live_revision where version.organization_id='$organization_id';")"
expected_r4="$((before_r4 + 2))|4|unavailable|4|1"
[ "$after_r4" = "$expected_r4" ] || { printf 'accept/withdraw ordering left unexpected state: %q expected %q\n' "$after_r4" "$expected_r4" >&2; exit 1; }

echo 'organization role-change concurrency proof passed'
