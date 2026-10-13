CREATE FUNCTION vortex_identity.subject_revisions_are_valid(p_subject_ids uuid[], p_subject_revisions bigint[]) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
    SET search_path TO ''
    AS $$
declare
  subject_revision bigint;
begin
  if pg_catalog.array_ndims(p_subject_revisions) <> 1
    or pg_catalog.array_lower(p_subject_revisions, 1) <> 1
    or pg_catalog.cardinality(p_subject_revisions) <> pg_catalog.cardinality(p_subject_ids) then
    return false;
  end if;

  foreach subject_revision in array p_subject_revisions loop
    if subject_revision is null or subject_revision not between 1 and 9007199254740991 then
      return false;
    end if;
  end loop;
  return true;
end
$$;

ALTER FUNCTION vortex_identity.subject_revisions_are_valid(p_subject_ids uuid[], p_subject_revisions bigint[]) OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_identity.subject_revisions_are_valid(p_subject_ids uuid[], p_subject_revisions bigint[]) FROM PUBLIC;
