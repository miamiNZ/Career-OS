import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { vault } from "./config.js";

export type SiteName = "seek" | "trademe" | "linkedin" | "indeed" | "zeil";

/** Deterministic search settings, sourced from Career/Profile/job-search.md. */
export interface SearchConfig {
  location: string;
  sites: SiteName[];
  maxResultsPerSite: number;
  employmentType: "full-time" | "part-time" | "any";
  engagement: "permanent" | "contract" | "any";
  keywordsOverride: string;
  tradeMeTitle: string;
  minFitToApply: number;
  /**
   * New primary-track leads scoring below this go straight to Dropped instead of onto the
   * board. 0 disables it. The job boards match on the whole ad body, not the title, so a
   * query carrying a generic word ("specialist", "consultant") drags in unrelated roles —
   * a Payroll Specialist or a Consultant Rheumatologist. The scorer already recognises
   * those (they land at 5-15); this acts on that instead of showing them.
   * The extra-search track is exempt — it is scored against the software profile and is
   * meant to rank low (see extraSearches).
   */
  minFitToKeep: number;
  /**
   * Primary-track queries — one search per entry (e.g. "senior software engineer",
   * ".net developer"). Empty = derive them from the profile's "Target roles" /
   * resume role. Several narrow role titles beat one wide keyword blob: job boards
   * rank on title relevance, so a single query only ever surfaces one slice of the market.
   */
  primarySearches: string[];
  /** Extra keyword searches run as a separate category (e.g. courier / driver). */
  extraSearches: string[];
  /** Location terms the extra searches are restricted to (e.g. ["Waikato"]). Empty = nationwide. */
  extraLocations: string[];
  /**
   * Every extra track, in run order. `extra_searches`/`extra_location` become the first
   * one, and `search_tracks:` in job-search.md adds the rest — a courier/driver track and
   * a "any IT job within reach of home" track want the same machinery (own queries, own
   * area, exempt from the primary track's type/engagement filters and off-target cut) but
   * different queries, and one shared pair of fields could only ever describe one of them.
   */
  tracks: SearchTrack[];
}

/** One extra search category: its own queries, restricted to its own area. */
export interface SearchTrack {
  /** Label used in logs and the run summary. */
  name: string;
  /** One keyword search per entry. */
  searches: string[];
  /**
   * Location terms a result must match. The first entry also becomes the `where` sent to
   * the job boards, so put the region first and the towns after it: searching the region
   * directly returns the local listings, where a nationwide search filtered down to
   * one region afterwards mostly returns nothing (20 relevance-ranked national results
   * rarely contain a local one). Empty = nationwide.
   */
  locations: string[];
  /**
   * Words/phrases a result's TITLE must contain to be kept. Empty = keep everything.
   *
   * The boards match a keyword query against the whole ad body, not the title, so a
   * broad track ("information technology", "it support") also returns every local
   * ad that merely mentions computers — Office Administrator, Customer Experience
   * Specialist. The primary track handles that with `min_fit_to_keep`, but tracks are
   * exempt from it by design (they are supposed to rank low), so they need a filter that
   * doesn't depend on the fit number. Matching is whole-word, case- and
   * punctuation-insensitive, so "it" hits "Operations & IT Support" and not "unit".
   */
  titleMatch: string[];
  /**
   * Seek classification ids browsed with no keyword (e.g. "6281" = Information &
   * Communication Technology). A keyword track can only return roles whose ad text uses
   * the words you guessed; a classification browse returns everything Seek itself files
   * under that category in the track's area, which for a small region is the whole local
   * market. Results are exempt from `titleMatch` — the board has already vouched for the
   * category, and the title filter demonstrably drops real ones ("Product Manager -
   * Lending" under ICT carries none of the IT words).
   */
  seekClassifications: string[];
  /** TradeMe job categories browsed with no keyword (e.g. "5000-5112-" = IT). */
  tradeMeCategories: string[];
}

/**
 * Friendly names for the category ids, so job-search.md can say `ict` instead of 6281.
 * Anything unrecognised is passed through, which is what lets a new id be used without a
 * code change.
 */
const SEEK_CLASSIFICATION_ALIASES: Record<string, string> = {
  ict: "6281",
  it: "6281",
  "information technology": "6281",
  "information communication technology": "6281",
  engineering: "1209",
  "science technology": "1223",
  "trades services": "1225",
  "transport logistics": "6092",
};
const TRADEME_CATEGORY_ALIASES: Record<string, string> = {
  ict: "5000-5112-",
  it: "5000-5112-",
  "information technology": "5000-5112-",
  engineering: "5000-5056-",
  "science technology": "5000-5179-",
  "trades services": "5000-5180-",
  "transport logistics": "5000-5068-",
};

function resolveAliases(values: string[], aliases: Record<string, string>): string[] {
  const out = values.map((v) => {
    const key = v.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    return aliases[key] ?? v.trim();
  });
  return [...new Set(out.filter(Boolean))];
}

const DEFAULTS: SearchConfig = {
  location: "New Zealand",
  sites: ["seek", "trademe", "linkedin", "indeed"],
  maxResultsPerSite: 20,
  employmentType: "full-time",
  engagement: "permanent",
  keywordsOverride: "",
  tradeMeTitle: "Software Developer",
  minFitToApply: 70,
  // Off by default: auto-dropping is destructive, so it stays opt-in per vault.
  minFitToKeep: 0,
  primarySearches: [],
  extraSearches: [],
  extraLocations: [],
  tracks: [],
};

/** Accept either a YAML list or a comma/newline-separated string of queries. */
function parseStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  if (typeof v === "string") return v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

const VALID_SITES: SiteName[] = ["seek", "trademe", "linkedin", "indeed", "zeil"];

/**
 * Build the extra tracks: the legacy `extra_searches` / `extra_location` pair first (so
 * an untouched vault behaves exactly as before), then each entry of `search_tracks`.
 * A track with no queries is dropped rather than run empty.
 */
function parseTracks(d: Record<string, unknown>): SearchTrack[] {
  const tracks: SearchTrack[] = [];

  const legacy = parseStringList(d.extra_searches);
  if (legacy.length) {
    tracks.push({
      name: "extra",
      searches: legacy,
      locations: parseStringList(d.extra_location),
      titleMatch: [],
      seekClassifications: [],
      tradeMeCategories: [],
    });
  }

  const declared = Array.isArray(d.search_tracks) ? d.search_tracks : [];
  for (const [i, entry] of declared.entries()) {
    if (!entry || typeof entry !== "object") continue;
    const t = entry as Record<string, unknown>;
    const searches = parseStringList(t.searches);
    const seekClassifications = resolveAliases(
      parseStringList(t.seek_classifications ?? t.seek_classification),
      SEEK_CLASSIFICATION_ALIASES,
    );
    const tradeMeCategories = resolveAliases(
      parseStringList(t.trademe_categories ?? t.trademe_category),
      TRADEME_CATEGORY_ALIASES,
    );
    // A track with nothing to run is dropped rather than run empty. A category browse
    // counts as something to run, so a track can be declared with no `searches` at all.
    if (!searches.length && !seekClassifications.length && !tradeMeCategories.length) continue;
    tracks.push({
      name: typeof t.name === "string" && t.name.trim() ? t.name.trim() : `track-${i + 1}`,
      searches,
      // `location` and `locations` both read naturally in YAML; accept either.
      locations: parseStringList(t.locations ?? t.location),
      titleMatch: parseStringList(t.title_match),
      seekClassifications,
      tradeMeCategories,
    });
  }
  return tracks;
}

/** Read job-search.md frontmatter, falling back to sensible defaults per field. */
export async function loadSearchConfig(): Promise<SearchConfig> {
  let raw: string;
  const file = path.join(vault.profileDir, "job-search.md");
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (e) {
    // A missing file is a legitimate un-configured vault: fall back to the defaults.
    // Anything else is the vault being unreachable — the SMB share dropping, a permission
    // failure — and falling back there silently runs a COMPLETELY different search:
    // nationwide, with none of the region tracks, which looks exactly like "the local
    // jobs stopped coming through". Fail the run instead of quietly searching the wrong
    // thing.
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { ...DEFAULTS };
    throw new Error(
      `Cannot read ${file} — the vault is unreachable, so the search would silently run ` +
        `nationwide with no region tracks.`,
      { cause: e },
    );
  }
  const d = matter(raw).data as Record<string, unknown>;

  const sites = Array.isArray(d.sites)
    ? (d.sites as string[]).filter((s): s is SiteName => VALID_SITES.includes(s as SiteName))
    : DEFAULTS.sites;

  return {
    location: typeof d.location === "string" && d.location ? d.location : DEFAULTS.location,
    sites: sites.length ? sites : DEFAULTS.sites,
    maxResultsPerSite: Number(d.max_results_per_site) || DEFAULTS.maxResultsPerSite,
    employmentType: (d.employment_type as SearchConfig["employmentType"]) ?? DEFAULTS.employmentType,
    engagement: (d.engagement as SearchConfig["engagement"]) ?? DEFAULTS.engagement,
    keywordsOverride: typeof d.keywords_override === "string" ? d.keywords_override : "",
    tradeMeTitle:
      typeof d.trademe_title === "string" && d.trademe_title
        ? d.trademe_title
        : DEFAULTS.tradeMeTitle,
    minFitToApply: Number(d.min_fit_to_apply) || DEFAULTS.minFitToApply,
    // `|| DEFAULT` would turn a deliberate 0 back into the default, so read it directly.
    minFitToKeep: Number.isFinite(Number(d.min_fit_to_keep))
      ? Number(d.min_fit_to_keep)
      : DEFAULTS.minFitToKeep,
    primarySearches: parseStringList(d.primary_searches),
    extraSearches: parseStringList(d.extra_searches),
    extraLocations: parseStringList(d.extra_location),
    tracks: parseTracks(d),
  };
}
