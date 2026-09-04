import assert from "node:assert/strict";

async function main() {
  const previous = new Map<string, string | undefined>();
  for (const name of ["FEATURE_GROUNDED_GENERATION", "DATABASE_URL", "GUEST_SESSION_SECRET"]) {
    previous.set(name, process.env[name]);
    delete process.env[name];
  }
  try {
    const workspaceRoute = await import("../src/app/api/v1/workspaces/[id]/questions/route").catch(() => null);
    const sourceRoute = await import("../src/app/api/v1/question-versions/[id]/sources/route").catch(() => null);
    assert.ok(workspaceRoute, "Workspace question route must exist");
    assert.ok(sourceRoute, "Question-version source route must exist");

    const listed = await workspaceRoute.GET(
      new Request("https://sushua.test/api/v1/workspaces/ignored/questions"),
      { params: Promise.resolve({ id: "ignored" }) },
    );
    assert.equal(listed.status, 404);
    assert.equal((await listed.json()).error.code, "not_found");

    const sources = await sourceRoute.GET(
      new Request("https://sushua.test/api/v1/question-versions/ignored/sources"),
      { params: Promise.resolve({ id: "ignored" }) },
    );
    assert.equal(sources.status, 404);
    assert.equal((await sources.json()).error.code, "not_found");
    console.log("Question read v1 routes\n  ✓ Flag 默认关闭时不初始化 Auth/Postgres 即返回 404\n\n全部通过 ✓");
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
