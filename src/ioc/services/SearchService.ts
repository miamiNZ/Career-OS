import { injectable } from "inversify";
import { searchAll, searchExtra, type SearchResult } from "../../agents/search/index.js";
import { enrichDescriptions } from "../../agents/search/describe.js";
import { loadSearchConfig, type SearchConfig } from "../../searchConfig.js";
import type { Job } from "../../types.js";

/**
 * Injectable search service — runs the enabled job-board agents (Seek/TradeMe/LinkedIn/Indeed/
 * ZEIL), the extra-keyword track, description enrichment, and loads the search config.
 * Delegates to `agents/search/` + `searchConfig.ts`.
 */
@injectable()
export class SearchService {
  loadConfig(): Promise<SearchConfig> {
    return loadSearchConfig();
  }

  searchAll(queries: string[], cfg: SearchConfig): Promise<SearchResult> {
    return searchAll(queries, cfg);
  }

  searchExtra(queries: string[], cfg: SearchConfig): Promise<SearchResult> {
    return searchExtra(queries, cfg);
  }

  enrichDescriptions(jobs: Job[]): Promise<{ enriched: number }> {
    return enrichDescriptions(jobs);
  }
}
