import type {
  ActiveApplicationInstallationEvidence,
  ApplicationBoundReleaseSetResult,
} from "@vortex/contracts";
import { projectInstalledEventCatalogue } from "@vortex/definition";
import { describe, expect, it, vi } from "vitest";
import { createInstalledEventCatalogueSource } from "../src/installed-event-catalogue-source";

vi.mock("server-only", () => ({}));
vi.mock("@vortex/definition", () => ({ projectInstalledEventCatalogue: vi.fn(() => "catalogue") }));

describe("installed event catalogue source", () => {
  it("selects active installation before reading its exact Definition revision", async () => {
    const definitions = {
      marker: "definitions",
    } as unknown as ApplicationBoundReleaseSetResult;
    const installation = {
      applicationReleaseRevision: 3,
    } as unknown as ActiveApplicationInstallationEvidence;
    const order: string[] = [];
    const definitionRead = vi.fn(async () => {
      order.push("definition");
      return definitions;
    });
    const installationRead = vi.fn(async () => {
      order.push("installation");
      return installation;
    });
    const source = createInstalledEventCatalogueSource({
      definitionSetReader: { read: definitionRead },
      activeInstallationReader: { readCurrent: installationRead },
    });

    await expect(source.readCurrent()).resolves.toBe("catalogue");
    expect(order).toEqual(["installation", "definition"]);
    expect(definitionRead).toHaveBeenCalledWith({ applicationReleaseRevision: 3 });
    expect(installationRead).toHaveBeenCalledOnce();
    expect(projectInstalledEventCatalogue).toHaveBeenCalledWith({ definitions, installation });
  });
});
