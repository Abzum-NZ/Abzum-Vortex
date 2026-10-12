CREATE FUNCTION vortex_access.record_share_grant_json_internal(p_grant_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  stored vortex_access.record_share_grants%rowtype;
  consent vortex_access.record_share_grant_consent_requests%rowtype;
  grant_json jsonb;
  consent_json jsonb := null;
begin
  select grants.* into strict stored
  from vortex_access.record_share_grants as grants
  where grants.grant_id = p_grant_id;

  grant_json := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'scopeKind', stored.scope_kind,
    'grantId', stored.grant_id,
    'sourceClusterId', stored.source_cluster_id,
    'sourceOrganizationId', stored.source_organization_id,
    'sourceApplicationRootId', stored.source_application_root_id,
    'recipientClusterId', stored.recipient_cluster_id,
    'recipientOrganizationId', stored.recipient_organization_id,
    'recipientApplicationRootId', stored.recipient_application_root_id,
    'readableFieldIds', pg_catalog.to_jsonb(stored.readable_field_ids),
    'changeableFieldIds', pg_catalog.to_jsonb(stored.changeable_field_ids),
    'recipientRoleIds', pg_catalog.to_jsonb(stored.recipient_role_ids),
    'moduleRootId', stored.module_root_id,
    'allowedActionKeys', pg_catalog.to_jsonb(stored.allowed_action_keys),
    'exportAllowed', stored.export_allowed,
    'approvedRecipientRegion', stored.approved_recipient_region,
    'startsAt', pg_catalog.to_char(
      stored.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'expiresAt', case when stored.expires_at is null then null else pg_catalog.to_char(
      stored.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ) end,
    'status', stored.status,
    'createdByOrganizationAccountId', stored.created_by_organization_account_id,
    'consentRequestId', stored.consent_request_id,
    'contractVersion', stored.contract_version,
    'contractFingerprint', stored.contract_fingerprint,
    'recipientBindingId', stored.recipient_binding_id,
    'definitionMappingFingerprint', stored.definition_mapping_fingerprint,
    'recordTypeId', stored.record_type_id,
    'recordId', stored.record_id,
    'savedConditionId', stored.saved_condition_id,
    'savedConditionRevision', stored.saved_condition_revision,
    'savedConditionFingerprint', stored.saved_condition_fingerprint,
    'revokedAt', case when stored.revoked_at is null then null else pg_catalog.to_char(
      stored.revoked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ) end,
    'revokedByOrganizationAccountId', stored.revoked_by_organization_account_id,
    'revocationReason', stored.revocation_reason
  ))
  -- Parameters are added after null stripping so a saved condition's exact
  -- parameter object survives unchanged.
  || case when stored.scope_kind = 'saved_condition'
    then pg_catalog.jsonb_build_object('parameters', stored.saved_condition_parameters)
    else '{}'::jsonb end;

  if stored.consent_request_id is not null then
    select requests.* into strict consent
    from vortex_access.record_share_grant_consent_requests as requests
    where requests.request_id = stored.consent_request_id;
    consent_json := pg_catalog.jsonb_build_object(
      'requestId', consent.request_id,
      'sourceOrganizationId', consent.source_organization_id,
      'sourceClusterId', consent.source_cluster_id,
      'recipientOrganizationId', consent.recipient_organization_id,
      'recipientClusterId', consent.recipient_cluster_id,
      'proposedGrantFingerprint', consent.proposed_grant_fingerprint,
      'status', consent.status,
      'requestedByOrganizationAccountId', consent.requested_by_organization_account_id,
      'requestedAt', pg_catalog.to_char(
        consent.requested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'requiredDecisions', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'side', 'source_authorization',
          'authorizedRoleIds', pg_catalog.to_jsonb(consent.source_authorizing_role_ids)
        ),
        pg_catalog.jsonb_build_object(
          'side', 'recipient_acceptance',
          'authorizedRoleIds', pg_catalog.to_jsonb(consent.recipient_accepting_role_ids)
        )
      ),
      'expiresAt', pg_catalog.to_char(
        consent.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'grant', grant_json,
    'consentRequest', consent_json,
    'proposalFingerprint', stored.proposal_fingerprint,
    'revision', stored.revision,
    'changedAt', pg_catalog.to_char(
      stored.changed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  );
end
$$;


ALTER FUNCTION vortex_access.record_share_grant_json_internal(p_grant_id uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.record_share_grant_json_internal(p_grant_id uuid) FROM PUBLIC;
