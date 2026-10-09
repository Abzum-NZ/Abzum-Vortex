create or replace function vortex_identity.list_organization_account_choices_internal(
  p_tenant_id uuid,
  p_organization_id uuid,
  p_search text,
  p_page_size integer,
  p_after_sort_key text,
  p_after_organization_account_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  search_value text;
  result_value jsonb;
begin
  if p_tenant_id is null
    or p_organization_id is null
    or p_page_size is null
    or p_page_size not between 1 and 100
    or (p_search is not null and pg_catalog.char_length(p_search) not between 1 and 100)
    or (p_after_sort_key is null) <> (p_after_organization_account_id is null)
    or pg_catalog.char_length(p_after_sort_key) > 1000 then
    raise exception using errcode = '22023',
      message = 'Organisation account choice page input is invalid';
  end if;
  search_value := pg_catalog.lower(p_search);

  with candidates as (
    select account.organization_account_id,
      account.display_name,
      (coalesce(pg_catalog.lower(account.display_name), '') collate "C") as sort_key
    from vortex_identity.organization_accounts as account
    join vortex_identity.identity_projections as projection
      on projection.identity_id = account.identity_id
    join vortex_identity.organizations as organization
      on organization.organization_id = account.organization_id
    join vortex_identity.tenants as tenant
      on tenant.tenant_id = organization.tenant_id
    where tenant.tenant_id = p_tenant_id
      and organization.organization_id = p_organization_id
      and account.state = 'active'
      and projection.state = 'active'
      and organization.state = 'active'
      and tenant.state = 'active'
      and (
        search_value is null
        or pg_catalog.strpos(pg_catalog.lower(account.display_name), search_value) > 0
      )
  ),
  page as (
    select candidate.organization_account_id, candidate.display_name, candidate.sort_key,
      pg_catalog.row_number() over (
        order by candidate.sort_key, candidate.organization_account_id
      ) as ordinal
    from candidates as candidate
    where p_after_sort_key is null
      or (candidate.sort_key, candidate.organization_account_id)
        > ((p_after_sort_key collate "C"), p_after_organization_account_id)
    order by candidate.sort_key, candidate.organization_account_id
    limit p_page_size + 1
  )
  select pg_catalog.jsonb_build_object(
    'accounts', coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'organizationAccountId', entry.organization_account_id,
          'displayName', entry.display_name
        )) order by entry.ordinal
      ) filter (where entry.ordinal <= p_page_size),
      '[]'::jsonb
    ),
    'next', case
      when pg_catalog.count(*) > p_page_size then
        (pg_catalog.array_agg(
          pg_catalog.jsonb_build_object(
            'sortKey', entry.sort_key,
            'organizationAccountId', entry.organization_account_id
          ) order by entry.ordinal
        ) filter (where entry.ordinal <= p_page_size))[p_page_size]
      else null
    end
  )
  into result_value
  from page as entry;

  return result_value;
end
$function$;

revoke all on function vortex_identity.list_organization_account_choices_internal(uuid, uuid, text, integer, text, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.list_organization_account_choices_internal(
  uuid, uuid, text, integer, text, uuid
) is 'Identity-owned bounded picker projection of active accounts in one active organisation: account id and display name only, keyset-paged, no counts.';

alter function vortex_identity.list_organization_account_choices_internal(uuid, uuid, text, integer, text, uuid) owner to vortex_identity_owner;
grant execute on function vortex_identity.list_organization_account_choices_internal(uuid, uuid, text, integer, text, uuid) to postgres;

grant execute on function vortex_identity.list_organization_account_choices_internal(uuid,uuid,text,integer,text,uuid) to vortex_record_adapter;
