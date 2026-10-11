import { injectable } from "inversify";
import { getIngestSource, parseAlert, type IngestSource, type RawAlert } from "../../ingest/index.js";
import type { Job } from "../../types.js";

/**
 * Injectable ingest service — selects the configured alert source (file/graph/imap)
 * and parses raw alerts into Jobs. Delegates to `ingest/`.
 */
@injectable()
export class IngestService {
  /** The configured ingest source (file source by default). */
  getSource(): IngestSource {
    return getIngestSource();
  }

  /** Parse one raw alert email into zero-or-more Jobs. */
  parseAlert(alert: RawAlert): Job[] {
    return parseAlert(alert);
  }
}
