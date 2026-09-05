#!/usr/bin/env bash

set -euo pipefail

readonly proof_root="$(mktemp -d /tmp/vortex-access-version.XXXXXX)"
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id='61000000-0000-4000-8000-000000000224'
readonly organization_id='62000000-0000-4000-8000-000000000224'
readonly actor_id='69000000-0000-4000-8000-000000000224'
readonly correlation_a='67000000-0000-4000-8000-000000000224'
readonly correlation_b='67000000-0000-4000-8000-000000000225'
readonly correlation_future_holder='67000000-0000-4000-8000-000000000226'
readonly correlation_future_waiter='67000000-0000-4000-8000-000000000227'

fixture_claimed=0

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
  echo 'access-version proof did not reach its transaction barrier' >&2
  return 1
}

read_backend_pid() {
  local candidate="$1"
  local backend_pid
  wait_for_file "$candidate"
  backend_pid="$(tr -d '[:space:]' <"$candidate")"
  [[ "$backend_pid" =~ ^[1-9][0-9]*$ ]] || {
    printf 'access-version proof captured an invalid backend identifier: %q\n' "$backend_pid" >&2
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
  echo 'access-version proof did not observe the required row lock' >&2
  return 1
}

cleanup() {
  local pid
  local -a owned_pids=()
  touch "$proof_root/future-release"
  mapfile -t owned_pids < <(jobs -pr)
  for pid in "${owned_pids[@]}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
  for pid in "${owned_pids[@]}"; do
    wait "$pid" >/dev/null 2>&1 || true
  done
  if [ "$fixture_claimed" = 1 ]; then
    run_sql "
      begin;
      do \$proof\$
      begin
        if not exists (
          select 1 from vortex_identity.tenants
          where tenant_id = '$tenant_id'
            and short_name = 'access_concurrency'
            and created_by = '$actor_id'
        ) or not exists (
          select 1 from vortex_identity.organizations
          where organization_id = '$organization_id'
            and tenant_id = '$tenant_id'
            and short_name = 'access_concurrency'
            and created_by = '$actor_id'
        ) then
          raise exception 'Access-version proof fixture ownership marker mismatch';
        end if;
      end
      \$proof\$;
      delete from vortex_access.organization_access_versions
        where organization_id = '$organization_id';
      delete from vortex_identity.organizations where organization_id = '$organization_id';
      delete from vortex_identity.tenants where tenant_id = '$tenant_id';
      commit;
    " >/dev/null 2>&1 || true
  fi
  case "$proof_root" in
    /tmp/vortex-access-version.*) rm -rf -- "$proof_root" ;;
    *) echo "refusing to remove unexpected proof directory: $proof_root" >&2 ;;
  esac
}
trap cleanup EXIT

run_sql "
  begin;
  insert into vortex_identity.tenants (
    tenant_id, short_name, display_name, state, created_at, created_by,
    state_changed_at, revision
  ) values (
    '$tenant_id', 'access_concurrency', 'Access concurrency', 'active',
    clock_timestamp(), '$actor_id', clock_timestamp(), 1
  );
  insert into vortex_identity.organizations (
    organization_id, tenant_id, parent_organization_id, short_name, display_name,
    state, created_at, created_by, state_changed_at, revision
  ) values (
    '$organization_id', '$tenant_id', null, 'access_concurrency',
    'Access concurrency', 'active', clock_timestamp(), '$actor_id',
    clock_timestamp(), 1
  );
  select * from vortex_access.initialize_organization_access_version(
    '$organization_id', '$actor_id', '$correlation_a'
  );
  commit;
" >/dev/null
fixture_claimed=1

PGAPPNAME='vortex-access-increment-a' "${psql_command[@]}" >"$proof_root/a.log" 2>&1 <<SQL &
begin;
set lock_timeout = '30s';
set statement_timeout = '45s';
select current_version from vortex_access.increment_organization_access_version(
  '$organization_id', '$actor_id', '$correlation_a', 'role_assignment_changed'
)
\g '$proof_root/a.version'
select pg_catalog.pg_sleep(1);
commit;
SQL
a_pid=$!

for _ in $(seq 1 200); do
  [ -f "$proof_root/a.version" ] && break
  sleep 0.05
done
[ -f "$proof_root/a.version" ] || {
  echo 'first access-version increment did not reach its transaction barrier' >&2
  exit 1
}

PGAPPNAME='vortex-access-increment-b' "${psql_command[@]}" >"$proof_root/b.log" 2>&1 <<SQL &
begin;
set lock_timeout = '30s';
set statement_timeout = '45s';
select current_version from vortex_access.increment_organization_access_version(
  '$organization_id', '$actor_id', '$correlation_b', 'team_membership_changed'
)
\g '$proof_root/b.version'
commit;
SQL
b_pid=$!

wait "$a_pid"
wait "$b_pid"

[ "$(tr -d '[:space:]' <"$proof_root/a.version")" = '2' ] || {
  echo 'first concurrent increment did not return version two' >&2
  exit 1
}
[ "$(tr -d '[:space:]' <"$proof_root/b.version")" = '3' ] || {
  echo 'second concurrent increment did not retain the first update' >&2
  exit 1
}
[ "$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id = '$organization_id';")" = '3' ] || {
  echo 'concurrent increments lost an update' >&2
  exit 1
}

# Model a committed future observation followed by a queued statement. The
# holder's complete increment is accepted by the existing protector. The real
# helper must serialize to version five without moving changed_at backwards.
PGAPPNAME='vortex-access-future-holder' "${psql_command[@]}" >"$proof_root/future-holder.log" 2>&1 <<SQL &
begin;
set lock_timeout = '30s';
set statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/future-holder.pid'
update vortex_access.organization_access_versions
set current_version = current_version + 1,
  changed_at = pg_catalog.clock_timestamp() + interval '10 minutes',
  changed_by = '$actor_id',
  change_correlation_id = '$correlation_future_holder',
  change_reason = 'role_assignment_changed'
where organization_id = '$organization_id'
returning extract(epoch from changed_at) \g '$proof_root/future-holder.timestamp'
\! touch '$proof_root/future-holder-ready'
\! deadline=600; while [ ! -f '$proof_root/future-release' ] && [ \$deadline -gt 0 ]; do sleep 0.05; deadline=\$((deadline-1)); done; [ -f '$proof_root/future-release' ]
commit;
SQL
future_holder_pid=$!
wait_for_file "$proof_root/future-holder-ready"
future_holder_backend="$(read_backend_pid "$proof_root/future-holder.pid")"

PGAPPNAME='vortex-access-future-waiter' "${psql_command[@]}" >"$proof_root/future-waiter.log" 2>&1 <<SQL &
set lock_timeout = '30s';
set statement_timeout = '45s';
select pg_catalog.pg_backend_pid() \g '$proof_root/future-waiter.pid'
select current_version from vortex_access.increment_organization_access_version(
  '$organization_id', '$actor_id', '$correlation_future_waiter', 'team_membership_changed'
)
\g '$proof_root/future-waiter.version'
SQL
future_waiter_pid=$!
future_waiter_backend="$(read_backend_pid "$proof_root/future-waiter.pid")"
wait_for_database_blocker "$future_waiter_backend" "$future_holder_backend"
touch "$proof_root/future-release"
if ! wait "$future_holder_pid"; then
  echo 'future observation holder failed' >&2
  tail -n 80 -- "$proof_root/future-holder.log" >&2
  exit 1
fi
if ! wait "$future_waiter_pid"; then
  echo 'queued access-version increment failed' >&2
  tail -n 80 -- "$proof_root/future-waiter.log" >&2
  exit 1
fi

[ "$(tr -d '[:space:]' <"$proof_root/future-waiter.version")" = '5' ] || {
  echo 'queued access-version increment did not return version five' >&2
  exit 1
}
future_timestamp="$(tr -d '[:space:]' <"$proof_root/future-holder.timestamp")"
future_state="$(run_sql "select pg_catalog.concat_ws('|', current_version, extract(epoch from changed_at), changed_by, change_correlation_id, change_reason) from vortex_access.organization_access_versions where organization_id = '$organization_id';")"
[ "$future_state" = "5|$future_timestamp|$actor_id|$correlation_future_waiter|team_membership_changed" ] || {
  printf 'queued access-version increment regressed observation state: %q\n' "$future_state" >&2
  exit 1
}

echo 'access-version concurrency proof passed'
