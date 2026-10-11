/**
 * Composition root. Builds the InversifyJS container and binds every service +
 * injected constant. Entrypoints import `container` from here and resolve the root
 * service(s) they need, instead of importing pipeline/server functions directly.
 *
 * tsx/esbuild caveat: esbuild emits NO design-type metadata, so every constructor
 * parameter in a service carries an explicit `@inject(TYPES.X)` decorator. This module
 * only needs `experimentalDecorators` (set in tsconfig) to load — it does not rely on
 * `emitDecoratorMetadata`. `reflect-metadata` is imported by the entrypoints first.
 */
import { Container } from "inversify";
import { TYPES } from "./ioc/types.js";
import { config, vault } from "./config.js";

import { ConfigService } from "./ioc/services/ConfigService.js";
import { LlmService } from "./ioc/services/LlmService.js";
import { VaultService } from "./ioc/services/VaultService.js";
import { ScoreService } from "./ioc/services/ScoreService.js";
import { ReportService } from "./ioc/services/ReportService.js";
import { ConvertService } from "./ioc/services/ConvertService.js";
import { IngestService } from "./ioc/services/IngestService.js";
import { SearchService } from "./ioc/services/SearchService.js";
import { ContactsService } from "./ioc/services/ContactsService.js";
import { ResumeAgentService } from "./ioc/services/ResumeAgentService.js";
import { ApplicationService } from "./ioc/services/ApplicationService.js";
import { WorkflowService } from "./ioc/services/WorkflowService.js";
import { OrchestratorService } from "./ioc/services/OrchestratorService.js";
import { PipelineService } from "./ioc/services/PipelineService.js";
import { SchedulerService } from "./ioc/services/SchedulerService.js";
import { ApplyService } from "./ioc/services/ApplyService.js";
import { ServerService } from "./ioc/services/ServerService.js";

/** Build a fresh container with all bindings. Exported for tests that want isolation. */
export function buildContainer(): Container {
  const c = new Container({ defaultScope: "Singleton" });

  // Injected constants — bind the concrete config/vault objects as constant values.
  c.bind(TYPES.Config).toConstantValue(config);
  c.bind(TYPES.Vault).toConstantValue(vault);

  // Leaf services.
  c.bind(TYPES.ConfigService).to(ConfigService);
  c.bind(TYPES.LlmService).to(LlmService);
  c.bind(TYPES.VaultService).to(VaultService);
  c.bind(TYPES.ScoreService).to(ScoreService);
  c.bind(TYPES.ReportService).to(ReportService);
  c.bind(TYPES.ConvertService).to(ConvertService);
  c.bind(TYPES.IngestService).to(IngestService);
  c.bind(TYPES.SearchService).to(SearchService);
  c.bind(TYPES.ContactsService).to(ContactsService);
  c.bind(TYPES.ResumeAgentService).to(ResumeAgentService);
  c.bind(TYPES.ApplicationService).to(ApplicationService);

  // Composite / orchestration services.
  c.bind(TYPES.WorkflowService).to(WorkflowService);
  c.bind(TYPES.OrchestratorService).to(OrchestratorService);
  c.bind(TYPES.PipelineService).to(PipelineService);
  c.bind(TYPES.SchedulerService).to(SchedulerService);
  c.bind(TYPES.ApplyService).to(ApplyService);
  c.bind(TYPES.ServerService).to(ServerService);

  return c;
}

/** The application-wide container (singletons). */
export const container = buildContainer();
