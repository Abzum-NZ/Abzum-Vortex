#!/usr/bin/env bash

set -euo pipefail

readonly repository="${VORTEX_TEST_SOURCE_REPOSITORY:-/source}"
readonly query="${repository}/workflows/kestra/database-state-snapshot.sql"
readonly database_url="${VORTEX_SNAPSHOT_DATABASE_URL:?VORTEX_SNAPSHOT_DATABASE_URL is required}"
readonly suffix="${RANDOM}${RANDOM}"
readonly schema="vortex_snapshot_${suffix}"
readonly owner_role="vortex_snapshot_owner_${suffix}"
readonly member_role="vortex_snapshot_member_${suffix}"

run_sql() {
  psql "$database_url" --no-psqlrc --set ON_ERROR_STOP=1 --quiet "$@"
}

cleanup() {
  run_sql --command "drop schema if exists ${schema} cascade;" >/dev/null 2>&1 || true
  run_sql --command "drop role if exists ${member_role}; drop role if exists ${owner_role};" >/dev/null 2>&1 || true
}
trap cleanup EXIT

snapshot() {
  run_sql --tuples-only --no-align --file "$query" | sha256sum | cut -d' ' -f1
}

run_sql <<SQL
create schema ${schema};
create table ${schema}.items(id bigint primary key, value text not null);
create function ${schema}.touch_item() returns trigger
language plpgsql security definer set search_path = pg_catalog, ${schema}
as \$\$ begin new.value := pg_catalog.upper(new.value); return new; end \$\$;
create trigger touch_item before insert or update on ${schema}.items
for each row execute function ${schema}.touch_item();
create view ${schema}.item_view with (security_invoker = false) as
select id, value from ${schema}.items;
create role ${owner_role} nologin;
create role ${member_role} nologin;
SQL

initial="$(snapshot)"
run_sql --command "alter table ${schema}.items disable trigger touch_item;"
trigger_changed="$(snapshot)"
[ "$initial" != "$trigger_changed" ] || {
  echo "trigger enabled state did not change the database-state fingerprint" >&2
  exit 1
}

run_sql --command "alter view ${schema}.item_view set (security_barrier = true);"
view_changed="$(snapshot)"
[ "$trigger_changed" != "$view_changed" ] || {
  echo "view security options did not change the database-state fingerprint" >&2
  exit 1
}

run_sql --command "grant ${owner_role} to ${member_role};"
membership_changed="$(snapshot)"
[ "$view_changed" != "$membership_changed" ] || {
  echo "role membership did not change the database-state fingerprint" >&2
  exit 1
}

run_sql --command "alter role ${member_role} set statement_timeout = '7s';"
setting_changed="$(snapshot)"
[ "$membership_changed" != "$setting_changed" ] || {
  echo "role setting did not change the database-state fingerprint" >&2
  exit 1
}

echo "database-state snapshot PostgreSQL proof passed"
