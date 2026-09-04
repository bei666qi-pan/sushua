import { getPostgresServerRuntime } from "@/db/postgres/server";
import { createQuestionReadModule } from "./question-read-module";

const globalReader = globalThis as typeof globalThis & { __sushuaQuestionReader?: ReturnType<typeof createQuestionReadModule> };

export function getQuestionReadServer() {
  if (!globalReader.__sushuaQuestionReader) globalReader.__sushuaQuestionReader = createQuestionReadModule(getPostgresServerRuntime());
  return globalReader.__sushuaQuestionReader;
}
