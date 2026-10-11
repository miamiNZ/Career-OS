import { injectable } from "inversify";
import { writeReport } from "../../report.js";
import type { Job, Score } from "../../types.js";

/** Injectable report writer — renders a ranked markdown report of scored jobs. */
@injectable()
export class ReportService {
  writeReport(rows: { job: Job; score: Score }[]): Promise<string> {
    return writeReport(rows);
  }
}
