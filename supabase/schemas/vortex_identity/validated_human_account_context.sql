CREATE OR REPLACE FUNCTION vortex_identity.validated_human_account_context() RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
declare
  checked jsonb;
begin
  checked := vortex_platform.current_context();
  if checked ->> 'callerKind' is distinct from 'human'
    or not checked ?& array['identityId', 'organizationAccountId'] then
    raise exception using errcode = '42501', message = 'Organisation-account operation requires human context';
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

  return checked;
end
$$;

ALTER FUNCTION vortex_identity.validated_human_account_context() OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_identity.validated_human_account_context() FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_identity.validated_human_account_context() TO vortex_owner;
