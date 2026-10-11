import type { Job } from "./types.js";
import type { TailoredDocs } from "./tailor.js";

export interface FormPreview {
  url: string;
  fields: Record<string, string>;
  attachments: string[];
}

/**
 * Stage 5 (Phase 4): open the application form with Playwright, fill fields +
 * attach tailored docs, and return a preview WITHOUT submitting.
 *
 * GATE 2 lives between previewApplication() and submitApplication():
 * the user must explicitly approve before the irreversible submit click.
 *
 * TODO Phase 4: implement per-site (Seek/LinkedIn/TradeMe) form drivers.
 */
export async function previewApplication(_job: Job, _docs: TailoredDocs): Promise<FormPreview> {
  throw new Error("previewApplication() not implemented yet (Phase 4).");
}

/** Clicks Submit. MUST only be called after explicit human approval of the preview. */
export async function submitApplication(_preview: FormPreview, approved: boolean): Promise<void> {
  if (!approved) throw new Error("Refusing to submit: GATE 2 approval not given.");
  throw new Error("submitApplication() not implemented yet (Phase 4).");
}
