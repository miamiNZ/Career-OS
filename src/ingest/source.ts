import type { Job } from "../types.js";

/** A raw job-alert email pulled from a mailbox (or dev file). */
export interface RawAlert {
  id: string; // message id / filename
  from: string;
  subject: string;
  receivedAt: string; // ISO
  html: string;
  text: string;
}

/** Pluggable ingestion source: Graph, IMAP, or local files. */
export interface IngestSource {
  readonly name: string;
  /** Fetch unprocessed alert emails. */
  fetch(): Promise<RawAlert[]>;
}

/**
 * Parse a raw alert into zero-or-more Jobs.
 * Each provider (Seek/LinkedIn/TradeMe) lays out alert emails differently;
 * detect by sender domain, then extract listing blocks.
 *
 * TODO Phase 1: implement per-provider parsers. For now returns [].
 */
export function parseAlert(_alert: RawAlert): Job[] {
  return [];
}
