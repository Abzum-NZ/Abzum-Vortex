create or replace function vortex_access.propose_record_share_grant_for_administration(
  p_grant_id uuid,
  p_consent_request_id uuid,
  p_terms jsonb,
  p_proposal_fingerprint text,
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
  cross_organization boolean;
  now_value timestamptz := pg_catalog.statement_timestamp();
  append_result text;
begin
  if p_grant_id is null or p_grant_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_proposal_fingerprint is null or p_proposal_fingerprint !~ '^sha256:[a-f0-9]{64}$'
    or p_terms is null or pg_catalog.jsonb_typeof(p_terms) <> 'object'
    or (p_consent_request_id is not null
      and p_consent_request_id = '00000000-0000-0000-0000-000000000000'::uuid) then
    raise exception using errcode = '22023',
      message = 'Record-share grant proposal is invalid';
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
      message = 'Record-share grant proposal requires an application context';
  end if;

  -- Take the organisation governance lock before evaluating any authority, so a
  -- concurrent authority change cannot land between the check and the write.
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
      message = 'Record-share grant proposal is unavailable';
  end if;

  perform vortex_access.check_record_share_grant_terms_internal(p_terms, context_value);

  cross_organization := (p_terms ->> 'recipientOrganizationId')::uuid
    <> context_organization_id;
  if cross_organization is distinct from (p_consent_request_id is not null) then
    raise exception using errcode = '22023',
      message = 'Record-share grant proposal is invalid';
  end if;

  insert into vortex_access.record_share_grants (
    grant_id, source_organization_id, source_cluster_id, source_application_root_id,
    recipient_cluster_id, recipient_organization_id, recipient_application_root_id,
    scope_kind, module_root_id, record_type_id, record_id, saved_condition_id,
    saved_condition_revision, saved_condition_fingerprint, saved_condition_parameters,
    readable_field_ids, changeable_field_ids, recipient_role_ids, allowed_action_keys,
    export_allowed, approved_recipient_region, starts_at, expires_at, status,
    created_by_organization_account_id, consent_request_id, contract_version,
    contract_fingerprint, recipient_binding_id, definition_mapping_fingerprint,
    proposal_fingerprint, revision, created_at, changed_at
  ) values (
    p_grant_id, context_organization_id, (p_terms ->> 'sourceClusterId')::uuid,
    context_application_root_id, (p_terms ->> 'recipientClusterId')::uuid,
    (p_terms ->> 'recipientOrganizationId')::uuid,
    (p_terms ->> 'recipientApplicationRootId')::uuid,
    p_terms ->> 'scopeKind', (p_terms ->> 'moduleRootId')::uuid,
    (p_terms ->> 'recordTypeId')::uuid, (p_terms ->> 'recordId')::uuid,
    (p_terms ->> 'savedConditionId')::uuid, (p_terms ->> 'savedConditionRevision')::bigint,
    p_terms ->> 'savedConditionFingerprint', p_terms -> 'parameters',
    vortex_access.record_share_grant_uuid_array_internal(p_terms -> 'readableFieldIds', 1, 500),
    vortex_access.record_share_grant_uuid_array_internal(p_terms -> 'changeableFieldIds', 0, 500),
    vortex_access.record_share_grant_uuid_array_internal(p_terms -> 'recipientRoleIds', 1, 100),
    array(select pg_catalog.jsonb_array_elements_text(p_terms -> 'allowedActionKeys')),
    (p_terms ->> 'exportAllowed')::boolean, p_terms ->> 'approvedRecipientRegion',
    (p_terms ->> 'startsAt')::timestamptz, (p_terms ->> 'expiresAt')::timestamptz,
    case when cross_organization then 'pending_consent' else 'draft' end,
    context_account_id, p_consent_request_id, p_terms ->> 'contractVersion',
    p_terms ->> 'contractFingerprint', (p_terms ->> 'recipientBindingId')::uuid,
    p_terms ->> 'definitionMappingFingerprint', p_proposal_fingerprint, 1,
    now_value, now_value
  );

  -- The grant's foreign key to its consent request is deferred, so the request
  -- follows the grant it names.
  if cross_organization then
    insert into vortex_access.record_share_grant_consent_requests (
      request_id, grant_id, source_organization_id, source_cluster_id,
      recipient_organization_id, recipient_cluster_id, proposed_grant_fingerprint,
      status, requested_by_organization_account_id, requested_at,
      source_authorizing_role_ids, recipient_accepting_role_ids, expires_at,
      revision, changed_at
    ) values (
      p_consent_request_id, p_grant_id, context_organization_id,
      (p_terms ->> 'sourceClusterId')::uuid,
      (p_terms ->> 'recipientOrganizationId')::uuid,
      (p_terms ->> 'recipientClusterId')::uuid, p_proposal_fingerprint,
      'pending', context_account_id, now_value,
      vortex_access.record_share_grant_uuid_array_internal(
        p_terms -> 'sourceAuthorizingRoleIds', 1, 100),
      vortex_access.record_share_grant_uuid_array_internal(
        p_terms -> 'recipientAcceptingRoleIds', 1, 100),
      (p_terms ->> 'expiresAt')::timestamptz, 1, now_value
    );
  end if;


  append_result := vortex_activity.append_organization_activity_entry(
    context_organization_id, p_activity_id, now_value, 'organization_account',
    context_account_id, 'propose_record_share_grant', array[p_grant_id]::uuid[],
    array[]::uuid[], vortex_context.channel(), context_correlation_id, 'completed'
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Record-share grant proposal Activity is stale';
  end if;

  return vortex_access.record_share_grant_json_internal(p_grant_id);
end
$function$;

revoke all on function vortex_access.propose_record_share_grant_for_administration(
  uuid, uuid, jsonb, text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;
grant execute on function vortex_access.propose_record_share_grant_for_administration(
  uuid, uuid, jsonb, text, uuid
) to vortex_request;

comment on function vortex_access.propose_record_share_grant_for_administration(
  uuid, uuid, jsonb, text, uuid
) is
  'Fixed protected proposer: stores one exact record-share grant proposal for the context organisation after re-checking its current share authority; cross-organisation proposals stop at pending_consent with a consent request bound to the proposal fingerprint.';
