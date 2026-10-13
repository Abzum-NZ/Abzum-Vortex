CREATE OR REPLACE FUNCTION vortex_record.account_retains_owned_records_internal(p_organization_account_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  organization_id_value uuid;
  physical record;
  found_any boolean;
begin
  if p_organization_account_id is null
    or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Account deletion inventory selector is invalid';
  end if;

  organization_id_value := vortex_platform.organization_id();
  if organization_id_value is null then
    raise exception using errcode = '55000',
      message = 'Account deletion inventory completeness cannot be proved';
  end if;

  for physical in
    select relation.oid as relation_id, relation.relname, relation.relkind,
      relation.relrowsecurity
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'record_data'
      and relation.relname ~ '^rt_[a-f0-9]{32}$'
    order by relation.relname
  loop
    if physical.relkind <> 'r'
      or (physical.relrowsecurity and not exists (
        select 1 from pg_catalog.pg_policy as policy
        where policy.polrelid = physical.relation_id
          and policy.polname = 'record_account_deletion_inventory'
      )) then
      raise exception using errcode = '55000',
        message = 'Account deletion inventory completeness cannot be proved';
    end if;

    execute pg_catalog.format(
      'select exists (
         select 1 from record_data.%I as stored
         where stored.organisation_id = $1
           and stored.owner_organisation_account_id = $2
       )',
      physical.relname
    ) into found_any using organization_id_value, p_organization_account_id;

    if found_any then
      return true;
    end if;
  end loop;

  return false;
end
$_$;
alter function vortex_record.account_retains_owned_records_internal(uuid) owner to vortex_record_inventory;


COMMENT ON FUNCTION vortex_record.account_retains_owned_records_internal(p_organization_account_id uuid) IS 'Private all-scope account-deletion inventory over every physical Record table in the organisation; returns only whether any owned row remains.';

REVOKE ALL ON FUNCTION vortex_record.account_retains_owned_records_internal(p_organization_account_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_record.account_retains_owned_records_internal(p_organization_account_id uuid) TO vortex_record_adapter;
