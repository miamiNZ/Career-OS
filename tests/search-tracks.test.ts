import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { searchSeek } from "../src/agents/search/seek.js";
import { searchTradeMe, tradeMeRegionId } from "../src/agents/search/trademe.js";
import { searchTrack } from "../src/agents/search/index.js";
import type { SearchConfig, SearchTrack } from "../src/searchConfig.js";

const cfg = (over: Partial<SearchConfig> = {}): SearchConfig => ({
  location: "Waikato",
  sites: ["seek", "trademe"],
  maxResultsPerSite: 20,
  employmentType: "full-time",
  engagement: "permanent",
  keywordsOverride: "",
  tradeMeTitle: "Software Developer",
  minFitToApply: 70,
  minFitToKeep: 20,
  primarySearches: [],
  extraSearches: [],
  extraLocations: [],
  tracks: [],
  ...over,
});

const track = (over: Partial<SearchTrack> = {}): SearchTrack => ({
  name: "local-it",
  searches: [],
  locations: ["Waikato", "Hamilton"],
  titleMatch: [],
  seekClassifications: [],
  tradeMeCategories: [],
  ...over,
});

/** Every URL the code fetched, in call order. */
let calls: string[] = [];

/** Minimal Seek / TradeMe payloads keyed off which endpoint was asked for. */
function stubFetch(seekIds: string[] = [], tradeMeIds: string[] = []): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string) => {
      const url = String(input);
      calls.push(url);
      const body = url.includes("seek.co.nz")
        ? {
            data: seekIds.map((id) => ({
              id,
              title: `Seek role ${id}`,
              advertiser: { description: "Acme" },
              locations: [{ label: "Hamilton Central, Waikato" }],
              workTypes: ["Full time"],
              teaser: "",
            })),
          }
        : {
            List: tradeMeIds.map((id) => ({
              ListingId: id,
              Title: `TradeMe role ${id}`,
              Company: "Acme",
              Region: "Waikato",
              Suburb: "Hamilton",
              JobType: "Permanent",
              Body: "",
            })),
          };
      return { ok: true, status: 200, json: async () => body, text: async () => "" } as never;
    }),
  );
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Seek classification browse", () => {
  it("drops the keyword and sorts by listing date when browsing a classification", async () => {
    stubFetch(["1"]);
    await searchSeek("", cfg(), { classification: "6281" });
    const url = new URL(calls[0]!);
    expect(url.searchParams.get("classification")).toBe("6281");
    expect(url.searchParams.has("keywords")).toBe(false);
    expect(url.searchParams.get("sortMode")).toBe("ListedDate");
    expect(url.searchParams.get("where")).toBe("Waikato");
  });

  it("still runs a relevance-ranked keyword search when given one", async () => {
    stubFetch(["1"]);
    await searchSeek("it support", cfg());
    const url = new URL(calls[0]!);
    expect(url.searchParams.get("keywords")).toBe("it support");
    expect(url.searchParams.get("sortMode")).toBe("Relevance");
    expect(url.searchParams.has("classification")).toBe(false);
  });
});

describe("tradeMeRegionId", () => {
  it("resolves a region name whatever its punctuation", () => {
    expect(tradeMeRegionId("Waikato")).toBe("14");
    expect(tradeMeRegionId("hawke's bay")).toBe("5");
    expect(tradeMeRegionId("Manawatu / Whanganui")).toBe("6");
  });

  it("returns undefined for a town, so the search stays nationwide", () => {
    expect(tradeMeRegionId("Hamilton")).toBeUndefined();
    expect(tradeMeRegionId("")).toBeUndefined();
  });
});

describe("TradeMe region + category", () => {
  it("scopes a keyword search to the region", async () => {
    stubFetch([], ["9"]);
    await searchTradeMe(cfg(), "courier", { region: "14" });
    const url = new URL(calls[0]!);
    expect(url.searchParams.get("region")).toBe("14");
    expect(url.searchParams.get("search_string")).toBe("courier");
  });

  it("browses a category with no search string at all", async () => {
    stubFetch([], ["9"]);
    await searchTradeMe(cfg(), "", { category: "5000-5112-", region: "14" });
    const url = new URL(calls[0]!);
    expect(url.searchParams.get("category")).toBe("5000-5112-");
    expect(url.searchParams.has("search_string")).toBe(false);
  });

  it("keeps falling back to the configured title when nothing is passed", async () => {
    stubFetch([], ["9"]);
    await searchTradeMe(cfg());
    expect(new URL(calls[0]!).searchParams.get("search_string")).toBe("Software Developer");
  });
});

describe("searchTrack", () => {
  it("marks browse results so the caller can exempt them from title_match", async () => {
    stubFetch(["100"], ["200"]);
    const r = await searchTrack(
      track({ seekClassifications: ["6281"], tradeMeCategories: ["5000-5112-"] }),
      cfg(),
    );
    expect(r.categoryIds).toEqual(new Set(["seek-100", "trademe-200"]));
    expect(r.jobs.map((j) => j.id).sort()).toEqual(["seek-100", "trademe-200"]);
  });

  it("runs a browse-only track without issuing any keyword search", async () => {
    stubFetch(["100"]);
    await searchTrack(track({ seekClassifications: ["6281"] }), cfg({ sites: ["seek"] }));
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!).searchParams.has("keywords")).toBe(false);
  });

  it("sends the track's own region to TradeMe for its keyword searches", async () => {
    stubFetch([], ["200"]);
    await searchTrack(track({ searches: ["courier"] }), cfg({ sites: ["trademe"] }));
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!).searchParams.get("region")).toBe("14");
  });

  it("keeps a listing found both ways once, still flagged as category-sourced", async () => {
    stubFetch(["100"]);
    const r = await searchTrack(
      track({ searches: ["it support"], seekClassifications: ["6281"] }),
      cfg({ sites: ["seek"] }),
    );
    expect(r.jobs).toHaveLength(1);
    expect(r.categoryIds.has("seek-100")).toBe(true);
  });

  it("reports no category ids for a plain keyword track", async () => {
    stubFetch(["100"]);
    const r = await searchTrack(track({ searches: ["courier"] }), cfg({ sites: ["seek"] }));
    expect(r.categoryIds.size).toBe(0);
    expect(r.jobs).toHaveLength(1);
  });
});
