import { injectable } from "inversify";
import { scoreJob, hardFilterReject } from "../../score.js";
import type { HardFilters, Job, Profile, Score } from "../../types.js";

/**
 * Injectable job-fit scorer. Delegates to `score.ts` (Claude → Ollama → heuristic
 * fallback chain lives there unchanged). Exposed as a service so pipeline/orchestrator
 * receive it via DI.
 */
@injectable()
export class ScoreService {
  /** AI fit score for a job vs the profile. */
  scoreJob(job: Job, profile: Profile): Promise<Score> {
    return scoreJob(job, profile);
  }

  /** Deterministic hard-filter reasons (runs before AI scoring). */
  hardFilterReject(job: Job, filters?: HardFilters): string[] {
    return hardFilterReject(job, filters);
  }
}
