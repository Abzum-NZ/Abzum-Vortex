begin;
set local role vortex_owner;
drop function vortex_definition.list_organization_builder_roots();

create or replace function vortex_definition.list_organization_builder_roots(p_after_key text default null)
returns table (
  root_id uuid,
  kind text,
  definition_key text,
  display_name text,
  draft_revision bigint,
  current_release_revision bigint,
  application_origin_kind text,
  description text,
  icon text,
  edited_at timestamptz,
  edited_by uuid
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

  return query
  select
    root.root_id,
    root.kind,
    root.key,
    coalesce(
      nullif(pg_catalog.btrim(draft.draft_source -> 'body' ->> 'name'), ''),
      nullif(pg_catalog.btrim(release.authored_source -> 'body' ->> 'name'), '')
    ),
    draft.draft_revision,
    root.current_release_revision,
    root.application_origin_kind,
    coalesce(draft.draft_source -> 'body' ->> 'description', release.authored_source -> 'body' ->> 'description'),
    coalesce(draft.draft_source -> 'body' ->> 'icon', release.authored_source -> 'body' ->> 'icon'),
    coalesce(draft.updated_at, root.created_at),
    coalesce(draft.updated_by, root.created_by)
  from vortex_definition.roots as root
  left join vortex_definition.drafts as draft on draft.root_id = root.root_id
  left join vortex_definition.releases as release
    on release.root_id = root.root_id
    and release.release_revision = root.current_release_revision
  where root.organization_id = (checked_context ->> 'organizationId')::uuid
    and root.kind = 'application'
    and (p_after_key is null or root.key > p_after_key)
  order by root.key
  limit 41;
end
$function$;

revoke all on function vortex_definition.list_organization_builder_roots(text)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.list_organization_builder_roots(text)
  to vortex_request;

comment on function vortex_definition.list_organization_builder_roots(text) is
  'Lists a keyset page of 40 Application roots plus one continuation row in the validated human request organization for a permitted builder; Modules are internal to the Application that owns them.';

alter function vortex_definition.list_organization_builder_roots(text) owner to vortex_owner;

reset role;
commit;
