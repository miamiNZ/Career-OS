import { injectable } from "inversify";
import {
  markInterested,
  markApplied,
  dropJob,
  setStatus,
  nextStatuses,
  canTransition,
  type ActionResult,
} from "../../workflow.js";
import type { JobStatus } from "../../types.js";

/**
 * Injectable board-workflow service — guarded status transitions and the
 * "mark Interested → tailor → Application Ready" flow. Delegates to `workflow.ts`.
 */
@injectable()
export class WorkflowService {
  markInterested(id: string): Promise<ActionResult> {
    return markInterested(id);
  }

  markApplied(id: string, date?: string): Promise<ActionResult> {
    return markApplied(id, date);
  }

  dropJob(id: string): Promise<ActionResult> {
    return dropJob(id);
  }

  setStatus(id: string, to: JobStatus): Promise<ActionResult> {
    return setStatus(id, to);
  }

  nextStatuses(from: JobStatus): JobStatus[] {
    return nextStatuses(from);
  }

  canTransition(from: JobStatus, to: JobStatus): boolean {
    return canTransition(from, to);
  }
}
