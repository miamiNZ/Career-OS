import { injectable } from "inversify";
import {
  convertApplicationDoc,
  convertBoth,
  type DocKind,
  type DocFormat,
  type ConvertBothResult,
} from "../../convert.js";

/**
 * Injectable document converter — turns tailored resume/cover markdown into .docx/.pdf
 * (Word COM on Windows, html-to-docx elsewhere). Delegates to `convert.ts`.
 */
@injectable()
export class ConvertService {
  convertApplicationDoc(id: string, doc: DocKind, format: DocFormat): Promise<{ file: string }> {
    return convertApplicationDoc(id, doc, format);
  }

  convertBoth(id: string, format: DocFormat = "docx"): Promise<ConvertBothResult> {
    return convertBoth(id, format);
  }
}
