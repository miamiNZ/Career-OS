import { injectable } from "inversify";
import { previewApplication, submitApplication, type FormPreview } from "../../apply.js";
import type { Job } from "../../types.js";
import type { TailoredDocs } from "../../tailor.js";

/**
 * Injectable apply service — the (Phase-4, not-yet-implemented) Playwright form driver.
 * GATE 2 lives between preview and submit. Delegates to `apply.ts`; the underlying
 * functions currently throw "not implemented", which is preserved.
 */
@injectable()
export class ApplyService {
  previewApplication(job: Job, docs: TailoredDocs): Promise<FormPreview> {
    return previewApplication(job, docs);
  }

  submitApplication(preview: FormPreview, approved: boolean): Promise<void> {
    return submitApplication(preview, approved);
  }
}
