-- Rows installed by migrations, excluding tenant and demo data.

-- vortex_access.validation_reference_values: 208 rows
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('metering_forbidden_dimension_word', 'amount', 1);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('metering_forbidden_dimension_word', 'billing', 2);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('metering_forbidden_dimension_word', 'charge', 3);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('metering_forbidden_dimension_word', 'chargeable', 4);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('metering_forbidden_dimension_word', 'cost', 5);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('metering_forbidden_dimension_word', 'credential', 6);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('metering_forbidden_dimension_word', 'currency', 7);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('metering_forbidden_dimension_word', 'customer', 8);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('metering_forbidden_dimension_word', 'invoice', 9);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('metering_forbidden_dimension_word', 'password', 10);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('metering_forbidden_dimension_word', 'payment', 11);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('metering_forbidden_dimension_word', 'plan', 12);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('metering_forbidden_dimension_word', 'price', 13);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('metering_forbidden_dimension_word', 'pricing', 14);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('metering_forbidden_dimension_word', 'secret', 15);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('metering_forbidden_dimension_word', 'subscription', 16);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('private_invalidation_topic_prefix', 'vortex:invalidation', 1);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('private_invalidation_change_kind', 'created', 1);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('private_invalidation_change_kind', 'changed', 2);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('private_invalidation_change_kind', 'deleted', 3);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('private_invalidation_change_kind', 'restored', 4);
INSERT INTO vortex_access.validation_reference_values (reference_list, reference_value, reference_ordinal) VALUES ('private_invalidation_change_kind', 'access_changed', 5);
-- BEGIN GENERATED: organization settings reference seed
insert into vortex_access.validation_reference_values (
  reference_list, reference_value, reference_ordinal
) values
  ('organization_runtime_settings_currency', 'AED', 1),
  ('organization_runtime_settings_currency', 'AFN', 2),
  ('organization_runtime_settings_currency', 'ALL', 3),
  ('organization_runtime_settings_currency', 'AMD', 4),
  ('organization_runtime_settings_currency', 'AOA', 5),
  ('organization_runtime_settings_currency', 'ARS', 6),
  ('organization_runtime_settings_currency', 'AUD', 7),
  ('organization_runtime_settings_currency', 'AWG', 8),
  ('organization_runtime_settings_currency', 'AZN', 9),
  ('organization_runtime_settings_currency', 'BAM', 10),
  ('organization_runtime_settings_currency', 'BBD', 11),
  ('organization_runtime_settings_currency', 'BDT', 12),
  ('organization_runtime_settings_currency', 'BHD', 13),
  ('organization_runtime_settings_currency', 'BIF', 14),
  ('organization_runtime_settings_currency', 'BMD', 15),
  ('organization_runtime_settings_currency', 'BND', 16),
  ('organization_runtime_settings_currency', 'BOB', 17),
  ('organization_runtime_settings_currency', 'BOV', 18),
  ('organization_runtime_settings_currency', 'BRL', 19),
  ('organization_runtime_settings_currency', 'BSD', 20),
  ('organization_runtime_settings_currency', 'BTN', 21),
  ('organization_runtime_settings_currency', 'BWP', 22),
  ('organization_runtime_settings_currency', 'BYN', 23),
  ('organization_runtime_settings_currency', 'BZD', 24),
  ('organization_runtime_settings_currency', 'CAD', 25),
  ('organization_runtime_settings_currency', 'CDF', 26),
  ('organization_runtime_settings_currency', 'CHE', 27),
  ('organization_runtime_settings_currency', 'CHF', 28),
  ('organization_runtime_settings_currency', 'CHW', 29),
  ('organization_runtime_settings_currency', 'CLF', 30),
  ('organization_runtime_settings_currency', 'CLP', 31),
  ('organization_runtime_settings_currency', 'CNY', 32),
  ('organization_runtime_settings_currency', 'COP', 33),
  ('organization_runtime_settings_currency', 'COU', 34),
  ('organization_runtime_settings_currency', 'CRC', 35),
  ('organization_runtime_settings_currency', 'CUP', 36),
  ('organization_runtime_settings_currency', 'CVE', 37),
  ('organization_runtime_settings_currency', 'CZK', 38),
  ('organization_runtime_settings_currency', 'DJF', 39),
  ('organization_runtime_settings_currency', 'DKK', 40),
  ('organization_runtime_settings_currency', 'DOP', 41),
  ('organization_runtime_settings_currency', 'DZD', 42),
  ('organization_runtime_settings_currency', 'EGP', 43),
  ('organization_runtime_settings_currency', 'ERN', 44),
  ('organization_runtime_settings_currency', 'ETB', 45),
  ('organization_runtime_settings_currency', 'EUR', 46),
  ('organization_runtime_settings_currency', 'FJD', 47),
  ('organization_runtime_settings_currency', 'FKP', 48),
  ('organization_runtime_settings_currency', 'GBP', 49),
  ('organization_runtime_settings_currency', 'GEL', 50),
  ('organization_runtime_settings_currency', 'GHS', 51),
  ('organization_runtime_settings_currency', 'GIP', 52),
  ('organization_runtime_settings_currency', 'GMD', 53),
  ('organization_runtime_settings_currency', 'GNF', 54),
  ('organization_runtime_settings_currency', 'GTQ', 55),
  ('organization_runtime_settings_currency', 'GYD', 56),
  ('organization_runtime_settings_currency', 'HKD', 57),
  ('organization_runtime_settings_currency', 'HNL', 58),
  ('organization_runtime_settings_currency', 'HTG', 59),
  ('organization_runtime_settings_currency', 'HUF', 60),
  ('organization_runtime_settings_currency', 'IDR', 61),
  ('organization_runtime_settings_currency', 'ILS', 62),
  ('organization_runtime_settings_currency', 'INR', 63),
  ('organization_runtime_settings_currency', 'IQD', 64),
  ('organization_runtime_settings_currency', 'IRR', 65),
  ('organization_runtime_settings_currency', 'ISK', 66),
  ('organization_runtime_settings_currency', 'JMD', 67),
  ('organization_runtime_settings_currency', 'JOD', 68),
  ('organization_runtime_settings_currency', 'JPY', 69),
  ('organization_runtime_settings_currency', 'KES', 70),
  ('organization_runtime_settings_currency', 'KGS', 71),
  ('organization_runtime_settings_currency', 'KHR', 72),
  ('organization_runtime_settings_currency', 'KMF', 73),
  ('organization_runtime_settings_currency', 'KPW', 74),
  ('organization_runtime_settings_currency', 'KRW', 75),
  ('organization_runtime_settings_currency', 'KWD', 76),
  ('organization_runtime_settings_currency', 'KYD', 77),
  ('organization_runtime_settings_currency', 'KZT', 78),
  ('organization_runtime_settings_currency', 'LAK', 79),
  ('organization_runtime_settings_currency', 'LBP', 80),
  ('organization_runtime_settings_currency', 'LKR', 81),
  ('organization_runtime_settings_currency', 'LRD', 82),
  ('organization_runtime_settings_currency', 'LSL', 83),
  ('organization_runtime_settings_currency', 'LYD', 84),
  ('organization_runtime_settings_currency', 'MAD', 85),
  ('organization_runtime_settings_currency', 'MDL', 86),
  ('organization_runtime_settings_currency', 'MGA', 87),
  ('organization_runtime_settings_currency', 'MKD', 88),
  ('organization_runtime_settings_currency', 'MMK', 89),
  ('organization_runtime_settings_currency', 'MNT', 90),
  ('organization_runtime_settings_currency', 'MOP', 91),
  ('organization_runtime_settings_currency', 'MRU', 92),
  ('organization_runtime_settings_currency', 'MUR', 93),
  ('organization_runtime_settings_currency', 'MVR', 94),
  ('organization_runtime_settings_currency', 'MWK', 95),
  ('organization_runtime_settings_currency', 'MXN', 96),
  ('organization_runtime_settings_currency', 'MXV', 97),
  ('organization_runtime_settings_currency', 'MYR', 98),
  ('organization_runtime_settings_currency', 'MZN', 99),
  ('organization_runtime_settings_currency', 'NAD', 100),
  ('organization_runtime_settings_currency', 'NGN', 101),
  ('organization_runtime_settings_currency', 'NIO', 102),
  ('organization_runtime_settings_currency', 'NOK', 103),
  ('organization_runtime_settings_currency', 'NPR', 104),
  ('organization_runtime_settings_currency', 'NZD', 105),
  ('organization_runtime_settings_currency', 'OMR', 106),
  ('organization_runtime_settings_currency', 'PAB', 107),
  ('organization_runtime_settings_currency', 'PEN', 108),
  ('organization_runtime_settings_currency', 'PGK', 109),
  ('organization_runtime_settings_currency', 'PHP', 110),
  ('organization_runtime_settings_currency', 'PKR', 111),
  ('organization_runtime_settings_currency', 'PLN', 112),
  ('organization_runtime_settings_currency', 'PYG', 113),
  ('organization_runtime_settings_currency', 'QAR', 114),
  ('organization_runtime_settings_currency', 'RON', 115),
  ('organization_runtime_settings_currency', 'RSD', 116),
  ('organization_runtime_settings_currency', 'RUB', 117),
  ('organization_runtime_settings_currency', 'RWF', 118),
  ('organization_runtime_settings_currency', 'SAR', 119),
  ('organization_runtime_settings_currency', 'SBD', 120),
  ('organization_runtime_settings_currency', 'SCR', 121),
  ('organization_runtime_settings_currency', 'SDG', 122),
  ('organization_runtime_settings_currency', 'SEK', 123),
  ('organization_runtime_settings_currency', 'SGD', 124),
  ('organization_runtime_settings_currency', 'SHP', 125),
  ('organization_runtime_settings_currency', 'SLE', 126),
  ('organization_runtime_settings_currency', 'SOS', 127),
  ('organization_runtime_settings_currency', 'SRD', 128),
  ('organization_runtime_settings_currency', 'SSP', 129),
  ('organization_runtime_settings_currency', 'STN', 130),
  ('organization_runtime_settings_currency', 'SVC', 131),
  ('organization_runtime_settings_currency', 'SYP', 132),
  ('organization_runtime_settings_currency', 'SZL', 133),
  ('organization_runtime_settings_currency', 'THB', 134),
  ('organization_runtime_settings_currency', 'TJS', 135),
  ('organization_runtime_settings_currency', 'TMT', 136),
  ('organization_runtime_settings_currency', 'TND', 137),
  ('organization_runtime_settings_currency', 'TOP', 138),
  ('organization_runtime_settings_currency', 'TRY', 139),
  ('organization_runtime_settings_currency', 'TTD', 140),
  ('organization_runtime_settings_currency', 'TWD', 141),
  ('organization_runtime_settings_currency', 'TZS', 142),
  ('organization_runtime_settings_currency', 'UAH', 143),
  ('organization_runtime_settings_currency', 'UGX', 144),
  ('organization_runtime_settings_currency', 'USD', 145),
  ('organization_runtime_settings_currency', 'USN', 146),
  ('organization_runtime_settings_currency', 'UYI', 147),
  ('organization_runtime_settings_currency', 'UYU', 148),
  ('organization_runtime_settings_currency', 'UYW', 149),
  ('organization_runtime_settings_currency', 'UZS', 150),
  ('organization_runtime_settings_currency', 'VED', 151),
  ('organization_runtime_settings_currency', 'VES', 152),
  ('organization_runtime_settings_currency', 'VND', 153),
  ('organization_runtime_settings_currency', 'VUV', 154),
  ('organization_runtime_settings_currency', 'WST', 155),
  ('organization_runtime_settings_currency', 'XAD', 156),
  ('organization_runtime_settings_currency', 'XAF', 157),
  ('organization_runtime_settings_currency', 'XAG', 158),
  ('organization_runtime_settings_currency', 'XAU', 159),
  ('organization_runtime_settings_currency', 'XBA', 160),
  ('organization_runtime_settings_currency', 'XBB', 161),
  ('organization_runtime_settings_currency', 'XBC', 162),
  ('organization_runtime_settings_currency', 'XBD', 163),
  ('organization_runtime_settings_currency', 'XCD', 164),
  ('organization_runtime_settings_currency', 'XCG', 165),
  ('organization_runtime_settings_currency', 'XDR', 166),
  ('organization_runtime_settings_currency', 'XOF', 167),
  ('organization_runtime_settings_currency', 'XPD', 168),
  ('organization_runtime_settings_currency', 'XPF', 169),
  ('organization_runtime_settings_currency', 'XPT', 170),
  ('organization_runtime_settings_currency', 'XSU', 171),
  ('organization_runtime_settings_currency', 'XTS', 172),
  ('organization_runtime_settings_currency', 'XUA', 173),
  ('organization_runtime_settings_currency', 'XXX', 174),
  ('organization_runtime_settings_currency', 'YER', 175),
  ('organization_runtime_settings_currency', 'ZAR', 176),
  ('organization_runtime_settings_currency', 'ZMW', 177),
  ('organization_runtime_settings_currency', 'ZWG', 178),
  ('organization_runtime_settings_date_format', 'short', 1),
  ('organization_runtime_settings_date_format', 'medium', 2),
  ('organization_runtime_settings_date_format', 'long', 3),
  ('organization_runtime_settings_date_format', 'full', 4),
  ('organization_runtime_settings_number_format', 'auto', 1),
  ('organization_runtime_settings_number_format', 'always', 2),
  ('organization_runtime_settings_number_format', 'min2', 3),
  ('organization_runtime_settings_number_format', 'never', 4)
;
-- END GENERATED: organization settings reference seed

-- vortex_access.platform_permission_declarations: 22 rows
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', '687d5649-62ee-43dd-b684-b8af3a5394c1', 'platform.organization.permissions.read', 'read', 'View available permissions', 'View the selected organisation''s registered permission catalogue without receiving use or assignment authority.', 'sha256:be47b7066dd31f8797452f035cadcb18ef6ead6ff06bec6d3ec54ff769812567', 'organisation-administration', true, 1);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', 'ca5f56d4-5382-4bf8-9a91-fbfdc77642b2', 'platform.organization.roles.read', 'read', 'View roles', 'View the selected organisation''s live roles and registered application role templates.', 'sha256:87c065a43a5dc6676c3276aea10d4ad848665c07a39393dae237e72d6582367b', 'organisation-administration', true, 1);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', '87c96495-c806-4692-9bc2-250ddb10613c', 'platform.organization.roles.manage', 'manage', 'Manage roles', 'Create, change or retire roles only within the actor''s explicit delegated scope.', 'sha256:91eb8281f4905ef55dbe5acf537d49febeede8df37aeaf2ff69292107a59ae2b', 'organisation-administration', true, 1);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', '290ae49f-4cab-4159-9c20-6e664f07d50b', 'platform.organization.groups.read', 'read', 'View groups', 'View the selected organisation''s Groups and membership administration data.', 'sha256:cfb428fda5934cc18c54bc71bcbb4b6e7038714550587b189df0a3c0a3e44f8a', 'organisation-administration', true, 1);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', '6185dc64-464b-4776-97dc-c64a6f299550', 'platform.organization.groups.manage', 'manage', 'Manage groups', 'Manage Groups and memberships subject to delegated scope and permanent-steward safeguards.', 'sha256:a44b20bb994a4519ca283fbd7cc933b7dbba7f7c6c4c0e036492cb84f432b22e', 'organisation-administration', true, 1);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', '9901c0dc-8bac-45c7-be0b-3642cb839bb1', 'platform.organization.assignments.read', 'read', 'View access assignments', 'View the selected organisation''s role and delegation assignments and their effective scope.', 'sha256:e46f5f2b4e9dcf77e6f96918828c7421044605b35216c5eecc0e29909c9a6848', 'organisation-administration', true, 1);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', '156d01f3-8f80-45fb-8fc8-b31c47dbb1df', 'platform.organization.assignments.manage', 'manage', 'Manage access assignments', 'Grant, change or revoke use and delegation assignments only within the actor''s explicit delegated scope.', 'sha256:9c2cf2b688335a1c3edf32d397c7a9e611743736680e30c3672dfaf11c7a9f36', 'organisation-administration', true, 1);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', '02c772e5-2921-4300-ad90-4f5772a7fa46', 'platform.organization.accounts.read', 'read', 'View organisation accounts', 'View the selected organisation''s safe account-administration information.', 'sha256:51234f517c9a62379cecc8ef047c3b5266096381dbc58e77d8a889fc3be32641', 'organisation-administration', true, 1);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', '630a980c-0ff5-40b1-a329-7326a2122395', 'platform.organization.accounts.manage', 'manage', 'Manage organisation accounts', 'Change organisation-account lifecycle through the protected operation without changing global identity or removing the final permanent steward.', 'sha256:59439415b18b92167020f82086693b45cd238c9c4b8ac6fdd3ce071bc6d5b9e0', 'organisation-administration', true, 1);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', '9300e501-6d56-41b1-b203-3361dbace9bc', 'platform.organization.invitations.read', 'read', 'View invitations', 'View safe invitation administration metadata without the raw invitation secret or its stored fingerprint.', 'sha256:b4462ee4471b7c93d820caef5690a31f7e7be4070e3ba8b7e83fe2e68b024cd8', 'organisation-administration', true, 1);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', 'c2e03f58-debe-478e-b1e0-a4a8b8f1b9cb', 'platform.organization.invitations.manage', 'manage', 'Manage invitations', 'Create or revoke invitations through the protected operation; role assignment additionally requires the actor''s assignment authority.', 'sha256:65b1804f9f5148adfb06d50ac16243b9711cab368b8c9950ff935e2e89a69154', 'organisation-administration', true, 1);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', '6dffcb0b-ded8-4cd5-acc8-c50f7d4269a5', 'platform.organization.runtime_settings.read', 'read', 'View organisation display settings', 'View the organisation''s default language, time zone, currency, date and number display settings.', 'sha256:cba574ab17eff487cc68f32e8ce013eea83570060f17f73b02e91764f665120a', 'organisation-administration', true, 1);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', 'c658c254-2884-414a-9012-512c0cfe4b34', 'platform.organization.runtime_settings.manage', 'manage', 'Manage organisation display settings', 'Change the organisation''s validated default display settings through the protected revision-checked operation.', 'sha256:e79914b57f2c0b37bb07698bee58dc8557762020d3f082e19a4ceb8304b8e4f7', 'organisation-administration', true, 1);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', '7ecd3304-f16c-47d4-94db-0964980091ba', 'platform.organization.applications.manage', 'manage', 'Manage applications', 'Install, upgrade or detach exact application bindings in the selected organisation without receiving business-record use or role-assignment authority.', 'sha256:f3c8f4195e1d61f27a1cc65b82f6aa46ac45629195f3a8ea125925c7f12f3f81', 'organisation-administration', false, 3);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', 'ec2908a1-f3cd-4c4a-8bf7-91bffbf4cb3d', 'platform.organization.connections.manage', 'manage', 'Manage connections', 'Register, grant, check, revoke and reauthorise connection instances in the selected organisation without application-installation or access-assignment authority.', 'sha256:809b4b3ad29ff61ab5ea73c06504909540b8111a2b3c2e1310559a7e9dc2e31e', 'system-core', false, 4);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', 'e85c2232-2ed7-4ce8-b1e5-7e2ad8e2b847', 'platform.security.identities.disable', 'manage', 'Disable identities', 'Disable an identity and revoke its active sessions through the identity owner''s protected operation without receiving general identity-administration or business-record authority.', 'sha256:d3b44fd282d1155370c5325aecc38590891afebf6172a29d1b3afcc8501ce745', 'system-core', false, 5);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', '014d2898-1969-4434-805c-eeb0f0e6f797', 'platform.support.access.request', 'manage', 'Request support access', 'Request time-bounded support access to another organisation for a named operator and exact scope without receiving standing access to that organisation.', 'sha256:1cd6a404fef31df331259055de726ca6f176b58994e79946ceb069bac113ce4c', 'system-core', false, 5);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', '07e4653c-d358-489f-8067-46e085d99478', 'platform.organization.support.approve', 'manage', 'Approve support access', 'Approve or refuse a time-bounded support-access request for one''s own organisation without granting the requester standing authority.', 'sha256:84b1f9b314ca426256aceec5c156dcc3e771a9d5612505ab77dbcfd89df9c659', 'system-core', false, 5);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', '0548c061-b1a9-48e5-a04a-eb1d0dae0644', 'platform.organization.definition_drafts.manage', 'manage', 'Manage definition drafts', 'Create and change module and application drafts, including flows, placements and role templates, without publication or installation authority.', 'sha256:29c4f706d6b65b54f4c3378de3f64816c01a22dc308ee7f6f0898d71eda216a0', 'system-core', false, 6);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', 'dfdd5aba-2b85-4169-b570-92be284e7b5c', 'platform.organization.definition_releases.manage', 'manage', 'Manage definition releases', 'Publish module and application drafts as immutable releases without receiving installation or business-record authority.', 'sha256:b291e3a7d8a7f5cc0f346762914d1b1122be875d21fa70e5fdad819d28b1a80a', 'system-core', false, 6);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', 'd1be247f-094d-47c1-a38d-762290868c91', 'platform.organization.custom_code.manage', 'manage', 'Manage custom code', 'Required in addition to the application-management permission to install, upgrade or uninstall packages that bundle custom components or scripts.', 'sha256:d8faa202f04c0c453cb87ed37f3b8f226b4171d133fc1277616a2b418db43c21', 'system-core', false, 6);
INSERT INTO vortex_access.platform_permission_declarations (owner_kind, owner_id, permission_id, permission_key, action_kind, label, description, meaning_fingerprint, source_module_key, steward_minimum, first_revision) VALUES ('platform', 'cabe121e-0baf-4084-9471-cce915d460a8', 'eaade6fd-7390-44d2-a7ef-343324c7384a', 'platform.organization.system_applications.manage', 'manage', 'Manage system applications', 'Change system application definitions, including extension fields, theme, navigation and dependent applications, without uninstallation authority.', 'sha256:0c68ccc8a752c8009a5b84e5a22a584f3f22f666213121db1be7fb010cdbc50b', 'system-core', false, 6);

-- vortex_record.protected_read_model_views: 16 rows
INSERT INTO vortex_record.protected_read_model_views (protected_read_model_key, reader_schema, reader_function, changed_at) VALUES ('organization_runtime_settings', 'vortex_access', 'list_organization_runtime_settings_projection', '2026-10-12 16:24:38.327221+00');
INSERT INTO vortex_record.protected_read_model_views (protected_read_model_key, reader_schema, reader_function, changed_at) VALUES ('organization_accounts', 'vortex_access', 'list_organization_accounts_projection', '2026-10-12 16:24:39.837915+00');
INSERT INTO vortex_record.protected_read_model_views (protected_read_model_key, reader_schema, reader_function, changed_at) VALUES ('organization_invitations', 'vortex_access', 'list_organization_invitations_projection', '2026-10-12 16:24:39.837915+00');
INSERT INTO vortex_record.protected_read_model_views (protected_read_model_key, reader_schema, reader_function, changed_at) VALUES ('groups', 'vortex_access', 'list_organization_groups_projection', '2026-10-12 16:24:39.908127+00');
INSERT INTO vortex_record.protected_read_model_views (protected_read_model_key, reader_schema, reader_function, changed_at) VALUES ('people', 'vortex_access', 'list_organization_group_memberships_projection', '2026-10-12 16:24:39.908127+00');
INSERT INTO vortex_record.protected_read_model_views (protected_read_model_key, reader_schema, reader_function, changed_at) VALUES ('permissions', 'vortex_access', 'list_organization_permissions_projection', '2026-10-12 16:24:40.114471+00');
INSERT INTO vortex_record.protected_read_model_views (protected_read_model_key, reader_schema, reader_function, changed_at) VALUES ('roles', 'vortex_access', 'list_organization_roles_projection', '2026-10-12 16:24:40.114471+00');
INSERT INTO vortex_record.protected_read_model_views (protected_read_model_key, reader_schema, reader_function, changed_at) VALUES ('effective_assignments', 'vortex_access', 'list_organization_role_assignments_projection', '2026-10-12 16:24:40.114471+00');
INSERT INTO vortex_record.protected_read_model_views (protected_read_model_key, reader_schema, reader_function, changed_at) VALUES ('role_activations', 'vortex_access', 'list_organization_role_activations_projection', '2026-10-12 16:24:40.114471+00');
INSERT INTO vortex_record.protected_read_model_views (protected_read_model_key, reader_schema, reader_function, changed_at) VALUES ('delegations', 'vortex_access', 'list_organization_delegations_projection', '2026-10-12 16:24:40.114471+00');
INSERT INTO vortex_record.protected_read_model_views (protected_read_model_key, reader_schema, reader_function, changed_at) VALUES ('tenant_structure', 'vortex_identity', 'list_organizations_projection', '2026-10-12 16:24:40.202072+00');
INSERT INTO vortex_record.protected_read_model_views (protected_read_model_key, reader_schema, reader_function, changed_at) VALUES ('tenants', 'vortex_identity', 'list_tenants_projection', '2026-10-12 16:24:40.202072+00');
INSERT INTO vortex_record.protected_read_model_views (protected_read_model_key, reader_schema, reader_function, changed_at) VALUES ('tenant_administrators', 'vortex_identity', 'list_tenant_administrators_projection', '2026-10-12 16:24:40.202072+00');
INSERT INTO vortex_record.protected_read_model_views (protected_read_model_key, reader_schema, reader_function, changed_at) VALUES ('installed_applications', 'vortex_access', 'list_installed_applications_projection', '2026-10-12 16:24:40.202072+00');
INSERT INTO vortex_record.protected_read_model_views (protected_read_model_key, reader_schema, reader_function, changed_at) VALUES ('landing_zone_applications', 'vortex_access', 'list_landing_zone_applications_projection', '2026-10-12 16:24:42.94796+00');
INSERT INTO vortex_record.protected_read_model_views (protected_read_model_key, reader_schema, reader_function, changed_at) VALUES ('application_role_templates', 'vortex_access', 'list_application_role_templates_projection', '2026-10-12 16:24:50.984155+00');

INSERT INTO storage.buckets (id, name, public) VALUES ('private_files', 'private_files', false), ('component_bundles', 'component_bundles', false) ON CONFLICT (id) DO UPDATE SET public = false;

CREATE POLICY vortex_component_bundle_read ON storage.objects FOR SELECT TO authenticated USING (((bucket_id = 'component_bundles'::text) AND ((auth.jwt() ->> 'tokenKind'::text) = 'vortex_component_bundle_operation'::text) AND ((auth.jwt() ->> 'role'::text) = 'authenticated'::text) AND ((auth.jwt() ->> 'destinationProject'::text) = NULLIF(current_setting('vortex.destination_project'::text, true), ''::text)) AND ((auth.jwt() ->> 'bucketId'::text) = bucket_id) AND ((auth.jwt() ->> 'objectPath'::text) = name) AND (name ~ '^(manifests/[0-9a-f]{96}\.json|bundles/[0-9a-f]{96}/[A-Za-z0-9._/-]+)$'::text) AND ((auth.jwt() ->> 'operation'::text) = 'read'::text) AND ((auth.jwt() ->> 'iat'::text) ~ '^[0-9]{1,18}$'::text) AND ((auth.jwt() ->> 'exp'::text) ~ '^[0-9]{1,18}$'::text) AND (((auth.jwt() ->> 'exp'::text))::bigint > ((auth.jwt() ->> 'iat'::text))::bigint) AND ((((auth.jwt() ->> 'exp'::text))::bigint - ((auth.jwt() ->> 'iat'::text))::bigint) <= 60) AND (((auth.jwt() ->> 'iat'::text))::bigint <= ((floor(date_part('epoch'::text, clock_timestamp())))::bigint + 5)) AND (((auth.jwt() ->> 'exp'::text))::bigint >= (floor(date_part('epoch'::text, clock_timestamp())))::bigint)));
CREATE POLICY vortex_component_bundle_upload ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'component_bundles'::text) AND ((auth.jwt() ->> 'tokenKind'::text) = 'vortex_component_bundle_operation'::text) AND ((auth.jwt() ->> 'role'::text) = 'authenticated'::text) AND ((auth.jwt() ->> 'destinationProject'::text) = NULLIF(current_setting('vortex.destination_project'::text, true), ''::text)) AND ((auth.jwt() ->> 'bucketId'::text) = bucket_id) AND ((auth.jwt() ->> 'objectPath'::text) = name) AND (name ~ '^(manifests/[0-9a-f]{96}\.json|bundles/[0-9a-f]{96}/[A-Za-z0-9._/-]+)$'::text) AND ((auth.jwt() ->> 'operation'::text) = 'upload'::text) AND ((auth.jwt() ->> 'iat'::text) ~ '^[0-9]{1,18}$'::text) AND ((auth.jwt() ->> 'exp'::text) ~ '^[0-9]{1,18}$'::text) AND (((auth.jwt() ->> 'exp'::text))::bigint > ((auth.jwt() ->> 'iat'::text))::bigint) AND ((((auth.jwt() ->> 'exp'::text))::bigint - ((auth.jwt() ->> 'iat'::text))::bigint) <= 60) AND (((auth.jwt() ->> 'iat'::text))::bigint <= ((floor(date_part('epoch'::text, clock_timestamp())))::bigint + 5)) AND (((auth.jwt() ->> 'exp'::text))::bigint >= (floor(date_part('epoch'::text, clock_timestamp())))::bigint)));
CREATE POLICY vortex_private_file_delete ON storage.objects FOR DELETE TO authenticated USING (((bucket_id = 'private_files'::text) AND ((auth.jwt() ->> 'tokenKind'::text) = 'vortex_file_storage_operation'::text) AND ((auth.jwt() ->> 'role'::text) = 'authenticated'::text) AND ((auth.jwt() ->> 'destinationProject'::text) = NULLIF(current_setting('vortex.destination_project'::text, true), ''::text)) AND ((auth.jwt() ->> 'bucketId'::text) = bucket_id) AND ((auth.jwt() ->> 'objectPath'::text) = name) AND (name ~~ ((auth.jwt() ->> 'organizationId'::text) || '/%'::text)) AND ((auth.jwt() ->> 'organizationId'::text) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND ((auth.jwt() ->> 'operation'::text) = 'delete'::text) AND ((auth.jwt() ->> 'iat'::text) ~ '^[0-9]{1,18}$'::text) AND ((auth.jwt() ->> 'exp'::text) ~ '^[0-9]{1,18}$'::text) AND (((auth.jwt() ->> 'exp'::text))::bigint > ((auth.jwt() ->> 'iat'::text))::bigint) AND ((((auth.jwt() ->> 'exp'::text))::bigint - ((auth.jwt() ->> 'iat'::text))::bigint) <= 60) AND (((auth.jwt() ->> 'iat'::text))::bigint <= ((floor(date_part('epoch'::text, clock_timestamp())))::bigint + 5)) AND (((auth.jwt() ->> 'exp'::text))::bigint >= (floor(date_part('epoch'::text, clock_timestamp())))::bigint)));
CREATE POLICY vortex_private_file_read ON storage.objects FOR SELECT TO authenticated USING (((bucket_id = 'private_files'::text) AND ((auth.jwt() ->> 'tokenKind'::text) = 'vortex_file_storage_operation'::text) AND ((auth.jwt() ->> 'role'::text) = 'authenticated'::text) AND ((auth.jwt() ->> 'destinationProject'::text) = NULLIF(current_setting('vortex.destination_project'::text, true), ''::text)) AND ((auth.jwt() ->> 'bucketId'::text) = bucket_id) AND ((auth.jwt() ->> 'objectPath'::text) = name) AND (name ~~ ((auth.jwt() ->> 'organizationId'::text) || '/%'::text)) AND ((auth.jwt() ->> 'organizationId'::text) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND ((auth.jwt() ->> 'operation'::text) = 'read'::text) AND ((auth.jwt() ->> 'iat'::text) ~ '^[0-9]{1,18}$'::text) AND ((auth.jwt() ->> 'exp'::text) ~ '^[0-9]{1,18}$'::text) AND (((auth.jwt() ->> 'exp'::text))::bigint > ((auth.jwt() ->> 'iat'::text))::bigint) AND ((((auth.jwt() ->> 'exp'::text))::bigint - ((auth.jwt() ->> 'iat'::text))::bigint) <= 60) AND (((auth.jwt() ->> 'iat'::text))::bigint <= ((floor(date_part('epoch'::text, clock_timestamp())))::bigint + 5)) AND (((auth.jwt() ->> 'exp'::text))::bigint >= (floor(date_part('epoch'::text, clock_timestamp())))::bigint)));
CREATE POLICY vortex_private_file_upload ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'private_files'::text) AND ((auth.jwt() ->> 'tokenKind'::text) = 'vortex_file_storage_operation'::text) AND ((auth.jwt() ->> 'role'::text) = 'authenticated'::text) AND ((auth.jwt() ->> 'destinationProject'::text) = NULLIF(current_setting('vortex.destination_project'::text, true), ''::text)) AND ((auth.jwt() ->> 'bucketId'::text) = bucket_id) AND ((auth.jwt() ->> 'objectPath'::text) = name) AND (name ~~ ((auth.jwt() ->> 'organizationId'::text) || '/%'::text)) AND ((auth.jwt() ->> 'organizationId'::text) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND ((auth.jwt() ->> 'operation'::text) = 'upload'::text) AND ((auth.jwt() ->> 'iat'::text) ~ '^[0-9]{1,18}$'::text) AND ((auth.jwt() ->> 'exp'::text) ~ '^[0-9]{1,18}$'::text) AND (((auth.jwt() ->> 'exp'::text))::bigint > ((auth.jwt() ->> 'iat'::text))::bigint) AND ((((auth.jwt() ->> 'exp'::text))::bigint - ((auth.jwt() ->> 'iat'::text))::bigint) <= 60) AND (((auth.jwt() ->> 'iat'::text))::bigint <= ((floor(date_part('epoch'::text, clock_timestamp())))::bigint + 5)) AND (((auth.jwt() ->> 'exp'::text))::bigint >= (floor(date_part('epoch'::text, clock_timestamp())))::bigint)));

-- Deferred Vortex object ownership: the postgres migration role must finish
-- comments, constraints, grants, policies, and system data before handing over.
GRANT ALL ON SCHEMA record_data TO vortex_record_owner;
GRANT ALL ON SCHEMA vortex_module TO vortex_module_owner;
GRANT ALL ON SCHEMA vortex_record TO vortex_record_owner, vortex_record_inventory;
ALTER FUNCTION vortex_access.evaluate_organization_permission_eligibility(p_declaration jsonb) OWNER TO vortex_access_owner;
ALTER FUNCTION vortex_access.evaluate_organization_record_permission_availability(p_declaration jsonb) OWNER TO vortex_access_owner;
ALTER FUNCTION vortex_access.list_organization_permissions_for_administration(p_after_application_root_id uuid, p_after_owner_kind text, p_after_owner_id uuid, p_after_permission_id uuid, p_page_size integer) OWNER TO vortex_access_owner;
ALTER FUNCTION vortex_access.list_organization_permissions_projection(p_record_id uuid, p_page_size integer) OWNER TO vortex_access_owner;
ALTER FUNCTION vortex_access.organization_account_has_current_application_access_internal(p_organization_id uuid, p_organization_account_id uuid, p_application_root_id uuid) OWNER TO vortex_access_owner;
ALTER FUNCTION vortex_access.organization_groups_administration_scope() OWNER TO vortex_access_owner;
ALTER FUNCTION vortex_access.organization_permissions_administration_scope() OWNER TO vortex_access_owner;
ALTER FUNCTION vortex_access.protect_platform_permission_declarations() OWNER TO vortex_access_owner;
ALTER FUNCTION vortex_access.read_application_permission_snapshot(p_organization_id uuid, p_application_root_id uuid) OWNER TO vortex_access_owner;
ALTER FUNCTION vortex_access.read_available_permission(p_organization_id uuid, p_application_root_id uuid, p_owner_kind text, p_owner_id uuid, p_permission_id uuid) OWNER TO vortex_access_owner;
ALTER FUNCTION vortex_access.read_capability_reservation_balance(p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text) OWNER TO vortex_access_owner;
ALTER FUNCTION vortex_access.read_current_application_role_ids_for_launcher() OWNER TO vortex_access_owner;
ALTER FUNCTION vortex_access.read_guarded_platform_permission_minimum_internal() OWNER TO vortex_access_owner;
ALTER FUNCTION vortex_access.read_organization_permission_for_administration(p_application_root_id uuid, p_owner_kind text, p_owner_id uuid, p_permission_id uuid) OWNER TO vortex_access_owner;
ALTER FUNCTION vortex_access.read_platform_permission_declaration_catalogue_internal(p_registration_revision bigint) OWNER TO vortex_access_owner;
ALTER FUNCTION vortex_access.resolve_record_field_bounds_internal(p_decision jsonb) OWNER TO vortex_access_owner;
ALTER FUNCTION vortex_access.resolve_record_read_field_bounds_internal(p_declaration jsonb) OWNER TO vortex_access_owner;
ALTER FUNCTION vortex_access.resolve_record_read_scan_routes_internal(p_declaration jsonb, p_ownership_mode text) OWNER TO vortex_access_owner;
ALTER FUNCTION vortex_access.validate_application_role_template_continuity_evidence() OWNER TO vortex_access_owner;
ALTER FUNCTION vortex_access.validate_organization_role_revision_evidence() OWNER TO vortex_access_owner;
ALTER FUNCTION vortex_access.validate_permission_continuity_evidence() OWNER TO vortex_access_owner;
ALTER FUNCTION vortex_access.validation_reference_list(p_list text) OWNER TO vortex_access_owner;
ALTER FUNCTION vortex_activity.read_organization_activity_aggregates(p_occurred_from timestamp with time zone, p_occurred_to timestamp with time zone, p_actor_kind text, p_actor_id uuid, p_action text, p_correlation_id uuid, p_outcome text, p_source text, p_group_by text) OWNER TO vortex_activity_owner;
ALTER FUNCTION vortex_activity.read_organization_activity_page(p_occurred_from timestamp with time zone, p_occurred_to timestamp with time zone, p_actor_kind text, p_actor_id uuid, p_action text, p_correlation_id uuid, p_outcome text, p_source text, p_page_size integer, p_after_occurred_at timestamp with time zone, p_after_activity_id uuid) OWNER TO vortex_activity_owner;
ALTER FUNCTION vortex_connection.assert_connection_administration_authority(p_context jsonb) OWNER TO vortex_connection_owner;
ALTER FUNCTION vortex_connection.assert_human_administration_request() OWNER TO vortex_connection_owner;
ALTER FUNCTION vortex_connection.grant_connection_application_for_administration(p_connection_instance_id uuid, p_application_root_id uuid, p_administrator_activity_id uuid) OWNER TO vortex_connection_owner;
ALTER FUNCTION vortex_connection.reauthorize_connection_instance_for_administration(p_connection_instance_id uuid, p_expected_revision bigint, p_administrator_activity_id uuid, p_destination_fingerprint text, p_token_expires_at timestamp with time zone) OWNER TO vortex_connection_owner;
ALTER FUNCTION vortex_connection.reauthorize_connection_instance_internal(p_connection_instance_id uuid, p_expected_revision bigint, p_administrator_activity_id uuid, p_destination_fingerprint text, p_token_expires_at timestamp with time zone) OWNER TO vortex_connection_owner;
ALTER FUNCTION vortex_connection.record_connection_health_check_for_administration(p_connection_instance_id uuid, p_expected_revision bigint, p_new_health_outcome text, p_administrator_activity_id uuid) OWNER TO vortex_connection_owner;
ALTER FUNCTION vortex_connection.record_connection_health_check_internal(p_connection_instance_id uuid, p_expected_revision bigint, p_new_health_outcome text, p_administrator_activity_id uuid) OWNER TO vortex_connection_owner;
ALTER FUNCTION vortex_connection.register_connection_instance_for_administration(p_connection_instance_id uuid, p_connection_type_id uuid, p_connection_type_version text, p_destination_key text, p_destination_fingerprint text, p_administrator_activity_id uuid, p_token_expires_at timestamp with time zone) OWNER TO vortex_connection_owner;
ALTER FUNCTION vortex_connection.register_connection_instance_internal(p_connection_instance_id uuid, p_organization_id uuid, p_connection_type_id uuid, p_connection_type_version text, p_destination_key text, p_destination_fingerprint text, p_administrator_activity_id uuid, p_token_expires_at timestamp with time zone) OWNER TO vortex_connection_owner;
ALTER FUNCTION vortex_connection.revoke_connection_application_for_administration(p_connection_instance_id uuid, p_application_root_id uuid, p_administrator_activity_id uuid) OWNER TO vortex_connection_owner;
ALTER FUNCTION vortex_connection.revoke_connection_application_internal(p_connection_instance_id uuid, p_application_root_id uuid, p_administrator_activity_id uuid) OWNER TO vortex_connection_owner;
ALTER FUNCTION vortex_connection.revoke_connection_instance_for_administration(p_connection_instance_id uuid, p_expected_revision bigint, p_administrator_activity_id uuid) OWNER TO vortex_connection_owner;
ALTER FUNCTION vortex_connection.revoke_connection_instance_internal(p_connection_instance_id uuid, p_expected_revision bigint, p_administrator_activity_id uuid) OWNER TO vortex_connection_owner;
ALTER FUNCTION vortex_connection.validated_administration_context(p_organization_id uuid) OWNER TO vortex_connection_owner;
ALTER FUNCTION vortex_definition.application_role_identity_is_exact_for_human_request_internal(p_application_root_id uuid, p_source_role_id uuid) OWNER TO vortex_definition_owner;
ALTER FUNCTION vortex_definition.application_root_exists_for_organization_internal(p_organization_id uuid, p_application_root_id uuid) OWNER TO vortex_definition_owner;
ALTER FUNCTION vortex_definition.read_application_release_adoption_release_set(p_application_root_id uuid, p_application_release_revision bigint) OWNER TO vortex_definition_owner;
ALTER FUNCTION vortex_definition.read_application_release_adoption_target(p_application_root_id uuid) OWNER TO vortex_definition_owner;
ALTER FUNCTION vortex_definition.validated_builder_draft_write_context_internal(p_root_id uuid) OWNER TO vortex_definition_owner;
ALTER FUNCTION vortex_event.acknowledge_consumer_occurrence(p_consumer_key text, p_ack_cursor uuid, p_occurrence_id uuid) OWNER TO vortex_event_owner;
ALTER FUNCTION vortex_event.append_detached_offboarding_reassignment_internal(p_storage_contract_id uuid, p_record_id uuid, p_record_type_id uuid, p_occurrence_id uuid) OWNER TO vortex_event_owner;
ALTER FUNCTION vortex_event.append_record_occurrences(p_storage_contract_id uuid, p_record_id uuid, p_occurrences jsonb) OWNER TO vortex_event_owner;
ALTER FUNCTION vortex_event.claim_consumer_occurrences(p_consumer_key text, p_batch_size integer, p_lease_seconds integer) OWNER TO vortex_event_owner;
ALTER FUNCTION vortex_event.event_dispatch_backlog_status() OWNER TO vortex_event_owner;
ALTER FUNCTION vortex_event.list_terminally_failed_consumer_occurrences(p_consumer_key text, p_limit integer) OWNER TO vortex_event_owner;
ALTER FUNCTION vortex_event.record_consumer_occurrence_delivery_failure(p_consumer_key text, p_occurrence_id uuid, p_claim_cursor uuid, p_failure_code text, p_max_attempts integer, p_retry_backoff_seconds integer) OWNER TO vortex_event_owner;
ALTER FUNCTION vortex_event.recover_consumer_occurrence_claim(p_consumer_key text, p_occurrence_id uuid, p_expected_failure_count integer, p_system_actor_id uuid) OWNER TO vortex_event_owner;
ALTER FUNCTION vortex_event.renew_consumer_occurrence_lease(p_consumer_key text, p_ack_cursor uuid, p_occurrence_id uuid, p_lease_seconds integer) OWNER TO vortex_event_owner;
ALTER FUNCTION vortex_file.activate_uploaded_file(p_file_id uuid, p_expected_revision bigint, p_owner_record_type_id uuid, p_owner_record_id uuid, p_owner_field_id uuid, p_attachment_reference_id uuid, p_replacing_file_id uuid) OWNER TO vortex_file_owner;
ALTER FUNCTION vortex_file.claim_file_download_grant(p_one_time_id uuid) OWNER TO vortex_file_owner;
ALTER FUNCTION vortex_file.claim_file_upload_grant(p_one_time_id uuid) OWNER TO vortex_file_owner;
ALTER FUNCTION vortex_file.read_file_for_download(p_file_id uuid) OWNER TO vortex_file_owner;
ALTER FUNCTION vortex_file.read_file_upload(p_file_id uuid) OWNER TO vortex_file_owner;
ALTER FUNCTION vortex_file.read_versioned_file_metadata(p_file_id uuid) OWNER TO vortex_file_owner;
ALTER FUNCTION vortex_file.record_file_download_grant(p_one_time_id uuid, p_file_id uuid, p_owner_record_type_id uuid, p_owner_record_id uuid, p_owner_field_id uuid, p_actor jsonb, p_purpose text, p_correlation_id uuid, p_expires_at timestamp with time zone) OWNER TO vortex_file_owner;
ALTER FUNCTION vortex_file.record_file_upload_outcome(p_file_id uuid, p_expected_revision bigint, p_detected_media_type text, p_size_bytes bigint, p_checksum text, p_scanner_name text, p_scanner_version text, p_scanner_result text) OWNER TO vortex_file_owner;
ALTER FUNCTION vortex_file.renew_file_upload(p_file_id uuid, p_expected_revision bigint, p_previous_one_time_id uuid, p_new_one_time_id uuid, p_policy_fingerprint text, p_grant_expires_at timestamp with time zone) OWNER TO vortex_file_owner;
ALTER FUNCTION vortex_file.upload_validated_context() OWNER TO vortex_file_owner;
ALTER FUNCTION vortex_identity.accept_organization_invitation(p_token_fingerprint text, p_identity_id uuid, p_verified_email text, p_display_name text, p_correlation_id uuid) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.accept_organization_invitation_with_transition(p_token_fingerprint text, p_identity_id uuid, p_verified_email text, p_display_name text, p_correlation_id uuid) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.begin_organization_account_closing(p_organization_account_id uuid, p_expected_revision bigint) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.change_organization_account_state(p_organization_account_id uuid, p_expected_revision bigint, p_state text) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.close_cluster_identity(p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid, p_command_fingerprint text, p_identity_id uuid, p_expected_revision bigint) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.create_organization_invitation(p_invited_email text, p_token_fingerprint text, p_expires_at timestamp with time zone) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.ensure_identity_projection(p_identity_id uuid, p_correlation_id uuid) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.finalize_organization_account_deletion(p_organization_account_id uuid, p_expected_revision bigint) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.has_active_identity_organization_account_internal(p_identity_id uuid, p_organization_id uuid) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.identity_is_disabled(p_identity_id uuid) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.initialize_organization_runtime_settings(p_organization_id uuid, p_language text, p_time_zone text, p_currency text, p_date_format text, p_number_format text) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.is_active_organization_account_reference_internal(p_tenant_id uuid, p_organization_id uuid, p_organization_account_id uuid) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.list_organization_account_choices_internal(p_tenant_id uuid, p_organization_id uuid, p_search text, p_page_size integer, p_after_sort_key text, p_after_organization_account_id uuid) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.list_organization_accounts(p_identity_id uuid) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.list_organization_accounts_for_administration_internal(p_organization_id uuid, p_after_organization_account_id uuid, p_page_size integer) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.list_organization_accounts_projection_internal(p_organization_id uuid, p_active_members_only boolean) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.list_organization_invitations_for_administration_internal(p_organization_id uuid, p_after_invitation_id uuid, p_page_size integer) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.list_organization_invitations_projection_internal(p_organization_id uuid) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.lock_organization_account_for_deletion_internal(p_organization_account_id uuid) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.organization_and_tenant_are_active_internal(p_organization_id uuid) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.publish_identity_disablement(p_subject_identity_id uuid, p_actor_identity_id uuid, p_correlation_id uuid, p_published_at timestamp with time zone) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.reactivate_cluster_identity(p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid, p_command_fingerprint text, p_identity_id uuid, p_expected_revision bigint) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.reactivate_tenant(p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_expected_revision bigint) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.read_current_organization_runtime_settings_internal(p_organization_id uuid) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.read_identity_projection(p_identity_id uuid) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.read_organization_account_for_administration_internal(p_organization_id uuid, p_organization_account_id uuid) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.read_organization_invitation_for_administration_internal(p_organization_id uuid, p_invitation_id uuid) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.read_organization_time_zone_internal(p_organization_id uuid) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.revoke_organization_invitation(p_invitation_id uuid, p_expected_revision bigint) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.save_organization_runtime_settings_record_internal(p_organization_id uuid, p_expected_revision bigint, p_core_values jsonb, p_extension_values jsonb) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.suspend_cluster_identity(p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid, p_command_fingerprint text, p_identity_id uuid, p_expected_revision bigint) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.suspend_tenant(p_cluster_id uuid, p_operator_actor_id uuid, p_duplicate_key uuid, p_command_fingerprint text, p_tenant_id uuid, p_expected_revision bigint) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.tenant_administrator_grant_expiry_cap(p_actor_identity_id uuid, p_tenant_id uuid, p_capabilities text[], p_evaluated_at timestamp with time zone) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.tenant_has_permanent_manager(p_tenant_id uuid, p_checked_at timestamp with time zone, p_excluded_assignment_id uuid) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.update_organization_account_profile_internal(p_organization_id uuid, p_organization_account_id uuid, p_expected_revision bigint, p_display_name text, p_language text, p_time_zone text) OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.validate_organization_lifecycle() OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_identity.validate_tenant_lifecycle() OWNER TO vortex_identity_owner;
ALTER FUNCTION vortex_invalidation.application_is_installed(p_organization_id uuid, p_application_root_id uuid) OWNER TO vortex_invalidation_owner;
ALTER FUNCTION vortex_module.activate_application_installation(p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.assert_prepared_installation_runtime_bundle(p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb, p_pin_fingerprint text) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.assert_preview_installation_authority_internal() OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.count_storage_adoption_dependents_internal(p_module_root_id uuid, p_storage_contract_id uuid, p_dependent_release_revisions bigint[]) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.create_preview_installation(p_application_root_id uuid, p_expected_draft_revision bigint, p_candidate jsonb) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.detach_application_installation(p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.discard_preview_installation(p_preview_installation_id uuid) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.drain_installation(p_activity_id uuid, p_root_id uuid, p_release_revision bigint, p_expected_module_bindings jsonb) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.expire_preview_installations(p_limit integer) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.has_active_application_release_binding_internal(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.lock_active_installation_runtime_mapping_internal(p_expected_identity jsonb) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.lock_prepared_installation_runtime_mapping_internal(p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.lock_storage_adoption_binding_internal(p_organization_id uuid, p_application_root_id uuid, p_module_root_id uuid, p_storage_contract_id uuid, p_source_release_revision bigint) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.provision_module_contribution_storage(p_application_root_id uuid, p_application_release_revision bigint, p_module_root_id uuid, p_module_release_revision bigint, p_expected_binding_revision bigint, p_contribution_mode text, p_contributions jsonb) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.provision_module_installation_storage(p_application_root_id uuid, p_application_release_revision bigint, p_module_root_id uuid, p_module_release_revision bigint, p_expected_binding_revision bigint) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.read_active_installation_bundle_identity() OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.read_active_installation_for_scope_internal(p_organization_id uuid, p_application_root_id uuid) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.read_active_shared_record_consumers_internal(p_module_root_id uuid, p_record_type_id uuid, p_storage_contract_id uuid) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.read_application_installation_bindings(p_application_root_id uuid) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.read_current_active_installation() OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.read_current_detached_installation_for_transfer_internal() OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.read_current_offboarding_inventory_installation_internal() OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.read_installation_runtime_bundle_index(p_application_root_id uuid, p_application_release_revision bigint, p_bundle_format_version integer) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.read_installation_runtime_bundle_parts(p_application_root_id uuid, p_application_release_revision bigint, p_bundle_format_version integer, p_sections jsonb) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.read_lifecycle_activation_targets_internal(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.read_offboarding_inventory_contract_applications_internal(p_storage_contract_id uuid) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.read_prepared_installation_runtime_source(p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.read_preview_installation(p_preview_installation_id uuid) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.read_preview_record_installation_internal(p_preview_installation_id uuid) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.read_provisioned_lifecycle_setup_targets_internal(p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.record_application_installation_outcome(p_activity_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_state text) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.record_lifecycle_provisioned_setup_target_internal(p_organization_id uuid, p_application_root_id uuid, p_expected_binding_revision bigint, p_storage_contract_id uuid, p_workflow_id uuid, p_expected_workflow_revision bigint) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.record_lifecycle_target_is_installed_internal(p_organization_id uuid, p_application_root_id uuid, p_storage_contract_id uuid) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.record_lifecycle_workflow_is_installed_internal(p_organization_id uuid, p_application_root_id uuid, p_storage_contract_id uuid, p_workflow_id uuid, p_expected_workflow_revision bigint) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.remove_abandoned_runtime_bundles_internal(p_limit integer) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.remove_installation_runtime_bundles_internal(p_application_root_id uuid) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.repair_active_installation_runtime_bundle_internal(p_expected_identity jsonb, p_parts jsonb) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.resolve_addressed_active_application_identity(p_application_key text) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.storage_conversion_is_installed_internal(p_organization_id uuid, p_application_root_id uuid, p_storage_contract_id uuid, p_module_root_id uuid, p_module_release_revision bigint) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_module.write_installation_runtime_bundle_internal(p_application_root_id uuid, p_application_release_revision bigint, p_bundle_format_version integer, p_pin_fingerprint text, p_parts jsonb) OWNER TO vortex_module_owner;
ALTER FUNCTION vortex_operations.read_open_alert_signals(p_limit integer) OWNER TO vortex_operations_owner;
ALTER FUNCTION vortex_operations.record_alert_signal(p_code text, p_severity text, p_affected_service text, p_deduplication_key text, p_owning_role text, p_runbook_reference text) OWNER TO vortex_operations_owner;
ALTER FUNCTION vortex_page.abandon_private_form_draft(p_draft_id uuid, p_expected_revision bigint) OWNER TO vortex_page_owner;
ALTER FUNCTION vortex_page.create_private_form_draft(p_form_id uuid, p_flow_id uuid, p_node_id uuid, p_subject_record_id uuid, p_field_values jsonb, p_validation_state jsonb) OWNER TO vortex_page_owner;
ALTER FUNCTION vortex_page.expire_private_form_drafts(p_limit integer) OWNER TO vortex_page_owner;
ALTER FUNCTION vortex_page.private_form_draft_context_internal() OWNER TO vortex_page_owner;
ALTER FUNCTION vortex_page.read_private_form_draft(p_form_id uuid, p_flow_id uuid, p_node_id uuid, p_subject_record_id uuid) OWNER TO vortex_page_owner;
ALTER FUNCTION vortex_page.update_private_form_draft(p_draft_id uuid, p_expected_revision bigint, p_form_id uuid, p_flow_id uuid, p_node_id uuid, p_subject_record_id uuid, p_field_values jsonb, p_validation_state jsonb) OWNER TO vortex_page_owner;
ALTER FUNCTION vortex_record.account_retains_owned_records_internal(p_organization_account_id uuid) OWNER TO vortex_record_inventory;
ALTER FUNCTION vortex_record.acquire_relationship_edge_locks_internal(p_identities text[]) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.adopt_storage_conversion(p_conversion_contract_id uuid, p_expected_plan_revision bigint, p_application_root_id uuid, p_module_root_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.allocate_preview_reference_number_internal(p_preview_installation_id uuid, p_storage_contract_id uuid, p_field_id uuid, p_settings jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.allocate_reference_number_internal(p_organization_id uuid, p_storage_contract_id uuid, p_field_id uuid, p_application_root_id uuid, p_settings jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.allocate_storage_conversion_plan(p_conversion_contract_id uuid, p_expected_plan_revision bigint) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.append_declared_named_action_occurrences_internal(p_storage_contract_id uuid, p_record_id uuid, p_event_descriptors jsonb, p_occurrence_ids jsonb, p_field_values jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.append_record_lifecycle_effect_internal(p_effect_kind text, p_storage_contract_id uuid, p_record_type_id uuid, p_record_id uuid, p_pre_concurrency_number bigint, p_relationship_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.apply_action_record_changes(p_command_id uuid, p_operation text, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_submitted_values jsonb, p_mutations jsonb, p_activity_id uuid, p_occurrence_id uuid, p_action jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.apply_lifecycle_record_changes(p_command_id uuid, p_operation text, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_mutations jsonb, p_activity_id uuid, p_occurrence_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.apply_lifecycle_record_changes_internal(p_operation text, p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_mutations jsonb, p_activity_id uuid, p_occurrence_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.apply_named_action_relationship_copies_internal(p_plan jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.apply_record_changes(p_command_id uuid, p_operation text, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_submitted_values jsonb, p_selected_group_id uuid, p_mutations jsonb, p_activity_id uuid, p_occurrence_id uuid, p_action jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.apply_record_lifecycle_generated_values_internal(p_preparation jsonb, p_include_root boolean, p_mutations jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.apply_relationship_total_parent_internal(p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_final_values jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.assert_record_lifecycle_receipt_completed_internal() OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.authorize_created_records_for_command_internal(p_creations jsonb, p_created_records jsonb, p_original_context jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.authorize_index_status_internal(p_organization_id uuid, p_application_root_id uuid) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.authorize_storage_conversion_internal(p_storage_contract_id uuid, p_installed_release_revision bigint) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.base_save_command_fingerprint_internal(p_command_id uuid, p_operation text, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_submitted_values jsonb, p_selected_group_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.before_save_rules_for_record_type_internal(p_module_root_id uuid, p_module_release_revision bigint, p_record_type_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.bump_record_data_version_internal(p_organization_id uuid, p_storage_contract_id uuid, p_application_root_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.canonical_record_value_matches(p_value jsonb, p_field_type text, p_database_value_type text) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.change_record(p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_final_values jsonb, p_submitted_field_ids uuid[]) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.change_record_by_named_action_internal(p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_final_values jsonb, p_submitted_field_ids uuid[], p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.change_record_relationship_internal(p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_relationship_id uuid, p_target_value jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.claim_command_receipt_internal(p_command_kind text, p_command_id uuid, p_operation text, p_fingerprint text, p_record_type_id uuid, p_record_id uuid, p_identity jsonb, p_details jsonb, p_replay_only boolean) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.claim_record_index_build(p_lease_seconds integer) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.command_receipt_exists_internal(p_command_kind text, p_command_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.compile_query_filter_internal(p_condition jsonb, p_field_types jsonb, p_field_columns jsonb, p_field_database_types jsonb, p_field_definitions jsonb, p_read_time_expressions jsonb, p_parameter_types jsonb, p_parameter_values jsonb, p_parameter_sql_parameter integer, p_parameter_offset integer) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.complete_command_receipt_internal(p_command_kind text, p_command_id uuid, p_record_id uuid, p_concurrency_number bigint, p_stale_message text) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.conversion_semantic_for_fields(p_source_field jsonb, p_target_field jsonb) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.conversion_semantic_for_types(p_source_database_value_type text, p_target_database_value_type text) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.conversion_value_assignment(p_conversion_semantic text, p_source_column_token text, p_target_column_token text) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.convert_record_storage_batch(p_conversion_contract_id uuid, p_batch_size integer, p_expected_plan_revision bigint) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.create_record_internal(p_record_type_id uuid, p_final_values jsonb, p_submitted_field_ids uuid[], p_selected_group_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.create_record_storage_table_internal(p_storage_contract_id uuid, p_module_root_id uuid, p_record_type_id uuid, p_storage_scope text, p_ownership_mode text) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.create_system_projection_companion_storage_internal(p_storage_contract_id uuid, p_target_module_root_id uuid, p_record_type_id uuid, p_contributor_module_root_id uuid, p_field_definition jsonb, p_validate_only boolean) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.database_value_type(p_field jsonb) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.detach_exact_module_contributions(p_module_root_id uuid, p_module_release_revision bigint, p_contributions jsonb, p_retire boolean) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.discover_relationship_total_closure_internal(p_catalogue jsonb, p_operation text, p_record_type_id uuid, p_record_id uuid, p_submitted_values jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.drop_preview_installation_storage(p_preview_installation_id uuid) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.enforce_relationship_edge_scope() OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.ensure_account_deletion_fence_internal(p_physical_table_token text) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.ensure_field_index_internal(p_storage_contract_id uuid, p_field_id uuid, p_purpose text, p_storage_scope text, p_table_token text, p_scope_index_columns text, p_column_token text) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.ensure_offboarding_owner_index_internal(p_physical_table_token text) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.ensure_storage_conversion_column_internal(p_table_token text, p_column_token text, p_database_value_type text) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.field_storage_meaning(p_field jsonb) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.filter_calculated_readable_field_ids(p_record_types jsonb, p_record_type_id uuid, p_readable_field_ids jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.finalize_account_deletion_fence(p_organization_account_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.index_build_statements_internal(p_storage_contract_id uuid, p_field_id uuid) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.index_contract_identity(p_storage_contract_id uuid, p_field_id uuid) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.index_definition(p_purpose text, p_table_token text, p_scope_index_columns text, p_column_token text) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.index_definition_fingerprint(p_purpose text, p_table_token text, p_scope_index_columns text, p_column_token text) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.index_scope_columns(p_storage_scope text) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.initialize_organization_lifecycle_limits(p_organization_id uuid, p_limits jsonb) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.insert_named_action_record_internal(p_record_type_id uuid, p_final_values jsonb, p_submitted_field_ids uuid[]) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.is_lifecycle_action_list(p_values text[]) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.is_lifecycle_destination(p_value text) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.is_lifecycle_destination_list(p_values text[]) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.is_lifecycle_limit_value(p_value jsonb) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.is_lifecycle_revision_value(p_value jsonb) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.is_record_type_lifecycle_policy(p_policy jsonb) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.list_offboarding_owned_records(p_source_organization_account_id uuid, p_target_kind text, p_target_id uuid, p_section_kind text, p_after_storage_contract_id uuid, p_after_record_id uuid, p_limit integer) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.list_offboarding_owned_records_internal(p_source_organization_account_id uuid, p_target_kind text, p_target_id uuid, p_after_storage_contract_id uuid, p_after_record_id uuid, p_limit integer) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.list_offboarding_owned_shared_records_internal(p_source_organization_account_id uuid, p_target_kind text, p_target_id uuid, p_after_storage_contract_id uuid, p_after_record_id uuid, p_limit integer) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.load_named_action_facts_internal(p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.load_offboarding_ownership_transfer_facts_internal(p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.load_record_access_facts_for_transfer_installation_internal(p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_installation jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.load_record_access_facts_from_installation_internal(p_record_type_id uuid, p_action_kind text, p_record_id uuid, p_expected_concurrency_number bigint, p_installation jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.load_record_access_facts_internal(p_record_type_id uuid, p_action_kind text, p_record_id uuid, p_expected_concurrency_number bigint) OWNER TO vortex_record_adapter;
ALTER TABLE vortex_record.command_receipts OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.lock_command_receipt_internal(p_command_kind text, p_command_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.lock_record_change_targets_internal(p_record_type jsonb, p_organization_id uuid, p_final_values jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.lock_record_recovery_policy_internal(p_organization_id uuid, p_storage_contract_id uuid, p_application_root_id uuid) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.lock_relationship_target_row_internal(p_target_record_type_id uuid, p_target_record_id uuid, p_organization_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.lock_storage_adoption_internal(p_conversion_contract_id uuid, p_organization_id uuid, p_application_root_id uuid) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.named_action_command_closure_internal(p_catalogue jsonb, p_record_type_id uuid, p_record_id uuid, p_submitted_values jsonb, p_creations jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.named_action_command_fingerprint_internal(p_command_id uuid, p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_inputs jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.named_action_command_link_targets_internal(p_catalogue jsonb, p_record_type_id uuid, p_submitted_values jsonb, p_creations jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.named_action_creation_plan_internal(p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_creations jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.named_action_deleted_subject_replay_internal(p_command_id uuid, p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.observe_field_index_internal(p_purpose text, p_table_token text, p_scope_index_columns text, p_column_token text) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.ownership_transfer_command_fingerprint_internal(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_operation_identity text, p_source_organization_account_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.plan_record_read_scan_internal(p_record_type_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.prepare_base_record_save(p_command_id uuid, p_operation text, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_submitted_values jsonb, p_selected_group_id uuid, p_activity_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.prepare_module_query_internal(p_module_root_id uuid, p_query_id uuid, p_expected_release_revision bigint, p_input_values jsonb, p_user_filter jsonb, p_declared_filterable_field_ids jsonb, p_stage text, p_prior_plan jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.prepare_named_action_command_totals(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_submitted_values jsonb, p_creations jsonb, p_activity_id uuid, p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.prepare_named_action_relationship_copies_internal(p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_subject_record_type_id uuid, p_subject_record_id uuid, p_inputs jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.prepare_named_action_set_announce(p_command_id uuid, p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_inputs jsonb, p_activity_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.prepare_named_action_set_announce_internal(p_preview boolean, p_command_id uuid, p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_inputs jsonb, p_activity_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.prepare_protected_record_delete(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_activity_id uuid, p_occurrence_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.prepare_protected_record_restore(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_activity_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.prepare_record_lifecycle_totals_internal(p_operation text, p_record_type_id uuid, p_record_id uuid, p_command_id uuid, p_root_snapshot jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.prepare_relationship_total_save(p_command_id uuid, p_operation text, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_submitted_values jsonb, p_selected_group_id uuid, p_activity_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.preview_named_action_set_announce(p_command_id uuid, p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_inputs jsonb, p_activity_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.preview_record_field_bounds_internal(p_record_type_id uuid, p_storage_contract_id uuid, p_record_type jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.preview_record_lifecycle_candidates(p_storage_contract_id uuid, p_application_root_id uuid, p_after_created_at timestamp with time zone, p_after_record_id uuid, p_limit integer) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.preview_scoped_command_id_internal(p_command_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.project_derived_readable_field_ids_internal(p_loaded jsonb, p_record_type_id uuid, p_record_id uuid, p_readable_field_ids jsonb, p_required_field_ids jsonb, p_seen_derived_field_keys jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.project_named_action_record_internal(p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.provision_account_deletion_fence_internal() OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.provision_exact_module_contributions(p_module_root_id uuid, p_module_release_revision bigint, p_contributions jsonb) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.provision_exact_module_storage(p_module_root_id uuid, p_module_release_revision bigint) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.provision_offboarding_owner_index_internal() OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.provision_preview_module_storage(p_preview_installation_id uuid, p_module_root_id uuid, p_module_release_revision bigint) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.read_application_index_status(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.read_application_lifecycle_policy_readiness(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.read_current_legal_holds(p_candidate jsonb) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.read_current_preview_installation_internal() OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.read_derived_field_ids_for_exact_record_internal(p_record_type_id uuid, p_record_id uuid, p_required_field_ids jsonb, p_seen_derived_field_keys jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.read_exact_module_storage_provision(p_module_root_id uuid, p_module_release_revision bigint) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.read_import_update_targets(p_record_type_id uuid, p_mapped_field_ids jsonb, p_targets jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.read_index_conflict_references_internal(p_record_type_id uuid, p_table_token text, p_scope_columns text, p_column_token text) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.read_index_readiness(p_organization_id uuid, p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.read_module_query_inputs(p_module_root_id uuid, p_query_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.read_provisioned_lifecycle_policy_setup(p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.read_record(p_record_type_id uuid, p_record_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.read_record_capabilities(p_record_type_id uuid, p_record_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.read_record_lifecycle_preview_candidates_internal(p_physical_table_token text, p_organization_id uuid, p_storage_contract_id uuid, p_application_root_id uuid, p_after_created_at timestamp with time zone, p_after_record_id uuid, p_limit integer) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.read_storage_conversion_corrections(p_conversion_contract_id uuid, p_limit integer) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.read_time_clock_internal() OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.read_time_deadline_expression_internal(p_storage_contract_id uuid, p_expression jsonb, p_clock jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.record_index_build_result(p_storage_contract_id uuid, p_field_id uuid, p_claim_id uuid, p_expected_definition_fingerprint text) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.record_lifecycle_command_fingerprint_internal(p_command_id uuid, p_operation text, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.record_lifecycle_current_revision_internal(p_record_type_id uuid, p_record_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.record_lifecycle_total_closure_internal(p_catalogue jsonb, p_operation text, p_record_type_id uuid, p_record_id uuid, p_command_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.record_named_action_precondition_refusal(p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_activity_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.register_storage_conversion_plan(p_source_storage_contract_id uuid, p_source_field_id uuid, p_target_field_id uuid, p_source_release_revision bigint, p_target_release_revision bigint) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.relationship_declares_target_internal(p_relationship jsonb, p_record_type_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.relationship_edge_lock_identities_internal(p_relationship_id uuid, p_from_storage_contract_id uuid, p_from_record_id uuid, p_to_storage_contract_id uuid, p_to_record_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.relationship_edge_record_identity_internal(p_relationship_id uuid, p_storage_contract_id uuid, p_record_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.relationship_total_catalogue_internal() OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.relationship_total_record_snapshot_internal(p_catalogue jsonb, p_record_type_id uuid, p_record_id uuid, p_lock boolean) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.relationship_total_source_is_retained_internal(p_catalogue jsonb, p_record_type_id uuid, p_record_id uuid, p_organization_id uuid, p_application_root_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.release_command_receipt_internal(p_command_kind text, p_command_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.renew_record_index_build_lease(p_storage_contract_id uuid, p_field_id uuid, p_claim_id uuid, p_lease_seconds integer) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.reserve_named_action_creation_locks_internal(p_record_type_id uuid, p_creations jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.resolve_active_bundle_record_access_plan_internal(p_expected_identity jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.resolve_installation_access_plan_internal(p_installation jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.resolve_installed_module_query_internal(p_module_root_id uuid, p_query_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.resolve_named_action_context_internal(p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.resolve_prepared_record_access_plan_internal(p_application_root_id uuid, p_application_release_revision bigint, p_expected_module_bindings jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.resolve_preview_module_query_internal(p_module_root_id uuid, p_query_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.resolve_record_action_context_internal(p_record_type_id uuid, p_action_kind text) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.restore_record_internal(p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.run_module_query(p_module_root_id uuid, p_query_id uuid, p_expected_release_revision bigint, p_input_values jsonb, p_requested_field_ids jsonb, p_page_size integer, p_after jsonb, p_requested_system_field_keys jsonb, p_user_inputs jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.run_module_query_summary(p_module_root_id uuid, p_query_id uuid, p_expected_release_revision bigint, p_input_values jsonb, p_user_inputs jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.save_base_record(p_command_id uuid, p_operation text, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_submitted_values jsonb, p_final_values jsonb, p_selected_group_id uuid, p_activity_id uuid, p_occurrence_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.save_base_record_with_relationship_totals(p_command_id uuid, p_operation text, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_submitted_values jsonb, p_final_values jsonb, p_selected_group_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_parent_mutations jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.save_initial_record_type_lifecycle_policy_for_provisioned_setup(p_binding_application_root_id uuid, p_expected_binding_revision bigint, p_storage_contract_id uuid, p_application_root_id uuid, p_expected_settings_revision bigint, p_activity_id uuid, p_policy jsonb) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.save_organization_settings_record(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_submitted_values jsonb, p_final_values jsonb, p_activity_id uuid, p_occurrence_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.save_record_type_lifecycle_policy_for_administration(p_storage_contract_id uuid, p_application_root_id uuid, p_expected_settings_revision bigint, p_expected_policy_revision bigint, p_activity_id uuid, p_policy jsonb) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.share_lock_named_action_target_internal(p_catalogue jsonb, p_record_type_id uuid, p_record_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.soft_delete_record_internal(p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.soft_delete_record_recursive_internal(p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_visited text[]) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.sql_value_type(p_database_value_type text) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.storage_conversion_contract_identity(p_source_storage_contract_id uuid, p_source_field_id uuid, p_target_field_id uuid) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.storage_meaning(p_record_type jsonb) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.storage_meaning_fingerprint(p_record_type jsonb) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.switch_storage_conversion_mappings_internal(p_conversion_contract_id uuid, p_owns_module boolean) OWNER TO vortex_record_owner;
ALTER FUNCTION vortex_record.total_dependency_contract_internal(p_record_types jsonb, p_relationships jsonb, p_target_record_type_id uuid, p_total_field jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.total_inputs_readable_internal(p_loaded jsonb, p_target_record_type_id uuid, p_target_record_id uuid, p_total_field jsonb, p_seen_derived_field_keys jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.transfer_offboarding_active_owned_record(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_expected_access_version bigint) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.transfer_offboarding_owned_record(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_source_organization_account_id uuid, p_expected_access_version bigint) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.transfer_record_ownership_for_offboarding_internal(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_source_organization_account_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.validate_named_action_reference_inputs(p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_inputs jsonb) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.write_named_action_relationship_value_internal(p_source_record_type_id uuid, p_source_record_id uuid, p_relationship_id uuid, p_target_value jsonb, p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_subject_record_type_id uuid, p_subject_record_id uuid) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_record.write_relationship_value_internal(p_source_record_type_id uuid, p_source_record_id uuid, p_relationship_id uuid, p_target_value jsonb, p_increment_source_revision boolean) OWNER TO vortex_record_adapter;
ALTER FUNCTION vortex_search.put_document(p_organization_id uuid, p_record_type_id uuid, p_record_id uuid, p_application_root_id uuid, p_source_record_version bigint, p_deleted boolean, p_entries jsonb, p_content_fingerprint text) OWNER TO vortex_search_owner;
ALTER FUNCTION vortex_workflow.begin_flow_effect(p_run_id uuid, p_organization_id uuid, p_identity_id uuid, p_task_path text, p_iteration text) OWNER TO vortex_workflow_owner;
ALTER FUNCTION vortex_workflow.begin_flow_effect_with_origin(p_run_id uuid, p_organization_id uuid, p_principal_kind text, p_principal_id uuid, p_origin_kind text, p_origin_id uuid, p_task_path text, p_iteration text) OWNER TO vortex_workflow_owner;
ALTER FUNCTION vortex_workflow.complete_flow_effect(p_run_id uuid, p_organization_id uuid, p_identity_id uuid, p_task_path text, p_iteration text, p_outcome text, p_outputs jsonb) OWNER TO vortex_workflow_owner;
ALTER FUNCTION vortex_workflow.complete_flow_effect_with_origin(p_run_id uuid, p_organization_id uuid, p_principal_kind text, p_principal_id uuid, p_origin_kind text, p_origin_id uuid, p_task_path text, p_iteration text, p_outcome text, p_outputs jsonb) OWNER TO vortex_workflow_owner;
ALTER FUNCTION vortex_workflow.consume_flow_continuation(p_token_hash text, p_organization_id uuid, p_identity_id uuid, p_flow_id uuid, p_release_key text) OWNER TO vortex_workflow_owner;
ALTER FUNCTION vortex_workflow.issue_flow_continuation(p_token_hash text, p_run_id uuid, p_organization_id uuid, p_identity_id uuid, p_flow_id uuid, p_release_key text, p_state jsonb, p_elapsed_milliseconds integer, p_lifetime_seconds integer) OWNER TO vortex_workflow_owner;
ALTER FUNCTION vortex_workflow.read_committed_flow_start_intent(p_intent_id uuid) OWNER TO vortex_workflow_owner;
ALTER TABLE vortex_access.platform_permission_declarations OWNER TO vortex_access_owner;
ALTER TABLE vortex_module.installation_bindings OWNER TO vortex_module_owner;
ALTER TABLE vortex_module.installation_runtime_bundle_parts OWNER TO vortex_module_owner;
ALTER TABLE vortex_module.installation_runtime_bundles OWNER TO vortex_module_owner;
ALTER TABLE vortex_module.preview_installations OWNER TO vortex_module_owner;
ALTER TABLE vortex_record.field_storage_mappings OWNER TO vortex_record_owner;
ALTER TABLE vortex_record.index_catalogue OWNER TO vortex_record_owner;
ALTER TABLE vortex_record.installation_access_plans OWNER TO vortex_record_adapter;
ALTER TABLE vortex_record.legal_hold_versions OWNER TO vortex_record_owner;
ALTER TABLE vortex_record.organization_lifecycle_limits OWNER TO vortex_record_owner;
ALTER TABLE vortex_record.preview_command_receipts OWNER TO vortex_record_adapter;
ALTER TABLE vortex_record.preview_reference_counters OWNER TO vortex_record_adapter;
ALTER TABLE vortex_record.preview_storage_bindings OWNER TO vortex_record_owner;
ALTER TABLE vortex_record.protected_read_model_views OWNER TO vortex_record_owner;
ALTER SEQUENCE vortex_record.record_invalidation_sequence OWNER TO vortex_record_owner;
ALTER TABLE vortex_record.record_lifecycle_command_effects OWNER TO vortex_record_adapter;
ALTER TABLE vortex_record.record_reference_counters OWNER TO vortex_record_owner;
ALTER TABLE vortex_record.record_type_lifecycle_policies OWNER TO vortex_record_owner;
ALTER TABLE vortex_record.relationship_edges OWNER TO vortex_record_owner;
ALTER TABLE vortex_record.relationship_storage_mappings OWNER TO vortex_record_owner;
ALTER TABLE vortex_record.release_provisions OWNER TO vortex_record_owner;
ALTER TABLE vortex_record.storage_catalogue OWNER TO vortex_record_owner;
ALTER TABLE vortex_record.storage_conversion_catalogue OWNER TO vortex_record_owner;
ALTER TABLE vortex_record.storage_conversion_plans OWNER TO vortex_record_owner;
ALTER TABLE vortex_record.storage_conversion_progress OWNER TO vortex_record_owner;
REVOKE ALL ON SCHEMA vortex_record FROM vortex_record_inventory;
ALTER SCHEMA record_data OWNER TO vortex_record_owner;
ALTER SCHEMA vortex_module OWNER TO vortex_module_owner;
ALTER SCHEMA vortex_record OWNER TO vortex_record_owner;
REVOKE CREATE ON SCHEMA vortex_definition FROM postgres;

-- Restore grants after ownership transfer; grants to the temporary postgres
-- owner cannot survive a PostgreSQL ownership change with the same ACL.
SET ROLE vortex_record_owner;
REVOKE SELECT(protected_read_model_key) ON TABLE vortex_record.protected_read_model_views FROM vortex_record_owner;
REVOKE SELECT(reader_schema) ON TABLE vortex_record.protected_read_model_views FROM vortex_record_owner;
REVOKE SELECT(reader_function) ON TABLE vortex_record.protected_read_model_views FROM vortex_record_owner;
RESET ROLE;
SET ROLE vortex_module_owner;
GRANT USAGE ON SCHEMA vortex_module TO postgres;
RESET ROLE;
SET ROLE vortex_record_owner;
GRANT USAGE ON SCHEMA vortex_record TO postgres;
RESET ROLE;
SET ROLE vortex_access_owner;
GRANT ALL ON FUNCTION vortex_access.evaluate_organization_permission_eligibility(p_declaration jsonb) TO postgres;
GRANT ALL ON FUNCTION vortex_access.evaluate_organization_record_permission_availability(p_declaration jsonb) TO postgres;
GRANT ALL ON FUNCTION vortex_access.organization_groups_administration_scope() TO postgres;
GRANT ALL ON FUNCTION vortex_access.read_guarded_platform_permission_minimum_internal() TO postgres;
GRANT ALL ON FUNCTION vortex_access.read_platform_permission_declaration_catalogue_internal(p_registration_revision bigint) TO postgres;
GRANT ALL ON FUNCTION vortex_access.resolve_record_field_bounds_internal(p_decision jsonb) TO postgres;
GRANT ALL ON FUNCTION vortex_access.validation_reference_list(p_list text) TO postgres;
RESET ROLE;
SET ROLE vortex_definition_owner;
GRANT ALL ON FUNCTION vortex_definition.application_role_identity_is_exact_for_human_request_internal(p_application_root_id uuid, p_source_role_id uuid) TO postgres;
GRANT ALL ON FUNCTION vortex_definition.validated_builder_draft_write_context_internal(p_root_id uuid) TO postgres;
RESET ROLE;
SET ROLE vortex_identity_owner;
GRANT ALL ON FUNCTION vortex_identity.accept_organization_invitation_with_transition(p_token_fingerprint text, p_identity_id uuid, p_verified_email text, p_display_name text, p_correlation_id uuid) TO postgres;
GRANT ALL ON FUNCTION vortex_identity.begin_organization_account_closing(p_organization_account_id uuid, p_expected_revision bigint) TO postgres;
GRANT ALL ON FUNCTION vortex_identity.change_organization_account_state(p_organization_account_id uuid, p_expected_revision bigint, p_state text) TO postgres;
GRANT ALL ON FUNCTION vortex_identity.create_organization_invitation(p_invited_email text, p_token_fingerprint text, p_expires_at timestamp with time zone) TO postgres;
GRANT ALL ON FUNCTION vortex_identity.finalize_organization_account_deletion(p_organization_account_id uuid, p_expected_revision bigint) TO postgres;
GRANT ALL ON FUNCTION vortex_identity.identity_is_disabled(p_identity_id uuid) TO postgres;
GRANT ALL ON FUNCTION vortex_identity.initialize_organization_runtime_settings(p_organization_id uuid, p_language text, p_time_zone text, p_currency text, p_date_format text, p_number_format text) TO postgres;
GRANT ALL ON FUNCTION vortex_identity.list_organization_account_choices_internal(p_tenant_id uuid, p_organization_id uuid, p_search text, p_page_size integer, p_after_sort_key text, p_after_organization_account_id uuid) TO postgres;
GRANT ALL ON FUNCTION vortex_identity.list_organization_accounts_for_administration_internal(p_organization_id uuid, p_after_organization_account_id uuid, p_page_size integer) TO postgres;
GRANT ALL ON FUNCTION vortex_identity.list_organization_accounts_projection_internal(p_organization_id uuid, p_active_members_only boolean) TO postgres;
GRANT ALL ON FUNCTION vortex_identity.list_organization_invitations_for_administration_internal(p_organization_id uuid, p_after_invitation_id uuid, p_page_size integer) TO postgres;
GRANT ALL ON FUNCTION vortex_identity.list_organization_invitations_projection_internal(p_organization_id uuid) TO postgres;
GRANT ALL ON FUNCTION vortex_identity.lock_organization_account_for_deletion_internal(p_organization_account_id uuid) TO postgres;
GRANT ALL ON FUNCTION vortex_identity.publish_identity_disablement(p_subject_identity_id uuid, p_actor_identity_id uuid, p_correlation_id uuid, p_published_at timestamp with time zone) TO postgres;
GRANT ALL ON FUNCTION vortex_identity.read_current_organization_runtime_settings_internal(p_organization_id uuid) TO postgres;
GRANT ALL ON FUNCTION vortex_identity.read_organization_account_for_administration_internal(p_organization_id uuid, p_organization_account_id uuid) TO postgres;
GRANT ALL ON FUNCTION vortex_identity.read_organization_invitation_for_administration_internal(p_organization_id uuid, p_invitation_id uuid) TO postgres;
GRANT ALL ON FUNCTION vortex_identity.revoke_organization_invitation(p_invitation_id uuid, p_expected_revision bigint) TO postgres;
GRANT ALL ON FUNCTION vortex_identity.save_organization_runtime_settings_record_internal(p_organization_id uuid, p_expected_revision bigint, p_core_values jsonb, p_extension_values jsonb) TO postgres;
GRANT ALL ON FUNCTION vortex_identity.tenant_administrator_grant_expiry_cap(p_actor_identity_id uuid, p_tenant_id uuid, p_capabilities text[], p_evaluated_at timestamp with time zone) TO postgres;
GRANT ALL ON FUNCTION vortex_identity.tenant_has_permanent_manager(p_tenant_id uuid, p_checked_at timestamp with time zone, p_excluded_assignment_id uuid) TO postgres;
GRANT ALL ON FUNCTION vortex_identity.update_organization_account_profile_internal(p_organization_id uuid, p_organization_account_id uuid, p_expected_revision bigint, p_display_name text, p_language text, p_time_zone text) TO postgres;
RESET ROLE;
SET ROLE vortex_invalidation_owner;
GRANT ALL ON FUNCTION vortex_invalidation.application_is_installed(p_organization_id uuid, p_application_root_id uuid) TO postgres;
RESET ROLE;
SET ROLE vortex_module_owner;
GRANT ALL ON FUNCTION vortex_module.read_active_installation_for_scope_internal(p_organization_id uuid, p_application_root_id uuid) TO postgres;
GRANT ALL ON FUNCTION vortex_module.read_current_active_installation() TO postgres;
GRANT ALL ON FUNCTION vortex_module.read_current_detached_installation_for_transfer_internal() TO postgres;
REVOKE ALL ON FUNCTION vortex_module.read_current_offboarding_inventory_installation_internal() FROM vortex_module_owner;
REVOKE ALL ON FUNCTION vortex_module.read_offboarding_inventory_contract_applications_internal(p_storage_contract_id uuid) FROM vortex_module_owner;
REVOKE ALL ON FUNCTION vortex_module.read_preview_record_installation_internal(p_preview_installation_id uuid) FROM vortex_module_owner;
RESET ROLE;
SET ROLE vortex_record_adapter;
REVOKE ALL ON FUNCTION vortex_record.finalize_account_deletion_fence(p_organization_account_id uuid) FROM vortex_record_adapter;
REVOKE ALL ON FUNCTION vortex_record.list_offboarding_owned_records(p_source_organization_account_id uuid, p_target_kind text, p_target_id uuid, p_section_kind text, p_after_storage_contract_id uuid, p_after_record_id uuid, p_limit integer) FROM vortex_record_adapter;
REVOKE ALL ON FUNCTION vortex_record.read_index_conflict_references_internal(p_record_type_id uuid, p_table_token text, p_scope_columns text, p_column_token text) FROM vortex_record_adapter;
REVOKE ALL ON FUNCTION vortex_record.transfer_offboarding_active_owned_record(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_expected_access_version bigint) FROM vortex_record_adapter;
REVOKE ALL ON FUNCTION vortex_record.transfer_offboarding_owned_record(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_source_organization_account_id uuid, p_expected_access_version bigint) FROM vortex_record_adapter;
REVOKE ALL ON FUNCTION vortex_record.validate_named_action_reference_inputs(p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid, p_inputs jsonb) FROM vortex_record_adapter;
RESET ROLE;
SET ROLE vortex_record_owner;
GRANT SELECT(protected_read_model_key) ON TABLE vortex_record.protected_read_model_views TO postgres;
GRANT SELECT(reader_schema) ON TABLE vortex_record.protected_read_model_views TO postgres;
GRANT SELECT(reader_function) ON TABLE vortex_record.protected_read_model_views TO postgres;
GRANT SELECT ON TABLE vortex_record.storage_catalogue TO postgres;
RESET ROLE;
