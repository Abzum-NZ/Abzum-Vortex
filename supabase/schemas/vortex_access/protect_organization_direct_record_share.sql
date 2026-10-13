CREATE FUNCTION vortex_access.protect_organization_direct_record_share() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514',
      message = 'Direct record shares cannot be deleted';
  end if;

  if old.revision = 9007199254740991 then
    raise exception using errcode = '22003',
      message = 'Direct record-share revision is exhausted';
  end if;

  if old.state = 'revoked'
    or new.organization_id is distinct from old.organization_id
    or new.direct_share_id is distinct from old.direct_share_id
    or new.storage_scope is distinct from old.storage_scope
    or new.application_root_id is distinct from old.application_root_id
    or new.module_root_id is distinct from old.module_root_id
    or new.record_type_id is distinct from old.record_type_id
    or new.storage_contract_id is distinct from old.storage_contract_id
    or new.record_id is distinct from old.record_id
    or new.recipient_kind is distinct from old.recipient_kind
    or new.organization_account_id is distinct from old.organization_account_id
    or new.group_id is distinct from old.group_id
    or new.readable_field_ids is distinct from old.readable_field_ids
    or new.changeable_field_ids is distinct from old.changeable_field_ids
    or new.starts_at is distinct from old.starts_at
    or new.expires_at is distinct from old.expires_at
    or new.granted_by is distinct from old.granted_by
    or new.granted_at is distinct from old.granted_at
    or new.grant_correlation_id is distinct from old.grant_correlation_id
    or new.reason is distinct from old.reason
    or new.state <> 'revoked'
    or new.revision <> old.revision + 1
    or new.changed_at < old.changed_at then
    raise exception using errcode = '23514',
      message = 'Direct record-share identity, grant evidence or lifecycle is immutable';
  end if;

  return new;
end
$$;

ALTER FUNCTION vortex_access.protect_organization_direct_record_share() OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.protect_organization_direct_record_share() FROM PUBLIC;
