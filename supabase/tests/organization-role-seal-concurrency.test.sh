#!/usr/bin/env bash

set -euo pipefail

run_uuid="${VORTEX_ROLE_SEAL_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then
  [ -r /proc/sys/kernel/random/uuid ] || {
    echo 'a Linux random UUID source is required for the role-seal proof' >&2
    exit 1
  }
  IFS= read -r run_uuid </proc/sys/kernel/random/uuid
fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  echo 'VORTEX_ROLE_SEAL_PROOF_RUN_ID must be a lowercase UUID v4' >&2
  exit 1
}

readonly run_uuid
readonly run_token="${run_uuid//-/}"
readonly fixture_name_token="${run_token:0:24}"
readonly fixture_short_name="seal_${fixture_name_token}"
readonly application_key="proof.role_seal.run_${run_token}"
proof_root="$(mktemp -d /tmp/vortex-role-seal.XXXXXX)"
readonly proof_root
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id="81${run_uuid:2}"
readonly organization_id="82${run_uuid:2}"
readonly application_root_id="83${run_uuid:2}"
readonly permission_id="84${run_uuid:2}"
readonly entry_first_role_id="85${run_uuid:2}"
readonly seal_first_role_id="86${run_uuid:2}"
readonly entry_only_role_id="87${run_uuid:2}"
readonly actor_id="89${run_uuid:2}"
readonly correlation_initialize="8a${run_uuid:2}"
readonly correlation_register="8b${run_uuid:2}"
readonly correlation_seed="8c${run_uuid:2}"
readonly correlation_entry_first="8d${run_uuid:2}"
readonly correlation_seal_first="8e${run_uuid:2}"

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
  echo 'role-seal proof did not reach its transaction barrier' >&2
  return 1
}

read_backend_pid() {
  local candidate="$1"
  local backend_pid
  wait_for_file "$candidate"
  backend_pid="$(tr -d '[:space:]' <"$candidate")"
  [[ "$backend_pid" =~ ^[1-9][0-9]*$ ]] || {
    printf 'role-seal proof captured an invalid database backend identifier: %q\n' \
      "$backend_pid" >&2
    return 1
  }
  printf '%s\n' "$backend_pid"
}

wait_for_database_blocker() {
  local blocked_pid="$1"
  local blocking_pid="$2"
  local description="$3"
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
  echo "$description did not wait on the permanent role lock" >&2
  return 1
}

wait_owned_worker() {
  local pid="$1"
  local status
  if wait "$pid"; then status=0; else status=$?; fi
  reaped_worker_pids["$pid"]=1
  return "$status"
}

assert_failed_with_state() {
  local pid="$1"
  local log_file="$2"
  local state="$3"
  local description="$4"
  local message="${5:-}"
  if wait_owned_worker "$pid"; then
    echo "$description unexpectedly committed" >&2
    return 1
  fi
  grep -q "$state" "$log_file" || {
    echo "$description failed without SQLSTATE $state" >&2
    return 1
  }
  if [ -n "$message" ]; then
    grep -Fq "$message" "$log_file" || {
      echo "$description failed without its stable invariant message" >&2
      return 1
    }
  fi
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
        raise exception 'Role-seal proof fixture ownership marker mismatch';
      end if;
    end
    \$proof\$;
    delete from vortex_access.organization_role_permission_entries
      where organization_id = '$organization_id'
        and role_id in ('$entry_first_role_id', '$seal_first_role_id', '$entry_only_role_id');
    delete from vortex_access.organization_role_revisions
      where organization_id = '$organization_id'
        and role_id in ('$entry_first_role_id', '$seal_first_role_id', '$entry_only_role_id');
    delete from vortex_access.organization_roles
      where organization_id = '$organization_id'
        and role_id in ('$entry_first_role_id', '$seal_first_role_id', '$entry_only_role_id');
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
  touch "$proof_root/entry-first-a-release" "$proof_root/seal-first-a-release"
  stop_owned_workers
  cleanup_fixture
  operation_status=$?
  if [ "$operation_status" -ne 0 ]; then
    echo "role-seal proof fixture cleanup failed with status $operation_status" >&2
    cleanup_status="$operation_status"
  fi
  case "$proof_root" in
    /tmp/vortex-role-seal.*) rm -rf -- "$proof_root"; operation_status=$? ;;
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
      raise exception 'Role-seal proof fixture scope already exists';
    end if;
  end
  \$proof\$;
  insert into vortex_identity.tenants (
    tenant_id, short_name, display_name, state, created_at, created_by,
    state_changed_at, revision
  ) values (
    '$tenant_id', '$fixture_short_name', 'Role seal $fixture_name_token', 'active',
    pg_catalog.clock_timestamp(), '$actor_id', pg_catalog.clock_timestamp(), 1
  );
  insert into vortex_identity.organizations (
    organization_id, tenant_id, parent_organization_id, short_name, display_name,
    state, created_at, created_by, state_changed_at, revision
  ) values (
    '$organization_id', '$tenant_id', null, '$fixture_short_name',
    'Role seal $fixture_name_token', 'active', pg_catalog.clock_timestamp(), '$actor_id',
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
  ) values (
    '$application_root_id', 1, '1.0.0',
    pg_catalog.jsonb_build_object(
      'source_contract_version', '1.0.0', 'kind', 'application',
      'key', '$application_key', 'body', '{}'::jsonb
    ),
    'sha256:' || pg_catalog.repeat('1', 64), '1.0.0',
    pg_catalog.jsonb_build_object(
      'kind', 'application', 'canonical', pg_catalog.jsonb_build_object(
        'content', pg_catalog.jsonb_build_object(
          'permissions', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'permissionId', '$permission_id', 'key', 'proof.records.read',
            'label', 'View records', 'description', 'View proof records.',
            'actionKind', 'read', 'administrative', false
          ))
        )
      )
    ),
    pg_catalog.jsonb_build_object('fingerprint', 'sha256:' || pg_catalog.repeat('2', 64)),
    'sha256:' || pg_catalog.repeat('3', 64), 'sha256:' || pg_catalog.repeat('2', 64),
    '2.15.0', 'sha256:' || pg_catalog.repeat('4', 64), '[]',
    'Role-seal proof release', pg_catalog.clock_timestamp(), '$actor_id'
  );
  update vortex_definition.roots set current_release_revision = 1
    where root_id = '$application_root_id';
  select * from vortex_access.apply_application_permission_registration_v1_internal(
    'register', null,
    pg_catalog.jsonb_build_object(
      'contractVersion', '1.0.0', 'organizationId', '$organization_id',
      'applicationRootId', '$application_root_id',
      'applicationRelease', pg_catalog.jsonb_build_object(
        'kind', 'application', 'definitionKey', '$application_key',
        'rootId', '$application_root_id', 'releaseRevision', 1,
        'releaseVersion', '1.0.0', 'validationContractVersion', '2.15.0',
        'contentFingerprint', 'sha256:' || pg_catalog.repeat('3', 64),
        'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('2', 64)
      ),
      'applicationCatalogueFingerprint', 'sha256:' || pg_catalog.repeat('5', 64),
      'applicationPermissionIds', pg_catalog.jsonb_build_array('$permission_id'),
      'entries', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'applicationRootId', '$application_root_id', 'ownerKind', 'application',
        'ownerId', '$application_root_id',
        'permission', pg_catalog.jsonb_build_object(
          'permissionId', '$permission_id', 'key', 'proof.records.read',
          'label', 'View records', 'description', 'View proof records.',
          'actionKind', 'read', 'administrative', false
        ),
        'sourceRelease', pg_catalog.jsonb_build_object(
          'kind', 'application', 'definitionKey', '$application_key',
          'rootId', '$application_root_id', 'releaseRevision', 1,
          'releaseVersion', '1.0.0', 'validationContractVersion', '2.15.0',
          'contentFingerprint', 'sha256:' || pg_catalog.repeat('3', 64),
          'resolutionFingerprint', 'sha256:' || pg_catalog.repeat('2', 64)
        ),
        'meaningFingerprint', 'sha256:' || pg_catalog.repeat('6', 64)
      )),
      'candidateFingerprint', 'sha256:' || pg_catalog.repeat('7', 64)
    ),
    '$actor_id', '$correlation_register'
  );
  insert into vortex_access.organization_roles (
    organization_id, role_id, role_kind, role_key, application_root_id,
    source_role_id, live_revision, created_by, created_at
  ) values
    ('$organization_id', '$entry_first_role_id', 'application', 'entry_first',
     '$application_root_id', '$entry_first_role_id', 1, '$actor_id', pg_catalog.clock_timestamp()),
    ('$organization_id', '$seal_first_role_id', 'application', 'seal_first',
     '$application_root_id', '$seal_first_role_id', 1, '$actor_id', pg_catalog.clock_timestamp()),
    ('$organization_id', '$entry_only_role_id', 'application', 'entry_only',
     '$application_root_id', '$entry_only_role_id', 1, '$actor_id', pg_catalog.clock_timestamp());
  insert into vortex_access.organization_role_permission_entries (
    organization_id, role_id, role_revision, entry_ordinal, role_kind,
    role_application_root_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id,
    accepted_registration_revision, catalogue_fingerprint,
    continuity_revision, meaning_fingerprint
  )
  select '$organization_id', role_id, 1, 1, 'application', '$application_root_id',
    entry.application_root_id, entry.owner_kind, entry.owner_id, entry.permission_id,
    entry.registration_kind, entry.registration_owner_id, entry.registration_revision,
    registration.permission_catalogue_fingerprint, 1, entry.meaning_fingerprint
  from (values ('$entry_first_role_id'::uuid), ('$entry_only_role_id'::uuid)) as roles(role_id)
  cross join vortex_access.permission_catalogue_entries as entry
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
  )
  select '$organization_id', role.role_id, 1, 'application', '$application_root_id',
    case when role.role_id = '$seal_first_role_id' then 'unavailable' else 'active' end,
    'standard', 'standing', 1, 1, role.role_key,
    case when role.role_id = '$entry_first_role_id' then 'Entry first'
      when role.role_id = '$seal_first_role_id' then 'Seal first' else 'Entry only' end,
    'Role-seal concurrency proof.', '$application_key', 1, '1.0.0', '2.15.0',
    'sha256:' || pg_catalog.repeat('3', 64), 'sha256:' || pg_catalog.repeat('2', 64),
    'sha256:' || pg_catalog.repeat('8', 64), 'sha256:' || pg_catalog.repeat('5', 64),
    1, 1, 'sha256:' || pg_catalog.repeat('9', 64), '$actor_id',
    pg_catalog.clock_timestamp(), '$correlation_seed'
  from vortex_access.organization_roles as role
  where role.organization_id = '$organization_id';
  set constraints all immediate;
  commit;
" >/dev/null
fixture_claimed=1

permission_entry_sql="
  insert into vortex_access.organization_role_permission_entries (
    organization_id, role_id, role_revision, entry_ordinal, role_kind,
    role_application_root_id, application_root_id, owner_kind, owner_id,
    permission_id, registration_kind, registration_owner_id,
    accepted_registration_revision, catalogue_fingerprint,
    continuity_revision, meaning_fingerprint
  )
  select '$organization_id', 'ROLE_ID'::uuid, 2, 1, 'application', '$application_root_id',
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
"

role_revision_sql="
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
  )
  select organization_id, role_id, 2, role_kind, application_root_id, 'LIFECYCLE',
    privilege_classification, assignment_policy, policy_continuity_revision,
    authority_continuity_revision, role_key, label, description,
    source_definition_key, source_release_revision, source_release_version,
    source_validation_contract_version, source_content_fingerprint,
    source_resolution_fingerprint, source_template_fingerprint,
    source_catalogue_fingerprint, accepted_registration_revision,
    template_continuity_revision, accepted_grant_fingerprint,
    '$actor_id', pg_catalog.clock_timestamp(), 'CORRELATION_ID'::uuid
  from vortex_access.organization_role_revisions
  where organization_id = '$organization_id' and role_id = 'ROLE_ID'::uuid and revision = 1;
"

entry_first_entry="${permission_entry_sql//ROLE_ID/$entry_first_role_id}"
entry_first_revision="${role_revision_sql//ROLE_ID/$entry_first_role_id}"
entry_first_revision="${entry_first_revision//LIFECYCLE/active}"
entry_first_revision="${entry_first_revision//CORRELATION_ID/$correlation_entry_first}"

PGAPPNAME="vortex-role-seal-entry-first-a-$fixture_name_token" \
  "${psql_command[@]}" >"$proof_root/entry-first-a.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/entry-first-a.pid'
$entry_first_entry
\! touch '$proof_root/entry-first-a-ready'
\! deadline=600; while [ ! -f '$proof_root/entry-first-a-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/entry-first-a-release' ]
$entry_first_revision
update vortex_access.organization_roles set live_revision = 2
where organization_id = '$organization_id' and role_id = '$entry_first_role_id';
set constraints all immediate;
commit;
SQL
entry_first_a_pid=$!
worker_pids+=("$entry_first_a_pid")
wait_for_file "$proof_root/entry-first-a-ready"
entry_first_a_backend_pid="$(read_backend_pid "$proof_root/entry-first-a.pid")"

PGAPPNAME="vortex-role-seal-entry-first-b-$fixture_name_token" \
  "${psql_command[@]}" >"$proof_root/entry-first-b.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/entry-first-b.pid'
set local lock_timeout = '30s';
$entry_first_revision
commit;
SQL
entry_first_b_pid=$!
worker_pids+=("$entry_first_b_pid")
entry_first_b_backend_pid="$(read_backend_pid "$proof_root/entry-first-b.pid")"
wait_for_database_blocker "$entry_first_b_backend_pid" "$entry_first_a_backend_pid" \
  'the competing entry-first seal'
touch "$proof_root/entry-first-a-release"
wait_owned_worker "$entry_first_a_pid"
assert_failed_with_state "$entry_first_b_pid" "$proof_root/entry-first-b.log" '23505' \
  'the competing entry-first seal'
[ "$(run_sql "select count(*) from vortex_access.organization_role_revisions where organization_id = '$organization_id' and role_id = '$entry_first_role_id' and revision = 2;")" = '1' ] || {
  echo 'entry-first convergence did not leave exactly one sealed revision' >&2
  exit 1
}

seal_first_revision="${role_revision_sql//ROLE_ID/$seal_first_role_id}"
seal_first_revision="${seal_first_revision//LIFECYCLE/unavailable}"
seal_first_revision="${seal_first_revision//CORRELATION_ID/$correlation_seal_first}"
seal_first_entry="${permission_entry_sql//ROLE_ID/$seal_first_role_id}"

PGAPPNAME="vortex-role-seal-seal-first-a-$fixture_name_token" \
  "${psql_command[@]}" >"$proof_root/seal-first-a.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/seal-first-a.pid'
$seal_first_revision
update vortex_access.organization_roles set live_revision = 2
where organization_id = '$organization_id' and role_id = '$seal_first_role_id';
set constraints all immediate;
\! touch '$proof_root/seal-first-a-ready'
\! deadline=600; while [ ! -f '$proof_root/seal-first-a-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/seal-first-a-release' ]
commit;
SQL
seal_first_a_pid=$!
worker_pids+=("$seal_first_a_pid")
wait_for_file "$proof_root/seal-first-a-ready"
seal_first_a_backend_pid="$(read_backend_pid "$proof_root/seal-first-a.pid")"

PGAPPNAME="vortex-role-seal-seal-first-b-$fixture_name_token" \
  "${psql_command[@]}" >"$proof_root/seal-first-b.log" 2>&1 <<SQL &
\set VERBOSITY verbose
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/seal-first-b.pid'
set local lock_timeout = '30s';
$seal_first_entry
commit;
SQL
seal_first_b_pid=$!
worker_pids+=("$seal_first_b_pid")
seal_first_b_backend_pid="$(read_backend_pid "$proof_root/seal-first-b.pid")"
wait_for_database_blocker "$seal_first_b_backend_pid" "$seal_first_a_backend_pid" \
  'the append racing a completed seal'
touch "$proof_root/seal-first-a-release"
wait_owned_worker "$seal_first_a_pid"
assert_failed_with_state "$seal_first_b_pid" "$proof_root/seal-first-b.log" '23514' \
  'the append racing a completed seal' 'Organization role permission set is already sealed'
[ "$(run_sql "select count(*) from vortex_access.organization_role_permission_entries where organization_id = '$organization_id' and role_id = '$seal_first_role_id' and role_revision = 2;")" = '0' ] || {
  echo 'seal-first convergence retained a late permission append' >&2
  exit 1
}

entry_only_entry="${permission_entry_sql//ROLE_ID/$entry_only_role_id}"
set +e
PGAPPNAME="vortex-role-seal-entry-only-$fixture_name_token" \
  "${psql_command[@]}" >"$proof_root/entry-only.log" 2>&1 <<SQL
\set VERBOSITY verbose
begin;
$entry_only_entry
commit;
SQL
entry_only_status=$?
set -e
[ "$entry_only_status" -ne 0 ] || {
  echo 'an entry-only transaction unexpectedly committed without its final revision' >&2
  exit 1
}
grep -q '23503' "$proof_root/entry-only.log" || {
  echo 'the entry-only transaction failed without its deferred foreign-key state' >&2
  exit 1
}
[ "$(run_sql "select count(*) from vortex_access.organization_role_permission_entries where organization_id = '$organization_id' and role_id = '$entry_only_role_id' and role_revision = 2;")" = '0' ] || {
  echo 'the refused entry-only transaction left partial permission evidence' >&2
  exit 1
}

echo 'organization role seal concurrency proof passed'
