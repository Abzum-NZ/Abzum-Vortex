create or replace function vortex_access.withdraw_record_share_grant_for_administration(
  p_grant_id uuid,
  p_expected_revision bigint,
  p_reason text,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  context_application_root_id uuid;
  locked_access_version bigint;
  stored vortex_access.record_share_grants%rowtype;
  now_value timestamptz := pg_catalog.statement_timestamp();
  append_result text;
begin
  if p_grant_id is null or p_grant_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991
    or p_reason is null or pg_catalog.char_length(p_reason) not between 1 and 500
    or p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Record-share grant withdrawal is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;
  context_application_root_id := case
    when context_value ? 'applicationRootId' then (context_value ->> 'applicationRootId')::uuid
    else null end;
  if context_application_root_id is null then
    raise exception using errcode = '42501',
      message = 'Record-share grant withdrawal requires an application context';
  end if;

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active' and tenant.state = 'active'
  for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Record-share grant withdrawal is unavailable';
  end if;

  select grants.* into stored
  from vortex_access.record_share_grants as grants
  where grants.grant_id = p_grant_id
    and grants.source_organization_id = context_organization_id
    and grants.source_application_root_id = context_application_root_id
  for update;
  if not found then
    raise exception using errcode = '42501',
      message = 'Record-share grant withdrawal is unavailable';
  end if;
  if stored.revision <> p_expected_revision or stored.status not in ('draft', 'pending_consent') then
    raise exception using errcode = '40001',
      message = 'Record-share grant is stale or no longer a proposal';
  end if;

  -- Withdrawing only narrows, so it needs no field ceiling. The proposer may
  -- always withdraw its own proposal; anyone else needs the same current
  -- row-independent share authority over the proposal's scope that proposing
  -- it would need (the protected share revocation rule, 20260910114716 F2).
  if (stored.created_by_organization_account_id <> context_account_id
      or context_value ? 'delegatedContext' or context_value ? 'supportContext')
    and pg_catalog.jsonb_array_length(
      vortex_access.record_share_grant_source_authority_internal(
        context_value, stored.module_root_id, stored.record_type_id
      ) -> 'recordTypeIds'
    ) = 0 then
    raise exception using errcode = '42501',
      message = 'Record-share grant withdrawal is unavailable';
  end if;

  update vortex_access.record_share_grants as grants
  set status = 'revoked',
      revoked_at = now_value,
      revoked_by_organization_account_id = context_account_id,
      revocation_reason = p_reason,
      revision = grants.revision + 1,
      changed_at = now_value
  where grants.grant_id = p_grant_id;

  if stored.consent_request_id is not null then
    update vortex_access.record_share_grant_consent_requests as requests
    set status = 'withdrawn', revision = requests.revision + 1, changed_at = now_value
    where requests.request_id = stored.consent_request_id;
  end if;

  append_result := vortex_activity.append_organization_activity_entry(
    context_organization_id, p_activity_id, now_value, 'organization_account',
    context_account_id, 'withdraw_record_share_grant', array[p_grant_id]::uuid[],
    array[]::uuid[], vortex_context.channel(), context_correlation_id, 'completed'
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Record-share grant withdrawal Activity is stale';
  end if;

  return vortex_access.record_share_grant_json_internal(p_grant_id);
end
$function$;

revoke all on function vortex_access.withdraw_record_share_grant_for_administration(
  uuid, bigint, text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;
grant execute on function vortex_access.withdraw_record_share_grant_for_administration(
  uuid, bigint, text, uuid
) to vortex_request;

comment on function vortex_access.withdraw_record_share_grant_for_administration(
  uuid, bigint, text, uuid
) is
  'Fixed protected withdrawal: its proposer, or a holder of current row-independent share authority over its scope, revokes a draft or pending_consent proposal of the context organisation and application under an exact expected revision and withdraws its consent request.';
