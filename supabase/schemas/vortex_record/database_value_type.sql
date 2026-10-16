CREATE FUNCTION vortex_record.database_value_type(p_field jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  select case
    when p_field ->> 'type' in ('calculation', 'total') then
      case p_field #>> '{settings,resultType}'
        when 'whole_number' then 'integer'
        when 'decimal_number' then 'decimal'
        when 'yes_no' then 'boolean'
        when 'date' then 'date'
        when 'date_time' then 'timestamp_with_time_zone'
        when 'money' then 'json'
        when 'text' then 'text'
        else null
      end
    else case p_field ->> 'type'
    when 'whole_number' then 'integer'
    when 'decimal_number' then 'decimal'
    when 'yes_no' then 'boolean'
    when 'date' then 'date'
    when 'date_time' then 'timestamp_with_time_zone'
    when 'link' then 'json'
    when 'link_to_one_of_several' then 'json'
    when 'link_to_person' then 'json'
    when 'formatted_text' then 'json'
    when 'several_choices' then 'json'
    when 'table' then 'json'
    when 'money' then 'json'
    when 'attachment' then 'json'
    when 'text' then 'text'
    when 'long_text' then 'text'
    when 'reference_number' then 'text'
    when 'email_address' then 'text'
    when 'phone_number' then 'text'
    when 'web_address' then 'text'
    when 'choice' then 'text'
    else null
    end
  end
$$;
alter function vortex_record.database_value_type(jsonb) owner to vortex_owner;


REVOKE ALL ON FUNCTION vortex_record.database_value_type(p_field jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vortex_record.database_value_type(p_field jsonb) TO vortex_record_adapter;
