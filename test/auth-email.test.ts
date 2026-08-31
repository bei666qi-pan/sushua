import assert from "node:assert/strict";
import { createOTPEmailDelivery } from "../src/features/auth/email";

async function main() {
  const messages: Array<Record<string, unknown>> = [];
  const delivery = createOTPEmailDelivery({
    from: "速刷 <login@example.test>",
    transport: {
      async sendMail(message) {
        messages.push(message as Record<string, unknown>);
        return { messageId: "test-message" };
      },
    },
  });

  console.log("邮箱 OTP 投递");
  await delivery({ email: "learner@example.com", otp: "123456", type: "sign-in" });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.from, "速刷 <login@example.test>");
  assert.equal(messages[0]?.to, "learner@example.com");
  assert.match(String(messages[0]?.subject), /登录验证码/);
  assert.match(String(messages[0]?.text), /123456/);
  assert.match(String(messages[0]?.text), /5 分钟/);
  assert.equal(String(messages[0]?.html).includes("123456"), true);
  console.log("  ✓ 收件人、用途、验证码和 5 分钟期限完整");

  await assert.rejects(
    delivery({ email: "learner@example.com", otp: "123456", type: "forget-password" }),
    /unsupported_otp_type/,
  );
  assert.equal(messages.length, 1);
  console.log("  ✓ P0 拒绝密码恢复用途");
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
