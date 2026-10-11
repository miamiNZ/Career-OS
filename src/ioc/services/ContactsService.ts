import { injectable } from "inversify";
import { syncContactsFromJobs, type ContactSyncResult } from "../../contacts.js";

/**
 * Injectable contacts service — extracts recruiter/hiring contacts from job ad text
 * into Career/Contacts/. Delegates to `contacts.ts`.
 */
@injectable()
export class ContactsService {
  syncFromJobs(): Promise<ContactSyncResult> {
    return syncContactsFromJobs();
  }
}
