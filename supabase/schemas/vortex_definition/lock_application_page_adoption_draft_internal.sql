create or replace function vortex_definition.lock_application_page_adoption_draft_internal(
  p_root_id uuid,
  p_expected_draft_revision bigint,
  p_expected_release_revision bigint
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
  locked_draft_revision bigint;
  result_value jsonb;
begin
  if p_root_id is null or p_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_draft_revision is null
    or p_expected_draft_revision not between 1 and 9007199254740991
    or p_expected_release_revision is null
    or p_expected_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Page adoption draft selector is invalid';
  end if;
  -- This existing guard locks Access before the classified Application root.
  checked_context := vortex_definition.validated_builder_draft_write_context_internal(p_root_id);
  select root.* into strict root_row
  from vortex_definition.roots as root
  where root.root_id = p_root_id
    and root.organization_id = (checked_context ->> 'organizationId')::uuid
    and root.kind = 'application';
  if root_row.application_origin_kind is distinct from 'ordinary' then
    raise exception using errcode = '42501', message = 'Page adoption source is unavailable';
  end if;
  if root_row.current_release_revision is distinct from p_expected_release_revision then
    raise exception using errcode = '40001', message = 'Page adoption publication changed';
  end if;
  select draft.draft_revision into locked_draft_revision
  from vortex_definition.drafts as draft
  where draft.root_id = p_root_id for update;
  if not found or locked_draft_revision is distinct from p_expected_draft_revision then
    raise exception using errcode = '40001', message = 'Page adoption draft changed';
  end if;
  perform vortex_definition.validated_builder_draft_write_context_internal(p_root_id);
  result_value := vortex_definition.read_publication_state(p_root_id);
  if result_value is null then
    raise exception using errcode = '55000', message = 'Page adoption draft is unavailable';
  end if;
  return result_value;
end
$function$;

alter function vortex_definition.lock_application_page_adoption_draft_internal(uuid,bigint,bigint)
  owner to postgres;
revoke all on function vortex_definition.lock_application_page_adoption_draft_internal(uuid,bigint,bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.lock_application_page_adoption_draft_internal(uuid,bigint,bigint)
  to vortex_request;
comment on function vortex_definition.lock_application_page_adoption_draft_internal(uuid,bigint,bigint) is
  'Locks an ordinary Application draft for current HUMAN page adoption derivation in Access, root and draft order; returns only its existing protected publication state and writes no source or release.';
