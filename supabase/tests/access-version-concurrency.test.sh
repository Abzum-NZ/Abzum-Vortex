#!/usr/bin/env bash

set -euo pipefail

readonly proof_root="$(mktemp -d /tmp/vortex-access-version.XXXXXX)"
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
readonly tenant_id='61000000-0000-4000-8000-000000000224'
readonly organization_id='62000000-0000-4000-8000-000000000224'
readonly actor_id='69000000-0000-4000-8000-000000000224'
readonly correlation_a='67000000-0000-4000-8000-000000000224'
readonly correlation_b='67000000-0000-4000-8000-000000000225'

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
    delete from vortex_access.organization_access_versions
      where organization_id = '$organization_id';
    delete from vortex_identity.organizations where organization_id = '$organization_id';
    delete from vortex_identity.tenants where tenant_id = '$tenant_id';
  " >/dev/null 2>&1 || true
  rm -rf "$proof_root"
}
trap cleanup EXIT

run_sql "
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
" >/dev/null

PGAPPNAME='vortex-access-increment-a' "${psql_command[@]}" >"$proof_root/a.log" 2>&1 <<SQL &
begin;
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

echo 'access-version concurrency proof passed'
