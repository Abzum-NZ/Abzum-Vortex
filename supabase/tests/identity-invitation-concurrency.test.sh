#!/usr/bin/env bash

set -euo pipefail

readonly proof_root="$(mktemp -d /tmp/vortex-identity-invitation.XXXXXX)"
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id='61000000-0000-4000-8000-000000000001'
readonly organization_id='62000000-0000-4000-8000-000000000001'
readonly inviter_identity_id='64000000-0000-4000-8000-000000000001'
readonly invited_identity_id='64000000-0000-4000-8000-000000000002'
readonly inviter_account_id='65000000-0000-4000-8000-000000000001'
readonly invitation_id='68000000-0000-4000-8000-000000000001'
readonly actor_id='69000000-0000-4000-8000-000000000001'
readonly correlation_id='67000000-0000-4000-8000-000000000001'
readonly token_fingerprint='sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'

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
    delete from vortex_identity.organization_invitations
      where organization_id = '$organization_id';
    delete from vortex_identity.organization_accounts
      where organization_id = '$organization_id';
    delete from vortex_identity.identity_projections
      where identity_id in ('$inviter_identity_id', '$invited_identity_id');
    delete from vortex_identity.organizations where organization_id = '$organization_id';
    delete from vortex_identity.tenants where tenant_id = '$tenant_id';
  " >/dev/null 2>&1 || true
  rm -rf "$proof_root"
}
trap cleanup EXIT

wait_for_file() {
  local candidate="$1"
  local attempt
  for attempt in $(seq 1 200); do
    [ -f "$candidate" ] && return 0
    sleep 0.05
  done
  echo 'invitation concurrency proof did not reach its transaction barrier' >&2
  return 1
}

read_backend_pid() {
  local candidate="$1"
  local backend_pid
  wait_for_file "$candidate"
  backend_pid="$(tr -d '[:space:]' <"$candidate")"
  [[ "$backend_pid" =~ ^[1-9][0-9]*$ ]] || {
    echo 'invitation concurrency proof captured an invalid backend identifier' >&2
    return 1
  }
  printf '%s\n' "$backend_pid"
}

run_sql "
  insert into vortex_identity.tenants (
    tenant_id, short_name, display_name, state, created_at, created_by,
    state_changed_at, revision
  ) values (
    '$tenant_id', 'invitation_concurrency', 'Invitation concurrency', 'active',
    clock_timestamp(), '$actor_id', clock_timestamp(), 1
  );
  insert into vortex_identity.organizations (
    organization_id, tenant_id, parent_organization_id, short_name, display_name,
    state, created_at, created_by, state_changed_at, revision
  ) values (
    '$organization_id', '$tenant_id', null, 'invitation_concurrency',
    'Invitation concurrency', 'active', clock_timestamp(), '$actor_id',
    clock_timestamp(), 1
  );
  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values (
    '$inviter_identity_id', 'active', clock_timestamp(), clock_timestamp(),
    '$inviter_identity_id', '$correlation_id', 1
  );
  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name, state,
    activated_at, changed_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values (
    '$inviter_account_id', '$organization_id', '$inviter_identity_id', 'Inviter', 'active',
    clock_timestamp(), clock_timestamp(), clock_timestamp(), '$inviter_identity_id',
    '$correlation_id', 1
  );
  insert into vortex_identity.organization_invitations (
    invitation_id, organization_id, invited_email, token_fingerprint,
    invited_by_organization_account_id, created_at, invited_at, expires_at,
    changed_at, revision
  ) values (
    '$invitation_id', '$organization_id', 'person@example.test', '$token_fingerprint',
    '$inviter_account_id', clock_timestamp(), clock_timestamp(),
    clock_timestamp() + interval '1 day', clock_timestamp(), 1
  );
" >/dev/null

PGAPPNAME='vortex-invitation-accept-a' "${psql_command[@]}" >"$proof_root/a.log" 2>&1 <<SQL &
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/a.pid'
set local role vortex_runtime;
select outcome from vortex_identity.accept_organization_invitation(
  '$token_fingerprint', '$invited_identity_id', 'person@example.test', 'Person', '$correlation_id'
)
\g '$proof_root/a.outcome'
\! touch '$proof_root/a-ready'
\! while [ ! -f '$proof_root/a-release' ]; do sleep 0.05; done
commit;
SQL
a_pid=$!
wait_for_file "$proof_root/a-ready"
a_backend_pid="$(read_backend_pid "$proof_root/a.pid")"

PGAPPNAME='vortex-invitation-accept-b' "${psql_command[@]}" >"$proof_root/b.log" 2>&1 <<SQL &
begin;
select pg_catalog.pg_backend_pid()
\g '$proof_root/b.pid'
set local lock_timeout = '30s';
set local role vortex_runtime;
select outcome from vortex_identity.accept_organization_invitation(
  '$token_fingerprint', '$invited_identity_id', 'person@example.test', 'Other', '$correlation_id'
)
\g '$proof_root/b.outcome'
commit;
SQL
b_pid=$!
b_backend_pid="$(read_backend_pid "$proof_root/b.pid")"

deadline=$((SECONDS + 20))
while ((SECONDS < deadline)); do
  if [ "$(run_sql "select case when $a_backend_pid = any(pg_catalog.pg_blocking_pids($b_backend_pid)) then 'blocked' else '' end;")" = 'blocked' ]; then
    break
  fi
  sleep 0.1
done
if ((SECONDS >= deadline)); then
  echo 'the second invitation acceptance did not wait on the first transaction' >&2
  exit 1
fi

touch "$proof_root/a-release"
wait "$a_pid"
wait "$b_pid"

[ "$(tr -d '[:space:]' <"$proof_root/a.outcome")" = 'accepted' ] || {
  echo 'the first invitation acceptance did not perform the state transition' >&2
  exit 1
}
[ "$(tr -d '[:space:]' <"$proof_root/b.outcome")" = 'already_accepted' ] || {
  echo 'the concurrent invitation acceptance was not an idempotent replay' >&2
  exit 1
}
[ "$(run_sql "select count(*) from vortex_identity.organization_accounts where organization_id = '$organization_id' and identity_id = '$invited_identity_id';")" = '1' ] || {
  echo 'concurrent acceptance created more than one organisation account' >&2
  exit 1
}
[ "$(run_sql "select revision from vortex_identity.organization_invitations where invitation_id = '$invitation_id';")" = '2' ] || {
  echo 'concurrent acceptance changed the invitation more than once' >&2
  exit 1
}

echo 'identity invitation concurrency proof passed'
