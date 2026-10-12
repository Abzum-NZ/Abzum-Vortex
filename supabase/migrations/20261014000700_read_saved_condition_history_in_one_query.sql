create or replace function vortex_definition.read_saved_condition_history(
  p_root_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  root_row vortex_definition.roots%rowtype;
begin
  checked_context := vortex_definition.validated_builder_evidence_read_context_internal();
  if p_root_id is null or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Saved condition history requires a non-nil root identifier';
  end if;
  select root.* into root_row from vortex_definition.roots as root where root.root_id = p_root_id;
  if not found then return null; end if;
  if root_row.organization_id <> (checked_context ->> 'organizationId')::uuid then
    raise exception using errcode = '42501',
      message = 'Definition root does not belong to the context organization';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(last_seen.condition order by last_seen.condition_id)
    from (
      select distinct on (condition.value ->> 'conditionId')
        condition.value ->> 'conditionId' as condition_id,
        condition.value as condition
      from vortex_definition.releases as release
      cross join lateral pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(
            release.compilation_output -> 'canonical' -> 'content' -> 'sharingConditions'
          ) = 'array'
            then release.compilation_output -> 'canonical' -> 'content' -> 'sharingConditions'
          else '[]'::jsonb
        end
      ) as condition(value)
      where release.root_id = p_root_id
      order by condition.value ->> 'conditionId', release.release_revision desc
    ) as last_seen
  ), '[]'::jsonb);
end
$function$;

revoke execute on function vortex_definition.read_saved_condition_history(uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_definition.read_saved_condition_history(uuid) to vortex_request;

comment on function vortex_definition.read_saved_condition_history(uuid) is
  'Returns, for each saved sharing condition ever published by one organisation-scoped Module root, its most recent published form, so the next release can assign condition revisions.';

