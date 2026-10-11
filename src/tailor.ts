import type { Job, Profile } from "./types.js";

export interface TailoredDocs {
  resumeMarkdown: string;
  coverLetterMarkdown: string;
}

/**
 * Stage 4 (Phase 3): produce a tailored resume + cover letter for a job.
 * Draft from profile.resumeMaster + profile.coverLetterTemplate, reordered/emphasised
 * to the JD via Claude. Output stays markdown; docx export happens at submit time.
 *
 * TODO Phase 3: implement Claude call + docx render (e.g. via a pandoc/docx step).
 */
export async function tailor(_job: Job, _profile: Profile): Promise<TailoredDocs> {
  throw new Error("tailor() not implemented yet (Phase 3).");
}
