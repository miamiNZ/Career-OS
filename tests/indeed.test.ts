import { describe, it, expect, afterEach, vi } from "vitest";
import { searchIndeed } from "../src/agents/search/indeed.js";
import type { SearchConfig } from "../src/searchConfig.js";

const cfg = (over: Partial<SearchConfig> = {}): SearchConfig => ({
  location: "Waikato",
  sites: ["indeed"],
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

/** Last request body sent to the GraphQL endpoint. */
let sent: any;

function stubFetch(results: unknown[], opts: { status?: number; errors?: unknown[] } = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      const body = opts.errors ? { errors: opts.errors } : { data: { jobSearch: { results } } };
      return new Response(JSON.stringify(body), { status: opts.status ?? 200 });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  sent = undefined;
});

const job = (over: Record<string, unknown> = {}) => ({
  job: {
    key: "abc123",
    title: "Senior .NET Developer &amp; Lead",
    datePublished: 1790545777000,
    expired: false,
    description: { html: "<p>Build things.</p><ul><li>C#</li><li>Azure</li></ul>" },
    location: { formatted: { long: "Hamilton, Waikato" } },
    compensation: { baseSalary: { unitOfWork: "YEAR", range: { min: 120000, max: 140000 } }, estimated: null },
    attributes: [{ label: "Full-time" }, { label: "Permanent" }, { label: "Hybrid work" }],
    employer: { name: "Acme Ltd" },
    ...over,
  },
});

describe("searchIndeed", () => {
  it("maps a GraphQL result onto a Job", async () => {
    stubFetch([job()]);
    const [j] = await searchIndeed("developer", cfg());
    expect(j).toMatchObject({
      id: "indeed-abc123",
      source: "indeed",
      title: "Senior .NET Developer & Lead",
      company: "Acme Ltd",
      location: "Hamilton, Waikato",
      url: "https://nz.indeed.com/viewjob?jk=abc123",
      salaryText: "$120,000 – $140,000 a year",
      engagement: "permanent",
      employmentType: "full-time",
      workArrangement: "hybrid",
      postedAt: new Date(1790545777000).toISOString(),
    });
    expect(j!.description).toContain("Build things.");
    expect(j!.description).toContain("- C#");
  });

  it("sends the query, the configured area and the result cap as variables", async () => {
    stubFetch([]);
    await searchIndeed("courier", cfg({ location: "Waikato", maxResultsPerSite: 7 }));
    expect(sent.variables).toEqual({ what: "courier", where: "Waikato", limit: 7 });
  });

  it("falls back to nationwide when no location is configured", async () => {
    stubFetch([]);
    await searchIndeed("developer", cfg({ location: "  " }));
    expect(sent.variables.where).toBe("New Zealand");
  });

  it("drops expired listings and marks Indeed's own salary estimates", async () => {
    stubFetch([
      job({ key: "gone", expired: true }),
      job({
        key: "est",
        compensation: { baseSalary: null, estimated: { baseSalary: { unitOfWork: "HOUR", range: { min: 30, max: 30 } } } },
        attributes: [],
      }),
    ]);
    const jobs = await searchIndeed("courier", cfg());
    expect(jobs.map((j) => j.id)).toEqual(["indeed-est"]);
    expect(jobs[0]!.salaryText).toBe("$30 an hour (Indeed estimate)");
    expect(jobs[0]!.engagement).toBe("unknown");
  });

  it("throws on an HTTP error so the run logs it against the site", async () => {
    stubFetch([], { status: 403 });
    await expect(searchIndeed("developer", cfg())).rejects.toThrow("Indeed search 403");
  });

  it("throws on a GraphQL error payload", async () => {
    stubFetch([], { errors: [{ message: "bad field" }] });
    await expect(searchIndeed("developer", cfg())).rejects.toThrow("bad field");
  });
});

describe("Indeed in the search pipeline", () => {
  /** Answers Indeed's GraphQL and Seek's search API; records which hosts were asked. */
  let hosts: string[] = [];
  let indeedVars: any[] = [];

  function stubBoards(indeedJobs: unknown[], seekJobs: unknown[] = []): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | string, init?: RequestInit) => {
        const url = String(input);
        hosts.push(new URL(url).host);
        if (url.includes("apis.indeed.com")) {
          indeedVars.push(JSON.parse(String(init?.body)).variables);
          return new Response(JSON.stringify({ data: { jobSearch: { results: indeedJobs } } }));
        }
        return new Response(JSON.stringify({ data: seekJobs }));
      }),
    );
  }

  afterEach(() => {
    hosts = [];
    indeedVars = [];
  });

  it("runs Indeed for every query, scoped to the track's first location", async () => {
    const { searchExtra } = await import("../src/agents/search/index.js");
    stubBoards([job()]);
    const r = await searchExtra(["courier", "driver"], cfg({ location: "New Zealand" }), ["Waikato", "Hamilton"]);
    expect(indeedVars.map((v) => v.what).sort()).toEqual(["courier", "driver"]);
    expect(indeedVars.every((v) => v.where === "Waikato")).toBe(true);
    expect(r.bySite.indeed?.count).toBe(2);
    expect(r.jobs.map((j) => j.id)).toEqual(["indeed-abc123"]);
  });

  it("is not called when it is left out of sites", async () => {
    const { searchAll } = await import("../src/agents/search/index.js");
    stubBoards([job()]);
    await searchAll(["developer"], cfg({ sites: ["seek"] }));
    expect(hosts).not.toContain("apis.indeed.com");
  });

  it("is never used for a category browse, which it has no taxonomy for", async () => {
    const { searchTrack } = await import("../src/agents/search/index.js");
    stubBoards([job()]);
    await searchTrack(
      {
        name: "local-it",
        searches: [],
        locations: ["Waikato"],
        titleMatch: [],
        seekClassifications: ["6281"],
        tradeMeCategories: [],
      },
      cfg({ sites: ["seek", "indeed"] }),
    );
    expect(hosts).not.toContain("apis.indeed.com");
  });

  it("gives way to the Seek copy when both boards carry the same role", async () => {
    const { searchAll } = await import("../src/agents/search/index.js");
    stubBoards(
      [job({ title: "Senior Developer", employer: { name: "Acme Limited" } })],
      [{ id: "1", title: "Senior Developer", advertiser: { description: "Acme Ltd" }, locations: [{ label: "Hamilton" }] }],
    );
    const r = await searchAll(["developer"], cfg({ sites: ["seek", "indeed"] }));
    expect(r.jobs.map((j) => j.source)).toEqual(["seek"]);
  });
});
