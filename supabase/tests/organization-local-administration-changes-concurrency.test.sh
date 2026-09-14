#!/usr/bin/env bash
set -euo pipefail

run_uuid="${VORTEX_LOCAL_ADMINISTRATION_CHANGE_PROOF_RUN_ID:-}"
if [ -z "$run_uuid" ]; then IFS= read -r run_uuid </proc/sys/kernel/random/uuid; fi
[[ "$run_uuid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || {
  echo 'local-administration change proof requires a lowercase UUID v4' >&2; exit 1;
}
readonly run_uuid token="${run_uuid//-/}"
readonly tenant_id="18${run_uuid:2}" organization_id="28${run_uuid:2}"
readonly admin_identity="48${run_uuid:2}" target_identity="49${run_uuid:2}"
readonly replacement_identity="4a${run_uuid:2}" third_identity="4b${run_uuid:2}"
readonly admin_account="58${run_uuid:2}" target_account="59${run_uuid:2}"
readonly replacement_account="5a${run_uuid:2}" third_account="5b${run_uuid:2}"
readonly steward_role="68${run_uuid:2}" original_assignment="78${run_uuid:2}"
readonly replacement_assignment="79${run_uuid:2}" third_assignment="7a${run_uuid:2}"
readonly replacement_delegation="89${run_uuid:2}" third_delegation="8a${run_uuid:2}"
readonly actor_id="98${run_uuid:2}" short_name="localchange_${token:0:18}"
readonly proof_root="$(mktemp -d /tmp/vortex-local-administration-change.XXXXXX)"
readonly database_url="${VORTEX_CONCURRENCY_DATABASE_URL:-}"
psql_command=(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1)
if [ -n "$database_url" ]; then psql_command+=("$database_url"); fi
run_sql() { "${psql_command[@]}" --command "$1"; }

wait_file() { local f="$1" end=$((SECONDS+20)); while ((SECONDS<end)); do [ -f "$f" ] && return; sleep .05; done; return 1; }
wait_blocked() {
  local blocked="$1" blocker="$2" description="${3:-governance lock wait}" end=$((SECONDS+20))
  while ((SECONDS<end)); do
    [ "$(run_sql "select case when $blocker=any(pg_catalog.pg_blocking_pids($blocked)) then 1 else 0 end")" = 1 ] && return
    sleep .1
  done
  echo "expected $description was not observed" >&2; return 1
}
pid_from() { wait_file "$1"; tr -d '[:space:]' <"$1"; }

cleanup() {
  local status=$?
  set +e
  if [ "$status" -ne 0 ]; then
    for proof_log in "$proof_root"/*.log; do
      [ -f "$proof_log" ] || continue
      echo "--- ${proof_log##*/}" >&2
      tail -100 "$proof_log" >&2
    done
  fi
  run_sql "begin; set local session_replication_role=replica;
  do \$proof\$ declare candidate record; begin
    if exists(select 1 from vortex_identity.organizations where organization_id='$organization_id'
      and short_name<>'$short_name') then raise exception 'ownership marker mismatch'; end if;
    for candidate in select table_schema,table_name from information_schema.columns
      where column_name='organization_id' and table_schema in
      ('vortex_identity','vortex_access','vortex_activity') order by 1,2 loop
      execute pg_catalog.format('delete from %I.%I where organization_id=\$1',
        candidate.table_schema,candidate.table_name) using '$organization_id'::uuid;
    end loop;
    delete from vortex_identity.accepted_administration_receipts where tenant_id='$tenant_id';
    delete from vortex_identity.identity_projections where identity_id in
      ('$admin_identity','$target_identity','$replacement_identity','$third_identity');
    delete from vortex_identity.tenants where tenant_id='$tenant_id';
  end \$proof\$; commit" >/dev/null
  case "$proof_root" in /tmp/vortex-local-administration-change.*) rm -rf -- "$proof_root";; esac
  exit "$status"
}
trap cleanup EXIT INT TERM

run_sql "begin;
insert into vortex_identity.tenants(tenant_id,short_name,display_name,state,created_at,created_by,state_changed_at,revision)
values('$tenant_id','$short_name','Local change race','active',clock_timestamp(),'$actor_id',clock_timestamp(),1);
insert into vortex_identity.organizations(organization_id,tenant_id,short_name,display_name,state,created_at,created_by,state_changed_at,revision)
values('$organization_id','$tenant_id','$short_name','Local change race','active',clock_timestamp(),'$actor_id',clock_timestamp(),1);
insert into vortex_identity.identity_projections(identity_id,state,created_at,state_changed_at,state_changed_by,state_change_correlation_id,revision) values
('$admin_identity','active',clock_timestamp(),clock_timestamp(),'$actor_id','a8${run_uuid:2}',1),
('$target_identity','active',clock_timestamp(),clock_timestamp(),'$actor_id','b8${run_uuid:2}',1),
('$replacement_identity','active',clock_timestamp(),clock_timestamp(),'$actor_id','c8${run_uuid:2}',1),
('$third_identity','active',clock_timestamp(),clock_timestamp(),'$actor_id','d8${run_uuid:2}',1);
insert into vortex_identity.organization_accounts(organization_account_id,organization_id,identity_id,display_name,state,activated_at,changed_at,state_changed_at,state_changed_by,state_change_correlation_id,revision) values
('$admin_account','$organization_id','$admin_identity','Original steward','active',clock_timestamp(),clock_timestamp(),clock_timestamp(),'$actor_id','e8${run_uuid:2}',1),
('$target_account','$organization_id','$target_identity','Target','active',clock_timestamp(),clock_timestamp(),clock_timestamp(),'$actor_id','f8${run_uuid:2}',1),
('$replacement_account','$organization_id','$replacement_identity','Replacement','active',clock_timestamp(),clock_timestamp(),clock_timestamp(),'$actor_id','aa${run_uuid:2}',1),
('$third_account','$organization_id','$third_identity','Third steward','active',clock_timestamp(),clock_timestamp(),clock_timestamp(),'$actor_id','ab${run_uuid:2}',1);
select * from vortex_access.initialize_organization_access_version('$organization_id','$actor_id','ac${run_uuid:2}');
select * from vortex_access.initialize_platform_permission_catalogue('$organization_id','$actor_id','ad${run_uuid:2}');
select * from vortex_access.coordinate_organization_stewardship_adoption('$organization_id','$admin_account','$steward_role',
'organization_steward','Organisation steward','Permanent minimum organisation administration.',
'$original_assignment','88${run_uuid:2}','$actor_id','ae${run_uuid:2}'); commit" >/dev/null

# Replacement grant holds governance while the original steward's close queues.
( "${psql_command[@]}" >"$proof_root/grant.out" 2>"$proof_root/grant.log" <<SQL
begin;
select * from vortex_access.coordinate_organization_role_assignment_change('grant','$organization_id',
'$replacement_assignment',null,'$steward_role',1,'organization_account','$replacement_account',null,
'standing',clock_timestamp()-interval '1 minute',null,'$admin_account','af${run_uuid:2}');
select * from vortex_access.coordinate_organization_delegation_authority_change('grant_delegation',
'$organization_id','$replacement_delegation',null,'organization_account','$replacement_account',null,
'organization_catalogue',null,null,clock_timestamp()-interval '1 minute',null,
'$admin_account','b9${run_uuid:2}');
select pg_backend_pid() \g '$proof_root/grant.pid'
select pg_sleep(2); commit;
SQL
) & grant_worker=$!
wait_file "$proof_root/grant.pid"
( "${psql_command[@]}" >"$proof_root/close.out" 2>"$proof_root/close.log" <<SQL
select pg_backend_pid() \g '$proof_root/close.pid'
begin;
select * from vortex_access.resolve_human_organization_change_scope('$admin_identity','$organization_id');
delete from vortex_context.request_contexts where backend_pid=pg_backend_pid();
select vortex_context.initialize(jsonb_build_object('callerKind','human','identityAuthorityId','ba${run_uuid:2}',
'tenantId','$tenant_id','organizationId','$organization_id','organizationAccountId','$admin_account',
'identityId','$admin_identity','sessionId','ca${run_uuid:2}','authenticationStrength','single_factor',
'issuedAt',clock_timestamp(),'expiresAt',clock_timestamp()+interval '1 hour','accessVersion',
(select current_version from vortex_access.organization_access_versions where organization_id='$organization_id'),
'correlationId','b0${run_uuid:2}'));
set local role vortex_request;
select outcome from vortex_access.close_organization_account_for_administration('d0${run_uuid:2}','$admin_account',1);
commit;
SQL
) & close_worker=$!
wait_blocked "$(pid_from "$proof_root/close.pid")" "$(pid_from "$proof_root/grant.pid")"
wait "$grant_worker"; wait "$close_worker"
[ "$(run_sql "select state from vortex_identity.organization_accounts where organization_account_id='$admin_account'")" = closed ]
[ "$(run_sql "select vortex_access.organization_has_permanent_steward('$organization_id',clock_timestamp())")" = t ]

# Same-key invitation creation races converge; a changed payload conflicts.
( "${psql_command[@]}" >"$proof_root/invite1.out" 2>"$proof_root/invite1.log" <<SQL
begin; select * from vortex_access.resolve_human_organization_change_scope('$replacement_identity','$organization_id');
delete from vortex_context.request_contexts where backend_pid=pg_backend_pid();
select vortex_context.initialize(jsonb_build_object('callerKind','human','identityAuthorityId','ba${run_uuid:2}',
'tenantId','$tenant_id','organizationId','$organization_id','organizationAccountId','$replacement_account',
'identityId','$replacement_identity','sessionId','cb${run_uuid:2}','authenticationStrength','single_factor',
'issuedAt',clock_timestamp(),'expiresAt',clock_timestamp()+interval '1 hour','accessVersion',(select current_version from vortex_access.organization_access_versions where organization_id='$organization_id'),'correlationId','b1${run_uuid:2}'));
set local role vortex_request;
select outcome,invitation_id from vortex_access.create_organization_invitation_for_administration(
'd1${run_uuid:2}','race@example.test','sha256:'||repeat('1',64),'2099-01-01'::timestamptz);
reset role; select pg_backend_pid() \g '$proof_root/invite1.pid'
select pg_sleep(2); commit;
SQL
) & invite1=$!
wait_file "$proof_root/invite1.pid"
( "${psql_command[@]}" >"$proof_root/invite2.out" 2>"$proof_root/invite2.log" <<SQL
select pg_backend_pid() \g '$proof_root/invite2.pid'
begin; select * from vortex_access.resolve_human_organization_change_scope('$replacement_identity','$organization_id');
delete from vortex_context.request_contexts where backend_pid=pg_backend_pid();
select vortex_context.initialize(jsonb_build_object('callerKind','human','identityAuthorityId','ba${run_uuid:2}',
'tenantId','$tenant_id','organizationId','$organization_id','organizationAccountId','$replacement_account',
'identityId','$replacement_identity','sessionId','cc${run_uuid:2}','authenticationStrength','single_factor',
'issuedAt',clock_timestamp(),'expiresAt',clock_timestamp()+interval '1 hour','accessVersion',(select current_version from vortex_access.organization_access_versions where organization_id='$organization_id'),'correlationId','b2${run_uuid:2}'));
set local role vortex_request;
select outcome,invitation_id from vortex_access.create_organization_invitation_for_administration(
'd1${run_uuid:2}','race@example.test','sha256:'||repeat('2',64),'2099-01-01'::timestamptz); commit;
SQL
) & invite2=$!
wait_blocked "$(pid_from "$proof_root/invite2.pid")" "$(pid_from "$proof_root/invite1.pid")"
wait "$invite1"; wait "$invite2"
[ "$(run_sql "select count(*) from vortex_identity.organization_invitations where organization_id='$organization_id' and invited_email='race@example.test'")" = 1 ]
grep -q replayed "$proof_root/invite2.out"

set +e
run_sql "begin; select * from vortex_access.resolve_human_organization_change_scope('$replacement_identity','$organization_id');
delete from vortex_context.request_contexts where backend_pid=pg_backend_pid();
select vortex_context.initialize(jsonb_build_object('callerKind','human','identityAuthorityId','ba${run_uuid:2}','tenantId','$tenant_id','organizationId','$organization_id','organizationAccountId','$replacement_account','identityId','$replacement_identity','sessionId','cd${run_uuid:2}','authenticationStrength','single_factor','issuedAt',clock_timestamp(),'expiresAt',clock_timestamp()+interval '1 hour','accessVersion',(select current_version from vortex_access.organization_access_versions where organization_id='$organization_id'),'correlationId','b3${run_uuid:2}')); set local role vortex_request;
select * from vortex_access.create_organization_invitation_for_administration('d1${run_uuid:2}','changed@example.test','sha256:'||repeat('3',64),'2099-01-01'::timestamptz); commit" >"$proof_root/changed.out" 2>"$proof_root/changed.log"
changed_status=$?; set -e
[ "$changed_status" -ne 0 ] && grep -q 'Administration duplicate conflicts' "$proof_root/changed.log"

# Competing expected revisions serialize: one account change, one stale result.
version_before="$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id='$organization_id'")"
( "${psql_command[@]}" >"$proof_root/account1.out" 2>"$proof_root/account1.log" <<SQL
begin; select * from vortex_access.resolve_human_organization_change_scope('$replacement_identity','$organization_id');
delete from vortex_context.request_contexts where backend_pid=pg_backend_pid();
select vortex_context.initialize(jsonb_build_object('callerKind','human','identityAuthorityId','ba${run_uuid:2}','tenantId','$tenant_id','organizationId','$organization_id','organizationAccountId','$replacement_account','identityId','$replacement_identity','sessionId','ce${run_uuid:2}','authenticationStrength','single_factor','issuedAt',clock_timestamp(),'expiresAt',clock_timestamp()+interval '1 hour','accessVersion',(select current_version from vortex_access.organization_access_versions where organization_id='$organization_id'),'correlationId','b4${run_uuid:2}'));
set local role vortex_request; select outcome from vortex_access.suspend_organization_account_for_administration('d2${run_uuid:2}','$target_account',1);
reset role; select pg_backend_pid() \g '$proof_root/account1.pid'
select pg_sleep(2); commit;
SQL
) & account1=$!
wait_file "$proof_root/account1.pid"
( "${psql_command[@]}" >"$proof_root/account2.out" 2>"$proof_root/account2.log" <<SQL
select pg_backend_pid() \g '$proof_root/account2.pid'
begin; select * from vortex_access.resolve_human_organization_change_scope('$replacement_identity','$organization_id');
delete from vortex_context.request_contexts where backend_pid=pg_backend_pid();
select vortex_context.initialize(jsonb_build_object('callerKind','human','identityAuthorityId','ba${run_uuid:2}','tenantId','$tenant_id','organizationId','$organization_id','organizationAccountId','$replacement_account','identityId','$replacement_identity','sessionId','cf${run_uuid:2}','authenticationStrength','single_factor','issuedAt',clock_timestamp(),'expiresAt',clock_timestamp()+interval '1 hour','accessVersion',(select current_version from vortex_access.organization_access_versions where organization_id='$organization_id'),'correlationId','b5${run_uuid:2}'));
set local role vortex_request; select * from vortex_access.close_organization_account_for_administration('d3${run_uuid:2}','$target_account',1); commit;
SQL
) & account2=$!
wait_blocked "$(pid_from "$proof_root/account2.pid")" "$(pid_from "$proof_root/account1.pid")"
wait "$account1"
set +e; wait "$account2"; account2_status=$?; set -e
[ "$account2_status" -ne 0 ] && grep -q 'stale or unavailable' "$proof_root/account2.log"
[ "$(run_sql "select state||'|'||revision from vortex_identity.organization_accounts where organization_account_id='$target_account'")" = 'suspended|2' ]
[ "$(run_sql "select current_version from vortex_access.organization_access_versions where organization_id='$organization_id'")" = "$((version_before+1))" ]

# Revoke wins against acceptance while both contend for governance.
run_sql "insert into vortex_identity.organization_invitations(invitation_id,organization_id,invited_email,token_fingerprint,invited_by_organization_account_id,created_at,invited_at,expires_at,changed_at,revision)
values('38${run_uuid:2}','$organization_id','accept-race@example.test','sha256:'||repeat('4',64),'$replacement_account',clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 day',clock_timestamp(),1)" >/dev/null
( "${psql_command[@]}" >"$proof_root/revoke.out" 2>"$proof_root/revoke.log" <<SQL
begin; select * from vortex_access.resolve_human_organization_change_scope('$replacement_identity','$organization_id');
delete from vortex_context.request_contexts where backend_pid=pg_backend_pid();
select vortex_context.initialize(jsonb_build_object('callerKind','human','identityAuthorityId','ba${run_uuid:2}','tenantId','$tenant_id','organizationId','$organization_id','organizationAccountId','$replacement_account','identityId','$replacement_identity','sessionId','d1${run_uuid:2}','authenticationStrength','single_factor','issuedAt',clock_timestamp(),'expiresAt',clock_timestamp()+interval '1 hour','accessVersion',(select current_version from vortex_access.organization_access_versions where organization_id='$organization_id'),'correlationId','b6${run_uuid:2}'));
set local role vortex_request; select outcome from vortex_access.revoke_organization_invitation_for_administration('d4${run_uuid:2}','38${run_uuid:2}',1);
reset role; select pg_backend_pid() \g '$proof_root/revoke.pid'
select pg_sleep(2); commit;
SQL
) & revoke_worker=$!
wait_file "$proof_root/revoke.pid"
( "${psql_command[@]}" >"$proof_root/accept.out" 2>"$proof_root/accept.log" <<SQL
select pg_backend_pid() \g '$proof_root/accept.pid'
select outcome from vortex_access.accept_organization_invitation('sha256:'||repeat('4',64),
'4c${run_uuid:2}','accept-race@example.test','Invitee','b7${run_uuid:2}');
SQL
) & accept_worker=$!
wait_blocked "$(pid_from "$proof_root/accept.pid")" "$(pid_from "$proof_root/revoke.pid")"
wait "$revoke_worker"; wait "$accept_worker"
grep -q unavailable "$proof_root/accept.out"
[ "$(run_sql "select (revoked_at is not null)::text||'|'||(accepted_at is null)::text from vortex_identity.organization_invitations where invitation_id='38${run_uuid:2}'")" = 'true|true' ]

# A later account closure wins against acceptance of an earlier invitation.
run_sql "begin; select * from vortex_access.resolve_human_organization_change_scope('$replacement_identity','$organization_id');
delete from vortex_context.request_contexts where backend_pid=pg_backend_pid();
select vortex_context.initialize(jsonb_build_object('callerKind','human','identityAuthorityId','ba${run_uuid:2}','tenantId','$tenant_id','organizationId','$organization_id','organizationAccountId','$replacement_account','identityId','$replacement_identity','sessionId','d2${run_uuid:2}','authenticationStrength','single_factor','issuedAt',clock_timestamp(),'expiresAt',clock_timestamp()+interval '1 hour','accessVersion',(select current_version from vortex_access.organization_access_versions where organization_id='$organization_id'),'correlationId','b8${run_uuid:2}')); set local role vortex_request;
select * from vortex_access.reactivate_organization_account_for_administration('d5${run_uuid:2}','$target_account',2); commit" >/dev/null
run_sql "insert into vortex_identity.organization_invitations(invitation_id,organization_id,invited_email,token_fingerprint,invited_by_organization_account_id,created_at,invited_at,expires_at,changed_at,revision)
values('39${run_uuid:2}','$organization_id','inactive-race@example.test','sha256:'||repeat('5',64),'$replacement_account',clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 day',clock_timestamp(),1)" >/dev/null
( "${psql_command[@]}" >"$proof_root/inactive.out" 2>"$proof_root/inactive.log" <<SQL
begin; select * from vortex_access.resolve_human_organization_change_scope('$replacement_identity','$organization_id');
delete from vortex_context.request_contexts where backend_pid=pg_backend_pid();
select vortex_context.initialize(jsonb_build_object('callerKind','human','identityAuthorityId','ba${run_uuid:2}','tenantId','$tenant_id','organizationId','$organization_id','organizationAccountId','$replacement_account','identityId','$replacement_identity','sessionId','d3${run_uuid:2}','authenticationStrength','single_factor','issuedAt',clock_timestamp(),'expiresAt',clock_timestamp()+interval '1 hour','accessVersion',(select current_version from vortex_access.organization_access_versions where organization_id='$organization_id'),'correlationId','b9${run_uuid:2}'));
set local role vortex_request; select outcome from vortex_access.close_organization_account_for_administration('d6${run_uuid:2}','$target_account',3);
reset role; select pg_backend_pid() \g '$proof_root/inactive.pid'
select pg_sleep(2); commit;
SQL
) & inactive_worker=$!
wait_file "$proof_root/inactive.pid"
( "${psql_command[@]}" >"$proof_root/inactive-accept.out" 2>"$proof_root/inactive-accept.log" <<SQL
select pg_backend_pid() \g '$proof_root/inactive-accept.pid'
select outcome from vortex_access.accept_organization_invitation('sha256:'||repeat('5',64),
'$target_identity','inactive-race@example.test','Target','ba${run_uuid:2}');
SQL
) & inactive_accept_worker=$!
wait_blocked "$(pid_from "$proof_root/inactive-accept.pid")" "$(pid_from "$proof_root/inactive.pid")"
wait "$inactive_worker"; wait "$inactive_accept_worker"
grep -q unavailable "$proof_root/inactive-accept.out"
[ "$(run_sql "select account.state||'|'||account.revision||'|'||(invitation.accepted_at is null)::text from vortex_identity.organization_accounts account join vortex_identity.organization_invitations invitation on invitation.invitation_id='39${run_uuid:2}' where account.organization_account_id='$target_account'")" = 'closed|4|true' ]

# Authority removed while a resolved request queues is rechecked and refused.
run_sql "begin;
select * from vortex_access.coordinate_organization_role_assignment_change('grant','$organization_id','$third_assignment',null,'$steward_role',1,'organization_account','$third_account',null,'standing',clock_timestamp()-interval '1 minute',null,'$replacement_account','bb${run_uuid:2}');
select * from vortex_access.coordinate_organization_delegation_authority_change('grant_delegation','$organization_id','$third_delegation',null,'organization_account','$third_account',null,'organization_catalogue',null,null,clock_timestamp()-interval '1 minute',null,'$replacement_account','bc${run_uuid:2}'); commit" >/dev/null
( "${psql_command[@]}" >"$proof_root/authority-revoke.out" 2>"$proof_root/authority-revoke.log" <<SQL
begin; select * from vortex_access.coordinate_organization_role_assignment_change('revoke','$organization_id','$replacement_assignment',1,null,null,null,null,null,null,null,null,'$third_account','be${run_uuid:2}');
select pg_backend_pid() \g '$proof_root/authority-revoke.pid'
select pg_sleep(2); commit;
SQL
) & authority_revoke_worker=$!
wait_file "$proof_root/authority-revoke.pid"
( "${psql_command[@]}" >"$proof_root/authority-request.out" 2>"$proof_root/authority-request.log" <<SQL
select pg_backend_pid() \g '$proof_root/authority-request.pid'
begin; select * from vortex_access.resolve_human_organization_change_scope('$replacement_identity','$organization_id');
delete from vortex_context.request_contexts where backend_pid=pg_backend_pid();
select vortex_context.initialize(jsonb_build_object('callerKind','human','identityAuthorityId','ba${run_uuid:2}','tenantId','$tenant_id','organizationId','$organization_id','organizationAccountId','$replacement_account','identityId','$replacement_identity','sessionId','d4${run_uuid:2}','authenticationStrength','single_factor','issuedAt',clock_timestamp(),'expiresAt',clock_timestamp()+interval '1 hour','accessVersion',(select current_version from vortex_access.organization_access_versions where organization_id='$organization_id'),'correlationId','bd${run_uuid:2}'));
set local role vortex_request; select * from vortex_access.create_organization_invitation_for_administration('d7${run_uuid:2}','removed-authority@example.test','sha256:'||repeat('6',64),clock_timestamp()+interval '1 day'); commit;
SQL
) & authority_request_worker=$!
wait_blocked "$(pid_from "$proof_root/authority-request.pid")" "$(pid_from "$proof_root/authority-revoke.pid")"
wait "$authority_revoke_worker"
set +e; wait "$authority_request_worker"; authority_request_status=$?; set -e
[ "$authority_request_status" -ne 0 ] && grep -q 'Organization invitation administration change is unavailable' "$proof_root/authority-request.log"
[ "$(run_sql "select count(*) from vortex_identity.organization_invitations where organization_id='$organization_id' and invited_email='removed-authority@example.test'")" = 0 ]
[ "$(run_sql "select count(*) from vortex_identity.accepted_administration_receipts where tenant_id='$tenant_id' and actor_id='$replacement_account' and operation_key='create_organization_invitation' and duplicate_key='d7${run_uuid:2}'")" = 0 ]

# One account change overlaps a request read plus configured projection and tenant lifecycle.
run_sql "begin; select * from vortex_access.resolve_human_organization_change_scope('$third_identity','$organization_id');
delete from vortex_context.request_contexts where backend_pid=pg_backend_pid();
select vortex_context.initialize(jsonb_build_object('callerKind','human','identityAuthorityId','ba${run_uuid:2}','tenantId','$tenant_id','organizationId','$organization_id','organizationAccountId','$third_account','identityId','$third_identity','sessionId','d5${run_uuid:2}','authenticationStrength','single_factor','issuedAt',clock_timestamp(),'expiresAt',clock_timestamp()+interval '1 hour','accessVersion',(select current_version from vortex_access.organization_access_versions where organization_id='$organization_id'),'correlationId','bf${run_uuid:2}')); set local role vortex_request;
select * from vortex_access.reactivate_organization_account_for_administration('d8${run_uuid:2}','$target_account',4); commit" >/dev/null
( "${psql_command[@]}" >"$proof_root/overlap-change.out" 2>"$proof_root/overlap-change.log" <<SQL
begin; select * from vortex_access.resolve_human_organization_change_scope('$third_identity','$organization_id');
delete from vortex_context.request_contexts where backend_pid=pg_backend_pid();
select vortex_context.initialize(jsonb_build_object('callerKind','human','identityAuthorityId','ba${run_uuid:2}','tenantId','$tenant_id','organizationId','$organization_id','organizationAccountId','$third_account','identityId','$third_identity','sessionId','d6${run_uuid:2}','authenticationStrength','single_factor','issuedAt',clock_timestamp(),'expiresAt',clock_timestamp()+interval '1 hour','accessVersion',(select current_version from vortex_access.organization_access_versions where organization_id='$organization_id'),'correlationId','c0${run_uuid:2}'));
set local role vortex_request; select outcome from vortex_access.suspend_organization_account_for_administration('d9${run_uuid:2}','$target_account',5);
reset role; select pg_backend_pid() \g '$proof_root/overlap-change.pid'
select pg_sleep(6); commit;
SQL
) & overlap_change_worker=$!
wait_file "$proof_root/overlap-change.pid"
( "${psql_command[@]}" >"$proof_root/overlap-read.out" 2>"$proof_root/overlap-read.log" <<SQL
select pg_backend_pid() \g '$proof_root/overlap-read.pid'
begin; select * from vortex_access.resolve_human_organization_change_scope('$third_identity','$organization_id');
delete from vortex_context.request_contexts where backend_pid=pg_backend_pid();
select vortex_context.initialize(jsonb_build_object('callerKind','human','identityAuthorityId','ba${run_uuid:2}','tenantId','$tenant_id','organizationId','$organization_id','organizationAccountId','$third_account','identityId','$third_identity','sessionId','d7${run_uuid:2}','authenticationStrength','single_factor','issuedAt',clock_timestamp(),'expiresAt',clock_timestamp()+interval '1 hour','accessVersion',(select current_version from vortex_access.organization_access_versions where organization_id='$organization_id'),'correlationId','c1${run_uuid:2}')); set local role vortex_request;
select accounts::text from vortex_access.list_organization_accounts_for_administration(null,100); commit;
SQL
) & overlap_read_worker=$!
( "${psql_command[@]}" >"$proof_root/overlap-projection.out" 2>"$proof_root/overlap-projection.log" <<SQL
select pg_backend_pid() \g '$proof_root/overlap-projection.pid'
begin; set local role vortex_runtime; select outcome from vortex_identity.suspend_cluster_identity('c8${run_uuid:2}','$actor_id','da${run_uuid:2}','sha256:'||repeat('8',64),'$target_identity',1); commit;
SQL
) & overlap_projection_worker=$!
( "${psql_command[@]}" >"$proof_root/overlap-tenant.out" 2>"$proof_root/overlap-tenant.log" <<SQL
\set VERBOSITY verbose
select pg_backend_pid() \g '$proof_root/overlap-tenant.pid'
begin; set local role vortex_runtime; select outcome from vortex_identity.suspend_tenant('c8${run_uuid:2}','$actor_id','db${run_uuid:2}','sha256:'||repeat('9',64),'$tenant_id',1); commit;
SQL
) & overlap_tenant_worker=$!
wait_blocked "$(pid_from "$proof_root/overlap-read.pid")" "$(pid_from "$proof_root/overlap-change.pid")" 'request read wait behind the account change'
wait_blocked "$(pid_from "$proof_root/overlap-tenant.pid")" "$(pid_from "$proof_root/overlap-read.pid")" 'tenant lifecycle wait behind the request read'
wait_blocked "$(pid_from "$proof_root/overlap-projection.pid")" "$(pid_from "$proof_root/overlap-tenant.pid")" 'projection lifecycle wait behind the tenant lifecycle'
wait "$overlap_change_worker"; wait "$overlap_read_worker"; wait "$overlap_projection_worker"; wait "$overlap_tenant_worker"
grep -q accepted "$proof_root/overlap-change.out"
grep -q '"state": "active"' "$proof_root/overlap-read.out"
grep -q accepted "$proof_root/overlap-projection.out"
grep -q accepted "$proof_root/overlap-tenant.out"
[ "$(run_sql "select state from vortex_identity.identity_projections where identity_id='$target_identity'")" = suspended ]
[ "$(run_sql "select state||'|'||revision from vortex_identity.tenants where tenant_id='$tenant_id'")" = 'suspended|2' ]
[ "$(run_sql "select state||'|'||revision from vortex_identity.organization_accounts where organization_account_id='$target_account'")" = 'suspended|6' ]

echo 'organization-local administration change concurrency proof passed'
