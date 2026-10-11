/**
 * Tests for src/agents/application.ts — buildTailoredDocs (the crown jewel).
 *
 * Strategy:
 * - Mock ../llm.js (ollamaAvailable + ollamaChat) deterministically
 * - Provide a realistic profile.resumeMaster fixture
 * - Assert structural invariants: skills trimmed+reordered, floor categories kept,
 *   highlights reordered (permutation, no loss), the candidate's own title never
 *   replaced by the advertised one, metrics preserved, cover --- fences stripped, banned-phrase/fallback,
 *   ungrounded-tech cover fallback, summary grounding guard, offline path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Job, Score, Profile } from "../src/types.js";

// --- Fixtures ----------------------------------------------------------------

const RESUME_MASTER = `---
name: John Smith
role: Senior Integration Developer
tagline: API-led integrations in .NET / C# across enterprise systems
location: Nelson, Tasman
phone: 021 123 4567
email: john.smith@example.com
linkedin: https://linkedin.com/in/johnsmith
github: https://github.com/johnsmith
---

# John Smith

**Senior Integration Developer**

*API-led integrations in .NET / C# across enterprise systems*

Location: Nelson, Tasman | Phone: 021 123 4567
Email: john.smith@example.com | LinkedIn: https://linkedin.com/in/johnsmith

## Career Highlights

- Delivered CQRS architecture in AWS serving FHIR patient records at Northwind Health, reducing data latency by 40%
- Built live bed-status feed over WebSockets for ward systems
- Designed CQRS-based order API for FlowCore at Southern Fibre Networks, cutting integration time by 30%
- Automated payment matching with Example Bank at Harbour Insurance, eliminating manual matching
- Led migration of legacy SOAP services to REST/OpenAPI, improving maintainability across 12 downstream systems

## Professional Summary

Integration developer, 20+ years in finance and logistics software. Builds message-driven services in .NET / C# that keep business systems in sync.

## Core Competencies

- **API Design & Integration:** REST, GraphQL, SOAP, OpenAPI, event-driven architecture
- **Cloud & DevOps:** AWS (Lambda, SQS, SNS, API Gateway), CI/CD (GitHub Actions, Jenkins)
- **Healthcare Informatics:** HL7 FHIR, clinical data modelling, Northwind Health integration patterns
- **Leadership & Delivery:** Agile, team lead, mentoring, cross-functional stakeholder management

## Technical Skills

**Languages & Frameworks:** C#, .NET 6/8, TypeScript, Node.js, SQL

**Architecture & Patterns:** CQRS, Event Sourcing, Domain-Driven Design, Microservices, REST, OpenAPI

**Cloud & Infrastructure:** AWS (Lambda, SQS, SNS, API Gateway, CloudFormation), Docker

**Messaging & Integration:** RabbitMQ, MSMQ, MassTransit, NServiceBus, Azure Service Bus

**Data & Storage:** SQL Server, PostgreSQL, Redis, DynamoDB

**Testing & Quality:** xUnit, NUnit, MSTest, SpecFlow, Playwright

## Work Experience

### Northwind Health — Senior Integration Developer (2022–present)
Designed and built CQRS-based event-driven integrations in AWS, serving FHIR patient records to partner systems.

### Southern Fibre Networks — Integration Developer (2020–2022)
Built CQRS-based order API for FlowCore OSS/BSS platform. Delivered REST APIs consumed by the customer portal.

### Harbour Insurance — Integration Developer (2018–2020)
Connected the 'Keystone' policy system to the broker portal and automated payment matching with Example Bank.
`;

const makeJob = (overrides: Partial<Job> = {}): Job => ({
  id: "job-1",
  source: "seek",
  title: "Senior Integration Developer",
  company: "TechCorp NZ",
  location: "Wellington, NZ",
  url: "https://seek.co.nz/job/1",
  description:
    "Looking for a Senior Integration Developer with .NET, C#, AWS, REST API, CQRS and FHIR experience. You will design and build enterprise integrations.",
  salaryText: "$120k - $140k",
  salaryMin: 120_000,
  salaryMax: 140_000,
  engagement: "permanent",
  employmentType: "full-time",
  workArrangement: "hybrid",
  ingestedAt: new Date().toISOString(),
  ...overrides,
});

const makeProfile = (overrides: Partial<Profile> = {}): Profile => ({
  skills: "C# .NET AWS CQRS FHIR REST API integration",
  experience: "Northwind Health, Southern Fibre Networks, Harbour Insurance",
  education: "BSc Computer Science",
  preferences: "Permanent, NZ, $100k+",
  resumeMaster: RESUME_MASTER,
  coverLetterTemplate:
    "Dear {{hiring_manager}},\n\nI am applying for the {{job_title}} role at {{company}}.\n\nKind regards,\n{{name}}",
  ...overrides,
});

const makeScore = (overrides: Partial<Score> = {}): Score => ({
  jobId: "job-1",
  fit: 85,
  rejected: false,
  rejectReasons: [],
  matchedSkills: ["C#", ".NET", "CQRS", "FHIR", "AWS"],
  missingSkills: ["Kafka"],
  rationale: "Strong match for senior integration developer",
  ...overrides,
});

// --- Mock setup --------------------------------------------------------------

vi.mock("../src/llm.js", () => ({
  ollamaAvailable: vi.fn(),
  ollamaChat: vi.fn(),
}));

vi.mock("../src/vault.js", () => ({
  loadProfile: vi.fn(),
}));

import { buildTailoredDocs } from "../src/agents/application.js";
import { ollamaAvailable, ollamaChat } from "../src/llm.js";

const mockAvailable = vi.mocked(ollamaAvailable);
const mockChat = vi.mocked(ollamaChat);

// --- Helper to set up sequential ollamaChat return values -------------------
// Call order in buildTailoredDocs (when tailored=true):
//   1. focusSkills → reorderCatSection("Core Competencies") → rankLabels → ollamaChat
//   2. focusSkills → reorderCatSection("Technical Skills") → rankLabels → ollamaChat
//   3. reorderBulletSection("Career Highlights") → ollamaChat
//   4. tailorSummary → ollamaChat
//   5. tailorCover → ollamaChat

const CORE_LABELS = [
  "API Design & Integration",
  "Cloud & DevOps",
  "Healthcare Informatics",
  "Leadership & Delivery",
];
const TECH_LABELS = [
  "Languages & Frameworks",
  "Architecture & Patterns",
  "Cloud & Infrastructure",
  "Messaging & Integration",
  "Data & Storage",
  "Testing & Quality",
];

const GOOD_SUMMARY =
  "Senior integration developer specialising in .NET and C# with 20+ years at Northwind Health and Southern Fibre Networks building event-driven systems.";

// A realistic ~170-word letter: grounded in the master, no banned phrases, within the
// 150–500 word gate that buildTailoredDocs enforces.
const GOOD_COVER = [
  "Dear Hiring Manager,",
  "",
  "Your team is scaling enterprise integrations, and keeping distributed systems talking reliably is the problem I have spent my career on. I have 20 years of .NET and C# integration experience, including CQRS at Northwind Health.",
  "",
  "At Northwind Health I designed an event-driven CQRS architecture in AWS that served FHIR patient records to partner systems, and built a live bed-status feed over WebSockets for ward systems. At Southern Fibre Networks I built the CQRS-based order API for FlowCore. At Harbour Insurance I automated payment matching with Example Bank, removing a manual matching step in a regulated setting. Across these I relied on REST APIs, RabbitMQ and MSMQ messaging, and CI/CD on GitHub Actions and Jenkins.",
  "",
  "I would welcome the chance to talk through how this integration background fits your roadmap. I am based in Nelson, open to remote and relocation, and available at short notice.",
  "",
  "Kind regards,",
  "John Smith",
].join("\n");

function setupOnlineMocks(opts: {
  coreOrder?: string[];
  techOrder?: string[];
  highlightOrder?: number[];
  summary?: string;
  cover?: string;
} = {}): void {
  const core = opts.coreOrder ?? CORE_LABELS;
  const tech = opts.techOrder ?? TECH_LABELS;
  const highlights = opts.highlightOrder ?? [1, 2, 3, 4, 5];
  const summary = opts.summary ?? GOOD_SUMMARY;
  const cover = opts.cover ?? GOOD_COVER;

  mockChat
    .mockResolvedValueOnce(JSON.stringify({ order: core }))
    .mockResolvedValueOnce(JSON.stringify({ order: tech }))
    .mockResolvedValueOnce(JSON.stringify({ order: highlights }))
    .mockResolvedValueOnce(summary)
    .mockResolvedValueOnce(cover);
}

// Use resetAllMocks (not clearAllMocks) so queued mockResolvedValueOnce calls
// are also flushed between tests.
beforeEach(() => {
  vi.resetAllMocks();
});

// --- Tests -------------------------------------------------------------------

describe("buildTailoredDocs — Ollama offline path", () => {
  beforeEach(() => {
    mockAvailable.mockResolvedValue(false);
  });

  it("returns tailored=false when Ollama is unavailable", async () => {
    const result = await buildTailoredDocs(makeJob(), makeProfile());
    expect(result.tailored).toBe(false);
  });

  it("never calls ollamaChat when offline", async () => {
    await buildTailoredDocs(makeJob(), makeProfile());
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("includes the contact header with name in resumeMd", async () => {
    const result = await buildTailoredDocs(makeJob(), makeProfile());
    expect(result.resumeMd).toContain("John Smith");
    expect(result.resumeMd).toContain("021 123 4567");
  });

  it("resume contains master body sections", async () => {
    const result = await buildTailoredDocs(makeJob(), makeProfile());
    expect(result.resumeMd).toContain("Career Highlights");
    expect(result.resumeMd).toContain("Professional Summary");
    expect(result.resumeMd).toContain("Work Experience");
  });

  it("uses the fallback deterministic cover letter when offline", async () => {
    const result = await buildTailoredDocs(makeJob(), makeProfile());
    expect(result.coverMd).toContain("Dear Hiring Manager,");
    expect(result.coverMd).toContain("Kind regards,");
  });

  it("cover letter does not start with --- frontmatter fence", async () => {
    const result = await buildTailoredDocs(makeJob(), makeProfile());
    expect(result.coverMd.trimStart()).not.toMatch(/^---/);
  });

  it("reviewed=false when offline", async () => {
    const result = await buildTailoredDocs(makeJob(), makeProfile());
    expect(result.reviewed).toBe(false);
  });
});

describe("buildTailoredDocs — Ollama online path (happy path)", () => {
  beforeEach(() => {
    mockAvailable.mockResolvedValue(true);
    setupOnlineMocks();
  });

  it("returns tailored=true", async () => {
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.tailored).toBe(true);
  });

  it("calls ollamaChat 5 times (core, tech, highlights, summary, cover)", async () => {
    await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(mockChat).toHaveBeenCalledTimes(5);
  });

  it("resumeMd contains the tailored summary prose", async () => {
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.resumeMd).toContain("Senior integration developer specialising");
  });

  it("resumeMd still contains Career Highlights section", async () => {
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.resumeMd).toContain("Career Highlights");
  });

  it("preserves all 5 highlight bullets (no bullet is lost)", async () => {
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.resumeMd).toContain("CQRS architecture in AWS");
    expect(result.resumeMd).toContain("WebSockets");
    expect(result.resumeMd).toContain("FlowCore");
    expect(result.resumeMd).toContain("Example Bank");
    expect(result.resumeMd).toContain("SOAP services to REST");
  });

  it("reviewed=true when online", async () => {
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.reviewed).toBe(true);
  });

  it("uses the tailored cover when it is clean", async () => {
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.coverMd).toContain("I have 20 years of .NET");
  });
});

describe("buildTailoredDocs — cover fences stripped", () => {
  it("strips leading --- fence from model cover output", async () => {
    mockAvailable.mockResolvedValue(true);
    setupOnlineMocks({
      cover: "---\nDear Hiring Manager,\n\nContent.\n\nKind regards,\nJohn",
    });
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.coverMd.trimStart()).not.toMatch(/^---/);
    expect(result.coverMd).toContain("Dear Hiring Manager,");
  });

  it("strips trailing --- fence from model cover output", async () => {
    mockAvailable.mockResolvedValue(true);
    setupOnlineMocks({
      cover: "Dear Hiring Manager,\n\nContent.\n\nKind regards,\nJohn\n---",
    });
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.coverMd.trimEnd()).not.toMatch(/---$/);
  });
});

describe("buildTailoredDocs — the candidate's own title is never replaced", () => {
  // The headline under the name is an identity claim, not a keyword slot. The app used to
  // stamp the advertised title there for dev-sounding ads, which retitled the candidate on
  // their own resume. The master frontmatter `role` now wins for every kind of job.
  it("keeps the master role for a 'Courier Driver' job", async () => {
    mockAvailable.mockResolvedValue(false);
    const result = await buildTailoredDocs(makeJob({ title: "Courier Driver" }), makeProfile());
    expect(result.resumeMd).toContain("**Senior Integration Developer**");
    expect(result.resumeMd).not.toMatch(/\*\*Courier Driver\*\*/);
  });

  it("keeps the master role for a 'Full Stack Developer' job", async () => {
    mockAvailable.mockResolvedValue(false);
    const result = await buildTailoredDocs(makeJob({ title: "Full Stack Developer" }), makeProfile());
    expect(result.resumeMd).toContain("**Senior Integration Developer**");
    expect(result.resumeMd).not.toMatch(/\*\*Full Stack Developer\*\*/);
  });

  it("keeps the master role for a 'DevOps Engineer' job", async () => {
    mockAvailable.mockResolvedValue(false);
    const result = await buildTailoredDocs(makeJob({ title: "DevOps Engineer" }), makeProfile());
    expect(result.resumeMd).toContain("**Senior Integration Developer**");
    expect(result.resumeMd).not.toMatch(/\*\*DevOps Engineer\*\*/);
  });

  it("keeps the master role for a 'Solutions Architect' job, which the resume does not claim", async () => {
    mockAvailable.mockResolvedValue(false);
    const result = await buildTailoredDocs(makeJob({ title: "Solutions Architect" }), makeProfile());
    expect(result.resumeMd).toContain("**Senior Integration Developer**");
    expect(result.resumeMd).not.toMatch(/\*\*Solutions Architect\*\*/);
  });

  it("puts the master role in the headline even when tailoring is fully online", async () => {
    mockAvailable.mockResolvedValue(true);
    setupOnlineMocks();
    const result = await buildTailoredDocs(makeJob({ title: "Senior Platform Engineer" }), makeProfile());
    expect(result.resumeMd).toContain("**Senior Integration Developer**");
    expect(result.resumeMd).not.toMatch(/\*\*Senior Platform Engineer\*\*/);
  });
});

describe("buildTailoredDocs — cover letter grounding guard", () => {
  it("falls back to deterministic cover when model invents ungrounded tech (Salesforce)", async () => {
    mockAvailable.mockResolvedValue(true);
    // Profile/resume has NO mention of Salesforce — this cover is ungrounded.
    // Note: the master DOES contain "Azure Service Bus" so "azure" passes grounding;
    // we use "salesforce" which is not anywhere in the profile or master.
    setupOnlineMocks({
      cover: "I have extensive Salesforce CRM experience at scale.",
    });
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.coverMd).toContain("Dear Hiring Manager,");
    expect(result.coverMd.toLowerCase()).not.toContain("salesforce");
  });

  it("falls back to deterministic cover on banned cliché phrase 'proven track record'", async () => {
    mockAvailable.mockResolvedValue(true);
    setupOnlineMocks({
      cover: "I have a proven track record of delivering results.",
    });
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.coverMd).toContain("Dear Hiring Manager,");
  });

  it("falls back when cover contains 'honed'", async () => {
    mockAvailable.mockResolvedValue(true);
    setupOnlineMocks({
      cover: "I have honed my .NET skills over many years of integration work.",
    });
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.coverMd).toContain("Dear Hiring Manager,");
  });

  it("falls back when cover contains 'spearheaded'", async () => {
    mockAvailable.mockResolvedValue(true);
    setupOnlineMocks({
      cover: "I spearheaded multiple digital transformation initiatives.",
    });
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.coverMd).toContain("Dear Hiring Manager,");
  });

  it("falls back when cover contains 'leverage'", async () => {
    mockAvailable.mockResolvedValue(true);
    setupOnlineMocks({
      cover: "I leverage my skills to deliver value.",
    });
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.coverMd).toContain("Dear Hiring Manager,");
  });

  it("uses the model cover when it is grounded and clean", async () => {
    mockAvailable.mockResolvedValue(true);
    // Grounded (C#, .NET, CQRS, AWS, FHIR — all in the master), no banned phrases, and long
    // enough to clear the 150-word minimum the shipping gate now enforces.
    const cleanCover = [
      "Dear Hiring Manager,",
      "",
      "You are building enterprise integrations that have to stay reliable under load, and that is the work I do. I have built .NET and C# integrations at Northwind Health using CQRS for 20 years.",
      "",
      "At Northwind Health I delivered an event-driven CQRS architecture in AWS serving FHIR patient records, plus a live bed-status feed over WebSockets for ward systems. At Southern Fibre Networks I built the CQRS-based order API for FlowCore. At Harbour Insurance I automated payment matching with Example Bank, cutting out a manual matching step. I work with REST APIs, RabbitMQ and MSMQ messaging, and CI/CD pipelines on GitHub Actions and Jenkins.",
      "",
      "I would be glad to discuss how this integration background fits what your team is building, and where I could add the most value early on. I am based in Nelson, open to both remote work and relocation for the right role, and available to start at short notice.",
      "",
      "Kind regards,",
      "John Smith",
    ].join("\n");
    setupOnlineMocks({ cover: cleanCover });
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.coverMd).toContain("I have built .NET and C# integrations");
  });

  it("falls back when cover is empty", async () => {
    mockAvailable.mockResolvedValue(true);
    mockChat
      .mockResolvedValueOnce(JSON.stringify({ order: CORE_LABELS }))
      .mockResolvedValueOnce(JSON.stringify({ order: TECH_LABELS }))
      .mockResolvedValueOnce(JSON.stringify({ order: [1, 2, 3, 4, 5] }))
      .mockResolvedValueOnce(GOOD_SUMMARY)
      .mockResolvedValueOnce(""); // empty cover
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.coverMd).toContain("Dear Hiring Manager,");
  });
});

describe("buildTailoredDocs — summary grounding guard", () => {
  it("falls back to master summary when model output is too short (< 80 chars)", async () => {
    mockAvailable.mockResolvedValue(true);
    mockChat
      .mockResolvedValueOnce(JSON.stringify({ order: CORE_LABELS }))
      .mockResolvedValueOnce(JSON.stringify({ order: TECH_LABELS }))
      .mockResolvedValueOnce(JSON.stringify({ order: [1, 2, 3, 4, 5] }))
      .mockResolvedValueOnce("Too short.") // < 80 chars → guard throws → falls back
      .mockResolvedValueOnce(GOOD_COVER);
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    // Master summary text should appear verbatim (assembleResume keeps master body)
    expect(result.resumeMd).toContain(
      "Integration developer, 20+ years in finance and logistics software",
    );
  });

  it("falls back when model introduces ungrounded tech (Kubernetes)", async () => {
    mockAvailable.mockResolvedValue(true);
    // Kubernetes is not in the profile/master resume
    const ungroundedSummary =
      "Senior developer with Kubernetes and Terraform expertise at scale across cloud-native microservices architectures.";
    mockChat
      .mockResolvedValueOnce(JSON.stringify({ order: CORE_LABELS }))
      .mockResolvedValueOnce(JSON.stringify({ order: TECH_LABELS }))
      .mockResolvedValueOnce(JSON.stringify({ order: [1, 2, 3, 4, 5] }))
      .mockResolvedValueOnce(ungroundedSummary) // ungrounded → guard throws → falls back
      .mockResolvedValueOnce(GOOD_COVER);
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.resumeMd).toContain(
      "Integration developer, 20+ years in finance and logistics software",
    );
    expect(result.resumeMd).not.toContain("Kubernetes");
  });
});

describe("buildTailoredDocs — Technical Skills floor categories", () => {
  it("always keeps 'Languages & Frameworks' even when not ranked by model", async () => {
    mockAvailable.mockResolvedValue(true);
    // Model returns 4 tech categories but omits Languages & Frameworks
    mockChat
      .mockResolvedValueOnce(JSON.stringify({ order: CORE_LABELS }))
      .mockResolvedValueOnce(JSON.stringify({
        order: ["Cloud & Infrastructure", "Messaging & Integration", "Data & Storage", "Testing & Quality"],
        // 'Languages & Frameworks' intentionally omitted — floor should re-add it
      }))
      .mockResolvedValueOnce(JSON.stringify({ order: [1, 2, 3, 4, 5] }))
      .mockResolvedValueOnce(GOOD_SUMMARY)
      .mockResolvedValueOnce(GOOD_COVER);
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.resumeMd).toContain("Languages & Frameworks");
  });

  it("always keeps 'Architecture & Patterns' even when not ranked by model", async () => {
    mockAvailable.mockResolvedValue(true);
    mockChat
      .mockResolvedValueOnce(JSON.stringify({ order: CORE_LABELS }))
      .mockResolvedValueOnce(JSON.stringify({
        order: ["Cloud & Infrastructure", "Languages & Frameworks", "Messaging & Integration", "Data & Storage"],
        // 'Architecture & Patterns' intentionally omitted — floor should re-add it
      }))
      .mockResolvedValueOnce(JSON.stringify({ order: [1, 2, 3, 4, 5] }))
      .mockResolvedValueOnce(GOOD_SUMMARY)
      .mockResolvedValueOnce(GOOD_COVER);
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.resumeMd).toContain("Architecture & Patterns");
  });
});

describe("buildTailoredDocs — highlight bullet reordering (permutation integrity)", () => {
  it("reorders highlights as permutation: bullet 3 (FlowCore) appears before bullet 1 (CQRS AWS)", async () => {
    mockAvailable.mockResolvedValue(true);
    // Bullet 3 = "Designed CQRS-based order API for FlowCore"
    // Bullet 1 = "Delivered CQRS architecture in AWS"
    // Order [3,5,1,4,2] → FlowCore is bullet index 0 in reordered, CQRS-AWS is bullet index 2
    mockChat
      .mockResolvedValueOnce(JSON.stringify({ order: CORE_LABELS }))
      .mockResolvedValueOnce(JSON.stringify({ order: TECH_LABELS }))
      .mockResolvedValueOnce(JSON.stringify({ order: [3, 5, 1, 4, 2] })) // FlowCore first
      .mockResolvedValueOnce(GOOD_SUMMARY)
      .mockResolvedValueOnce(GOOD_COVER);
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    // All 5 bullets present
    expect(result.resumeMd).toContain("CQRS architecture in AWS");
    expect(result.resumeMd).toContain("WebSockets");
    expect(result.resumeMd).toContain("FlowCore");
    expect(result.resumeMd).toContain("Example Bank");
    expect(result.resumeMd).toContain("SOAP services to REST");
    // FlowCore bullet (3) should appear before CQRS-AWS bullet (1) after reorder
    const flowcoreIdx = result.resumeMd.indexOf("Designed CQRS-based order API for FlowCore");
    const cqrsIdx = result.resumeMd.indexOf("Delivered CQRS architecture in AWS");
    expect(flowcoreIdx).toBeLessThan(cqrsIdx);
  });

  it("keeps original order when model returns invalid permutation (duplicate index)", async () => {
    mockAvailable.mockResolvedValue(true);
    mockChat
      .mockResolvedValueOnce(JSON.stringify({ order: CORE_LABELS }))
      .mockResolvedValueOnce(JSON.stringify({ order: TECH_LABELS }))
      .mockResolvedValueOnce(JSON.stringify({ order: [1, 1, 2, 3, 4] })) // INVALID duplicate
      .mockResolvedValueOnce(GOOD_SUMMARY)
      .mockResolvedValueOnce(GOOD_COVER);
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    // All bullets still present
    expect(result.resumeMd).toContain("CQRS architecture in AWS");
    expect(result.resumeMd).toContain("FlowCore");
  });

  it("keeps original order when model returns wrong count (3 of 5)", async () => {
    mockAvailable.mockResolvedValue(true);
    mockChat
      .mockResolvedValueOnce(JSON.stringify({ order: CORE_LABELS }))
      .mockResolvedValueOnce(JSON.stringify({ order: TECH_LABELS }))
      .mockResolvedValueOnce(JSON.stringify({ order: [1, 2, 3] })) // only 3 → invalid
      .mockResolvedValueOnce(GOOD_SUMMARY)
      .mockResolvedValueOnce(GOOD_COVER);
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.resumeMd).toContain("Example Bank");
    expect(result.resumeMd).toContain("SOAP services to REST");
  });
});

describe("buildTailoredDocs — metrics preservation", () => {
  it("preserves numeric metrics from highlight bullets (40%, 30%)", async () => {
    mockAvailable.mockResolvedValue(false); // offline for simplicity
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.resumeMd).toContain("40%");
    expect(result.resumeMd).toContain("30%");
  });

  it("preserves metric references in online path too", async () => {
    mockAvailable.mockResolvedValue(true);
    setupOnlineMocks();
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.resumeMd).toContain("40%");
    expect(result.resumeMd).toContain("30%");
  });
});

describe("buildTailoredDocs — UK spelling", () => {
  it("converts 'specialized' → 'specialised' in tailored summary", async () => {
    mockAvailable.mockResolvedValue(true);
    setupOnlineMocks({
      summary:
        "Senior integration developer specialized in API-led event-driven systems at Northwind Health and Southern Fibre Networks building .NET and C# platforms.",
    });
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.resumeMd).toContain("specialised");
    expect(result.resumeMd).not.toContain(" specialized ");
  });
});

describe("buildTailoredDocs — fillPlaceholders", () => {
  it("clears any remaining [Your Name] placeholders from cover", async () => {
    mockAvailable.mockResolvedValue(true);
    setupOnlineMocks({
      cover: "Dear [Your Name], I am applying.\n\n[Your Phone] is my number.\n\nRegards,\n[Your Name]",
    });
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    // Either the placeholder cover was used (cleaned) or we fell back — no [Your X] either way
    expect(result.coverMd).not.toContain("[Your Name]");
    expect(result.coverMd).not.toContain("[Your Phone]");
  });

  it("strips {{placeholder}} tokens left unfilled by the model", async () => {
    mockAvailable.mockResolvedValue(true);
    setupOnlineMocks({
      cover: "I am applying to {{company}} for the {{job_title}} role at {{unknown_token}}.",
    });
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.coverMd).not.toContain("{{");
  });
});

describe("buildTailoredDocs — sanitizeText (code fence stripping)", () => {
  it("strips ```markdown code fences from summary output", async () => {
    mockAvailable.mockResolvedValue(true);
    setupOnlineMocks({
      summary:
        "```markdown\nSenior integration developer with .NET and C# at Northwind Health and Southern Fibre Networks — 20+ years of event-driven integrations.\n```",
    });
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.resumeMd).not.toContain("```");
  });
});

// --- Regression: a fabricating cover letter -----------------------------------
//
// A real generated cover letter shipped three fabrications and an em dash:
//   - "pipelines that handled millions of records daily" (no such metric anywhere)
//   - "migrated a system to a new platform" (the profile says the TEAM changed process)
//   - "spent years ensuring that systems I built long ago are still in active use"
// These tests lock the guards that now reject each class, and the ASCII fold.

describe("buildTailoredDocs - ASCII only", () => {
  it("folds em dashes, curly quotes and middots out of the cover letter", async () => {
    mockAvailable.mockResolvedValue(true);
    setupOnlineMocks({
      cover: GOOD_COVER.replace(
        "Your team is scaling enterprise integrations,",
        "I\u2019ve spent two decades on this \u2014 systems people rely on \u00b7 daily,",
      ),
    });
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.coverMd).not.toMatch(/[^\x09\x0a\x20-\x7e]/);
    expect(result.coverMd).toContain("I've spent two decades");
  });

  it("emits an ASCII-only resume even though the master uses em dashes", async () => {
    mockAvailable.mockResolvedValue(true);
    setupOnlineMocks();
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.resumeMd).not.toMatch(/[^\x09\x0a\x20-\x7e]/);
  });

  it("keeps the resume ASCII-only on the offline path too", async () => {
    mockAvailable.mockResolvedValue(false);
    const result = await buildTailoredDocs(makeJob(), makeProfile());
    expect(result.resumeMd).not.toMatch(/[^\x09\x0a\x20-\x7e]/);
    expect(result.coverMd).not.toMatch(/[^\x09\x0a\x20-\x7e]/);
  });
});

describe("buildTailoredDocs - invented metrics are rejected", () => {
  it("falls back when the cover claims a scale word the profile never states", async () => {
    mockAvailable.mockResolvedValue(true);
    setupOnlineMocks({
      cover: GOOD_COVER.replace(
        "At Southern Fibre Networks I built the CQRS-based order API for FlowCore.",
        "I designed real-time pipelines that handled millions of records daily.",
      ),
    });
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.coverMd).not.toContain("millions of records");
  });

  it("falls back when the cover invents a percentage", async () => {
    mockAvailable.mockResolvedValue(true);
    setupOnlineMocks({
      cover: GOOD_COVER.replace("including CQRS at Northwind Health", "cutting release time by 85%"),
    });
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.coverMd).not.toContain("85%");
  });

  it("keeps a real metric that IS in the master", async () => {
    mockAvailable.mockResolvedValue(true);
    setupOnlineMocks({
      cover: GOOD_COVER.replace(
        "including CQRS at Northwind Health",
        "including a CQRS build at Northwind Health that reduced data latency by 40%",
      ),
    });
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.coverMd).toContain("40%");
  });

  it("rejects an invented team size but tolerates version numbers", async () => {
    mockAvailable.mockResolvedValue(true);
    setupOnlineMocks({
      cover: GOOD_COVER.replace("I have 20 years", "I led a team of 14 engineers for 20 years"),
    });
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.coverMd).not.toContain("14 engineers");
  });
});

describe("buildTailoredDocs - unverifiable effort claims are rejected", () => {
  it("falls back on 'spent years ensuring...'", async () => {
    mockAvailable.mockResolvedValue(true);
    setupOnlineMocks({
      cover: GOOD_COVER.replace(
        "I would welcome the chance",
        "I have spent years ensuring those systems still run. I would welcome the chance",
      ),
    });
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.coverMd).not.toContain("spent years");
  });

  it("falls back on 'mentoring junior engineers' when the master does not say it", async () => {
    mockAvailable.mockResolvedValue(true);
    setupOnlineMocks({
      cover: GOOD_COVER.replace(
        "Kind regards,",
        "I enjoy mentoring junior engineers.\n\nKind regards,",
      ),
    });
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.coverMd).not.toContain("mentoring junior engineers");
  });

  it("falls back on 'single-handedly'", async () => {
    mockAvailable.mockResolvedValue(true);
    setupOnlineMocks({
      cover: GOOD_COVER.replace("At Southern Fibre Networks I built", "I single-handedly built"),
    });
    const result = await buildTailoredDocs(makeJob(), makeProfile(), makeScore());
    expect(result.coverMd).not.toContain("single-handedly");
  });
});

// --- Regression: guard false positives ---------------------------------------
//
// Found by a live qwen3:32b run: every cover letter was being rejected because the
// letterhead date ("11 August 2026") parsed as an ungrounded count of 11. Letterhead
// digits are ours, not claims about the candidate, and must never trip the metric guard.

import { ungroundedNumbers, ungroundedTech, failedGuards, asciiOnly } from "../src/agents/application.js";

describe("ungroundedNumbers - letterhead is not a claim", () => {
  const source = "20 years of C# and .NET. Cut release time by 60%+. Systems built in 2009.";

  it("ignores the injected date line", () => {
    expect(ungroundedNumbers("11 August 2026\n\nDear Hiring Manager,", source)).toEqual([]);
  });

  it("ignores every month spelling in the date line", () => {
    for (const d of ["1 January 2026", "30 September 2026", "5 December 2025"]) {
      expect(ungroundedNumbers(d, source)).toEqual([]);
    }
  });

  it("ignores the phone number and profile URLs", () => {
    const head = "021 555 0142 | jane.smith@example.co.nz\nlinkedin.com/in/jane-smith";
    expect(ungroundedNumbers(head, source)).toEqual([]);
  });

  it("still catches an invented year count next to a real date", () => {
    expect(ungroundedNumbers("11 August 2026. I have 18+ years of experience.", source)).toContain("18+");
  });

  it("accepts a grounded figure and its '+' rendering", () => {
    expect(ungroundedNumbers("20+ years, cutting deploys by 60%", source)).toEqual([]);
  });

  it("names the offending figures rather than just failing", () => {
    const out = ungroundedNumbers("I handled thousands of records over 15+ years", source);
    expect(out).toContain("thousands");
    expect(out).toContain("15+");
  });
});

describe("failedGuards - reports why a draft was rejected", () => {
  const source = "20 years of C# and .NET at Northwind Health.";

  it("returns an empty list for a clean grounded draft", () => {
    expect(failedGuards("I have 20 years of C# and .NET at Northwind Health.", source)).toEqual([]);
  });

  it("names the guard and the figures it tripped on", () => {
    const out = failedGuards("I have 18+ years and led thousands of users.", source).join(" ");
    expect(out).toContain("ungrounded-numbers");
    expect(out).toContain("18+");
  });

  it("names a banned phrase separately from a metric problem", () => {
    expect(failedGuards("I am excited to apply.", source)).toContain("banned-phrase");
  });
});

describe("asciiOnly", () => {
  it("folds dashes, quotes, middots and ellipsis", () => {
    expect(asciiOnly("a \u2014 b \u2013 c \u2019d\u2019 \u201Ce\u201D \u00B7 f\u2026")).toBe(
      "a - b - c 'd' \"e\" - f...",
    );
  });

  it("strips emoji and folds accents", () => {
    expect(asciiOnly("caf\u00E9 \uD83D\uDE80 r\u00E9sum\u00E9")).toBe("cafe resume");
  });

  it("preserves leading indentation of nested bullets", () => {
    expect(asciiOnly("- top\n  - nested")).toBe("- top\n  - nested");
  });
});

// --- Regression: framework fabrication ---------------------------------------
//
// Found in a live Loadscan "Full Web Stack Developer" application: the JD asked for
// "HTML, CSS, JS, React, Typescript, NodeJS and Express". The model wrote "deep expertise
// in full web stack development, including TypeScript/Node.js, React, and RESTful
// architectures" into the resume summary and shipped it. TypeScript and Node.js are real;
// React is not in the master at all. The old guard only watched clouds (azure, gcp, ...),
// so a framework slipped straight through beside two true skills.

describe("ungroundedTech - frameworks", () => {
  const master =
    "C#, .NET 8, TypeScript, JavaScript, Node.js, NestJS, jQuery, HTML5, " +
    "PostgreSQL, Bash. AWS Lambda.";

  it("catches a framework smuggled in beside real skills", () => {
    expect(ungroundedTech("Deep expertise in TypeScript/Node.js, React, and REST.", master))
      .toContain("react");
  });

  it("catches other frameworks a web JD names", () => {
    for (const [claim, term] of [
      ["Built the API in Express and Koa.", "express"],
      ["Front end in Vue and Angular.", "vue"],
      ["Services written in Java and Spring Boot.", "java"],
      ["Pipelines on Kafka into Snowflake.", "kafka"],
    ] as [string, string][]) {
      expect(ungroundedTech(claim, master)).toContain(term);
    }
  });

  it("does not fire on skills the master actually has", () => {
    expect(ungroundedTech("TypeScript, Node.js, NestJS, jQuery and HTML5 front ends.", master))
      .toEqual([]);
  });

  it("does not mistake javascript for java", () => {
    expect(ungroundedTech("Strong JavaScript and TypeScript.", master)).toEqual([]);
  });

  it("does not fire on an ordinary word that contains a term", () => {
    expect(ungroundedTech("The team reacted quickly and I expressed the design clearly.", master))
      .toEqual([]);
  });

  it("allows an honestly-owned gap", () => {
    const honest =
      "React is the one item on your list I'd be picking up on the job rather than bringing " +
      "with me. I work in TypeScript daily so it is a short step.";
    expect(ungroundedTech(honest, master)).toEqual([]);
  });

  it("still rejects a claim that merely sits near a gap sentence", () => {
    const sneaky =
      "I have shipped production React applications for five years. " +
      "Kubernetes is the one thing I would be learning on the job.";
    expect(ungroundedTech(sneaky, master)).toContain("react");
    expect(ungroundedTech(sneaky, master)).not.toContain("kubernetes");
  });

  it("names the fabricated tech in the failure reason", () => {
    expect(failedGuards("We used React throughout.", master).join(" ")).toContain("react");
  });
});

// --- Regression: em dash folded into a false compound -------------------------
//
// The same Loadscan letter shipped "Jenkins-tools I've used across .NET" and
// "cloud infrastructure-especially AWS-aligns": the model wrote em dashes, and the
// ASCII fold turned each into a bare hyphen, gluing the words either side together.

describe("asciiOnly - dash spacing", () => {
  it("folds an em dash between words to a spaced hyphen", () => {
    expect(asciiOnly("Jenkins—tools I've used")).toBe("Jenkins - tools I've used");
  });

  it("normalises a one-sided en dash the same way", () => {
    expect(asciiOnly("cloud infrastructure– especially AWS– aligns")).toBe(
      "cloud infrastructure - especially AWS - aligns",
    );
  });

  it("leaves a true hyphen alone", () => {
    expect(asciiOnly("event-driven sync-on-reconnect")).toBe("event-driven sync-on-reconnect");
  });

  it("does not let a dash swallow a line break", () => {
    expect(asciiOnly("- first\n— second")).toBe("- first\n - second");
  });
});

// --- Regression: off-track jobs get an off-track fallback ---------------------
//
// Found on a live "Storeperson" application (fit 5/100, surfaced by a search track).
// Ollama was offline, so the deterministic fallback ran - and it was hardcoded for
// software roles, interpolating the title into "the Storeperson role lines up closely
// with the work I do day to day", followed by a paragraph on the software career.

describe("buildTailoredDocs - off-track fallback", () => {
  beforeEach(() => {
    mockAvailable.mockResolvedValue(false);
  });

  const storeperson = makeJob({
    title: "Storeperson",
    company: "Hardware Depot",
    location: "Nelson Central, Tasman",
    description: "Receiving, storage and delivery paperwork. Assist with stock movements.",
  });

  it("never claims a warehouse role matches the software career", async () => {
    const { coverMd } = await buildTailoredDocs(storeperson, makeProfile());
    expect(coverMd).not.toContain("lines up closely");
    expect(coverMd).not.toMatch(/CQRS|FHIR|integration developer/i);
  });

  it("owns the change of work instead of hiding it", async () => {
    const { coverMd } = await buildTailoredDocs(storeperson, makeProfile());
    expect(coverMd).toContain("different work from my last role");
    expect(coverMd).toContain("Storeperson");
    expect(coverMd).toContain("Hardware Depot");
  });

  it("keeps the generic software fallback to the master's own tagline and town", async () => {
    const { coverMd } = await buildTailoredDocs(makeJob(), makeProfile());
    expect(coverMd).toContain("Senior Integration Developer role at TechCorp NZ");
    expect(coverMd).toContain("API-led integrations in .NET / C# across enterprise systems.");
    expect(coverMd).toContain("I'm based in Nelson");
    expect(coverMd).not.toMatch(/CQRS|FHIR|Northwind/);
  });

  it("says where the candidate is local to from the master, not a hard-coded town", async () => {
    const { coverMd } = await buildTailoredDocs(storeperson, makeProfile());
    expect(coverMd).toContain("I'm local to Nelson, available now");

    const nowhere = makeProfile({ resumeMaster: RESUME_MASTER.replace("location: Nelson, Tasman\n", "") });
    const { coverMd: noTown } = await buildTailoredDocs(storeperson, nowhere);
    expect(noTown).toContain("I'm available now and would be glad to come in and talk.");
  });

  it("cites a driver licence only when the master records one", async () => {
    const withLicence = makeProfile({
      resumeMaster: RESUME_MASTER.replace(
        "phone: 021 123 4567",
        "phone: 021 123 4567\ndrivers_licence: Full New Zealand driver's licence",
      ),
    });
    const { coverMd } = await buildTailoredDocs(storeperson, withLicence);
    expect(coverMd).toContain("full New Zealand driver's licence");

    const without = await buildTailoredDocs(storeperson, makeProfile());
    expect(without.coverMd).not.toMatch(/licence/i);
  });

  it("stays short enough for the audience", async () => {
    const { coverMd } = await buildTailoredDocs(storeperson, makeProfile());
    expect(coverMd.split(/\s+/).filter(Boolean).length).toBeLessThan(200);
  });
});

// --- The candidate's own fallback wording comes from the vault ------------------

describe("buildTailoredDocs - cover-letter fallback note", () => {
  beforeEach(() => {
    mockAvailable.mockResolvedValue(false);
  });

  const NOTE = [
    "---",
    "type: profile",
    "---",
    "",
    "# Cover letter fallback",
    "",
    "Notes for the user, never sent.",
    "",
    "## Software role",
    "",
    "The {{role}} role at {{company}} is the integration work I have done at Northwind Health.",
    "",
    "Based in {{town}} ({{location}}).",
    "",
    "## Other role",
    "",
    "I'd like the {{role}} job at {{company}}.",
    "",
    "I hold a {{drivers_licence}}.",
    "",
    "I'm local to {{town}}.",
    "",
  ].join("\n");

  const storeperson = makeJob({ title: "Storeperson", company: "Hardware Depot" });

  it("uses the note's Software role section, filled from the job and the master", async () => {
    const { coverMd } = await buildTailoredDocs(makeJob(), makeProfile({ coverFallback: NOTE }));
    expect(coverMd).toContain(
      "The Senior Integration Developer role at TechCorp NZ is the integration work I have done at Northwind Health.",
    );
    expect(coverMd).toContain("Based in Nelson (Nelson, Tasman).");
    expect(coverMd).not.toContain("Notes for the user");
    expect(coverMd).not.toContain("I'd like the");
  });

  it("uses the note's Other role section for an off-track job", async () => {
    const { coverMd } = await buildTailoredDocs(storeperson, makeProfile({ coverFallback: NOTE }));
    expect(coverMd).toContain("I'd like the Storeperson job at Hardware Depot.");
    expect(coverMd).toContain("I'm local to Nelson.");
    expect(coverMd).not.toContain("Northwind");
  });

  it("drops a line whose placeholder has no value instead of printing a gap", async () => {
    const { coverMd } = await buildTailoredDocs(storeperson, makeProfile({ coverFallback: NOTE }));
    expect(coverMd).not.toMatch(/licence|\{\{/);
    expect(coverMd).not.toMatch(/\n{3,}/);
  });

  it("falls back to the generic body when the note lacks the section", async () => {
    const softwareOnly = NOTE.slice(0, NOTE.indexOf("## Other role"));
    const { coverMd } = await buildTailoredDocs(storeperson, makeProfile({ coverFallback: softwareOnly }));
    expect(coverMd).toContain("different work from my last role");
  });
});

describe("ungroundedNumbers - a bare figure must match as a number, not a substring", () => {
  // Regression: qwen3:32b wrote "12+ years" into a summary for a master resume that states
  // no years figure at all, and the guard passed it. The "+" fallback did a raw substring
  // check, so "12" matched inside the employment dates and the phone number and the invented
  // credential shipped. A resume claiming experience the candidate never stated is the exact
  // failure these guards exist to prevent.
  const master = [
    "phone: 021 123 4567",
    "Backend developer building payment and data services.",
    "Northwind Health | June 2021 to May 2025",
    "Greenline Waste | March 2009 to April 2012",
    "Cut release time by 60%+ with build automation.",
  ].join("\n");

  it("rejects an invented years claim whose digits merely appear inside a date", () => {
    expect(ungroundedNumbers("Senior developer with 12+ years of experience.", master)).toContain("12+");
  });

  it("rejects one whose digits appear inside the phone number", () => {
    expect(ungroundedNumbers("Led a team of 21+ engineers.", master)).toContain("21+");
  });

  it("still accepts a figure the master genuinely states", () => {
    expect(ungroundedNumbers("Reduced release time by 60%+.", master)).toEqual([]);
  });

  it("accepts a bare number that stands alone in the master", () => {
    expect(ungroundedNumbers("Delivered 60+ integrations.", "Delivered 60 integrations.")).toEqual([]);
  });

  it("does not treat a longer number in the text as grounded by a shorter one in the master", () => {
    expect(ungroundedNumbers("Handled 6000+ requests.", "Handled 60 requests.")).toContain("6000+");
  });
});
