CREATE FUNCTION vortex_record.finalize_account_deletion_fence(p_organization_account_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  scope record;
  target record;
  changed record;
  resulting_revision bigint;
begin
  if p_organization_account_id is null
    or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Account deletion command is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_accounts_offboarding_inventory_scope_internal() as authorized;

  -- After the lock wait, each later statement must read the rows committed
  -- by the writers it waited for; an older transaction snapshot cannot.
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = '55000',
      message = 'Account deletion inventory completeness cannot be proved';
  end if;

  select locked.state, locked.revision into target
  from vortex_identity.lock_organization_account_for_deletion_internal(
    p_organization_account_id
  ) as locked;

  if not found then
    return pg_catalog.jsonb_build_object(
      'outcome', 'not_closing',
      'accessVersion', scope.access_version
    );
  end if;

  if target.state not in ('closing', 'deleted') then
    return pg_catalog.jsonb_build_object(
      'outcome', 'not_closing',
      'organizationAccountId', p_organization_account_id,
      'state', target.state,
      'revision', target.revision,
      'accessVersion', scope.access_version
    );
  end if;

  resulting_revision := target.revision;
  if target.state = 'closing' then
    if vortex_record.account_retains_owned_records_internal(p_organization_account_id) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'records_remain',
        'accessVersion', scope.access_version
      );
    end if;

    select result.* into strict changed
    from vortex_identity.finalize_organization_account_deletion(
      p_organization_account_id, target.revision
    ) as result;

    if changed.organization_id <> scope.organization_id
      or changed.organization_account_id <> p_organization_account_id
      or changed.state <> 'deleted'
      or changed.revision <> target.revision + 1 then
      raise exception using errcode = '42501', message = 'Account deletion result is unavailable';
    end if;
    resulting_revision := changed.revision;
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'deleted',
    'organizationAccountId', p_organization_account_id,
    'state', 'deleted',
    'revision', resulting_revision,
    'accessVersion', scope.access_version
  );
end
$$;

COMMENT ON FUNCTION vortex_record.finalize_account_deletion_fence(p_organization_account_id uuid) IS 'Protected final account-deletion fence: accounts.manage, exclusive account lock, private all-scope inventory, then closing-to-deleted only when nothing is owned.';

REVOKE ALL ON FUNCTION vortex_record.finalize_account_deletion_fence(p_organization_account_id uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION vortex_record.finalize_account_deletion_fence(p_organization_account_id uuid) FROM vortex_record_adapter;
GRANT ALL ON FUNCTION vortex_record.finalize_account_deletion_fence(p_organization_account_id uuid) TO vortex_request;
