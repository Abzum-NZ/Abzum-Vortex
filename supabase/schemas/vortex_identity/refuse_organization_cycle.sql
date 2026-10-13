CREATE FUNCTION vortex_identity.refuse_organization_cycle() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  -- Keep serialisation and cycle validation in the same trigger so their
  -- correctness cannot depend on trigger-name ordering.
  perform 1
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = new.tenant_id
  for update;

  if new.parent_organization_id is null then
    return new;
  end if;

  if exists (
    with recursive ancestors as (
      select candidate.organization_id, candidate.parent_organization_id
      from vortex_identity.organizations as candidate
      where candidate.tenant_id = new.tenant_id
        and candidate.organization_id = new.parent_organization_id

      union

      select parent.organization_id, parent.parent_organization_id
      from vortex_identity.organizations as parent
      join ancestors on ancestors.parent_organization_id = parent.organization_id
      where parent.tenant_id = new.tenant_id
    )
    select 1
    from ancestors
    where ancestors.organization_id = new.organization_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'Organisation hierarchy cannot contain a cycle';
  end if;

  return new;
end
$$;

alter function vortex_identity.refuse_organization_cycle() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_identity.refuse_organization_cycle() FROM PUBLIC;

grant execute on function vortex_identity.refuse_organization_cycle() to postgres;
