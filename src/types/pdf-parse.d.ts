declare module "pdf-parse/lib/pdf-parse.js" {
  interface PdfParseResult {
    text: string;
    numpages: number;
    info: unknown;
  }
  const pdfParse: (buf: Buffer, options?: Record<string, unknown>) => Promise<PdfParseResult>;
  export default pdfParse;
}
