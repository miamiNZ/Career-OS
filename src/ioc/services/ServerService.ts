import { injectable, inject } from "inversify";
import { TYPES } from "../types.js";
import { startServer } from "../../server.js";
import type { SchedulerService } from "./SchedulerService.js";
import type { VaultService } from "./VaultService.js";
import type { WorkflowService } from "./WorkflowService.js";
import type { OrchestratorService } from "./OrchestratorService.js";
import type { ConvertService } from "./ConvertService.js";
import type { LlmService } from "./LlmService.js";

/**
 * Injectable dashboard-server service — boots the HTTP dashboard + scheduler and wires
 * graceful shutdown. Composes the services the server surfaces (injected explicitly);
 * the HTTP handler + boot/shutdown logic lives in `server.ts` (which keeps resolving the
 * static `web/` assets relative to its own file, untouched by this wrapper).
 */
@injectable()
export class ServerService {
  constructor(
    @inject(TYPES.SchedulerService) private readonly scheduler: SchedulerService,
    @inject(TYPES.VaultService) private readonly vault: VaultService,
    @inject(TYPES.WorkflowService) private readonly workflow: WorkflowService,
    @inject(TYPES.OrchestratorService) private readonly orchestrator: OrchestratorService,
    @inject(TYPES.ConvertService) private readonly convert: ConvertService,
    @inject(TYPES.LlmService) private readonly llm: LlmService,
  ) {}

  /** Start the dashboard + scheduler; runs until SIGINT/SIGTERM. */
  start(): Promise<void> {
    return startServer();
  }
}
