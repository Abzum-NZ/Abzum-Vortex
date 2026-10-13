create or replace function vortex_definition.list_organization_builder_roots()
returns table (
  root_id uuid,
  kind text,
  definition_key text,
  display_name text,
  draft_revision bigint,
  current_release_revision bigint,
  application_origin_kind text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
begin
  checked_context := vortex_definition.validated_builder_evidence_read_context_internal();
  if checked_context ->> 'callerKind' is distinct from 'human'
    or checked_context ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Definition builder root listing requires a human organization context';
  end if;

  if exists (
    select 1
    from vortex_definition.roots as root
    left join vortex_definition.drafts as draft on draft.root_id = root.root_id
    where root.organization_id = (checked_context ->> 'organizationId')::uuid
      and root.kind in ('application', 'module')
      and draft.root_id is null
  ) then
    raise exception using errcode = '23503',
      message = 'A Definition root requires its current draft';
  end if;

  return query
  select
    root.root_id,
    root.kind,
    root.key,
    nullif(pg_catalog.btrim(draft.draft_source -> 'body' ->> 'name'), ''),
    draft.draft_revision,
    root.current_release_revision,
    root.application_origin_kind
  from vortex_definition.roots as root
  join vortex_definition.drafts as draft on draft.root_id = root.root_id
  where root.organization_id = (checked_context ->> 'organizationId')::uuid
    and root.kind in ('application', 'module')
  order by coalesce(nullif(pg_catalog.btrim(draft.draft_source -> 'body' ->> 'name'), ''), root.key), root.key, root.root_id
  limit 200;
end
$function$;

revoke all on function vortex_definition.list_organization_builder_roots()
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.list_organization_builder_roots()
  to vortex_request;

comment on function vortex_definition.list_organization_builder_roots() is
  'Lists at most 200 application and module drafts in the validated human request organization for a permitted builder.';

alter function vortex_definition.list_organization_builder_roots() owner to vortex_owner;
