-- B7D-B3b (B7DA-SQL-1): the exposure rule of a Module query lives in one helper that both query
-- resolvers call before anything else is decided. An Application reads a query of a Module it
-- only uses when that Module exposes it (or the query lists a record type by its own identity, or
-- the Application owns the Module). Before this, prepare_module_query_internal applied the rule
-- after the resolver and read_module_query_inputs never applied it, so a private query of another
-- Application's system-projection Module answered installation_required in a Studio preview with
-- no installation and query_unavailable once installed, and the installed path returned the input
-- declarations of a private query. Now every caller gets the same answer from the resolvers:
-- null, which they all turn into query_unavailable, for a private query, a missing query and an
-- unknown Module alike, in a preview with or without an installation and on the installed path.
-- The rule is deleted from prepare_module_query_internal (one way only).
-- The three resolver and prepare bodies are the live ones (verified against pg_get_functiondef
-- and the canonical files before this change; no other migration rewrites them after
-- 20261106010000) and are changed in place by exactly-once text replacement; the result equals
-- the canonical files in supabase/schemas.
set role vortex_record_adapter;

create or replace function vortex_record.module_query_is_readable_internal(
  p_module_root_id uuid,
  p_query jsonb,
  p_application_root_id uuid
)
returns boolean
language sql
stable
set search_path = ''
as $function$
  -- The one exposure rule of a Module query, applied by both resolvers before anything else is
  -- decided, so a refusal never tells a private query from a missing one: an Application reads a
  -- query of a Module it only uses when that Module exposes it (the rule the Studio picker, the
  -- draft compile and publication apply). A record type's own listing carries its record type's
  -- identity and follows record access instead.
  select coalesce(
      pg_catalog.lower(p_query ->> 'queryId') = pg_catalog.lower(p_query #>> '{recordType,recordTypeId}'),
      false
    )
    or p_query ->> 'exposure' = 'exposed'
    or exists (
      select 1
      from vortex_definition.roots as root
      where root.root_id = p_module_root_id
        and root.kind = 'module'
        and root.owner_application_root_id = p_application_root_id
    );
$function$;

alter function vortex_record.module_query_is_readable_internal(uuid,jsonb,uuid)
  owner to vortex_record_adapter;

revoke all on function vortex_record.module_query_is_readable_internal(uuid,jsonb,uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.module_query_is_readable_internal(uuid,jsonb,uuid) is
  'Private: whether the Application may read one query of a Module: a record type''s own listing, a query its Module exposes, or any query of a Module the Application owns.';

do $migration$
declare
  definition text;
  old_fragment text;
  new_fragment text;
begin
  definition := pg_catalog.pg_get_functiondef(
    'vortex_record.resolve_preview_module_query_internal(uuid,uuid)'::pg_catalog.regprocedure
  );
  old_fragment := $q$    or query_item #>> '{recordType,state}' is distinct from 'resolved' then
    return null;
  end if;

  record_type_module_root_id_text$q$;
  new_fragment := $q$    or query_item #>> '{recordType,state}' is distinct from 'resolved' then
    return null;
  end if;
  if not vortex_record.module_query_is_readable_internal(
    p_module_root_id, query_item, (installation ->> 'applicationRootId')::uuid
  ) then
    return null;
  end if;

  record_type_module_root_id_text$q$;
  if (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, old_fragment, '')))
      <> pg_catalog.length(old_fragment) then
    raise exception 'resolve_preview_module_query_internal does not hold the expected fragment exactly once';
  end if;
  execute pg_catalog.replace(definition, old_fragment, new_fragment);

  definition := pg_catalog.pg_get_functiondef(
    'vortex_record.resolve_installed_module_query_internal(uuid,uuid)'::pg_catalog.regprocedure
  );
  old_fragment := $q$    or not coalesce(pg_catalog.pg_input_is_valid(query_item #>> '{recordType,recordTypeId}', 'uuid'), false) then
    return null;
  end if;
$q$;
  new_fragment := $q$    or not coalesce(pg_catalog.pg_input_is_valid(query_item #>> '{recordType,recordTypeId}', 'uuid'), false) then
    return null;
  end if;
  if not vortex_record.module_query_is_readable_internal(
    p_module_root_id, query_item, (installation ->> 'applicationRootId')::uuid
  ) then
    return null;
  end if;
$q$;
  if (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, old_fragment, '')))
      <> pg_catalog.length(old_fragment) then
    raise exception 'resolve_installed_module_query_internal does not hold the expected fragment exactly once';
  end if;
  execute pg_catalog.replace(definition, old_fragment, new_fragment);

  definition := pg_catalog.pg_get_functiondef(
    'vortex_record.prepare_module_query_internal(uuid,uuid,bigint,jsonb,jsonb,jsonb,text,jsonb)'::pg_catalog.regprocedure
  );
  old_fragment := $q$  -- A query of a Module this Application only uses is read only when that Module exposes it,
  -- the same rule the Studio picker, the draft compile and publication apply; a release that
  -- names a private or older query of another Application's Module reads nothing. A record
  -- type's own listing carries its record type's identity and follows record access instead.
  if pg_catalog.lower(resolved #>> '{query,queryId}')
      is distinct from pg_catalog.lower(resolved #>> '{query,recordType,recordTypeId}')
    and resolved #>> '{query,exposure}' is distinct from 'exposed'
    and not exists (
      select 1
      from vortex_definition.roots as root
      where root.root_id = p_module_root_id
        and root.kind = 'module'
        and root.owner_application_root_id = context_application_root_id
    ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
  end if;
$q$;
  new_fragment := '';
  if (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, old_fragment, '')))
      <> pg_catalog.length(old_fragment) then
    raise exception 'prepare_module_query_internal does not hold the expected fragment exactly once';
  end if;
  execute pg_catalog.replace(definition, old_fragment, new_fragment);
end
$migration$;

comment on function vortex_record.prepare_module_query_internal(uuid, uuid, bigint, jsonb, jsonb, jsonb, text, jsonb) is
  'Shared owner-only Module query preparation for list and summary reads: derives organisation and application authority from validated_human_request_context(), resolves one installed query or the exact current human-owned preview pins, revalidates preview prior plans, exact active field mappings and preview catalogue/field bounds without using the installed read-scan routes, refuses a preview of a used Module''s record type with read_forbidden when the same read plan decision admits no read alternative, validates declared inputs and the published filter narrowed by the declared user filter, and returns the exact access predicate, pushed filter and residual per-row condition with bound inputs; it never accepts authority or identity from caller values.';

comment on function vortex_record.resolve_preview_module_query_internal(uuid, uuid) is
  'Private preview-only resolver for one query and its exact pinned record type and active preview storage identity (a system projection resolves the draft''s query over the installed record type with no preview storage, and returns the refusal installation_required when there is no installed projection to read: no active installation binding the Module, or a draft whose record type or permissions differ from it); it returns null, before anything else is decided, for a query the Application may not read (a private query of another Application''s Module), so no refusal tells a private query from a missing one; it validates the current human-owned unexpired preview and never falls back to an active installation.';

COMMENT ON FUNCTION vortex_record.resolve_installed_module_query_internal(p_module_root_id uuid, p_query_id uuid) IS 'Private: the exact installed Module query and its record type, or null when either is unavailable to the current installation or the Application may not read the query (a private query of another Application''s Module).';

REVOKE ALL ON FUNCTION vortex_record.resolve_installed_module_query_internal(p_module_root_id uuid, p_query_id uuid) FROM PUBLIC;
