CREATE OR REPLACE FUNCTION vortex_access.read_current_direct_record_share_contributions(p_binding_organization_id uuid, p_binding_application_root_id uuid, p_binding_module_root_id uuid, p_binding_record_type_id uuid, p_binding_storage_contract_id uuid, p_binding_storage_scope text, p_record_id uuid, p_current_organization_id uuid, p_current_application_root_id uuid, p_current_organization_account_id uuid, p_checked_at timestamp with time zone) RETURNS TABLE(direct_share_id uuid, direct_share_revision bigint, recipient_kind text, organization_account_id uuid, group_id uuid, readable_field_ids uuid[], changeable_field_ids uuid[], valid_until timestamp with time zone)
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if not vortex_platform.is_non_nil_uuid(p_binding_organization_id::text)
    or not vortex_platform.is_non_nil_uuid(p_binding_application_root_id::text)
    or not vortex_platform.is_non_nil_uuid(p_binding_module_root_id::text)
    or not vortex_platform.is_non_nil_uuid(p_binding_record_type_id::text)
    or not vortex_platform.is_non_nil_uuid(p_binding_storage_contract_id::text)
    or not vortex_platform.is_non_nil_uuid(p_record_id::text)
    or not vortex_platform.is_non_nil_uuid(p_current_organization_id::text)
    or not vortex_platform.is_non_nil_uuid(p_current_application_root_id::text)
    or not vortex_platform.is_non_nil_uuid(p_current_organization_account_id::text)
    or p_binding_storage_scope is null
    or p_binding_storage_scope not in ('organization_shared', 'application_contained')
    or p_checked_at is null
    or p_checked_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_binding_organization_id <> p_current_organization_id
    or p_binding_application_root_id <> p_current_application_root_id then
    raise exception using errcode = '22023',
      message = 'Direct record-share contribution evidence is invalid';
  end if;

  return query
  select
    share.direct_share_id,
    share.revision,
    share.recipient_kind,
    share.organization_account_id,
    share.group_id,
    share.readable_field_ids,
    share.changeable_field_ids,
    case
      when share.recipient_kind = 'organization_account' then share.expires_at
      when share.expires_at is null then membership.expires_at
      when membership.expires_at is null then share.expires_at
      else least(share.expires_at, membership.expires_at)
    end
  from vortex_access.organization_direct_record_shares as share
  left join vortex_access.organization_groups as recipient_group
    on share.recipient_kind = 'group'
    and recipient_group.organization_id = share.organization_id
    and recipient_group.group_id = share.group_id
    and recipient_group.state = 'active'
  left join vortex_access.organization_group_memberships as membership
    on recipient_group.organization_id is not null
    and membership.organization_id = share.organization_id
    and membership.group_id = share.group_id
    and membership.organization_account_id = p_current_organization_account_id
    and membership.state = 'live'
    and membership.starts_at <= p_checked_at
    and (membership.expires_at is null or membership.expires_at > p_checked_at)
  where share.organization_id = p_binding_organization_id
    and share.storage_scope = p_binding_storage_scope
    and share.application_root_id is not distinct from case
      when p_binding_storage_scope = 'application_contained'
        then p_binding_application_root_id
      else null::uuid
    end
    and share.module_root_id = p_binding_module_root_id
    and share.record_type_id = p_binding_record_type_id
    and share.storage_contract_id = p_binding_storage_contract_id
    and share.record_id = p_record_id
    and share.state = 'active'
    and share.starts_at <= p_checked_at
    and (share.expires_at is null or share.expires_at > p_checked_at)
    and (
      (
        share.recipient_kind = 'organization_account'
        and share.organization_account_id = p_current_organization_account_id
      ) or (
        share.recipient_kind = 'group'
        and membership.membership_id is not null
      )
    )
  order by share.direct_share_id;
end
$$;

ALTER FUNCTION vortex_access.read_current_direct_record_share_contributions(p_binding_organization_id uuid, p_binding_application_root_id uuid, p_binding_module_root_id uuid, p_binding_record_type_id uuid, p_binding_storage_contract_id uuid, p_binding_storage_scope text, p_record_id uuid, p_current_organization_id uuid, p_current_application_root_id uuid, p_current_organization_account_id uuid, p_checked_at timestamp with time zone) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.read_current_direct_record_share_contributions(p_binding_organization_id uuid, p_binding_application_root_id uuid, p_binding_module_root_id uuid, p_binding_record_type_id uuid, p_binding_storage_contract_id uuid, p_binding_storage_scope text, p_record_id uuid, p_current_organization_id uuid, p_current_application_root_id uuid, p_current_organization_account_id uuid, p_checked_at timestamp with time zone) IS 'Returns independent current account or Group direct-share field contributions for one exact trusted record binding; it does not union fields or grant permission.';

REVOKE ALL ON FUNCTION vortex_access.read_current_direct_record_share_contributions(p_binding_organization_id uuid, p_binding_application_root_id uuid, p_binding_module_root_id uuid, p_binding_record_type_id uuid, p_binding_storage_contract_id uuid, p_binding_storage_scope text, p_record_id uuid, p_current_organization_id uuid, p_current_application_root_id uuid, p_current_organization_account_id uuid, p_checked_at timestamp with time zone) FROM PUBLIC;
