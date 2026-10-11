import { injectable, inject } from "inversify";
import { TYPES } from "../types.js";
import {
  runNow,
  startScheduler,
  setSchedule,
  getSchedulerState,
  stopScheduler,
  type SchedulerState,
  type ScheduleMode,
} from "../../scheduler.js";
import type { SearchOverrides } from "../../orchestrator.js";
import type { PipelineSummary } from "../../types.js";
import type { OrchestratorService } from "./OrchestratorService.js";

/**
 * Injectable scheduler — arms the daily/interval timer, runs the pipeline now, and
 * exposes clean shutdown (clears the pending timer). Depends on the orchestrator service
 * (the run body it triggers). Delegates timer/state management to `scheduler.ts`.
 */
@injectable()
export class SchedulerService {
  constructor(
    @inject(TYPES.OrchestratorService) private readonly orchestrator: OrchestratorService,
  ) {}

  runNow(overrides: SearchOverrides = {}): Promise<PipelineSummary> {
    return runNow(overrides);
  }

  start(opts: { enabled: boolean; time: string }): Promise<void> {
    return startScheduler(opts);
  }

  set(
    opts: Partial<{ enabled: boolean; mode: ScheduleMode; time: string; intervalMinutes: number }>,
  ): Promise<SchedulerState> {
    return setSchedule(opts);
  }

  state(): SchedulerState {
    return getSchedulerState();
  }

  /** Clear the pending timer on shutdown (no dangling setTimeout). */
  stop(): void {
    stopScheduler();
  }
}
