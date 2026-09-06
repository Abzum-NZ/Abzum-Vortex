#!/usr/bin/env bash

set -euo pipefail

run_uuid="${VORTEX_INVITATION_ACCESS_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then
  [ -r /proc/sys/kernel/random/uuid ] || {
    echo 'a Linux random UUID source is required for the invitation-access proof' >&2
    exit 1
  }
  IFS= read -r run_uuid </proc/sys/kernel/random/uuid
fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  echo 'VORTEX_INVITATION_ACCESS_PROOF_RUN_ID must be a lowercase UUID v4' >&2
  exit 1
}

readonly run_uuid
readonly run_token="${run_uuid//-/}"
readonly fixture_name_token="${run_token:0:20}"
readonly fixture_short_name="invite_${fixture_name_token}"
proof_root="$(mktemp -d /tmp/vortex-invitation-access.XXXXXX)"
readonly proof_root
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id="b1${run_uuid:2}"
readonly organization_id="b2${run_uuid:2}"
readonly inviter_identity_id="b3${run_uuid:2}"
readonly invited_a_identity_id="b4${run_uuid:2}"
readonly invited_b_identity_id="b5${run_uuid:2}"
readonly invited_c_identity_id="b6${run_uuid:2}"
readonly inviter_account_id="b7${run_uuid:2}"
readonly steward_role_id="b8${run_uuid:2}"
readonly steward_assignment_id="b9${run_uuid:2}"
readonly steward_delegation_id="ba${run_uuid:2}"
readonly group_id="bb${run_uuid:2}"
readonly membership_a_id="bc${run_uuid:2}"
readonly assignment_a_id="bd${run_uuid:2}"
readonly membership_c_id="be${run_uuid:2}"
readonly membership_b_id="c0${run_uuid:2}"
readonly actor_id="bf${run_uuid:2}"
readonly correlation_initialize="c1${run_uuid:2}"
readonly correlation_catalogue="c2${run_uuid:2}"
readonly correlation_adopt="c3${run_uuid:2}"
readonly correlation_create_a="c4${run_uuid:2}"
readonly correlation_accept_a="c5${run_uuid:2}"
readonly correlation_replay_a="c6${run_uuid:2}"
readonly correlation_create_b="c7${run_uuid:2}"
readonly correlation_legacy_b="c8${run_uuid:2}"
readonly correlation_create_c="c9${run_uuid:2}"
readonly correlation_accept_c="ca${run_uuid:2}"
readonly token_base="${run_token}${run_token}"
readonly token_a="sha256:${token_base:0:63}a"
readonly token_b="sha256:${token_base:0:63}b"
readonly token_c="sha256:${token_base:0:63}c"
readonly email_a="invite-a-${fixture_name_token}@example.test"
readonly email_b="invite-b-${fixture_name_token}@example.test"
readonly email_c="invite-c-${fixture_name_token}@example.test"

fixture_claimed=0
declare -a worker_pids=()
declare -A reaped_worker_pids=()

psql_command=(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1)
if [ -n "$database_url" ]; then psql_command+=("$database_url"); fi

run_sql() { "${psql_command[@]}" --command "$1"; }

wait_for_file() {
  local candidate="$1"
  local deadline=$((SECONDS + 25))
  while ((SECONDS < deadline)); do
    [ -f "$candidate" ] && return 0
    sleep 0.05
  done
  echo 'invitation-access proof did not reach its transaction barrier' >&2
  return 1
}

read_backend_pid() {
  local candidate="$1"
  local backend_pid
  wait_for_file "$candidate"
  backend_pid="$(tr -d '[:space:]' <"$candidate")"
  [[ "$backend_pid" =~ ^[1-9][0-9]*$ ]] || {
    printf 'invitation-access proof captured an invalid backend identifier: %q\n' "$backend_pid" >&2
    return 1
  }
  printf '%s\n' "$backend_pid"
}

wait_for_database_blocker() {
  local blocked_pid="$1"
  local blocking_pid="$2"
  local deadline=$((SECONDS + 25))
  local state
  while ((SECONDS < deadline)); do
    state="$(run_sql "select case when $blocking_pid = any(pg_catalog.pg_blocking_pids($blocked_pid)) then 'blocked' else '' end;")"
    [ "$state" = 'blocked' ] && return 0
    sleep 0.1
  done
  echo 'invitation-access proof did not observe the required lock ordering' >&2
  return 1
}

wait_for_database_time() {
  local target="$1"
  local deadline=$((SECONDS + 20))
  local reached
  while ((SECONDS < deadline)); do
    reached="$(run_sql "select case when pg_catalog.clock_timestamp() >= '$target'::timestamptz then 'yes' else '' end;")"
    [ "$reached" = 'yes' ] && return 0
    sleep 0.05
  done
  echo 'invitation-access proof did not reach the fixed invitation deadline' >&2
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
  echo 'invitation-access proof failed; bounded owned worker diagnostics follow' >&2
  for log_path in "$proof_root"/*.log; do
    [ -f "$log_path" ] || continue
    printf '%s\n' "--- ${log_path##*/} (last 100 lines) ---" >&2
    tail -n 100 -- "$log_path" >&2
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
        select 1 from vortex_identity.organization_accounts
        where organization_id = '$organization_id'
          and organization_account_id = '$inviter_account_id'
          and identity_id = '$inviter_identity_id'
      ) or not exists (
        select 1
        from vortex_access.organization_stewardship_requirements
        where organization_id = '$organization_id'
          and original_organization_account_id = '$inviter_account_id'
          and original_role_id = '$steward_role_id'
          and original_role_assignment_id = '$steward_assignment_id'
          and original_delegation_authority_id = '$steward_delegation_id'
          and adopted_by = '$actor_id'
          and adoption_correlation_id = '$correlation_adopt'
      ) or not exists (
        select 1
        from vortex_identity.organization_invitations as invitation
        join vortex_access.organization_invitation_access_intents as intent
          on intent.organization_id = invitation.organization_id
          and intent.invitation_id = invitation.invitation_id
        where invitation.organization_id = '$organization_id'
          and invitation.token_fingerprint = '$token_a'
          and intent.intended_by_organization_account_id = '$inviter_account_id'
      ) then
        raise exception 'Invitation-access proof fixture ownership marker mismatch';
      end if;
    end
    \$proof\$;
    delete from vortex_access.organization_invitation_access_intents
      where organization_id = '$organization_id';
    delete from vortex_access.organization_stewardship_requirements
      where organization_id = '$organization_id';
    delete from vortex_access.organization_group_memberships
      where organization_id = '$organization_id';
    delete from vortex_access.organization_role_activations
      where organization_id = '$organization_id';
    delete from vortex_access.organization_delegation_authorities
      where organization_id = '$organization_id';
    delete from vortex_access.organization_role_assignments
      where organization_id = '$organization_id';
    delete from vortex_access.organization_role_permission_entries
      where organization_id = '$organization_id';
    delete from vortex_access.organization_role_revisions
      where organization_id = '$organization_id';
    delete from vortex_access.organization_role_activation_policy_revisions
      where organization_id = '$organization_id';
    delete from vortex_access.organization_roles
      where organization_id = '$organization_id';
    delete from vortex_access.organization_groups
      where organization_id = '$organization_id';
    delete from vortex_access.application_role_template_continuities
      where organization_id = '$organization_id';
    delete from vortex_access.permission_continuities
      where organization_id = '$organization_id';
    delete from vortex_access.permission_catalogue_entries
      where organization_id = '$organization_id';
    delete from vortex_access.permission_registrations
      where organization_id = '$organization_id';
    delete from vortex_access.permission_registration_revisions
      where organization_id = '$organization_id';
    delete from vortex_access.organization_access_versions
      where organization_id = '$organization_id';
    delete from vortex_identity.organization_invitations
      where organization_id = '$organization_id';
    delete from vortex_identity.organization_accounts
      where organization_id = '$organization_id';
    delete from vortex_identity.identity_projections
      where identity_id in (
        '$inviter_identity_id', '$invited_a_identity_id',
        '$invited_b_identity_id', '$invited_c_identity_id'
      );
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
  touch "$proof_root/accept-a-release" "$proof_root/create-b-release" \
    "$proof_root/group-holder-release"
  stop_owned_workers
  if [ "$original_status" -ne 0 ]; then emit_owned_failure_diagnostics; fi
  cleanup_fixture
  operation_status=$?
  if [ "$operation_status" -ne 0 ]; then cleanup_status="$operation_status"; fi
  case "$proof_root" in
    /tmp/vortex-invitation-access.*) rm -rf -- "$proof_root"; operation_status=$? ;;
    *) echo "refusing to remove unexpected proof directory: $proof_root" >&2; operation_status=1 ;;
  esac
  if [ "$operation_status" -ne 0 ] && [ "$cleanup_status" -eq 0 ]; then
    cleanup_status="$operation_status"
  fi
  if [ "$original_status" -ne 0 ]; then exit "$original_status"; fi
  exit "$cleanup_status"
}
trap finalize EXIT INT TERM

run_sql "
  begin;
  insert into vortex_identity.tenants (
    tenant_id, short_name, display_name, state, created_at, created_by,
    state_changed_at, revision
  ) values (
    '$tenant_id', '$fixture_short_name', 'Invitation access proof', 'active',
    pg_catalog.clock_timestamp(), '$actor_id', pg_catalog.clock_timestamp(), 1
  );
  insert into vortex_identity.organizations (
    organization_id, tenant_id, parent_organization_id, short_name, display_name,
    state, created_at, created_by, state_changed_at, revision
  ) values (
    '$organization_id', '$tenant_id', null, '$fixture_short_name',
    'Invitation access proof', 'active', pg_catalog.clock_timestamp(), '$actor_id',
    pg_catalog.clock_timestamp(), 1
  );
  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values (
    '$inviter_identity_id', 'active', pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), '$actor_id', '$correlation_initialize', 1
  );
  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name, state,
    activated_at, changed_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values (
    '$inviter_account_id', '$organization_id', '$inviter_identity_id', 'Inviter',
    'active', pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(), '$actor_id', '$correlation_initialize', 1
  );
  select * from vortex_access.initialize_organization_access_version(
    '$organization_id', '$actor_id', '$correlation_initialize'
  );
  select * from vortex_access.initialize_platform_permission_catalogue(
    '$organization_id', '$actor_id', '$correlation_catalogue'
  );
  select * from vortex_access.coordinate_organization_stewardship_adoption(
    '$organization_id', '$inviter_account_id', '$steward_role_id',
    'organization_steward', 'Organisation steward',
    'Permanent minimum organisation administration.', '$steward_assignment_id',
    '$steward_delegation_id', '$actor_id', '$correlation_adopt'
  );
  insert into vortex_access.organization_groups (
    organization_id, group_id, group_key, label, state, revision,
    created_by, created_at, changed_by, changed_at, change_correlation_id
  ) values (
    '$organization_id', '$group_id', 'invitees', 'Invitees', 'active', 1,
    '$actor_id', pg_catalog.clock_timestamp(), '$actor_id',
    pg_catalog.clock_timestamp(), '$correlation_create_a'
  );
  select vortex_context.initialize(pg_catalog.jsonb_build_object(
    'callerKind', 'human',
    'identityAuthorityId', '$actor_id',
    'tenantId', '$tenant_id',
    'organizationId', '$organization_id',
    'sessionId', '$correlation_create_a',
    'issuedAt', pg_catalog.clock_timestamp() - interval '1 minute',
    'expiresAt', pg_catalog.clock_timestamp() + interval '10 minutes',
    'accessVersion', (
      select current_version from vortex_access.organization_access_versions
      where organization_id = '$organization_id'
    ),
    'correlationId', '$correlation_create_a',
    'identityId', '$inviter_identity_id',
    'organizationAccountId', '$inviter_account_id',
    'authenticationStrength', 'single_factor'
  ));
  select *
  from vortex_access.coordinate_organization_invitation_with_access_intent(
    '$email_a', '$token_a', pg_catalog.clock_timestamp() + interval '1 day',
    pg_catalog.jsonb_build_object(
      'membershipIntents', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'membershipId', '$membership_a_id', 'groupId', '$group_id',
          'startsAt', pg_catalog.clock_timestamp() - interval '1 minute',
          'expiresAt', pg_catalog.clock_timestamp() + interval '12 hours'
        )
      ),
      'roleAssignmentIntents', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'roleAssignmentId', '$assignment_a_id', 'roleId', '$steward_role_id',
          'expectedRoleRevision', 1, 'assignmentKind', 'standing',
          'startsAt', pg_catalog.clock_timestamp() - interval '1 minute',
          'expiresAt', pg_catalog.clock_timestamp() + interval '12 hours'
        )
      )
    )
  );
  commit;
" >/dev/null
fixture_claimed=1

access_before_a="$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id = '$organization_id';")"

PGAPPNAME='vortex-invitation-access-a-first' "${psql_command[@]}" >"$proof_root/accept-a-first.log" 2>&1 <<SQL &
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid()
\g '$proof_root/accept-a-first.pid'
select pg_catalog.concat_ws(
  '|', outcome, invitation_id, membership_ids[1], role_assignment_ids[1],
  access_version, correlation_id
)
from vortex_access.coordinate_organization_invitation_access_acceptance(
  '$token_a', '$invited_a_identity_id', '$email_a', 'Invitee A',
  '$correlation_accept_a'
)
\g '$proof_root/accept-a-first.outcome'
\! touch '$proof_root/accept-a-first-ready'
\! deadline=600; while [ ! -f '$proof_root/accept-a-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/accept-a-release' ]
commit;
SQL
accept_a_first_pid=$!
worker_pids+=("$accept_a_first_pid")
wait_for_file "$proof_root/accept-a-first-ready"
accept_a_first_backend="$(read_backend_pid "$proof_root/accept-a-first.pid")"

PGAPPNAME='vortex-invitation-access-a-second' "${psql_command[@]}" >"$proof_root/accept-a-second.log" 2>&1 <<SQL &
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid()
\g '$proof_root/accept-a-second.pid'
select pg_catalog.concat_ws(
  '|', outcome, invitation_id, membership_ids[1], role_assignment_ids[1],
  access_version, correlation_id
)
from vortex_access.coordinate_organization_invitation_access_acceptance(
  '$token_a', '$invited_a_identity_id', '$email_a', 'Changed name',
  '$correlation_replay_a'
)
\g '$proof_root/accept-a-second.outcome'
commit;
SQL
accept_a_second_pid=$!
worker_pids+=("$accept_a_second_pid")
accept_a_second_backend="$(read_backend_pid "$proof_root/accept-a-second.pid")"
wait_for_database_blocker "$accept_a_second_backend" "$accept_a_first_backend"
touch "$proof_root/accept-a-release"
wait_owned_worker "$accept_a_first_pid"
wait_owned_worker "$accept_a_second_pid"

invitation_a_id="$(run_sql "select invitation_id from vortex_identity.organization_invitations where organization_id = '$organization_id' and token_fingerprint = '$token_a';")"
expected_first="accepted|$invitation_a_id|$membership_a_id|$assignment_a_id|$((access_before_a + 1))|$correlation_accept_a"
expected_second="already_accepted|$invitation_a_id|$membership_a_id|$assignment_a_id|$((access_before_a + 1))|$correlation_replay_a"
[ "$(tr -d '[:space:]' <"$proof_root/accept-a-first.outcome")" = "$expected_first" ] || {
  echo 'first concurrent intent acceptance returned unexpected evidence' >&2
  exit 1
}
[ "$(tr -d '[:space:]' <"$proof_root/accept-a-second.outcome")" = "$expected_second" ] || {
  echo 'second concurrent intent acceptance was not an exact replay' >&2
  exit 1
}
[ "$(run_sql "select pg_catalog.concat_ws('|', count(*), min(state), max(revision)) from vortex_access.organization_group_memberships where organization_id = '$organization_id' and membership_id = '$membership_a_id';")" = '1|live|1' ] || {
  echo 'concurrent acceptance did not create exactly one membership fact' >&2
  exit 1
}
[ "$(run_sql "select pg_catalog.concat_ws('|', count(*), min(state), max(revision)) from vortex_access.organization_role_assignments where organization_id = '$organization_id' and role_assignment_id = '$assignment_a_id';")" = '1|live|1' ] || {
  echo 'concurrent acceptance did not create exactly one role-assignment fact' >&2
  exit 1
}
[ "$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id = '$organization_id';")" = "$((access_before_a + 1))" ] || {
  echo 'concurrent acceptance did not increment Access exactly once' >&2
  exit 1
}
[ "$(run_sql "select pg_catalog.concat_ws('|', change_reason, changed_by, change_correlation_id) from vortex_access.organization_access_versions where organization_id = '$organization_id';")" = "invitation_access_accepted|$inviter_account_id|$correlation_accept_a" ] || {
  echo 'concurrent acceptance did not record the exact composite Access evidence' >&2
  exit 1
}
[ "$(run_sql "select pg_catalog.concat_ws('|', invitation.revision, case when invitation.accepted_at is not null then 'accepted' else 'pending' end, case when exists (select 1 from vortex_identity.organization_accounts as account where account.organization_account_id = invitation.accepted_organization_account_id and account.organization_id = invitation.organization_id and account.identity_id = '$invited_a_identity_id') then 'matched' else 'mismatched' end) from vortex_identity.organization_invitations as invitation where invitation.organization_id = '$organization_id' and invitation.invitation_id = '$invitation_a_id';")" = '2|accepted|matched' ] || {
  echo 'concurrent acceptance did not perform exactly one linked invitation transition' >&2
  exit 1
}

access_before_b="$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id = '$organization_id';")"
PGAPPNAME='vortex-invitation-access-b-create' "${psql_command[@]}" >"$proof_root/create-b.log" 2>&1 <<SQL &
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select vortex_context.initialize(pg_catalog.jsonb_build_object(
  'callerKind', 'human',
  'identityAuthorityId', '$actor_id',
  'tenantId', '$tenant_id',
  'organizationId', '$organization_id',
  'sessionId', '$correlation_create_b',
  'issuedAt', pg_catalog.clock_timestamp() - interval '1 minute',
  'expiresAt', pg_catalog.clock_timestamp() + interval '10 minutes',
  'accessVersion', (
    select current_version from vortex_access.organization_access_versions
    where organization_id = '$organization_id'
  ),
  'correlationId', '$correlation_create_b',
  'identityId', '$inviter_identity_id',
  'organizationAccountId', '$inviter_account_id',
  'authenticationStrength', 'single_factor'
));
select invitation ->> 'invitationId'
from vortex_access.coordinate_organization_invitation_with_access_intent(
  '$email_b', '$token_b', pg_catalog.clock_timestamp() + interval '1 day',
  pg_catalog.jsonb_build_object(
    'membershipIntents', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'membershipId', '$membership_b_id', 'groupId', '$group_id',
        'startsAt', pg_catalog.clock_timestamp() - interval '1 minute'
      )
    ),
    'roleAssignmentIntents', '[]'::jsonb
  )
)
\g '$proof_root/create-b.invitation'
\! touch '$proof_root/create-b-ready'
\! deadline=600; while [ ! -f '$proof_root/create-b-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/create-b-release' ]
commit;
SQL
create_b_pid=$!
worker_pids+=("$create_b_pid")
wait_for_file "$proof_root/create-b-ready"

[ "$(run_sql "select count(*) from vortex_identity.organization_invitations where organization_id = '$organization_id' and token_fingerprint = '$token_b';")" = '0' ] || {
  echo 'an uncommitted intent invitation became externally visible' >&2
  exit 1
}
legacy_before_commit="$(run_sql "begin; set local role vortex_runtime; select outcome from vortex_access.accept_organization_invitation('$token_b', '$invited_b_identity_id', '$email_b', 'Invitee B', '$correlation_legacy_b'); commit;")"
[ "$legacy_before_commit" = 'unavailable' ] || {
  echo 'legacy acceptance observed an uncommitted intent invitation' >&2
  exit 1
}
touch "$proof_root/create-b-release"
wait_owned_worker "$create_b_pid"
[ "$(run_sql "select count(*) from vortex_identity.organization_invitations as invitation join vortex_access.organization_invitation_access_intents as intent on intent.organization_id = invitation.organization_id and intent.invitation_id = invitation.invitation_id where invitation.organization_id = '$organization_id' and invitation.token_fingerprint = '$token_b';")" = '1' ] || {
  echo 'the committed invitation and access intent were not atomically visible' >&2
  exit 1
}
legacy_after_commit="$(run_sql "begin; set local role vortex_runtime; select outcome from vortex_access.accept_organization_invitation('$token_b', '$invited_b_identity_id', '$email_b', 'Invitee B', '$correlation_legacy_b'); commit;")"
[ "$legacy_after_commit" = 'unavailable' ] || {
  echo 'legacy acceptance bypassed a committed pending access intent' >&2
  exit 1
}
[ "$(run_sql "select count(*) from vortex_identity.identity_projections where identity_id = '$invited_b_identity_id';")" = '0' ] || {
  echo 'legacy pending-intent refusal created an Identity projection' >&2
  exit 1
}
[ "$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id = '$organization_id';")" = "$access_before_b" ] || {
  echo 'intent creation or legacy refusal changed Access' >&2
  exit 1
}

PGAPPNAME='vortex-invitation-access-c-group-holder' "${psql_command[@]}" >"$proof_root/group-holder.log" 2>&1 <<SQL &
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid()
\g '$proof_root/group-holder.pid'
select 1
from vortex_access.organization_groups
where organization_id = '$organization_id'
  and group_id = '$group_id'
for update;
\! touch '$proof_root/group-holder-ready'
\! deadline=600; while [ ! -f '$proof_root/group-holder-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline - 1)); done; [ -f '$proof_root/group-holder-release' ]
rollback;
SQL
group_holder_pid=$!
worker_pids+=("$group_holder_pid")
wait_for_file "$proof_root/group-holder-ready"
group_holder_backend="$(read_backend_pid "$proof_root/group-holder.pid")"

deadline="$(run_sql "
  begin;
  do \$context\$
  begin
    perform vortex_context.initialize(pg_catalog.jsonb_build_object(
      'callerKind', 'human', 'identityAuthorityId', '$actor_id',
      'tenantId', '$tenant_id', 'organizationId', '$organization_id',
      'sessionId', '$correlation_create_c',
      'issuedAt', pg_catalog.clock_timestamp() - interval '1 minute',
      'expiresAt', pg_catalog.clock_timestamp() + interval '10 minutes',
      'accessVersion', (
        select current_version from vortex_access.organization_access_versions
        where organization_id = '$organization_id'
      ),
      'correlationId', '$correlation_create_c',
      'identityId', '$inviter_identity_id',
      'organizationAccountId', '$inviter_account_id',
      'authenticationStrength', 'single_factor'
    ));
  end
  \$context\$;
  with deadline as (
    select pg_catalog.clock_timestamp() + interval '15 seconds' as value
  ), created as (
    select *
    from deadline
    cross join lateral vortex_access.coordinate_organization_invitation_with_access_intent(
      '$email_c', '$token_c', deadline.value,
      pg_catalog.jsonb_build_object(
        'membershipIntents', pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'membershipId', '$membership_c_id', 'groupId', '$group_id',
            'startsAt', pg_catalog.clock_timestamp() - interval '1 minute',
            'expiresAt', deadline.value
          )
        ),
        'roleAssignmentIntents', '[]'::jsonb
      )
    )
  )
  select value from created;
  commit;
")"
access_before_c="$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id = '$organization_id';")"

PGAPPNAME='vortex-invitation-access-c-accept' "${psql_command[@]}" >"$proof_root/accept-c.log" 2>&1 <<SQL &
begin;
set local lock_timeout = '30s';
set local statement_timeout = '45s';
select pg_catalog.pg_backend_pid()
\g '$proof_root/accept-c.pid'
select outcome
from vortex_access.coordinate_organization_invitation_access_acceptance(
  '$token_c', '$invited_c_identity_id', '$email_c', 'Invitee C',
  '$correlation_accept_c'
)
\g '$proof_root/accept-c.outcome'
commit;
SQL
accept_c_pid=$!
worker_pids+=("$accept_c_pid")
accept_c_backend="$(read_backend_pid "$proof_root/accept-c.pid")"
wait_for_database_blocker "$accept_c_backend" "$group_holder_backend"
[ "$(run_sql "select case when pg_catalog.clock_timestamp() < '$deadline'::timestamptz then 'before' else 'late' end;")" = 'before' ] || {
  echo 'the invitation deadline passed before its downstream wait was observed' >&2
  exit 1
}
wait_for_database_time "$deadline"
touch "$proof_root/group-holder-release"
wait_owned_worker "$group_holder_pid"
wait_owned_worker "$accept_c_pid"

[ "$(tr -d '[:space:]' <"$proof_root/accept-c.outcome")" = 'unavailable' ] || {
  echo 'an invitation that expired during its observed source wait was accepted' >&2
  exit 1
}
[ "$(run_sql "select count(*) from vortex_identity.identity_projections where identity_id = '$invited_c_identity_id';")" = '0' ] || {
  echo 'expired waiting acceptance created an Identity projection' >&2
  exit 1
}
[ "$(run_sql "select count(*) from vortex_access.organization_group_memberships where organization_id = '$organization_id' and membership_id = '$membership_c_id';")" = '0' ] || {
  echo 'expired waiting acceptance created its intended membership' >&2
  exit 1
}
[ "$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id = '$organization_id';")" = "$access_before_c" ] || {
  echo 'expired waiting acceptance changed Access' >&2
  exit 1
}

echo 'organization invitation access concurrency proof passed'
