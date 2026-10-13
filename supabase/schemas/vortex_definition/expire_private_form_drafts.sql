create or replace function vortex_definition.expire_private_form_drafts(p_limit integer default 500)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked jsonb;
begin
  if p_limit is null or p_limit not between 1 and 10000 then
    raise exception using errcode = '22023',
      message = 'Private form draft expiry command is invalid';
  end if;

  checked := vortex_access.validated_human_request_context();
  if not vortex_platform.is_non_nil_uuid(checked ->> 'organizationId') then
    raise exception using errcode = '42501',
      message = 'Private form draft scope is unavailable';
  end if;

  return vortex_definition.private_form_draft_purge_internal(
    (checked ->> 'organizationId')::uuid,
    p_limit
  );
end
$function$;
alter function vortex_definition.expire_private_form_drafts(integer) owner to vortex_owner;


revoke all on function vortex_definition.expire_private_form_drafts(integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function vortex_definition.expire_private_form_drafts(integer)
  to vortex_request;

comment on function vortex_definition.expire_private_form_drafts(integer) is
  'Deletes a bounded batch of the current organisation''s private form drafts untouched for thirty days.';

alter function vortex_definition.expire_private_form_drafts(integer)
  owner to vortex_owner;
