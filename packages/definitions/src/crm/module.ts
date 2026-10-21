import activities from "./modules/activities.json";
import locations from "./modules/locations.json";
import opportunities from "./modules/opportunities.json";
import organisations from "./modules/organisations.json";
import people from "./modules/people.json";
import tags from "./modules/tags.json";

/** The Modules the CRM Application owns, authored inside its Application source. */
export const crmModules: readonly unknown[] = [
  locations,
  organisations,
  people,
  opportunities,
  activities,
  tags,
];
