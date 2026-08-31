import assert from "node:assert/strict";
import { safeReturnPath } from "../src/features/auth/return-path";

console.log("登录返回路径");
assert.equal(safeReturnPath("/workspaces"), "/workspaces");
assert.equal(safeReturnPath("/workspaces?claim=1"), "/workspaces?claim=1");
assert.equal(safeReturnPath("https://evil.example"), "/");
assert.equal(safeReturnPath("//evil.example/path"), "/");
assert.equal(safeReturnPath("javascript:alert(1)"), "/");
assert.equal(safeReturnPath("/login?next=/login"), "/");
assert.equal(safeReturnPath(null), "/");
console.log("  ✓ 仅允许站内绝对路径，拒绝外站与登录循环\n\n全部通过 ✓");
