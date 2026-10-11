// html-to-docx ships no type declarations. Minimal ambient module so the project
// type-checks (`make build`). Node resolves the default export to a function that
// returns a Buffer; the browser build returns a Blob (unused here).
declare module "html-to-docx" {
  const HTMLtoDOCX: (
    htmlString: string,
    headerHTMLString?: string | null,
    documentOptions?: Record<string, unknown>,
    footerHTMLString?: string | null,
  ) => Promise<Buffer | ArrayBuffer>;
  export default HTMLtoDOCX;
}
