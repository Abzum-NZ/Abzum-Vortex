import "server-only";

export * from "./public-abuse-policy";
export {
  createHumanInterfaceCallerService,
  type HumanInterfaceCallerConfiguration,
  type HumanInterfaceCallerIdentity,
  type HumanInterfaceCallerRequest,
  type HumanInterfaceCallerResult,
  type HumanInterfaceOperationContext,
  type HumanInterfaceViewerSafeOperation,
} from "./caller-context";

export const InterfaceService = Object.freeze({
  key: "interface",
  boundary: "@vortex/interface",
});
