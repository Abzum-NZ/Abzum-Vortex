create or replace function vortex_record.read_record_type_visible_field_ids(p_record_type_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  ctx jsonb := vortex_access.validated_human_request_context();
  installation jsonb := vortex_definition.read_current_active_installation();
  plan jsonb := vortex_record.resolve_installation_access_plan_internal(installation);
  declaration jsonb;
  eligibility jsonb;
  possible_ids jsonb;
begin
  declaration := vortex_record.record_type_read_declaration_internal(
    plan, p_record_type_id, (ctx ->> 'applicationRootId')::uuid
  );
  if declaration is null then
    return '[]'::jsonb;
  end if;
  eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
    declaration, ctx, pg_catalog.clock_timestamp()
  );
  if eligibility ->> 'outcome' is distinct from 'eligible' then
    return '[]'::jsonb;
  end if;
  -- An upper bound only, used to stop after exact witnesses cover it. It is
  -- never itself returned as a visibility grant, and uses accepted revisions.
  select coalesce(pg_catalog.jsonb_agg(distinct field.value), '[]'::jsonb)
  into possible_ids
  from pg_catalog.jsonb_array_elements(eligibility -> 'eligiblePermissions') as candidate(value)
  join vortex_access.permission_catalogue_entries as entry
    on entry.organization_id = (ctx ->> 'organizationId')::uuid
    and entry.registration_revision = (candidate.value ->> 'registrationRevision')::bigint
    and entry.application_root_id = (candidate.value #>> '{permission,applicationRootId}')::uuid
    and entry.owner_kind = candidate.value #>> '{permission,ownerKind}'
    and entry.owner_id = (candidate.value #>> '{permission,ownerId}')::uuid
    and entry.permission_id = (candidate.value #>> '{permission,permissionId}')::uuid
  cross join lateral pg_catalog.jsonb_array_elements(entry.field_policy -> 'readableFieldIds') as field(value);
  return vortex_record.resolve_record_type_visible_field_ids_internal(
    p_record_type_id, installation, plan, declaration, eligibility, possible_ids
  );
end
$function$;

alter function vortex_record.read_record_type_visible_field_ids(uuid) owner to vortex_owner;
revoke all on function vortex_record.read_record_type_visible_field_ids(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.read_record_type_visible_field_ids(uuid) to vortex_request;
comment on function vortex_record.read_record_type_visible_field_ids(uuid) is
  'Current installed record-type column visibility for the validated human context; returns field identities only, resolved once before grid reads. Distinct from conservative filter/sort bounds.';
