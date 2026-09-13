#!/usr/bin/env bash
set -euo pipefail

run_uuid="${VORTEX_TENANT_CREATION_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then IFS= read -r run_uuid </proc/sys/kernel/random/uuid; fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  echo 'tenant creation proof requires a lowercase UUID v4' >&2
  exit 1
}

readonly run_uuid run_token="${run_uuid//-/}"
readonly cluster_id="c4${run_uuid:2}" operator_id="94${run_uuid:2}"
readonly actor_id="44${run_uuid:2}" root_steward_id="45${run_uuid:2}"
readonly nominee_id="46${run_uuid:2}" secondary_actor_id="47${run_uuid:2}"
readonly expiring_actor_id="48${run_uuid:2}"
readonly secondary_assignment_id="34${run_uuid:2}" expiring_assignment_id="35${run_uuid:2}"
readonly changed_actor_id="49${run_uuid:2}" changed_assignment_id="36${run_uuid:2}"
readonly request_actor_assignment_id="37${run_uuid:2}"
readonly correlation_id="a4${run_uuid:2}"
readonly duplicate_same="b4${run_uuid:2}" duplicate_short_one="b5${run_uuid:2}"
readonly duplicate_short_two="b6${run_uuid:2}" duplicate_parent_child="b7${run_uuid:2}"
readonly duplicate_parent_archive="b8${run_uuid:2}" duplicate_revoke="b9${run_uuid:2}"
readonly duplicate_revoked_create="ba${run_uuid:2}" duplicate_expiring="bb${run_uuid:2}"
readonly duplicate_request_create="bc${run_uuid:2}"
readonly duplicate_change="bd${run_uuid:2}" duplicate_changed_create="be${run_uuid:2}"

proof_root="$(mktemp -d /tmp/vortex-tenant-creation.XXXXXX)"
readonly proof_root
database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
psql_command=(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1)
if [ -n "$database_url" ]; then psql_command+=("$database_url"); fi
run_sql() { "${psql_command[@]}" --command "$1"; }
fixture_created=0
declare -a workers=()

wait_file() {
  local deadline=$((SECONDS+25))
  while ((SECONDS<deadline)); do [ -f "$1" ] && return 0; sleep 0.05; done
  echo "tenant creation proof missed barrier ${1##*/}" >&2
  return 1
}
read_pid() { wait_file "$1"; tr -d '[:space:]' <"$1"; }
wait_blocked() {
  local blocked="$1" blocker="$2" description="$3" state='' deadline=$((SECONDS+25))
  while ((SECONDS<deadline)); do
    state="$(run_sql "select case when $blocker=any(pg_catalog.pg_blocking_pids($blocked)) then 'yes' else '' end;")"
    [ "$state" = yes ] && return 0
    sleep 0.1
  done
  echo "tenant creation proof did not observe $description" >&2
  return 1
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  touch "$proof_root/release-same" "$proof_root/release-short" \
    "$proof_root/release-parent" "$proof_root/release-revoke" \
    "$proof_root/release-expiry" "$proof_root/release-request" \
    "$proof_root/release-change" "$proof_root/continue-request"
  for worker in "${workers[@]}"; do wait "$worker" >/dev/null 2>&1 || true; done
  if [ "$fixture_created" = 1 ]; then
    run_sql "
      begin;
      set local session_replication_role=replica;
      delete from vortex_context.request_contexts
        where context ->> 'tenantId' = '$tenant_id';
      delete from vortex_identity.accepted_administration_receipts
        where tenant_id='$tenant_id' or cluster_id='$cluster_id';
      delete from vortex_access.organization_stewardship_requirements
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_access.organization_delegation_authorities
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_access.organization_role_activations
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_access.organization_role_assignments
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_access.organization_role_permission_entries
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_access.organization_role_revisions
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_access.organization_role_activation_policy_revisions
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_access.organization_roles
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_access.application_role_template_continuities
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_access.permission_continuities
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_access.permission_catalogue_entries
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_access.permission_registrations
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_access.permission_registration_revisions
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_identity.organization_runtime_settings
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_access.organization_access_versions
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_identity.organization_accounts
        where organization_id in (select organization_id from vortex_identity.organizations where tenant_id='$tenant_id');
      delete from vortex_identity.tenant_administrator_assignments where tenant_id='$tenant_id';
      delete from vortex_identity.organizations where tenant_id='$tenant_id';
      delete from vortex_identity.tenants where tenant_id='$tenant_id';
      delete from vortex_identity.identity_projections where identity_id in (
        '$actor_id','$root_steward_id','$nominee_id','$secondary_actor_id','$expiring_actor_id','$changed_actor_id'
      );
      commit;" >/dev/null
  fi
  case "$proof_root" in /tmp/vortex-tenant-creation.*) rm -rf -- "$proof_root" ;; esac
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

provisioned="$(run_sql "
  select tenant_id::text||'|'||root_organization_id::text||'|'||organization_account_id::text
  from vortex_identity.provision_tenant(
    '$cluster_id','$operator_id','d4${run_uuid:2}',
    'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    'tc_${run_token:0:24}','Tenant creation race','tc_root_${run_token:0:19}','Creation root',
    '$actor_id','$root_steward_id','Root steward','en-NZ','Pacific/Auckland',
    'en-NZ','Pacific/Auckland','NZD','medium','auto');")"
IFS='|' read -r tenant_id root_id root_steward_account_id <<<"$provisioned"
readonly tenant_id root_id root_steward_account_id
[[ "$tenant_id|$root_id|$root_steward_account_id" =~ ^[0-9a-f-]+\|[0-9a-f-]+\|[0-9a-f-]+$ ]] || {
  echo 'tenant creation proof could not provision its fixture' >&2
  exit 1
}
fixture_created=1

run_sql "
  insert into vortex_identity.identity_projections(identity_id,state,created_at,state_changed_at,state_changed_by,state_change_correlation_id,revision) values
    ('$nominee_id','active',now()-interval '1 hour',now()-interval '1 hour','$operator_id','$correlation_id',1),
    ('$secondary_actor_id','active',now()-interval '1 hour',now()-interval '1 hour','$operator_id','$correlation_id',1),
    ('$expiring_actor_id','active',now()-interval '1 hour',now()-interval '1 hour','$operator_id','$correlation_id',1),
    ('$changed_actor_id','active',now()-interval '1 hour',now()-interval '1 hour','$operator_id','$correlation_id',1);
  insert into vortex_identity.tenant_administrator_assignments(
    assignment_id,tenant_id,identity_id,capability_keys,starts_at,expires_at,revision,
    granted_at,granted_by_actor_id,grant_correlation_id,changed_at,changed_by_actor_id,change_correlation_id
  ) values
    ('$secondary_assignment_id','$tenant_id','$secondary_actor_id',array['platform.tenant.organizations.create'],now()-interval '1 hour',null,1,now()-interval '1 hour','$operator_id','$correlation_id',now()-interval '1 hour','$operator_id','$correlation_id'),
    ('$changed_assignment_id','$tenant_id','$changed_actor_id',array['platform.tenant.organizations.create'],now()-interval '1 hour',null,1,now()-interval '1 hour','$operator_id','$correlation_id',now()-interval '1 hour','$operator_id','$correlation_id'),
    ('$request_actor_assignment_id','$tenant_id','$root_steward_id',array['platform.tenant.organizations.create'],now()-interval '1 hour',null,1,now()-interval '1 hour','$operator_id','$correlation_id',now()-interval '1 hour','$operator_id','$correlation_id');" >/dev/null

create_call() {
  local actor="$1" duplicate="$2" fingerprint="$3" parent="$4" short_name="$5"
  local nominee="${6:-$nominee_id}"
  printf "select outcome||'|'||organization_id::text||'|'||organization_account_id::text from vortex_identity.create_tenant_organization('%s','%s','sha256:%s','%s',%s,'%s','Created organisation','%s','Explicit steward','en-NZ','Pacific/Auckland','en-NZ','Pacific/Auckland','NZD','medium','auto')" \
    "$actor" "$duplicate" "$fingerprint" "$tenant_id" "$parent" "$short_name" "$nominee"
}

# Same duplicate key: exactly one complete creation and one replay.
same_call="$(create_call "$actor_id" "$duplicate_same" "$(printf '2%.0s' {1..64})" null "same_${run_token:0:20}")"
"${psql_command[@]}" >"$proof_root/same-one.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/same-one.pid'
$same_call \g '$proof_root/same-one.result'
\! touch '$proof_root/same-one.ready'
\! while [ ! -f '$proof_root/release-same' ]; do sleep 0.05; done
commit;
SQL
w=$!; workers+=("$w"); wait_file "$proof_root/same-one.ready"; same_one_pid="$(read_pid "$proof_root/same-one.pid")"
"${psql_command[@]}" >"$proof_root/same-two.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/same-two.pid'
$same_call \g '$proof_root/same-two.result'
commit;
SQL
w=$!; workers+=("$w"); same_two_pid="$(read_pid "$proof_root/same-two.pid")"
wait_blocked "$same_two_pid" "$same_one_pid" 'same duplicate queued on tenant serialization'
touch "$proof_root/release-same"; wait "${workers[0]}"; wait "${workers[1]}"
same_one="$(tr -d '[:space:]' <"$proof_root/same-one.result")"
same_two="$(tr -d '[:space:]' <"$proof_root/same-two.result")"
[[ "$same_one" =~ ^accepted\|([0-9a-f-]+)\|([0-9a-f-]+)$ ]] || { echo 'first same-key creation failed' >&2; exit 1; }
[[ "$same_two" = "replayed|${BASH_REMATCH[1]}|${BASH_REMATCH[2]}" ]] || { echo 'same-key retry did not replay original identifiers' >&2; exit 1; }

# Same permanent short name: one commit, one safe refusal and no orphan facts.
short_name="short_${run_token:0:19}"
short_call_one="$(create_call "$actor_id" "$duplicate_short_one" "$(printf '3%.0s' {1..64})" null "$short_name")"
short_call_two="$(create_call "$actor_id" "$duplicate_short_two" "$(printf '4%.0s' {1..64})" null "$short_name")"
"${psql_command[@]}" >"$proof_root/short-one.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/short-one.pid'
$short_call_one \g '$proof_root/short-one.result'
\! touch '$proof_root/short-one.ready'
\! while [ ! -f '$proof_root/release-short' ]; do sleep 0.05; done
commit;
SQL
w=$!; workers+=("$w"); wait_file "$proof_root/short-one.ready"; short_one_pid="$(read_pid "$proof_root/short-one.pid")"
"${psql_command[@]}" >"$proof_root/short-two.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/short-two.pid'
\set ON_ERROR_STOP off
$short_call_two;
\echo :SQLSTATE
rollback;
SQL
w=$!; workers+=("$w"); short_two_pid="$(read_pid "$proof_root/short-two.pid")"
wait_blocked "$short_two_pid" "$short_one_pid" 'same short name queued on tenant serialization'
touch "$proof_root/release-short"; wait "${workers[2]}"; wait "${workers[3]}"
grep -qx 'V3101' "$proof_root/short-two.log" || { echo 'same short-name creation was not refused safely' >&2; cat "$proof_root/short-two.log" >&2; exit 1; }
[ "$(run_sql "select count(*) from vortex_identity.organizations where tenant_id='$tenant_id' and short_name='$short_name';")" = 1 ] || { echo 'same short-name race did not converge to one organisation' >&2; exit 1; }

# Creation commits before a competing parent archive; archive then sees the child.
parent_call="$(create_call "$actor_id" "$duplicate_parent_child" "$(printf '5%.0s' {1..64})" "'$root_id'" "parent_${run_token:0:18}")"
"${psql_command[@]}" >"$proof_root/parent-create.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/parent-create.pid'
$parent_call \g '$proof_root/parent-create.result'
\! touch '$proof_root/parent-create.ready'
\! while [ ! -f '$proof_root/release-parent' ]; do sleep 0.05; done
commit;
SQL
w=$!; workers+=("$w"); wait_file "$proof_root/parent-create.ready"; parent_create_pid="$(read_pid "$proof_root/parent-create.pid")"
"${psql_command[@]}" >"$proof_root/parent-archive.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/parent-archive.pid'
\set ON_ERROR_STOP off
select * from vortex_identity.archive_tenant_organization(
  '$actor_id','$duplicate_parent_archive','sha256:6666666666666666666666666666666666666666666666666666666666666666',
  '$tenant_id','$root_id',1);
\echo :SQLSTATE
rollback;
SQL
w=$!; workers+=("$w"); parent_archive_pid="$(read_pid "$proof_root/parent-archive.pid")"
wait_blocked "$parent_archive_pid" "$parent_create_pid" 'parent archive queued behind child creation'
touch "$proof_root/release-parent"; wait "${workers[4]}"; wait "${workers[5]}"
grep -qx 'V3101' "$proof_root/parent-archive.log" || { echo 'parent archive did not refuse its committed active child' >&2; cat "$proof_root/parent-archive.log" >&2; exit 1; }
[ "$(run_sql "select state||'|'||revision from vortex_identity.organizations where organization_id='$root_id';")" = 'active|1' ] || { echo 'parent archive race changed the parent' >&2; exit 1; }

# A supported authority change wins first; queued creation cannot use removed authority.
"${psql_command[@]}" >"$proof_root/change.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/change.pid'
select outcome from vortex_identity.change_tenant_administrator(
  '$actor_id','$duplicate_change','sha256:bcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc',
  '$tenant_id','$changed_assignment_id',1,
  '["platform.tenant.hierarchy.read"]'::jsonb, now()-interval '1 hour', null) \g '$proof_root/change.result'
\! touch '$proof_root/change.ready'
\! while [ ! -f '$proof_root/release-change' ]; do sleep 0.05; done
commit;
SQL
w=$!; workers+=("$w"); wait_file "$proof_root/change.ready"; change_pid="$(read_pid "$proof_root/change.pid")"
changed_call="$(create_call "$changed_actor_id" "$duplicate_changed_create" "$(printf 'c%.0s' {1..64})" null "changed_${run_token:0:18}")"
"${psql_command[@]}" >"$proof_root/changed-create.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/changed-create.pid'
\set ON_ERROR_STOP off
$changed_call;
\echo :SQLSTATE
rollback;
SQL
w=$!; workers+=("$w"); changed_create_pid="$(read_pid "$proof_root/changed-create.pid")"
wait_blocked "$changed_create_pid" "$change_pid" 'creation queued behind authority change'
touch "$proof_root/release-change"; wait "${workers[6]}"; wait "${workers[7]}"
grep -qx 'V3101' "$proof_root/changed-create.log" || { echo 'changed queued authority was not refused' >&2; cat "$proof_root/changed-create.log" >&2; exit 1; }

# A supported revoke wins first; queued creation rechecks and refuses.
"${psql_command[@]}" >"$proof_root/revoke.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/revoke.pid'
select outcome from vortex_identity.revoke_tenant_administrator(
  '$actor_id','$duplicate_revoke','sha256:7777777777777777777777777777777777777777777777777777777777777777',
  '$tenant_id','$secondary_assignment_id',1) \g '$proof_root/revoke.result'
\! touch '$proof_root/revoke.ready'
\! while [ ! -f '$proof_root/release-revoke' ]; do sleep 0.05; done
commit;
SQL
w=$!; workers+=("$w"); wait_file "$proof_root/revoke.ready"; revoke_pid="$(read_pid "$proof_root/revoke.pid")"
revoked_call="$(create_call "$secondary_actor_id" "$duplicate_revoked_create" "$(printf '8%.0s' {1..64})" null "revoked_${run_token:0:18}")"
"${psql_command[@]}" >"$proof_root/revoked-create.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/revoked-create.pid'
\set ON_ERROR_STOP off
$revoked_call;
\echo :SQLSTATE
rollback;
SQL
w=$!; workers+=("$w"); revoked_create_pid="$(read_pid "$proof_root/revoked-create.pid")"
wait_blocked "$revoked_create_pid" "$revoke_pid" 'creation queued behind authority revocation'
touch "$proof_root/release-revoke"; wait "${workers[8]}"; wait "${workers[9]}"
grep -qx 'V3101' "$proof_root/revoked-create.log" || { echo 'revoked queued authority was not refused' >&2; cat "$proof_root/revoked-create.log" >&2; exit 1; }

# Authority effective while queued expires before the tenant lock is released.
run_sql "
  insert into vortex_identity.tenant_administrator_assignments(
    assignment_id,tenant_id,identity_id,capability_keys,starts_at,expires_at,revision,
    granted_at,granted_by_actor_id,grant_correlation_id,changed_at,changed_by_actor_id,change_correlation_id
  ) values (
    '$expiring_assignment_id','$tenant_id','$expiring_actor_id',
    array['platform.tenant.organizations.create'],clock_timestamp()-interval '1 hour',
    clock_timestamp()+interval '5 seconds',1,clock_timestamp()-interval '1 hour',
    '$operator_id','$correlation_id',clock_timestamp()-interval '1 hour',
    '$operator_id','$correlation_id');" >/dev/null
"${psql_command[@]}" >"$proof_root/expiry-holder.log" 2>&1 <<SQL &
begin;
select pg_catalog.pg_backend_pid() \g '$proof_root/expiry-holder.pid'
select 1 from vortex_identity.tenants where tenant_id='$tenant_id' for update;
\! touch '$proof_root/expiry-holder.ready'
\! while [ ! -f '$proof_root/release-expiry' ]; do sleep 0.05; done
commit;
SQL
w=$!; workers+=("$w"); wait_file "$proof_root/expiry-holder.ready"; expiry_holder_pid="$(read_pid "$proof_root/expiry-holder.pid")"
effective="$(run_sql "select case when starts_at<=clock_timestamp() and expires_at>clock_timestamp() and revoked_at is null then 'yes' else '' end from vortex_identity.tenant_administrator_assignments where assignment_id='$expiring_assignment_id';")"
[ "$effective" = yes ] || { echo 'expiring creation authority was not effective immediately before queuing' >&2; exit 1; }
expiring_call="$(create_call "$expiring_actor_id" "$duplicate_expiring" "$(printf '9%.0s' {1..64})" null "expired_${run_token:0:18}")"
"${psql_command[@]}" >"$proof_root/expiring-create.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/expiring-create.pid'
\set ON_ERROR_STOP off
$expiring_call;
\echo :SQLSTATE
rollback;
SQL
w=$!; workers+=("$w"); expiring_create_pid="$(read_pid "$proof_root/expiring-create.pid")"
wait_blocked "$expiring_create_pid" "$expiry_holder_pid" 'expiring creation queued on tenant serialization'
deadline=$((SECONDS+20)); expired=''
while ((SECONDS<deadline)); do
  expired="$(run_sql "select case when clock_timestamp()>=expires_at then 'yes' else '' end from vortex_identity.tenant_administrator_assignments where assignment_id='$expiring_assignment_id';")"
  [ "$expired" = yes ] && break
  sleep 0.1
done
[ "$expired" = yes ] || { echo 'database time did not pass queued creation authority expiry' >&2; exit 1; }
touch "$proof_root/release-expiry"; wait "${workers[10]}"; wait "${workers[11]}"
grep -qx 'V3101' "$proof_root/expiring-create.log" || { echo 'expired queued creation was not refused' >&2; cat "$proof_root/expiring-create.log" >&2; exit 1; }

# Reproduce the prior lock cycle exactly: the request holds the same actor's
# projection and pauses before tenant resolution while creation holds the tenant.
# The shared projection lock lets creation finish; the request then waits only
# for the tenant, so both operations complete without a deadlock.
"${psql_command[@]}" >"$proof_root/request.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/request.pid'
select 1 from vortex_identity.identity_projections where identity_id='$root_steward_id' for share;
\! touch '$proof_root/request-projection-ready'
\! while [ ! -f '$proof_root/continue-request' ]; do sleep 0.05; done
select organization_id from vortex_access.resolve_human_organization_scope('$root_steward_id','$root_id') \g '$proof_root/request.result'
commit;
SQL
w=$!; workers+=("$w"); wait_file "$proof_root/request-projection-ready"; request_pid="$(read_pid "$proof_root/request.pid")"
request_call="$(create_call "$root_steward_id" "$duplicate_request_create" "$(printf 'a%.0s' {1..64})" null "request_${run_token:0:18}" "$root_steward_id")"
"${psql_command[@]}" >"$proof_root/request-create.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/request-create.pid'
$request_call \g '$proof_root/request-create.result'
\! touch '$proof_root/request-create-ready'
\! while [ ! -f '$proof_root/release-request' ]; do sleep 0.05; done
commit;
SQL
w=$!; workers+=("$w"); request_create_pid="$(read_pid "$proof_root/request-create.pid")"
wait_file "$proof_root/request-create-ready"
touch "$proof_root/continue-request"
wait_blocked "$request_pid" "$request_create_pid" 'same-actor request queued behind creation at tenant serialization'
touch "$proof_root/release-request"; wait "${workers[12]}"; wait "${workers[13]}"
grep -q '^accepted|' "$proof_root/request-create.result" || { echo 'creation did not complete after request resolution' >&2; cat "$proof_root/request-create.log" >&2; exit 1; }
[ "$(tr -d '[:space:]' <"$proof_root/request.result")" = "$root_id" ] || { echo 'same-actor request did not complete after creation' >&2; cat "$proof_root/request.log" >&2; exit 1; }

[ "$(run_sql "select count(*) from vortex_identity.accepted_administration_receipts where tenant_id='$tenant_id' and operation_key='create_tenant_organization' and duplicate_key in ('$duplicate_short_two','$duplicate_changed_create','$duplicate_revoked_create','$duplicate_expiring');")" = 0 ] || { echo 'a refused concurrency path wrote an accepted creation receipt' >&2; exit 1; }

echo 'tenant organization creation concurrency proof passed'
