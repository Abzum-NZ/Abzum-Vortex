create or replace function vortex_access.recent_authentication_deadline_internal(
  p_context jsonb,
  p_checked_at timestamptz,
  p_requirement jsonb
)
returns timestamptz
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  context_expires_value timestamptz := (p_context ->> 'expiresAt')::timestamptz;
  requirement_kind_value text := p_requirement ->> 'kind';
  requirement_maximum_age_value bigint := case
    when requirement_kind_value = 'none' then null
    else (p_requirement ->> 'maximumAgeSeconds')::numeric::bigint
  end;
  evidence_at timestamptz;
  satisfied boolean;
  deadline timestamptz;
begin
  if requirement_kind_value = 'none' then
    return context_expires_value;
  end if;

  evidence_at := case requirement_kind_value
    when 'primary' then (p_context ->> 'primaryAuthenticatedAt')::timestamptz
    when 'multi_factor' then (p_context ->> 'multiFactorAuthenticatedAt')::timestamptz
  end;

  satisfied := evidence_at is not null
    and evidence_at <= p_checked_at
    and extract(epoch from (p_checked_at - evidence_at)) <
      requirement_maximum_age_value::numeric;

  if satisfied is not true then
    return null;
  end if;

  deadline := context_expires_value;
  if requirement_maximum_age_value::numeric <
    extract(epoch from (context_expires_value - evidence_at)) then
    deadline := evidence_at +
      (requirement_maximum_age_value::double precision * interval '1 second');
  end if;

  return deadline;
end
$function$;

comment on function
  vortex_access.recent_authentication_deadline_internal(jsonb, timestamptz, jsonb) is
  'Private recent-authentication deadline evidence; null means the requirement is unsatisfied. No row or record authority.';

revoke execute on function
  vortex_access.recent_authentication_deadline_internal(jsonb, timestamptz, jsonb) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_module_owner, vortex_record_owner, vortex_record_adapter;
