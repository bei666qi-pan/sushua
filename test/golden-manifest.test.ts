import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateGoldenManifest } from "./golden/harness";

let failed = 0;

function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  ✓ ${name}`);
    return;
  }

  failed += 1;
  console.error(`  ✗ ${name} ${detail}`);
}

const manifestPath = resolve(process.cwd(), "test/golden/manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
const validation = validateGoldenManifest(manifest);

console.log("Golden Corpus manifest");
assert("清单结构合法", validation.ok, validation.errors.join("; "));

if (validation.ok) {
  assert("Schema 版本固定为 v1", validation.value.schema_version === "sushua.golden-corpus.v1");
  assert("Corpus 版本使用语义化版本", /^\d+\.\d+\.\d+$/.test(validation.value.corpus_version));
  assert(
    "空跑骨架不包含真实用户资料",
    validation.value.samples.length === 0,
    `got ${validation.value.samples.length} samples`,
  );
}

if (failed > 0) {
  console.error(`\n${failed} 项断言失败`);
  process.exit(1);
}

console.log("\n全部通过 ✓");
