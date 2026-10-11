/**
 * DI service-identifier registry. Every injectable service + injected constant is
 * keyed by a unique symbol here. Using symbols (not string names) avoids collisions
 * and keeps the composition root and constructor `@inject(TYPES.X)` decorators in sync.
 *
 * NOTE (tsx/esbuild): esbuild does NOT emit design-type metadata, so every constructor
 * parameter MUST carry an explicit `@inject(TYPES.X)` decorator — nothing is inferred.
 */
export const TYPES = {
  // Injected constants (values, not classes).
  Config: Symbol.for("Config"),
  Vault: Symbol.for("Vault"),

  // Leaf services.
  LlmService: Symbol.for("LlmService"),
  ConfigService: Symbol.for("ConfigService"),
  VaultService: Symbol.for("VaultService"),
  ScoreService: Symbol.for("ScoreService"),
  ReportService: Symbol.for("ReportService"),
  ConvertService: Symbol.for("ConvertService"),
  IngestService: Symbol.for("IngestService"),
  SearchService: Symbol.for("SearchService"),
  ContactsService: Symbol.for("ContactsService"),
  ResumeAgentService: Symbol.for("ResumeAgentService"),
  ApplicationService: Symbol.for("ApplicationService"),

  // Composite / orchestration services.
  WorkflowService: Symbol.for("WorkflowService"),
  OrchestratorService: Symbol.for("OrchestratorService"),
  PipelineService: Symbol.for("PipelineService"),
  SchedulerService: Symbol.for("SchedulerService"),
  ApplyService: Symbol.for("ApplyService"),
  ServerService: Symbol.for("ServerService"),
} as const;

export type TypeKey = keyof typeof TYPES;
