import { config } from "../config.js";
import type { IngestSource } from "./source.js";
import { FileSource } from "./file.js";

/** Select the ingest source from config. graph/imap are Phase-1 TODO. */
export function getIngestSource(): IngestSource {
  switch (config.ingestSource) {
    case "file":
      return new FileSource();
    case "graph":
      throw new Error("Graph ingest not implemented yet (Phase 1). Set INGEST_SOURCE=file.");
    case "imap":
      throw new Error("IMAP ingest not implemented yet (Phase 1). Set INGEST_SOURCE=file.");
    default:
      return new FileSource();
  }
}

export * from "./source.js";
