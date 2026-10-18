begin;
set local role vortex_owner;

create or replace function vortex_definition.read_source_import_conflicts(
  p_root_id uuid,
  p_identity_requirements jsonb
)
returns table (component_kind text, component_name text)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
begin
  -- Uses the same live organisation, root and system-application permissions as Save.
  -- The result is advisory: Save still records and checks the aliases atomically.
  checked_context := vortex_definition.validated_builder_draft_write_context_internal(p_root_id);
  if p_root_id is null or pg_catalog.jsonb_typeof(p_identity_requirements) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Source import requires a root and identity requirements';
  end if;
  return query
  select distinct requirement.kind, item.value
  from pg_catalog.jsonb_to_recordset(p_identity_requirements) as requirement(
    "ownerScope" text, scope text, kind text, "componentOwner" text, aliases jsonb
  )
  cross join lateral pg_catalog.jsonb_array_elements_text(requirement.aliases) as item(value)
  join vortex_definition.source_identity_aliases as alias
    on alias.root_id = p_root_id and alias.scope = requirement.scope
    and alias.kind = requirement.kind and alias.alias = item.value
  where alias.owner_scope is distinct from requirement."ownerScope"
    or alias.component_owner is distinct from requirement."componentOwner"
  order by requirement.kind, item.value;
end
$function$;

alter function vortex_definition.read_source_import_conflicts(uuid, jsonb) owner to vortex_owner;
revoke all on function vortex_definition.read_source_import_conflicts(uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_source_import_conflicts(uuid, jsonb) to vortex_request, postgres;

reset role;
commit;
