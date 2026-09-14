import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("Kestra deployment image", () => {
  it("packages reviewed flows and scripts instead of depending on ephemeral source mounts", async () => {
    const [dockerfile, compose, testingFlow, productionFlow] = await Promise.all([
      readFile(resolve(workspaceRoot, "workflows/kestra/Dockerfile"), "utf8"),
      readFile(resolve(workspaceRoot, "workflows/kestra/docker-compose.yml"), "utf8"),
      readFile(
        resolve(workspaceRoot, "workflows/kestra/flows/testing-database-delivery.yml"),
        "utf8",
      ),
      readFile(
        resolve(workspaceRoot, "workflows/kestra/flows/production-database-delivery.yml"),
        "utf8",
      ),
    ]);

    expect(dockerfile).toContain("COPY --chmod=0444 flows/ /app/vortex-flows/");
    expect(dockerfile).toContain("COPY --chmod=0555 scripts/ /app/vortex-operations/");
    expect(dockerfile).toContain("libtap-parser-sourcehandler-pgtap-perl=3.36-2");
    expect(compose).toContain("server standalone --flow-path /app/vortex-flows");
    expect(compose).not.toContain("./flows:/app/vortex-flows");
    expect(compose).not.toContain("./scripts:/app/vortex-operations");
    expect(testingFlow).toContain("trigger.body.ref == 'refs/heads/testing'");
    expect(productionFlow).toContain("trigger.body.ref == 'refs/heads/main'");
    expect(testingFlow).toContain("VORTEX_EVIDENCE_PATH: delivery-evidence.json");
    expect(testingFlow).toContain("VORTEX_REUSE_CANDIDATE:");
    expect(testingFlow).toContain("VORTEX_FORCE_FULL_VERIFICATION:");
    expect(testingFlow).toContain("key: database-testing-reusable-full-baseline");
    expect(testingFlow).toContain("id: publish_immutable_full_source");
    expect(testingFlow).toContain(
      "fromJson(read(outputs.apply_and_verify.outputFiles['delivery-evidence.json'])).verification.mode == 'full'",
    );
    expect(testingFlow).toContain("overwrite: false");
    expect(testingFlow.indexOf("id: invalidate_reusable_full_baseline")).toBeLessThan(
      testingFlow.indexOf("id: apply_and_verify"),
    );
    expect(testingFlow.indexOf("id: apply_and_verify")).toBeLessThan(
      testingFlow.indexOf("id: publish_reusable_full_baseline"),
    );
    expect(productionFlow).toContain("VORTEX_EVIDENCE_PATH: preparation-evidence.json");
    expect(productionFlow).toContain("VORTEX_EVIDENCE_PATH: delivery-evidence.json");
    expect(productionFlow).toContain("id: load_testing_full_source_evidence");
    expect(productionFlow).toContain("VORTEX_TESTING_FULL_SOURCE_EVIDENCE:");
    expect(testingFlow).not.toContain("{{ workingDir }}");
    expect(productionFlow).not.toContain("{{ workingDir }}");
  });
});
