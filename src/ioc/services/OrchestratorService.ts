import { injectable, inject } from "inversify";
import { TYPES } from "../types.js";
import {
  runAgents,
  rescoreAll,
  reenrichDescriptions,
  scanAppliedExpiry,
  dedupeLinkedInAgainstSeek,
  dedupeOpportunities,
  type AgenticSummary,
  type DedupeOpportunitiesResult,
  type SearchOverrides,
} from "../../orchestrator.js";
import type { JobStatus } from "../../types.js";
import type { ResumeAgentService } from "./ResumeAgentService.js";
import type { SearchService } from "./SearchService.js";
import type { ScoreService } from "./ScoreService.js";
import type { ReportService } from "./ReportService.js";
import type { VaultService } from "./VaultService.js";
import type { ContactsService } from "./ContactsService.js";

/**
 * Injectable orchestration service — the full agentic search run
 * (resume → search → enrich → filter → score → report → contacts) plus the maintenance
 * ops (rescore, re-enrich, LinkedIn dedupe). The collaborators it composes are injected
 * so the dependency graph is explicit and swappable; the run logic itself lives in
 * `orchestrator.ts` and is delegated to unchanged.
 *
 * NOTE: explicit `@inject(TYPES.X)` on every ctor param — esbuild/tsx emits no design
 * metadata, so nothing here is auto-inferred.
 */
@injectable()
export class OrchestratorService {
  constructor(
    @inject(TYPES.ResumeAgentService) private readonly resume: ResumeAgentService,
    @inject(TYPES.SearchService) private readonly search: SearchService,
    @inject(TYPES.ScoreService) private readonly score: ScoreService,
    @inject(TYPES.ReportService) private readonly report: ReportService,
    @inject(TYPES.VaultService) private readonly vault: VaultService,
    @inject(TYPES.ContactsService) private readonly contacts: ContactsService,
  ) {}

  runAgents(overrides: SearchOverrides = {}): Promise<AgenticSummary> {
    return runAgents(overrides);
  }

  rescoreAll(
    opts: { staleOnly?: boolean; includeDropped?: boolean } = {},
  ): Promise<{ rescored: number; skipped: number }> {
    return rescoreAll(opts);
  }

  reenrichDescriptions(
    statuses: JobStatus[] = ["lead"],
  ): Promise<{ scanned: number; enriched: number; expired: number }> {
    return reenrichDescriptions(statuses);
  }

  scanAppliedExpiry(): Promise<{
    scanned: number;
    flagged: number;
    cleared: number;
    confirmedGone: number;
  }> {
    return scanAppliedExpiry();
  }

  dedupeLinkedInAgainstSeek(): Promise<{ dropped: number }> {
    return dedupeLinkedInAgainstSeek();
  }

  dedupeOpportunities(opts: { dryRun?: boolean } = {}): Promise<DedupeOpportunitiesResult> {
    return dedupeOpportunities(opts);
  }
}
