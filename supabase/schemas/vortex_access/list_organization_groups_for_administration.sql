CREATE FUNCTION vortex_access.list_organization_groups_for_administration(p_after_group_id uuid, p_page_size integer) RETURNS TABLE(organization_id uuid, groups jsonb, next_after_group_id uuid, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  scope record;
  group_items jsonb;
  next_group_id uuid;
  page_group_ids uuid[];
  candidate_count integer;
begin
  if p_page_size is null or p_page_size not between 1 and 100
    or (
      p_after_group_id is not null
      and p_after_group_id = '00000000-0000-0000-0000-000000000000'::uuid
    ) then
    raise exception using errcode = '22023',
      message = 'Organization Group page input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_groups_administration_scope() as authorized;

  with candidates as (
    select organization_group.group_id, organization_group.group_key,
      organization_group.label, organization_group.state,
      organization_group.revision,
      pg_catalog.row_number() over (order by organization_group.group_id) as ordinal
    from vortex_access.organization_groups as organization_group
    where organization_group.organization_id = scope.organization_id
      and (
        p_after_group_id is null
        or organization_group.group_id > p_after_group_id
      )
    order by organization_group.group_id
    limit p_page_size + 1
  )
  select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'groupId', candidate.group_id,
          'key', candidate.group_key,
          'label', candidate.label,
          'state', candidate.state,
          'revision', candidate.revision
        ) order by candidate.group_id
      ) filter (where candidate.ordinal <= p_page_size),
      '[]'::jsonb
    ),
    pg_catalog.array_agg(candidate.group_id order by candidate.group_id)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.count(*)
  into group_items, page_group_ids, candidate_count
  from candidates as candidate;

  next_group_id := case
    when candidate_count > p_page_size then page_group_ids[p_page_size]
    else null
  end;

  return query select scope.organization_id, group_items,
    next_group_id, scope.access_version;
end
$$;


ALTER FUNCTION vortex_access.list_organization_groups_for_administration(p_after_group_id uuid, p_page_size integer) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.list_organization_groups_for_administration(p_after_group_id uuid, p_page_size integer) IS 'Returns one bounded stable-ID Group administration page after the fixed teams-read decision.';

REVOKE ALL ON FUNCTION vortex_access.list_organization_groups_for_administration(p_after_group_id uuid, p_page_size integer) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.list_organization_groups_for_administration(p_after_group_id uuid, p_page_size integer) TO vortex_request;
