"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

type Stage = "email" | "otp";

export function LoginForm() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("email");
  const [email, setEmail] = useState("");
  const [otp, setOTP] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!event.currentTarget.checkValidity()) {
      event.currentTarget.reportValidity();
      return;
    }
    setPending(true);
    setError("");
    try {
      const path = stage === "email" ? "/api/auth/email-otp/send-verification-otp" : "/api/auth/sign-in/email-otp";
      const body = stage === "email" ? { email, type: "sign-in" } : { email, otp };
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => null) as { message?: string } | null;
        throw new Error(result?.message || (stage === "email" ? "验证码发送失败，请稍后重试" : "验证码不正确或已过期"));
      }
      if (stage === "email") {
        setStage("otp");
        return;
      }
      router.replace("/");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "登录失败，请稍后重试");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-7 space-y-5" aria-busy={pending}>
      <div>
        <label htmlFor="login-email" className="mb-2 block text-sm font-medium text-ink">邮箱</label>
        <input
          id="login-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          disabled={pending || stage === "otp"}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="w-full rounded-xl border border-line-strong bg-card px-4 py-3 outline-none transition focus:border-pine focus:ring-2 focus:ring-pine/15 disabled:bg-paper"
          placeholder="name@example.com"
        />
      </div>
      {stage === "otp" && (
        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <label htmlFor="login-otp" className="text-sm font-medium text-ink">6 位验证码</label>
            <button type="button" onClick={() => { setStage("email"); setOTP(""); setError(""); }} className="text-xs text-pine hover:underline">
              更换邮箱
            </button>
          </div>
          <input
            id="login-otp"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            autoFocus
            disabled={pending}
            value={otp}
            onChange={(event) => setOTP(event.target.value.replace(/\D/g, "").slice(0, 6))}
            className="w-full rounded-xl border border-line-strong bg-card px-4 py-3 text-center font-mono text-2xl tracking-[0.35em] outline-none transition focus:border-pine focus:ring-2 focus:ring-pine/15"
          />
          <p className="mt-2 text-xs text-ink-faint">验证码已发送，5 分钟内有效，最多尝试 3 次。</p>
        </div>
      )}
      {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <button
        type="submit"
        disabled={pending || !email || (stage === "otp" && otp.length !== 6)}
        className="w-full rounded-xl bg-pine px-5 py-3 font-medium text-white transition hover:bg-pine-deep disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "处理中…" : stage === "email" ? "发送登录验证码" : "登录并同步学习记录"}
      </button>
    </form>
  );
}
