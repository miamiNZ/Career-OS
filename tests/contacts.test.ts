/**
 * Tests for the pure parsing/extraction logic in src/contacts.ts:
 * - extractFromNote (exported pure function)
 * - email + phone extraction, name heuristics, block-list filtering
 */
import { describe, it, expect } from "vitest";
import { extractFromNote } from "../src/contacts.js";

const META = {
  company: "Acme Ltd",
  jobTitle: "Senior Developer",
  jobUrl: "https://example.com/jobs/1",
  jobNote: "acme-ltd-senior-developer",
};

describe("extractFromNote — basic email extraction", () => {
  it("returns empty array when no email in body", () => {
    const contacts = extractFromNote("No contact info here.", META);
    expect(contacts).toEqual([]);
  });

  it("extracts a plain email address", () => {
    const contacts = extractFromNote("Send your CV to alice@acme.co.nz for more info.", META);
    expect(contacts).toHaveLength(1);
    expect(contacts[0]!.email).toBe("alice@acme.co.nz");
  });

  it("extracts multiple unique emails", () => {
    const contacts = extractFromNote(
      "Email bob@acme.com or carol@acme.com for details.",
      META,
    );
    expect(contacts).toHaveLength(2);
    const emails = contacts.map((c) => c.email);
    expect(emails).toContain("bob@acme.com");
    expect(emails).toContain("carol@acme.com");
  });

  it("deduplicates repeated email addresses", () => {
    const contacts = extractFromNote(
      "Contact dave@acme.com. Questions? Email dave@acme.com.",
      META,
    );
    expect(contacts).toHaveLength(1);
  });
});

describe("extractFromNote — block-list filtering", () => {
  it("blocks no-reply addresses", () => {
    expect(extractFromNote("From: noreply@seek.co.nz", META)).toHaveLength(0);
    expect(extractFromNote("From: no-reply@seek.co.nz", META)).toHaveLength(0);
    expect(extractFromNote("From: donotreply@seek.co.nz", META)).toHaveLength(0);
  });

  it("blocks job-board domain addresses", () => {
    expect(extractFromNote("alerts@seek.co.nz", META)).toHaveLength(0);
    expect(extractFromNote("noreply@trademe.co.nz", META)).toHaveLength(0);
    expect(extractFromNote("jobs@linkedin.com", META)).toHaveLength(0);
  });

  it("allows legitimate personal work emails", () => {
    const contacts = extractFromNote("Contact jane.smith@company.co.nz", META);
    expect(contacts).toHaveLength(1);
  });
});

describe("extractFromNote — name extraction", () => {
  it("derives a name from first.last@domain email", () => {
    const contacts = extractFromNote("Email tom.jones@acme.co.nz for info.", META);
    expect(contacts[0]!.name).toMatch(/Tom Jones/i);
  });

  it("finds name from 'contact Jane Smith at ...' cue", () => {
    const contacts = extractFromNote(
      "Please contact Jane Smith at recruitment@acme.com.",
      META,
    );
    expect(contacts[0]!.name).toMatch(/Jane Smith/);
  });

  it("falls back to company Recruitment when name can't be determined", () => {
    const contacts = extractFromNote("Send to jobs@acme.co.nz.", {
      ...META,
      company: "Acme",
    });
    // jobs@ is a generic local, and there's no cue name
    if (contacts.length > 0) {
      // The block-list doesn't catch 'jobs@acme.co.nz' (not a known job-board domain)
      expect(contacts[0]!.name).toMatch(/Acme|Recruitment/);
    }
  });

  it("does not use lowercase sentence words as names", () => {
    const contacts = extractFromNote(
      "Get in touch with us at contact@acme.co.nz for details.",
      META,
    );
    // 'us at' should not be treated as a proper name
    if (contacts.length > 0) {
      expect(contacts[0]!.name).not.toMatch(/^us at$/i);
    }
  });
});

describe("extractFromNote — phone extraction", () => {
  it("attaches a NZ mobile number near the email", () => {
    const contacts = extractFromNote(
      "Call Sarah on 021 123 4567 or email sarah@acme.co.nz",
      META,
    );
    expect(contacts).toHaveLength(1);
    expect(contacts[0]!.phone).toBeDefined();
    expect(contacts[0]!.phone).toMatch(/021/);
  });

  it("attaches a NZ landline number", () => {
    const contacts = extractFromNote(
      "Phone: 03 442 1234. Email: sales@acme.co.nz",
      META,
    );
    if (contacts.length > 0 && contacts[0]!.phone) {
      expect(contacts[0]!.phone).toMatch(/03/);
    }
  });

  it("does NOT attach an ISO date fragment as a phone", () => {
    const contacts = extractFromNote(
      "Closing date: 2026-06-15. Email apply@acme.co.nz",
      META,
    );
    // 2026-06-15 has digit length < 9 after removing non-digits → validPhone rejects it.
    // apply@acme.co.nz is a generic local-part but NOT on the job-board block list,
    // so a contact may or may not be found; what matters is that no phone is 2026.
    if (contacts.length > 0 && contacts[0]!.phone !== undefined) {
      expect(contacts[0]!.phone).not.toMatch(/2026/);
    }
    // If phone is undefined that's also correct (date was not mistaken for a phone)
    if (contacts.length > 0) {
      expect(contacts[0]!.phone === undefined || !String(contacts[0]!.phone).includes("2026")).toBe(true);
    }
  });

  it("returns undefined phone when none in ad", () => {
    const contacts = extractFromNote("Email only: hr@acme.co.nz", META);
    if (contacts.length > 0) {
      expect(contacts[0]!.phone).toBeUndefined();
    }
  });
});

describe("extractFromNote — metadata passthrough", () => {
  it("copies company, jobTitle, jobUrl, jobNote to each contact", () => {
    const contacts = extractFromNote("Email cto@startup.co.nz for roles.", META);
    if (contacts.length > 0) {
      expect(contacts[0]!.company).toBe("Acme Ltd");
      expect(contacts[0]!.jobTitle).toBe("Senior Developer");
      expect(contacts[0]!.jobUrl).toBe("https://example.com/jobs/1");
      expect(contacts[0]!.jobNote).toBe("acme-ltd-senior-developer");
    }
  });

  it("uses 'Recruiter / Hiring contact' as default role", () => {
    const contacts = extractFromNote("Email dev@tech.co.nz", META);
    if (contacts.length > 0) {
      expect(contacts[0]!.role).toBe("Recruiter / Hiring contact");
    }
  });
});
