#!/usr/bin/env bash
set -euo pipefail

run_uuid="${VORTEX_PRIVATE_SHARE_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then IFS= read -r run_uuid </proc/sys/kernel/random/uuid; fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]
readonly run_uuid token="${run_uuid//-/}"
readonly short_name="share_${token:0:20}"
readonly tenant_id="11${run_uuid:2}" organization_id="21${run_uuid:2}"
readonly identity_actor="31${run_uuid:2}" identity_recipient="41${run_uuid:2}"
readonly identity_next="32${run_uuid:2}"
readonly actor_id="51${run_uuid:2}" recipient_id="61${run_uuid:2}"
readonly next_owner_id="62${run_uuid:2}" owned_record_id="72${run_uuid:2}"
readonly grant_share_id="71${run_uuid:2}" revoke_share_id="81${run_uuid:2}"
readonly record_id="91${run_uuid:2}" module_id="a1${run_uuid:2}"
readonly type_id="b1${run_uuid:2}" contract_id="c1${run_uuid:2}"
readonly field_id="d1${run_uuid:2}"
proof_root="$(mktemp -d /tmp/vortex-private-share.XXXXXX)"
readonly proof_root database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
psql_command=(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1)
if [ -n "$database_url" ]; then psql_command+=("$database_url"); fi
run_sql() { "${psql_command[@]}" --command "$1"; }
fixture_claimed=0
declare -a workers=()

wait_file() {
  local path="$1" deadline=$((SECONDS + 20))
  while ((SECONDS < deadline)); do [ -f "$path" ] && return 0; sleep 0.05; done
  echo "private-share proof barrier timed out: $path" >&2; return 1
}
backend_pid() { wait_file "$1"; tr -d '[:space:]' <"$1"; }
wait_blocked() {
  local blocked="$1" blocker="$2" deadline=$((SECONDS + 20))
  while ((SECONDS < deadline)); do
    [ "$(run_sql "select case when $blocker = any(pg_catalog.pg_blocking_pids($blocked)) then 'yes' else 'no' end;")" = yes ] && return 0
    sleep 0.1
  done
  echo 'private-share proof did not observe the governance lock' >&2; return 1
}
cleanup() {
  local status=$? pid
  touch "$proof_root"/*-release 2>/dev/null || true
  for pid in "${workers[@]:-}"; do kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; done
  if [ "$fixture_claimed" = 1 ]; then
    run_sql "begin; set local session_replication_role=replica;
      drop function if exists vortex_access.coordinate_private_share_proof_ownership(uuid,uuid,bigint,uuid,uuid,uuid,uuid);
      drop table if exists vortex_access.private_share_proof_owned_records;
      delete from vortex_activity.organization_activity_entries where organization_id='$organization_id';
      delete from vortex_access.organization_direct_record_shares where organization_id='$organization_id';
      delete from vortex_access.organization_access_versions where organization_id='$organization_id';
      delete from vortex_identity.organization_accounts where organization_id='$organization_id';
      delete from vortex_identity.identity_projections where identity_id in ('$identity_actor','$identity_recipient','$identity_next');
      delete from vortex_identity.organizations where organization_id='$organization_id' and short_name='$short_name';
      delete from vortex_identity.tenants where tenant_id='$tenant_id' and short_name='$short_name'; commit;" >/dev/null || status=1
  fi
  case "$proof_root" in /tmp/vortex-private-share.*) rm -rf -- "$proof_root";; *) status=1;; esac
  exit "$status"
}
trap cleanup EXIT

run_sql "begin;
insert into vortex_identity.tenants(tenant_id,short_name,display_name,state,created_at,created_by,state_changed_at,revision)
values('$tenant_id','$short_name','Private share proof','active',clock_timestamp(),'$actor_id',clock_timestamp(),1);
insert into vortex_identity.organizations(organization_id,tenant_id,short_name,display_name,state,created_at,created_by,state_changed_at,revision)
values('$organization_id','$tenant_id','$short_name','Private share proof','active',clock_timestamp(),'$actor_id',clock_timestamp(),1);
insert into vortex_identity.identity_projections(identity_id,state,created_at,state_changed_at,state_changed_by,state_change_correlation_id,revision)
values('$identity_actor','active',clock_timestamp(),clock_timestamp(),'$actor_id','e1${run_uuid:2}',1),
('$identity_recipient','active',clock_timestamp(),clock_timestamp(),'$actor_id','e2${run_uuid:2}',1),
('$identity_next','active',clock_timestamp(),clock_timestamp(),'$actor_id','e6${run_uuid:2}',1);
insert into vortex_identity.organization_accounts(organization_account_id,organization_id,identity_id,display_name,state,activated_at,changed_at,state_changed_at,state_changed_by,state_change_correlation_id,revision)
values('$actor_id','$organization_id','$identity_actor','Actor','active',clock_timestamp(),clock_timestamp(),clock_timestamp(),'$actor_id','e3${run_uuid:2}',1),
('$recipient_id','$organization_id','$identity_recipient','Recipient','active',clock_timestamp(),clock_timestamp(),clock_timestamp(),'$actor_id','e4${run_uuid:2}',1);
insert into vortex_identity.organization_accounts(organization_account_id,organization_id,identity_id,display_name,state,activated_at,changed_at,state_changed_at,state_changed_by,state_change_correlation_id,revision)
values('$next_owner_id','$organization_id','$identity_next','Next owner','active',clock_timestamp(),clock_timestamp(),clock_timestamp(),'$actor_id','e7${run_uuid:2}',1);
select * from vortex_access.initialize_organization_access_version('$organization_id','$actor_id','e5${run_uuid:2}'); commit;" >/dev/null
fixture_claimed=1

run_sql "
create unlogged table vortex_access.private_share_proof_owned_records(
  organization_id uuid not null, record_id uuid not null,
  ownership_mode text not null check (ownership_mode='organization_account'),
  owner_account_id uuid not null, revision bigint not null,
  changed_at timestamptz not null, primary key(organization_id,record_id)
);
create function vortex_access.coordinate_private_share_proof_ownership(
  p_organization_id uuid,p_record_id uuid,p_expected_revision bigint,
  p_proposed_owner uuid,p_changed_by uuid,p_correlation_id uuid,p_activity_id uuid
) returns bigint language plpgsql volatile security invoker set search_path='' as \$body\$
declare current_record record; operation_at timestamptz; next_version bigint; activity_result text;
begin
  perform 1 from vortex_access.organization_access_versions version
    where version.organization_id=p_organization_id for update;
  if not found then raise exception using errcode='42501',message='Proof ownership scope unavailable'; end if;
  select owned.* into current_record from vortex_access.private_share_proof_owned_records owned
    where owned.organization_id=p_organization_id and owned.record_id=p_record_id for update;
  if not found or current_record.revision<>p_expected_revision then
    raise exception using errcode='40001',message='Proof ownership transfer stale or unavailable';
  end if;
  if current_record.owner_account_id=p_proposed_owner then
    raise exception using errcode='40001',message='Proof ownership unchanged';
  end if;
  perform 1 from vortex_identity.organization_accounts account
    where account.organization_id=p_organization_id
      and account.organization_account_id=p_proposed_owner and account.state='active';
  if not found then raise exception using errcode='42501',message='Proof ownership target unavailable'; end if;
  operation_at:=greatest(current_record.changed_at,clock_timestamp());
  update vortex_access.private_share_proof_owned_records owned
    set owner_account_id=p_proposed_owner,revision=current_record.revision+1,changed_at=operation_at
    where owned.organization_id=p_organization_id and owned.record_id=p_record_id
      and owned.revision=p_expected_revision;
  select version.current_version into next_version
    from vortex_access.increment_organization_access_version(
      p_organization_id,p_changed_by,p_correlation_id,'record_ownership_changed') version;
  activity_result:=vortex_activity.append_organization_activity_entry(
    p_organization_id,p_activity_id,operation_at,'organization_account',p_changed_by,
    'transfer_record_ownership',array[p_record_id]::uuid[],array[]::uuid[],
    'system',p_correlation_id,'completed');
  if activity_result is distinct from 'inserted' then
    raise exception using errcode='40001',message='Proof ownership Activity stale';
  end if;
  return next_version;
end \$body\$;
revoke execute on function vortex_access.coordinate_private_share_proof_ownership(uuid,uuid,bigint,uuid,uuid,uuid,uuid)
  from public,anon,authenticated,service_role,vortex_runtime,vortex_request;
insert into vortex_access.private_share_proof_owned_records values(
  '$organization_id','$owned_record_id','organization_account','$actor_id',1,clock_timestamp());
" >/dev/null

grant_call() {
  local share="$1" correlation="$2" activity="$3"
  printf "select * from vortex_access.grant_organization_direct_record_share('%s','%s','organization_shared',null,'%s','%s','%s','%s','organization_account','%s',null,array['%s']::uuid[],array[]::uuid[],clock_timestamp(),null,'Race proof','%s','%s','workflow','%s');" \
    "$organization_id" "$share" "$module_id" "$type_id" "$contract_id" "$record_id" "$recipient_id" "$field_id" "$actor_id" "$correlation" "$activity"
}

# Same-ID grant: the owner holds the governance row until the loser is blocked.
"${psql_command[@]}" >"$proof_root/g-owner.log" 2>&1 <<SQL &
begin; select pg_backend_pid() \g '$proof_root/g-owner.pid'
$(grant_call "$grant_share_id" "f1${run_uuid:2}" "a2${run_uuid:2}")
\! touch '$proof_root/g-ready'
\! while [ ! -f '$proof_root/g-release' ]; do sleep 0.05; done
commit;
SQL
owner=$!; workers+=("$owner"); wait_file "$proof_root/g-ready"; owner_db="$(backend_pid "$proof_root/g-owner.pid")"
"${psql_command[@]}" >"$proof_root/g-loser.log" 2>&1 <<SQL &
begin; select pg_backend_pid() \g '$proof_root/g-loser.pid'
$(grant_call "$grant_share_id" "f2${run_uuid:2}" "a3${run_uuid:2}")
commit;
SQL
loser=$!; workers+=("$loser"); loser_db="$(backend_pid "$proof_root/g-loser.pid")"; wait_blocked "$loser_db" "$owner_db"
touch "$proof_root/g-release"; wait "$owner"; if wait "$loser"; then echo 'same-ID grant loser unexpectedly succeeded' >&2; exit 1; fi
[ "$(run_sql "select count(*) from vortex_access.organization_direct_record_shares where organization_id='$organization_id' and direct_share_id='$grant_share_id';")" = 1 ]

# Seed a second share, then race the same expected revocation revision.
run_sql "$(grant_call "$revoke_share_id" "f3${run_uuid:2}" "a4${run_uuid:2}")" >/dev/null
"${psql_command[@]}" >"$proof_root/r-owner.log" 2>&1 <<SQL &
begin; select pg_backend_pid() \g '$proof_root/r-owner.pid'
select * from vortex_access.revoke_organization_direct_record_share('$organization_id','$revoke_share_id',1,'Race winner','$actor_id','f4${run_uuid:2}','interface','a5${run_uuid:2}');
\! touch '$proof_root/r-ready'
\! while [ ! -f '$proof_root/r-release' ]; do sleep 0.05; done
commit;
SQL
owner=$!; workers+=("$owner"); wait_file "$proof_root/r-ready"; owner_db="$(backend_pid "$proof_root/r-owner.pid")"
"${psql_command[@]}" >"$proof_root/r-loser.log" 2>&1 <<SQL &
begin; select pg_backend_pid() \g '$proof_root/r-loser.pid'
select * from vortex_access.revoke_organization_direct_record_share('$organization_id','$revoke_share_id',1,'Race loser','$actor_id','f5${run_uuid:2}','connection','a6${run_uuid:2}');
commit;
SQL
loser=$!; workers+=("$loser"); loser_db="$(backend_pid "$proof_root/r-loser.pid")"; wait_blocked "$loser_db" "$owner_db"
touch "$proof_root/r-release"; wait "$owner"; if wait "$loser"; then echo 'same-revision revoke loser unexpectedly succeeded' >&2; exit 1; fi
[ "$(run_sql "select state||'|'||revision from vortex_access.organization_direct_record_shares where organization_id='$organization_id' and direct_share_id='$revoke_share_id';")" = 'revoked|2' ]
[ "$(run_sql "select current_version||'|'||change_reason from vortex_access.organization_access_versions where organization_id='$organization_id';")" = '4|direct_share_changed' ]
[ "$(run_sql "select count(*) from vortex_activity.organization_activity_entries where organization_id='$organization_id';")" = 3 ]

# Same record revision ownership transfer: one exact proposed owner wins.
"${psql_command[@]}" >"$proof_root/o-owner.log" 2>&1 <<SQL &
begin; select pg_backend_pid() \g '$proof_root/o-owner.pid'
select vortex_access.coordinate_private_share_proof_ownership('$organization_id','$owned_record_id',1,'$recipient_id','$actor_id','f6${run_uuid:2}','a7${run_uuid:2}');
\! touch '$proof_root/o-ready'
\! while [ ! -f '$proof_root/o-release' ]; do sleep 0.05; done
commit;
SQL
owner=$!; workers+=("$owner"); wait_file "$proof_root/o-ready"; owner_db="$(backend_pid "$proof_root/o-owner.pid")"
"${psql_command[@]}" >"$proof_root/o-loser.log" 2>&1 <<SQL &
begin; select pg_backend_pid() \g '$proof_root/o-loser.pid'
select vortex_access.coordinate_private_share_proof_ownership('$organization_id','$owned_record_id',1,'$next_owner_id','$actor_id','f7${run_uuid:2}','a8${run_uuid:2}');
commit;
SQL
loser=$!; workers+=("$loser"); loser_db="$(backend_pid "$proof_root/o-loser.pid")"; wait_blocked "$loser_db" "$owner_db"
touch "$proof_root/o-release"; wait "$owner"; if wait "$loser"; then echo 'same-revision ownership loser unexpectedly succeeded' >&2; exit 1; fi
[ "$(run_sql "select owner_account_id||'|'||revision from vortex_access.private_share_proof_owned_records where organization_id='$organization_id' and record_id='$owned_record_id';")" = "$recipient_id|2" ]
[ "$(run_sql "select current_version||'|'||change_reason from vortex_access.organization_access_versions where organization_id='$organization_id';")" = '5|record_ownership_changed' ]
[ "$(run_sql "select count(*) from vortex_activity.organization_activity_entries where organization_id='$organization_id';")" = 4 ]
echo 'private direct-share competing-change proof passed'
