import { notFound } from "next/navigation";
import { LoginForm } from "./login-form";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { safeReturnPath } from "@/features/auth/return-path";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (!isFeatureEnabled("guest_claim")) notFound();
  const returnPath = safeReturnPath((await searchParams).next);
  return (
    <div className="mx-auto flex min-h-[calc(100vh-12rem)] w-full max-w-md items-center px-4 py-12">
      <section className="w-full rounded-3xl border border-line bg-card p-6 shadow-card sm:p-8" aria-labelledby="login-title">
        <span className="inline-flex rounded-full bg-pine-soft px-3 py-1 text-xs font-medium text-pine">跨设备同步</span>
        <h1 id="login-title" className="mt-4 font-display text-3xl font-bold">登录速刷</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          无需密码。验证码会发送到你的邮箱；登录后可认领游客资料并在不同设备继续学习。
        </p>
        <LoginForm returnPath={returnPath} />
        <p className="mt-5 text-center text-xs leading-relaxed text-ink-faint">未登录上传的资料默认保留 30 天，登录认领后按你的删除设置处理。</p>
      </section>
    </div>
  );
}
