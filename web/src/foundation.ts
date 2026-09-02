import "server-only";

import { AccessService } from "@vortex/access";
import { AppService } from "@vortex/app";
import { ConnectionService } from "@vortex/connection";
import { DefinitionService } from "@vortex/definition";
import { EventService } from "@vortex/event";
import { FileService } from "@vortex/file";
import { IdentityService } from "@vortex/identity";
import { InterfaceService } from "@vortex/interface";
import { ModuleService } from "@vortex/module";
import { PageService } from "@vortex/page";
import { QueryService } from "@vortex/query";
import { RecordService } from "@vortex/record";
import { RuleService } from "@vortex/rule";
import { SearchService } from "@vortex/search";
import { ThemeService } from "@vortex/theme";
import { WorkflowService } from "@vortex/workflow";

export const serviceRegistry = Object.freeze([
  DefinitionService,
  IdentityService,
  AccessService,
  ModuleService,
  RecordService,
  QueryService,
  RuleService,
  EventService,
  WorkflowService,
  AppService,
  PageService,
  ThemeService,
  SearchService,
  FileService,
  ConnectionService,
  InterfaceService,
]);
