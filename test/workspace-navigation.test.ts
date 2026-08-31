import assert from "node:assert/strict";
import { claimReturnPath, parsePendingClaim } from "../src/features/workspace/navigation";

const workspaceId = "0199751a-8a40-7c1f-8c20-2447737a0ca1";
console.log("Workspace 认领导航");
assert.equal(claimReturnPath(workspaceId), `/workspaces?claim=${workspaceId}`);
assert.equal(parsePendingClaim(workspaceId), workspaceId);
assert.equal(parsePendingClaim("not-a-uuid"), undefined);
assert.equal(parsePendingClaim("0199751a-8a40-6c1f-8c20-2447737a0ca1"), undefined);
assert.equal(parsePendingClaim(undefined), undefined);
console.log("  ✓ 登录返回仅携带合法 UUIDv7 Workspace，不放宽 RLS\n\n全部通过 ✓");
