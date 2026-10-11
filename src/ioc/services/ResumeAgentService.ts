import { injectable } from "inversify";
import { resumeAgent, type ResumeContext } from "../../agents/resume.js";
import type { SearchConfig } from "../../searchConfig.js";

/**
 * Injectable resume agent — derives the search query + keyword list from the master
 * resume (Claude when keyed, else a heuristic). Delegates to `agents/resume.ts`.
 */
@injectable()
export class ResumeAgentService {
  run(cfg: SearchConfig): Promise<ResumeContext> {
    return resumeAgent(cfg);
  }
}
