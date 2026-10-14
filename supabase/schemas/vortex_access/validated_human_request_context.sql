CREATE OR REPLACE FUNCTION vortex_access.validated_human_request_context() RETURNS jsonb
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  checked jsonb;
  stored record;
  current_transaction_id xid8 := pg_catalog.pg_current_xact_id_if_assigned();
  request_role text := pg_catalog.current_setting('role');
  cache_hit boolean := false;
begin
  select established.transaction_id, established.context,
    established.validated_transaction_id, established.validated_role,
    established.validated_human_context
  into stored
  from vortex_platform.request_contexts as established
  where established.backend_pid = pg_catalog.pg_backend_pid()
    and established.transaction_id = current_transaction_id;

  if found
    and stored.validated_transaction_id = current_transaction_id
    and stored.validated_role = request_role
    and stored.validated_human_context = stored.context then
    cache_hit := true;
    checked := stored.validated_human_context;

    if (checked ->> 'expiresAt')::timestamptz <= pg_catalog.statement_timestamp() then
      raise exception using errcode = '22023', message = 'Vortex request context is expired or inconsistent';
    end if;
    if checked ? 'delegatedContext'
      and (checked #>> '{delegatedContext,expiresAt}')::timestamptz <= pg_catalog.statement_timestamp() then
      raise exception using errcode = '22023', message = 'Vortex delegated context is expired or inconsistent';
    end if;
    if checked ? 'supportContext'
      and (checked #>> '{supportContext,expiresAt}')::timestamptz <= pg_catalog.statement_timestamp() then
      raise exception using errcode = '22023', message = 'Vortex support context is expired or inconsistent';
    end if;

    if not exists (
      select 1
      from vortex_identity.organization_accounts as account
      join vortex_identity.organizations as organization
        on organization.organization_id = account.organization_id
      join vortex_identity.tenants as tenant
        on tenant.tenant_id = organization.tenant_id
      join vortex_identity.identity_projections as identity
        on identity.identity_id = account.identity_id
      where account.organization_account_id = (checked ->> 'organizationAccountId')::uuid
        and account.organization_id = (checked ->> 'organizationId')::uuid
        and account.identity_id = (checked ->> 'identityId')::uuid
        and organization.tenant_id = (checked ->> 'tenantId')::uuid
        and account.state = 'active'
        and identity.state = 'active'
        and organization.state = 'active'
        and tenant.state = 'active'
    ) then
      raise exception using errcode = '42501', message = 'Organisation-account context is inactive or unavailable';
    end if;
  else
    checked := vortex_identity.validated_human_account_context();
  end if;

  if not exists (
    select 1
    from vortex_access.organization_access_versions as version
    where version.organization_id = (checked ->> 'organizationId')::uuid
      and version.current_version = (checked ->> 'accessVersion')::bigint
  ) then
    raise exception using errcode = '42501', message = 'Request access version is stale or unavailable';
  end if;

  if not cache_hit then
    update vortex_platform.request_contexts as established
    set validated_transaction_id = current_transaction_id,
      validated_role = request_role,
      validated_human_context = checked
    where established.backend_pid = pg_catalog.pg_backend_pid()
      and established.transaction_id = current_transaction_id
      and established.context = checked;
  end if;

  return checked;
end
$$;

alter function vortex_access.validated_human_request_context() owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.validated_human_request_context() IS 'Fails closed unless the current human account and Access version are still live.';

REVOKE ALL ON FUNCTION vortex_access.validated_human_request_context() FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.validated_human_request_context() TO vortex_request;
GRANT ALL ON FUNCTION vortex_access.validated_human_request_context() TO vortex_owner;
GRANT ALL ON FUNCTION vortex_access.validated_human_request_context() TO vortex_record_adapter;
GRANT ALL ON FUNCTION vortex_access.validated_human_request_context() TO vortex_owner;
GRANT ALL ON FUNCTION vortex_access.validated_human_request_context() TO vortex_owner;
GRANT ALL ON FUNCTION vortex_access.validated_human_request_context() TO vortex_owner;
GRANT ALL ON FUNCTION vortex_access.validated_human_request_context() TO vortex_owner;
GRANT ALL ON FUNCTION vortex_access.validated_human_request_context() TO vortex_owner;

grant execute on function vortex_access.validated_human_request_context() to postgres;
