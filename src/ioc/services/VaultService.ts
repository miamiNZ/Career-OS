import { injectable } from "inversify";
import {
  loadProfile,
  writeJobNote,
  existingJobIds,
  dedupeNoteFilesById,
  listJobNotes,
  getJobNoteById,
  setJobScore,
  setJobStatus,
  setAppliedDate,
  setInterested,
  reconcileApplications,
  expireClosedJobs,
  restoreDropped,
  archiveApplied,
  readAppliedHistory,
  flagExpiredApplied,
  updateAppliedListing,
  markJobExpired,
  getApplicationDir,
  getApplicationDocs,
  listReports,
  latestReport,
  readPresets,
  writePresets,
  type JobNote,
  type RestoreDroppedResult,
  type ArchiveAppliedResult,
} from "../../vault.js";
import type { AppliedHistoryEntry, Job, JobStatus, Profile, Score } from "../../types.js";

/**
 * Injectable vault I/O service — reads and writes the Obsidian job notes, profile,
 * reports and dashboard presets. Every method delegates to the existing `vault.ts`
 * functions (still exported for direct callers) so behaviour is unchanged.
 */
@injectable()
export class VaultService {
  loadProfile(): Promise<Profile> {
    return loadProfile();
  }

  writeJobNote(job: Job, status: JobStatus, extra: Record<string, unknown> = {}): Promise<string> {
    return writeJobNote(job, status, extra);
  }

  existingJobIds(): Promise<Set<string>> {
    return existingJobIds();
  }

  dedupeNoteFilesById(): Promise<{ removed: number }> {
    return dedupeNoteFilesById();
  }

  listJobNotes(): Promise<JobNote[]> {
    return listJobNotes();
  }

  getJobNoteById(id: string): Promise<JobNote | undefined> {
    return getJobNoteById(id);
  }

  setJobScore(id: string, score: Score): Promise<boolean> {
    return setJobScore(id, score);
  }

  setJobStatus(id: string, status: JobStatus): Promise<boolean> {
    return setJobStatus(id, status);
  }

  setAppliedDate(id: string, date: string): Promise<boolean> {
    return setAppliedDate(id, date);
  }

  setInterested(id: string, interested: boolean): Promise<boolean> {
    return setInterested(id, interested);
  }

  reconcileApplications(): Promise<number> {
    return reconcileApplications();
  }

  expireClosedJobs(): Promise<number> {
    return expireClosedJobs();
  }

  restoreDropped(
    opts: { minFit?: number; since?: string; titlePattern?: RegExp; dryRun?: boolean } = {},
  ): Promise<RestoreDroppedResult> {
    return restoreDropped(opts);
  }

  archiveApplied(
    opts: { statuses?: JobStatus[]; dryRun?: boolean } = {},
  ): Promise<ArchiveAppliedResult> {
    return archiveApplied(opts);
  }

  readAppliedHistory(): Promise<AppliedHistoryEntry[]> {
    return readAppliedHistory();
  }

  flagExpiredApplied(): Promise<{ scanned: number; flagged: number; cleared: number }> {
    return flagExpiredApplied();
  }

  updateAppliedListing(id: string, closesAt?: string, confirmedGone = false): Promise<boolean> {
    return updateAppliedListing(id, closesAt, confirmedGone);
  }

  markJobExpired(id: string): Promise<boolean> {
    return markJobExpired(id);
  }

  getApplicationDir(id: string): Promise<string> {
    return getApplicationDir(id);
  }

  getApplicationDocs(
    id: string,
  ): Promise<{ exists: boolean; resume: string; cover: string; folder: string }> {
    return getApplicationDocs(id);
  }

  listReports(): Promise<{ file: string; date: string }[]> {
    return listReports();
  }

  latestReport(): Promise<{ file: string; date: string; markdown: string } | null> {
    return latestReport();
  }

  readPresets(): Promise<Record<string, unknown>> {
    return readPresets();
  }

  writePresets(presets: Record<string, unknown>): Promise<void> {
    return writePresets(presets);
  }
}
