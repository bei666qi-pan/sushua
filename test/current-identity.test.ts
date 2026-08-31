import assert from "node:assert/strict";
import { createCurrentIdentityResolver } from "../src/features/auth/current-identity";

async function main() {
  console.log("当前学习身份解析");
  let guestCalls = 0;
  const authenticated = createCurrentIdentityResolver({
    readUser: async () => ({ id: "user-1" }),
    learners: { forUser: async (userId: string) => `learner-for-${userId}` },
    guests: {
      ensure: async () => {
        guestCalls += 1;
        return { learnerId: "guest", cookieValue: "secret" };
      },
      serializeCookie: () => "should-not-be-used",
    },
  });
  const authIdentity = await authenticated.resolve(new Request("https://sushua.test/api/v1/workspaces"));
  assert.deepEqual(authIdentity, { learnerId: "learner-for-user-1", userId: "user-1", kind: "user" });
  assert.equal(guestCalls, 0);
  console.log("  ✓ 登录会话优先映射稳定 Learner，不创建游客身份");

  let receivedCookie: string | undefined;
  const guest = createCurrentIdentityResolver({
    readUser: async () => null,
    learners: { forUser: async () => { throw new Error("unexpected_user_resolution"); } },
    guests: {
      ensure: async (cookieValue?: string) => {
        receivedCookie = cookieValue;
        return { learnerId: "guest-learner", cookieValue: "signed-capability" };
      },
      serializeCookie: (value: string, input: { secure: boolean }) =>
        `sushua.guest=${value}; HttpOnly${input.secure ? "; Secure" : ""}`,
    },
  });
  const guestIdentity = await guest.resolve(new Request("https://sushua.test/api/v1/workspaces", {
    headers: { cookie: "other=value; sushua.guest=existing-capability" },
  }));
  assert.equal(receivedCookie, "existing-capability");
  assert.deepEqual(guestIdentity, {
    learnerId: "guest-learner",
    kind: "guest",
    setCookie: "sushua.guest=signed-capability; HttpOnly; Secure",
  });
  console.log("  ✓ 未登录请求复用签名游客 Cookie，并返回待写入的安全 Cookie");
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
