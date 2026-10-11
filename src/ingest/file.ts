import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import type { IngestSource, RawAlert } from "./source.js";

/**
 * Dev source: reads .eml/.txt/.html files from ./inbox.
 * Lets us build + test the parser pipeline without live mailbox auth.
 */
export class FileSource implements IngestSource {
  readonly name = "file";

  async fetch(): Promise<RawAlert[]> {
    let files: string[];
    try {
      files = await fs.readdir(config.inboxDir);
    } catch {
      return [];
    }
    const out: RawAlert[] = [];
    for (const f of files) {
      if (!/\.(eml|txt|html?)$/i.test(f)) continue;
      const full = path.join(config.inboxDir, f);
      const content = await fs.readFile(full, "utf8");
      const stat = await fs.stat(full);
      out.push({
        id: f,
        from: "",
        subject: f,
        receivedAt: stat.mtime.toISOString(),
        html: /\.html?$/i.test(f) ? content : "",
        text: content,
      });
    }
    return out;
  }
}
