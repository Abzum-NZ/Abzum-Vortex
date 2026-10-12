CREATE FUNCTION vortex_access.fence_record_owner_account_target_internal() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if new.owner_organisation_account_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if new.owner_organisation_account_id is not distinct from old.owner_organisation_account_id
      and new.organisation_id is not distinct from old.organisation_id then
      return new;
    end if;
  end if;

  perform 1
  from vortex_identity.organization_accounts as account
  where account.organization_id = new.organisation_id
    and account.organization_account_id = new.owner_organisation_account_id
    and account.state = 'active'
  for share of account;

  if not found then
    raise exception using errcode = '40001', message = 'Record owner account is not active';
  end if;

  return new;
end
$$;


ALTER FUNCTION vortex_access.fence_record_owner_account_target_internal() OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.fence_record_owner_account_target_internal() IS 'Row trigger on every Record table: an assigned account owner must be active in the row organisation, under a share lock on the account.';

REVOKE ALL ON FUNCTION vortex_access.fence_record_owner_account_target_internal() FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.fence_record_owner_account_target_internal() TO vortex_record_owner;
