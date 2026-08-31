import type { SendMailOptions } from "nodemailer";

type MailTransport = {
  sendMail(message: SendMailOptions): Promise<unknown>;
};

type OTPMessage = {
  email: string;
  otp: string;
  type: "sign-in" | "email-verification" | "forget-password" | "change-email";
};

export function createOTPEmailDelivery(input: { from: string; transport: MailTransport }) {
  return async (message: OTPMessage) => {
    if (message.type !== "sign-in") throw new Error(`unsupported_otp_type:${message.type}`);
    await input.transport.sendMail({
      from: input.from,
      to: message.email,
      subject: "速刷登录验证码",
      text: `你的速刷登录验证码是 ${message.otp}。验证码 5 分钟内有效，请勿转发给他人。`,
      html: [
        '<div style="font-family:system-ui,-apple-system,sans-serif;color:#17352b;line-height:1.6">',
        "<h1 style=\"font-size:20px\">速刷登录验证码</h1>",
        `<p style="font-size:30px;font-weight:700;letter-spacing:6px">${message.otp}</p>`,
        "<p>验证码 5 分钟内有效，请勿转发给他人。</p>",
        "</div>",
      ].join(""),
    });
  };
}
