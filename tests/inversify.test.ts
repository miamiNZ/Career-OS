/**
 * Tests for src/inversify.config.ts — DI container wiring.
 *
 * Guards: every TYPES.* symbol resolves without throwing, singletons are shared
 * (same instance on two get() calls), composite services construct cleanly.
 *
 * reflect-metadata is imported in tests/setup.ts (vitest setupFiles).
 */
import { describe, it, expect } from "vitest";
import { buildContainer } from "../src/inversify.config.js";
import { TYPES } from "../src/ioc/types.js";

// Import each service class just to verify instanceof checks.
import { ConfigService } from "../src/ioc/services/ConfigService.js";
import { LlmService } from "../src/ioc/services/LlmService.js";
import { VaultService } from "../src/ioc/services/VaultService.js";
import { ScoreService } from "../src/ioc/services/ScoreService.js";
import { ReportService } from "../src/ioc/services/ReportService.js";
import { ConvertService } from "../src/ioc/services/ConvertService.js";
import { IngestService } from "../src/ioc/services/IngestService.js";
import { SearchService } from "../src/ioc/services/SearchService.js";
import { ContactsService } from "../src/ioc/services/ContactsService.js";
import { ResumeAgentService } from "../src/ioc/services/ResumeAgentService.js";
import { ApplicationService } from "../src/ioc/services/ApplicationService.js";
import { WorkflowService } from "../src/ioc/services/WorkflowService.js";
import { OrchestratorService } from "../src/ioc/services/OrchestratorService.js";
import { PipelineService } from "../src/ioc/services/PipelineService.js";
import { SchedulerService } from "../src/ioc/services/SchedulerService.js";
import { ApplyService } from "../src/ioc/services/ApplyService.js";
import { ServerService } from "../src/ioc/services/ServerService.js";

describe("buildContainer — leaf services resolve", () => {
  it("resolves ConfigService", () => {
    const c = buildContainer();
    expect(() => c.get(TYPES.ConfigService)).not.toThrow();
    expect(c.get(TYPES.ConfigService)).toBeInstanceOf(ConfigService);
  });

  it("resolves LlmService", () => {
    const c = buildContainer();
    expect(() => c.get(TYPES.LlmService)).not.toThrow();
    expect(c.get(TYPES.LlmService)).toBeInstanceOf(LlmService);
  });

  it("resolves VaultService", () => {
    const c = buildContainer();
    expect(() => c.get(TYPES.VaultService)).not.toThrow();
    expect(c.get(TYPES.VaultService)).toBeInstanceOf(VaultService);
  });

  it("resolves ScoreService", () => {
    const c = buildContainer();
    expect(() => c.get(TYPES.ScoreService)).not.toThrow();
    expect(c.get(TYPES.ScoreService)).toBeInstanceOf(ScoreService);
  });

  it("resolves ReportService", () => {
    const c = buildContainer();
    expect(() => c.get(TYPES.ReportService)).not.toThrow();
    expect(c.get(TYPES.ReportService)).toBeInstanceOf(ReportService);
  });

  it("resolves ConvertService", () => {
    const c = buildContainer();
    expect(() => c.get(TYPES.ConvertService)).not.toThrow();
    expect(c.get(TYPES.ConvertService)).toBeInstanceOf(ConvertService);
  });

  it("resolves IngestService", () => {
    const c = buildContainer();
    expect(() => c.get(TYPES.IngestService)).not.toThrow();
    expect(c.get(TYPES.IngestService)).toBeInstanceOf(IngestService);
  });

  it("resolves SearchService", () => {
    const c = buildContainer();
    expect(() => c.get(TYPES.SearchService)).not.toThrow();
    expect(c.get(TYPES.SearchService)).toBeInstanceOf(SearchService);
  });

  it("resolves ContactsService", () => {
    const c = buildContainer();
    expect(() => c.get(TYPES.ContactsService)).not.toThrow();
    expect(c.get(TYPES.ContactsService)).toBeInstanceOf(ContactsService);
  });

  it("resolves ResumeAgentService", () => {
    const c = buildContainer();
    expect(() => c.get(TYPES.ResumeAgentService)).not.toThrow();
    expect(c.get(TYPES.ResumeAgentService)).toBeInstanceOf(ResumeAgentService);
  });

  it("resolves ApplicationService", () => {
    const c = buildContainer();
    expect(() => c.get(TYPES.ApplicationService)).not.toThrow();
    expect(c.get(TYPES.ApplicationService)).toBeInstanceOf(ApplicationService);
  });
});

describe("buildContainer — composite / orchestration services resolve", () => {
  it("resolves WorkflowService", () => {
    const c = buildContainer();
    expect(() => c.get(TYPES.WorkflowService)).not.toThrow();
    expect(c.get(TYPES.WorkflowService)).toBeInstanceOf(WorkflowService);
  });

  it("resolves OrchestratorService", () => {
    const c = buildContainer();
    expect(() => c.get(TYPES.OrchestratorService)).not.toThrow();
    expect(c.get(TYPES.OrchestratorService)).toBeInstanceOf(OrchestratorService);
  });

  it("resolves PipelineService", () => {
    const c = buildContainer();
    expect(() => c.get(TYPES.PipelineService)).not.toThrow();
    expect(c.get(TYPES.PipelineService)).toBeInstanceOf(PipelineService);
  });

  it("resolves SchedulerService", () => {
    const c = buildContainer();
    expect(() => c.get(TYPES.SchedulerService)).not.toThrow();
    expect(c.get(TYPES.SchedulerService)).toBeInstanceOf(SchedulerService);
  });

  it("resolves ApplyService", () => {
    const c = buildContainer();
    expect(() => c.get(TYPES.ApplyService)).not.toThrow();
    expect(c.get(TYPES.ApplyService)).toBeInstanceOf(ApplyService);
  });

  it("resolves ServerService", () => {
    const c = buildContainer();
    expect(() => c.get(TYPES.ServerService)).not.toThrow();
    expect(c.get(TYPES.ServerService)).toBeInstanceOf(ServerService);
  });
});

describe("buildContainer — injected constants resolve", () => {
  it("resolves Config constant", () => {
    const c = buildContainer();
    expect(() => c.get(TYPES.Config)).not.toThrow();
    const cfg = c.get<{ vaultPath: string }>(TYPES.Config);
    expect(cfg.vaultPath).toBeTruthy();
  });

  it("resolves Vault constant", () => {
    const c = buildContainer();
    expect(() => c.get(TYPES.Vault)).not.toThrow();
    const v = c.get<{ root: string; jobsDir: string }>(TYPES.Vault);
    expect(v.root).toBeTruthy();
    expect(v.jobsDir).toBeTruthy();
  });
});

describe("buildContainer — Singleton scope (same instance on two gets)", () => {
  it("ConfigService is a singleton", () => {
    const c = buildContainer();
    expect(c.get(TYPES.ConfigService)).toBe(c.get(TYPES.ConfigService));
  });

  it("LlmService is a singleton", () => {
    const c = buildContainer();
    expect(c.get(TYPES.LlmService)).toBe(c.get(TYPES.LlmService));
  });

  it("OrchestratorService is a singleton", () => {
    const c = buildContainer();
    expect(c.get(TYPES.OrchestratorService)).toBe(c.get(TYPES.OrchestratorService));
  });

  it("PipelineService is a singleton", () => {
    const c = buildContainer();
    expect(c.get(TYPES.PipelineService)).toBe(c.get(TYPES.PipelineService));
  });

  it("ServerService is a singleton", () => {
    const c = buildContainer();
    expect(c.get(TYPES.ServerService)).toBe(c.get(TYPES.ServerService));
  });
});

describe("buildContainer — independent containers are isolated", () => {
  it("two buildContainer() calls produce different instances", () => {
    const c1 = buildContainer();
    const c2 = buildContainer();
    expect(c1.get(TYPES.ConfigService)).not.toBe(c2.get(TYPES.ConfigService));
  });
});

describe("ConfigService — properties", () => {
  it("exposes vaultPath from environment", () => {
    const c = buildContainer();
    const svc = c.get<ConfigService>(TYPES.ConfigService);
    expect(svc.vaultPath).toBeTruthy();
    expect(typeof svc.vaultPath).toBe("string");
  });

  it("exposes the hard-filter defaults, which reject nothing until the vault sets them", () => {
    const c = buildContainer();
    const svc = c.get<ConfigService>(TYPES.ConfigService);
    expect(svc.hardFilters.minSalary).toBe(0);
    expect(svc.hardFilters.rejectIfCitizenshipRequired).toBe(false);
  });
});

describe("LlmService — properties", () => {
  it("has url and model properties", () => {
    const c = buildContainer();
    const svc = c.get<LlmService>(TYPES.LlmService);
    expect(typeof svc.url).toBe("string");
    expect(typeof svc.model).toBe("string");
  });
});
