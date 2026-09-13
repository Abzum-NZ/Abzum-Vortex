#!/usr/bin/env bash
set -euo pipefail

run_uuid="${VORTEX_TENANT_LIFECYCLE_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then IFS= read -r run_uuid </proc/sys/kernel/random/uuid; fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  echo 'configured tenant lifecycle proof requires a lowercase UUID v4' >&2
  exit 1
}

readonly run_uuid run_token="${run_uuid//-/}"
readonly cluster_id="c6${run_uuid:2}" operator_id="96${run_uuid:2}"
readonly manager_id="46${run_uuid:2}" steward_id="47${run_uuid:2}"
readonly replacement_manager_id="48${run_uuid:2}" lifecycle_identity_id="49${run_uuid:2}"
readonly replacement_steward_id="4a${run_uuid:2}" lifecycle_account_id="56${run_uuid:2}"
readonly replacement_account_id="57${run_uuid:2}" manager_assignment_id="36${run_uuid:2}"
readonly replacement_role_assignment_id="76${run_uuid:2}"
readonly replacement_delegation_id="86${run_uuid:2}" setup_correlation_id="a6${run_uuid:2}"
readonly duplicate_same="b6${run_uuid:2}" duplicate_reactivate_one="c6${run_uuid:2}"
readonly duplicate_compete_one="d6${run_uuid:2}" duplicate_compete_two="e6${run_uuid:2}"
readonly duplicate_reactivate_two="f6${run_uuid:2}" duplicate_create="06${run_uuid:2}"
readonly duplicate_create_lifecycle="16${run_uuid:2}" duplicate_manager_change="26${run_uuid:2}"
readonly duplicate_manager_lifecycle="36${run_uuid:2}" duplicate_reactivate_three="46${run_uuid:2}"
readonly duplicate_identity="56${run_uuid:2}" duplicate_identity_lifecycle="66${run_uuid:2}"
readonly duplicate_reactivate_four="76${run_uuid:2}" duplicate_steward="86${run_uuid:2}"
readonly duplicate_steward_lifecycle="96${run_uuid:2}" duplicate_reactivate_five="a6${run_uuid:2}"
readonly duplicate_request_lifecycle="b7${run_uuid:2}" duplicate_reactivate_six="c7${run_uuid:2}"
readonly duplicate_final_suspend="d7${run_uuid:2}" duplicate_steward_refusal="e7${run_uuid:2}"
readonly final_steward_correlation="f7${run_uuid:2}"

proof_root="$(mktemp -d /tmp/vortex-configured-tenant-lifecycle.XXXXXX)"
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
  echo "configured tenant lifecycle proof missed barrier ${1##*/}" >&2
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
  echo "configured tenant lifecycle proof did not observe $description" >&2
  return 1
}
wait_worker() {
  local worker="$1" log="$2" description="$3"
  if ! wait "$worker"; then
    echo "configured tenant lifecycle proof failed: $description" >&2
    sed -n '1,180p' "$log" >&2
    return 1
  fi
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  touch "$proof_root/release-same" "$proof_root/release-compete" \
    "$proof_root/release-create" "$proof_root/release-manager" \
    "$proof_root/release-identity" "$proof_root/release-steward" \
    "$proof_root/release-request" "$proof_root/release-steward-refusal"
  for worker in "${workers[@]}"; do wait "$worker" >/dev/null 2>&1 || true; done
  if [ "$fixture_created" = 1 ]; then
    run_sql "begin; set local session_replication_role=replica;
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
        '$manager_id','$steward_id','$replacement_manager_id',
        '$lifecycle_identity_id','$replacement_steward_id');
      commit;" >/dev/null
  fi
  case "$proof_root" in
    /tmp/vortex-configured-tenant-lifecycle.*) rm -rf -- "$proof_root" ;;
  esac
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

provisioned="$(run_sql "
  select tenant_id::text||'|'||root_organization_id::text||'|'||
    tenant_administrator_assignment_id::text||'|'||organization_account_id::text
  from vortex_identity.provision_tenant(
    '$cluster_id','$operator_id','06${run_uuid:2}',
    'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    'ctl_${run_token:0:24}','Tenant lifecycle race',
    'ctl_root_${run_token:0:19}','Tenant lifecycle root',
    '$manager_id','$steward_id','Root steward','en-NZ','Pacific/Auckland',
    'en-NZ','Pacific/Auckland','NZD','medium','auto');")"
IFS='|' read -r tenant_id root_id original_manager_assignment_id steward_account_id <<<"$provisioned"
readonly tenant_id root_id original_manager_assignment_id steward_account_id
[[ "$tenant_id|$root_id|$original_manager_assignment_id|$steward_account_id" =~ ^[0-9a-f-]+\|[0-9a-f-]+\|[0-9a-f-]+\|[0-9a-f-]+$ ]] || {
  echo 'configured tenant lifecycle proof could not provision its fixture' >&2
  exit 1
}
fixture_created=1

IFS='|' read -r steward_role_id original_steward_assignment_id <<<"$(run_sql "
  select original_role_id::text||'|'||original_role_assignment_id::text
  from vortex_access.organization_stewardship_requirements
  where organization_id='$root_id';")"
readonly steward_role_id original_steward_assignment_id
run_sql "
  insert into vortex_identity.identity_projections(
    identity_id,state,created_at,state_changed_at,state_changed_by,state_change_correlation_id,revision
  ) values
    ('$replacement_manager_id','active',now(),now(),'$operator_id','$setup_correlation_id',1),
    ('$lifecycle_identity_id','active',now(),now(),'$operator_id','$setup_correlation_id',1),
    ('$replacement_steward_id','active',now(),now(),'$operator_id','$setup_correlation_id',1);
  insert into vortex_identity.tenant_administrator_assignments(
    assignment_id,tenant_id,identity_id,capability_keys,starts_at,expires_at,revision,
    granted_at,granted_by_actor_id,grant_correlation_id,changed_at,changed_by_actor_id,change_correlation_id
  ) values ('$manager_assignment_id','$tenant_id','$replacement_manager_id',
    array['platform.tenant.administrators.manage'],now()-interval '1 hour',null,1,
    now()-interval '1 hour','$operator_id','$setup_correlation_id',now()-interval '1 hour',
    '$operator_id','$setup_correlation_id');
  insert into vortex_identity.organization_accounts(
    organization_account_id,organization_id,identity_id,display_name,state,activated_at,
    changed_at,state_changed_at,state_changed_by,state_change_correlation_id,revision
  ) values
    ('$lifecycle_account_id','$root_id','$lifecycle_identity_id','Lifecycle identity','active',
      now(),now(),now(),'$operator_id','$setup_correlation_id',1),
    ('$replacement_account_id','$root_id','$replacement_steward_id','Replacement steward','active',
      now(),now(),now(),'$operator_id','$setup_correlation_id',1);
  select * from vortex_access.coordinate_organization_role_assignment_change(
    'grant','$root_id','$replacement_role_assignment_id',null,'$steward_role_id',1,
    'organization_account','$replacement_account_id',null,'standing',now()-interval '1 hour',
    null,'$operator_id','$setup_correlation_id');
  select * from vortex_access.coordinate_organization_delegation_authority_change(
    'grant_delegation','$root_id','$replacement_delegation_id',null,
    'organization_account','$replacement_account_id',null,'organization_catalogue',
    null,null,now()-interval '1 hour',null,'$operator_id','$setup_correlation_id');" >/dev/null

lifecycle_call() {
  local operation="$1" duplicate="$2" fingerprint="$3" expected="$4"
  printf "select outcome||'|'||revision from vortex_identity.%s('%s','%s','%s','sha256:%s','%s',%s)" \
    "$operation" "$cluster_id" "$operator_id" "$duplicate" "$fingerprint" "$tenant_id" "$expected"
}

# Exact same-key calls serialize on the accepted-result key and converge to one effect.
same_call="$(lifecycle_call suspend_tenant "$duplicate_same" "$(printf '2%.0s' {1..64})" 1)"
"${psql_command[@]}" >"$proof_root/same-one.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
set local role vortex_runtime;
select pg_catalog.pg_backend_pid() \g '$proof_root/same-one.pid'
$same_call \g '$proof_root/same-one.result'
\! touch '$proof_root/same-one.ready'
\! while [ ! -f '$proof_root/release-same' ]; do sleep 0.05; done
commit;
SQL
w=$!; workers+=("$w"); wait_file "$proof_root/same-one.ready"; same_one_pid="$(read_pid "$proof_root/same-one.pid")"
"${psql_command[@]}" >"$proof_root/same-two.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
set local role vortex_runtime;
select pg_catalog.pg_backend_pid() \g '$proof_root/same-two.pid'
$same_call \g '$proof_root/same-two.result'
commit;
SQL
w=$!; workers+=("$w"); same_two_pid="$(read_pid "$proof_root/same-two.pid")"
wait_blocked "$same_two_pid" "$same_one_pid" 'same-key retry queued on receipt serialization'
touch "$proof_root/release-same"; wait_worker "${workers[0]}" "$proof_root/same-one.log" 'first same-key transition'; wait_worker "${workers[1]}" "$proof_root/same-two.log" 'same-key replay'
[ "$(tr -d '[:space:]' <"$proof_root/same-one.result")" = 'accepted|2' ] || { echo 'first same-key transition was not accepted' >&2; exit 1; }
[ "$(tr -d '[:space:]' <"$proof_root/same-two.result")" = 'replayed|2' ] || { echo 'same-key retry did not replay' >&2; exit 1; }
[ "$(run_sql "begin; set local role vortex_runtime; select outcome||'|'||revision from vortex_identity.reactivate_tenant('$cluster_id','$operator_id','$duplicate_reactivate_one','sha256:3333333333333333333333333333333333333333333333333333333333333333','$tenant_id',2); commit;")" = 'accepted|3' ] || { echo 'runtime reactivation did not commit' >&2; exit 1; }

# Competing transitions serialize; only the first revision can commit.
first_compete="$(lifecycle_call suspend_tenant "$duplicate_compete_one" "$(printf '4%.0s' {1..64})" 3)"
second_compete="$(lifecycle_call reactivate_tenant "$duplicate_compete_two" "$(printf '5%.0s' {1..64})" 3)"
"${psql_command[@]}" >"$proof_root/compete-one.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/compete-one.pid'
$first_compete \g '$proof_root/compete-one.result'
\! touch '$proof_root/compete-one.ready'
\! while [ ! -f '$proof_root/release-compete' ]; do sleep 0.05; done
commit;
SQL
w=$!; workers+=("$w"); wait_file "$proof_root/compete-one.ready"; compete_one_pid="$(read_pid "$proof_root/compete-one.pid")"
"${psql_command[@]}" >"$proof_root/compete-two.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/compete-two.pid'
\set ON_ERROR_STOP off
$second_compete;
\echo :SQLSTATE
rollback;
SQL
w=$!; workers+=("$w"); compete_two_pid="$(read_pid "$proof_root/compete-two.pid")"
wait_blocked "$compete_two_pid" "$compete_one_pid" 'competing transition queued on tenant serialization'
touch "$proof_root/release-compete"; wait_worker "${workers[2]}" "$proof_root/compete-one.log" 'winning transition'; wait_worker "${workers[3]}" "$proof_root/compete-two.log" 'stale competing transition'
grep -qx 'V3102' "$proof_root/compete-two.log" || { echo 'competing transition did not refuse stale' >&2; cat "$proof_root/compete-two.log" >&2; exit 1; }
[ "$(run_sql "select outcome||'|'||revision from vortex_identity.reactivate_tenant('$cluster_id','$operator_id','$duplicate_reactivate_two','sha256:6666666666666666666666666666666666666666666666666666666666666666','$tenant_id',4);")" = 'accepted|5' ] || { echo 'second reactivation failed' >&2; exit 1; }

# Organisation creation commits while lifecycle waits. The discovered set
# recheck refuses the lifecycle attempt rather than operating on a partial set.
"${psql_command[@]}" >"$proof_root/create.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/create.pid'
select outcome from vortex_identity.create_tenant_organization(
  '$manager_id','$duplicate_create','sha256:7777777777777777777777777777777777777777777777777777777777777777',
  '$tenant_id',null,'ctl_child_${run_token:0:18}','Lifecycle child','$steward_id',
  'Child steward','en-NZ','Pacific/Auckland','en-NZ','Pacific/Auckland','NZD','medium','auto') \g '$proof_root/create.result'
\! touch '$proof_root/create.ready'
\! while [ ! -f '$proof_root/release-create' ]; do sleep 0.05; done
commit;
SQL
w=$!; workers+=("$w"); wait_file "$proof_root/create.ready"; create_pid="$(read_pid "$proof_root/create.pid")"
create_lifecycle="$(lifecycle_call suspend_tenant "$duplicate_create_lifecycle" "$(printf '8%.0s' {1..64})" 5)"
"${psql_command[@]}" >"$proof_root/create-lifecycle.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/create-lifecycle.pid'
\set ON_ERROR_STOP off
$create_lifecycle;
\echo :SQLSTATE
rollback;
SQL
w=$!; workers+=("$w"); create_lifecycle_pid="$(read_pid "$proof_root/create-lifecycle.pid")"
wait_blocked "$create_lifecycle_pid" "$create_pid" 'tenant lifecycle queued behind organisation creation'
touch "$proof_root/release-create"; wait_worker "${workers[4]}" "$proof_root/create.log" 'organisation creation'; wait_worker "${workers[5]}" "$proof_root/create-lifecycle.log" 'discovery recheck'
grep -qx 'V3102' "$proof_root/create-lifecycle.log" || { echo 'changed organisation set did not refuse stale' >&2; cat "$proof_root/create-lifecycle.log" >&2; exit 1; }

# A tenant-manager change owns tenant serialization first. Reactivation/suspension
# then observes the committed replacement and proceeds without restoring grants.
"${psql_command[@]}" >"$proof_root/manager.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/manager.pid'
select outcome from vortex_identity.change_tenant_administrator(
  '$manager_id','$duplicate_manager_change','sha256:9999999999999999999999999999999999999999999999999999999999999999',
  '$tenant_id','$original_manager_assignment_id',1,
  '["platform.tenant.administrators.read"]'::jsonb,now()-interval '1 hour',null) \g '$proof_root/manager.result'
\! touch '$proof_root/manager.ready'
\! while [ ! -f '$proof_root/release-manager' ]; do sleep 0.05; done
commit;
SQL
w=$!; workers+=("$w"); wait_file "$proof_root/manager.ready"; manager_pid="$(read_pid "$proof_root/manager.pid")"
manager_lifecycle="$(lifecycle_call suspend_tenant "$duplicate_manager_lifecycle" "$(printf 'a%.0s' {1..64})" 5)"
"${psql_command[@]}" >"$proof_root/manager-lifecycle.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/manager-lifecycle.pid'
$manager_lifecycle \g '$proof_root/manager-lifecycle.result'
commit;
SQL
w=$!; workers+=("$w"); manager_lifecycle_pid="$(read_pid "$proof_root/manager-lifecycle.pid")"
wait_blocked "$manager_lifecycle_pid" "$manager_pid" 'tenant lifecycle queued behind manager mutation'
touch "$proof_root/release-manager"; wait_worker "${workers[6]}" "$proof_root/manager.log" 'manager mutation'; wait_worker "${workers[7]}" "$proof_root/manager-lifecycle.log" 'lifecycle after manager mutation'
[ "$(tr -d '[:space:]' <"$proof_root/manager-lifecycle.result")" = 'accepted|6' ] || { echo 'lifecycle did not accept the current replacement manager' >&2; exit 1; }
[ "$(run_sql "select outcome||'|'||revision from vortex_identity.reactivate_tenant('$cluster_id','$operator_id','$duplicate_reactivate_three','sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','$tenant_id',6);")" = 'accepted|7' ] || { echo 'third reactivation failed' >&2; exit 1; }

# Slice 4A and tenant lifecycle use the same governance-before-tenant order.
"${psql_command[@]}" >"$proof_root/identity.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/identity.pid'
select outcome from vortex_identity.suspend_cluster_identity(
  '$cluster_id','$operator_id','$duplicate_identity',
  'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  '$lifecycle_identity_id',1) \g '$proof_root/identity.result'
\! touch '$proof_root/identity.ready'
\! while [ ! -f '$proof_root/release-identity' ]; do sleep 0.05; done
commit;
SQL
w=$!; workers+=("$w"); wait_file "$proof_root/identity.ready"; identity_pid="$(read_pid "$proof_root/identity.pid")"
identity_lifecycle="$(lifecycle_call suspend_tenant "$duplicate_identity_lifecycle" "$(printf 'd%.0s' {1..64})" 7)"
"${psql_command[@]}" >"$proof_root/identity-lifecycle.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/identity-lifecycle.pid'
$identity_lifecycle \g '$proof_root/identity-lifecycle.result'
commit;
SQL
w=$!; workers+=("$w"); identity_lifecycle_pid="$(read_pid "$proof_root/identity-lifecycle.pid")"
wait_blocked "$identity_lifecycle_pid" "$identity_pid" 'tenant lifecycle queued behind Slice 4A lifecycle'
touch "$proof_root/release-identity"; wait_worker "${workers[8]}" "$proof_root/identity.log" 'Slice 4A lifecycle'; wait_worker "${workers[9]}" "$proof_root/identity-lifecycle.log" 'tenant lifecycle after Slice 4A'
[ "$(tr -d '[:space:]' <"$proof_root/identity-lifecycle.result")" = 'accepted|8' ] || { echo 'tenant lifecycle failed after Slice 4A' >&2; exit 1; }
[ "$(run_sql "select outcome||'|'||revision from vortex_identity.reactivate_tenant('$cluster_id','$operator_id','$duplicate_reactivate_four','sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee','$tenant_id',8);")" = 'accepted|9' ] || { echo 'fourth reactivation failed' >&2; exit 1; }

# A real stewardship mutation holds the root governance row. Lifecycle waits,
# then rechecks the still-valid original steward after the replacement is revoked.
"${psql_command[@]}" >"$proof_root/steward.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/steward.pid'
select outcome from vortex_access.coordinate_organization_role_assignment_change(
  'revoke','$root_id','$replacement_role_assignment_id',1,
  null,null,null,null,null,null,null,null,'$operator_id','$duplicate_steward') \g '$proof_root/steward.result'
\! touch '$proof_root/steward.ready'
\! while [ ! -f '$proof_root/release-steward' ]; do sleep 0.05; done
commit;
SQL
w=$!; workers+=("$w"); wait_file "$proof_root/steward.ready"; steward_pid="$(read_pid "$proof_root/steward.pid")"
steward_lifecycle="$(lifecycle_call suspend_tenant "$duplicate_steward_lifecycle" "$(printf 'f%.0s' {1..64})" 9)"
"${psql_command[@]}" >"$proof_root/steward-lifecycle.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/steward-lifecycle.pid'
$steward_lifecycle \g '$proof_root/steward-lifecycle.result'
commit;
SQL
w=$!; workers+=("$w"); steward_lifecycle_pid="$(read_pid "$proof_root/steward-lifecycle.pid")"
wait_blocked "$steward_lifecycle_pid" "$steward_pid" 'tenant lifecycle queued behind stewardship mutation'
touch "$proof_root/release-steward"; wait_worker "${workers[10]}" "$proof_root/steward.log" 'stewardship mutation'; wait_worker "${workers[11]}" "$proof_root/steward-lifecycle.log" 'tenant lifecycle after stewardship mutation'
[ "$(tr -d '[:space:]' <"$proof_root/steward-lifecycle.result")" = 'accepted|10' ] || { echo 'tenant lifecycle failed after stewardship mutation' >&2; exit 1; }
[ "$(run_sql "select outcome||'|'||revision from vortex_identity.reactivate_tenant('$cluster_id','$operator_id','$duplicate_reactivate_five','sha256:1212121212121212121212121212121212121212121212121212121212121212','$tenant_id',10);")" = 'accepted|11' ] || { echo 'fifth reactivation failed' >&2; exit 1; }

# Existing request resolution and lifecycle complete in a single direction:
# governance/tenant shared reads first, lifecycle mutation second.
"${psql_command[@]}" >"$proof_root/request.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/request.pid'
select organization_id from vortex_access.resolve_human_organization_scope(
  '$steward_id','$root_id') \g '$proof_root/request.result'
\! touch '$proof_root/request.ready'
\! while [ ! -f '$proof_root/release-request' ]; do sleep 0.05; done
commit;
SQL
w=$!; workers+=("$w"); wait_file "$proof_root/request.ready"; request_pid="$(read_pid "$proof_root/request.pid")"
request_lifecycle="$(lifecycle_call suspend_tenant "$duplicate_request_lifecycle" "$(printf '3%.0s' {1..64})" 11)"
"${psql_command[@]}" >"$proof_root/request-lifecycle.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/request-lifecycle.pid'
$request_lifecycle \g '$proof_root/request-lifecycle.result'
commit;
SQL
w=$!; workers+=("$w"); request_lifecycle_pid="$(read_pid "$proof_root/request-lifecycle.pid")"
wait_blocked "$request_lifecycle_pid" "$request_pid" 'tenant lifecycle queued behind request resolution'
touch "$proof_root/release-request"; wait_worker "${workers[12]}" "$proof_root/request.log" 'request resolution'; wait_worker "${workers[13]}" "$proof_root/request-lifecycle.log" 'tenant lifecycle after request resolution'
[ "$(tr -d '[:space:]' <"$proof_root/request-lifecycle.result")" = 'accepted|12' ] || { echo 'tenant lifecycle failed after request resolution' >&2; exit 1; }
if request_after_suspend="$(run_sql "select * from vortex_access.resolve_human_organization_scope('$steward_id','$root_id');" 2>&1)"; then
  echo 'suspended tenant remained available to request resolution' >&2
  exit 1
fi
grep -Fq 'Organisation selection is unavailable' <<<"$request_after_suspend" || {
  echo 'suspended tenant produced an unexpected request refusal' >&2
  echo "$request_after_suspend" >&2
  exit 1
}
[ "$(run_sql "select outcome||'|'||revision from vortex_identity.reactivate_tenant('$cluster_id','$operator_id','$duplicate_reactivate_six','sha256:4545454545454545454545454545454545454545454545454545454545454545','$tenant_id',12);")" = 'accepted|13' ] || { echo 'sixth reactivation failed' >&2; exit 1; }

# A queued reactivation must evaluate the stewardship state that commits ahead
# of it. The direct mutation models already-stored legacy damage: it owns the
# governance row, removes the last live steward, and advances Access before
# committing. Reactivation then refuses without changing tenant state or
# recording acceptance.
[ "$(run_sql "select outcome||'|'||revision from vortex_identity.suspend_tenant('$cluster_id','$operator_id','$duplicate_final_suspend','sha256:5656565656565656565656565656565656565656565656565656565656565656','$tenant_id',13);")" = 'accepted|14' ] || { echo 'final suspension failed' >&2; exit 1; }
receipt_count_before="$(run_sql "select count(*) from vortex_identity.accepted_administration_receipts where cluster_id='$cluster_id' and actor_id='$operator_id' and operation_key='reactivate_tenant' and duplicate_key='$duplicate_steward_refusal' and subject_ids @> array['$tenant_id'::uuid];")"
readonly receipt_count_before
"${psql_command[@]}" >"$proof_root/steward-refusal.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/steward-refusal.pid'
select current_version from vortex_access.organization_access_versions
where organization_id='$root_id' for update;
update vortex_access.organization_role_assignments
set state='revoked',revision=revision+1,changed_by='$operator_id',
  changed_at=statement_timestamp(),change_correlation_id='$final_steward_correlation',
  revoked_by='$operator_id',revoked_at=statement_timestamp(),
  revocation_correlation_id='$final_steward_correlation'
where organization_id='$root_id'
  and role_assignment_id='$original_steward_assignment_id' and state='live';
select current_version from vortex_access.increment_organization_access_version(
  '$root_id','$operator_id','$final_steward_correlation','stewardship_changed');
\! touch '$proof_root/steward-refusal.ready'
\! while [ ! -f '$proof_root/release-steward-refusal' ]; do sleep 0.05; done
commit;
SQL
w=$!; workers+=("$w"); wait_file "$proof_root/steward-refusal.ready"; steward_refusal_pid="$(read_pid "$proof_root/steward-refusal.pid")"
steward_refusal_lifecycle="$(lifecycle_call reactivate_tenant "$duplicate_steward_refusal" "$(printf '7%.0s' {1..64})" 14)"
"${psql_command[@]}" >"$proof_root/steward-refusal-lifecycle.log" 2>&1 <<SQL &
begin; set local lock_timeout='25s'; set local statement_timeout='35s';
select pg_catalog.pg_backend_pid() \g '$proof_root/steward-refusal-lifecycle.pid'
\set ON_ERROR_STOP off
$steward_refusal_lifecycle;
\echo :SQLSTATE
rollback;
SQL
w=$!; workers+=("$w"); steward_refusal_lifecycle_pid="$(read_pid "$proof_root/steward-refusal-lifecycle.pid")"
wait_blocked "$steward_refusal_lifecycle_pid" "$steward_refusal_pid" 'reactivation queued behind committed stewardship loss'
touch "$proof_root/release-steward-refusal"; wait_worker "${workers[14]}" "$proof_root/steward-refusal.log" 'committed stewardship loss'; wait_worker "${workers[15]}" "$proof_root/steward-refusal-lifecycle.log" 'reactivation after stewardship loss'
grep -qx 'V3002' "$proof_root/steward-refusal-lifecycle.log" || { echo 'reactivation did not refuse committed stewardship loss' >&2; cat "$proof_root/steward-refusal-lifecycle.log" >&2; exit 1; }
[ "$(run_sql "select state||'|'||revision from vortex_identity.tenants where tenant_id='$tenant_id';")" = 'suspended|14' ] || {
  echo 'refused reactivation changed the tenant' >&2
  exit 1
}
[ "$(run_sql "select count(*) from vortex_identity.accepted_administration_receipts where cluster_id='$cluster_id' and actor_id='$operator_id' and operation_key='reactivate_tenant' and duplicate_key='$duplicate_steward_refusal' and subject_ids @> array['$tenant_id'::uuid];")" = "$receipt_count_before" ] || {
  echo 'refused reactivation wrote an accepted receipt' >&2
  exit 1
}

[ "$(run_sql "select count(*) from vortex_identity.accepted_administration_receipts where cluster_id='$cluster_id' and actor_id='$operator_id' and operation_key in ('suspend_tenant','reactivate_tenant') and duplicate_key in ('$duplicate_compete_two','$duplicate_create_lifecycle','$duplicate_steward_refusal') and subject_ids @> array['$tenant_id'::uuid];")" = 0 ] || {
  echo 'a stale concurrency path wrote a tenant lifecycle receipt' >&2
  exit 1
}
[ "$(run_sql "select state||'|'||revision from vortex_identity.tenants where tenant_id='$tenant_id';")" = 'suspended|14' ] || {
  echo 'configured tenant lifecycle proof ended with unexpected tenant state' >&2
  exit 1
}

echo 'configured tenant lifecycle concurrency proof passed'
