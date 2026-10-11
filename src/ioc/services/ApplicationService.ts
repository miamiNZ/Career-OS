import { injectable } from "inversify";
import {
  applicationAgent,
  buildTailoredDocs,
  type ApplicationDocs,
  type TailoredContent,
} from "../../agents/application.js";
import type { Job, Profile, Score } from "../../types.js";

/**
 * Injectable application-tailoring service — produces (and optionally writes) a tailored
 * resume + cover letter for a job the user marked Interested. Delegates to
 * `agents/application.ts`; preserves the `buildTailoredDocs(job, profile, score)` and
 * `applicationAgent(job, score)` signatures the tailoring proof depends on.
 */
@injectable()
export class ApplicationService {
  /** Pure: build the tailored resume + cover markdown, writing nothing to disk. */
  buildTailoredDocs(job: Job, profile: Profile, score?: Score): Promise<TailoredContent> {
    return buildTailoredDocs(job, profile, score);
  }

  /** Tailor + write resume/cover/job docs into Career/Jobs/Applications/<slug>/. */
  run(job: Job, score?: Score): Promise<ApplicationDocs> {
    return applicationAgent(job, score);
  }
}
