import "reflect-metadata";
import { container } from "./inversify.config.js";
import { TYPES } from "./ioc/types.js";
import type { PipelineService } from "./ioc/services/PipelineService.js";
import type { OrchestratorService } from "./ioc/services/OrchestratorService.js";
import type { ContactsService } from "./ioc/services/ContactsService.js";
import type { ServerService } from "./ioc/services/ServerService.js";
import type { VaultService } from "./ioc/services/VaultService.js";

const cmd = process.argv[2] ?? "run";

async function main() {
  const pipeline = container.get<PipelineService>(TYPES.PipelineService);

  switch (cmd) {
    case "agents":
    case "find": {
      // Full agentic run: resume → search (seek/trademe/linkedin) → score → tailor.
      const orchestrator = container.get<OrchestratorService>(TYPES.OrchestratorService);
      await orchestrator.runAgents();
      break;
    }
    case "rescore": {
      // Re-score existing job notes with the current scorer. Dropped roles are skipped
      // unless --include-dropped; --stale limits the pass to the notes scored against an
      // older resume or another model, which is what you want after editing the CV:
      //   npm run rescore -- --stale
      const orchestrator = container.get<OrchestratorService>(TYPES.OrchestratorService);
      const flags = process.argv.slice(3);
      await orchestrator.rescoreAll({
        staleOnly: flags.includes("--stale"),
        includeDropped: flags.includes("--include-dropped"),
      });
      break;
    }
    case "restore-dropped": {
      // Recover leads a bad run dropped. Defaults to a dry run — pass --apply to write.
      //   npm run restore-dropped -- --min-fit 60 --since 2026-06-01 --titles developer,engineer --apply
      const vault = container.get<VaultService>(TYPES.VaultService);
      const args = process.argv.slice(3);
      const flag = (name: string): string | undefined => {
        const i = args.indexOf(`--${name}`);
        return i >= 0 ? args[i + 1] : undefined;
      };
      const titles = flag("titles");
      const r = await vault.restoreDropped({
        minFit: Number(flag("min-fit") ?? 0),
        since: flag("since"),
        titlePattern: titles
          ? new RegExp(titles.split(",").map((t) => t.trim()).filter(Boolean).join("|"), "i")
          : undefined,
        dryRun: !args.includes("--apply"),
      });
      for (const t of r.titles) console.log(`  ${t}`);
      console.log(
        `[restore-dropped] ${args.includes("--apply") ? "restored" : "would restore"} ${r.restored} of ${r.scanned} dropped job(s)` +
          (args.includes("--apply") ? "" : " — re-run with --apply to write"),
      );
      break;
    }
    case "dedupe": {
      // Drop Opportunities that duplicate a role already in Applied/Dropped, or listed
      // twice across sites. Defaults to a dry run — pass --apply to write.
      //   npm run dedupe -- --apply
      const orchestrator = container.get<OrchestratorService>(TYPES.OrchestratorService);
      const apply = process.argv.slice(3).includes("--apply");
      const r = await orchestrator.dedupeOpportunities({ dryRun: !apply });
      for (const e of r.entries) console.log(`  ${e}`);
      console.log(
        `[dedupe] ${apply ? "dropped" : "would drop"} ${r.dropped} of ${r.scanned} opportunit(ies) — ` +
          `${r.vsApplied} already applied · ${r.vsDropped} already dropped · ${r.vsSelf} listed twice` +
          (apply ? "" : " — re-run with --apply to write"),
      );
      break;
    }
    case "archive-applied": {
      // Clear the Applied + Unsuccessful columns off the board. The notes move to
      // Career/Jobs/Archive/ and every role is recorded in Career/applied-history.json,
      // which search keeps excluding for good. Dry run by default — pass --apply to write.
      //   npm run archive-applied -- --apply
      const vault = container.get<VaultService>(TYPES.VaultService);
      const args = process.argv.slice(3);
      const apply = args.includes("--apply");
      const r = await vault.archiveApplied({ dryRun: !apply });
      for (const e of r.entries) console.log(`  ${e}`);
      console.log(
        `[archive-applied] ${apply ? "archived" : "would archive"} ${apply ? r.archived : r.scanned} note(s)` +
          (apply
            ? ` · ${r.recorded} new history entr(ies) · ${r.historyTotal} role(s) excluded from future searches`
            : ` · ${r.historyTotal} role(s) already on record — re-run with --apply to write`),
      );
      break;
    }
    case "expire-applied": {
      // Scan Applied positions and flag any whose listing has closed (never drops them).
      const orchestrator = container.get<OrchestratorService>(TYPES.OrchestratorService);
      const r = await orchestrator.scanAppliedExpiry();
      console.log(`[expire-applied] scanned ${r.scanned} · flagged ${r.flagged} · confirmed gone ${r.confirmedGone} · cleared ${r.cleared}`);
      break;
    }
    case "contacts": {
      // Extract recruiter/hiring contacts from job ads into Career/Contacts/.
      const contacts = container.get<ContactsService>(TYPES.ContactsService);
      const r = await contacts.syncFromJobs();
      console.log(`[contacts] scanned ${r.scanned} · found ${r.found} · wrote ${r.written} · skipped ${r.skipped}`);
      break;
    }
    case "ingest":
      await pipeline.ingest();
      break;
    case "score":
    case "report": {
      const jobs = await pipeline.ingest();
      await pipeline.scoreAndReport(jobs);
      break;
    }
    case "tailor":
      console.log("tailor: now part of `agents` run (application agent).");
      break;
    case "apply":
      console.log("apply: submit applications yourself from Job Opportunities.md (GATE 2).");
      break;
    case "dashboard":
    case "serve": {
      // starts the web dashboard + scheduler; runs until Ctrl+C
      const server = container.get<ServerService>(TYPES.ServerService);
      await server.start();
      break;
    }
    case "run":
    default:
      await pipeline.run();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
