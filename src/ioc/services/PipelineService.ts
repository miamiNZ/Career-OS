import { injectable, inject } from "inversify";
import { TYPES } from "../types.js";
import { ingest, scoreAndReport, runPipeline, run } from "../../pipeline.js";
import type { Job, Score, PipelineSummary } from "../../types.js";
import type { IngestService } from "./IngestService.js";
import type { ScoreService } from "./ScoreService.js";
import type { ReportService } from "./ReportService.js";
import type { VaultService } from "./VaultService.js";

/**
 * Injectable read-side pipeline — ingest → score → report (the alert-email flow, GATE 1).
 * Composes the ingest/score/report/vault services (injected explicitly) and delegates the
 * staged logic to `pipeline.ts`.
 */
@injectable()
export class PipelineService {
  constructor(
    @inject(TYPES.IngestService) private readonly ingestSvc: IngestService,
    @inject(TYPES.ScoreService) private readonly score: ScoreService,
    @inject(TYPES.ReportService) private readonly report: ReportService,
    @inject(TYPES.VaultService) private readonly vault: VaultService,
  ) {}

  ingest(): Promise<Job[]> {
    return ingest();
  }

  scoreAndReport(jobs: Job[]): Promise<{ file: string; rows: { job: Job; score: Score }[] }> {
    return scoreAndReport(jobs);
  }

  runPipeline(): Promise<PipelineSummary> {
    return runPipeline();
  }

  run(): Promise<void> {
    return run();
  }
}
