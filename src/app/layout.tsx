import type { Metadata, Viewport } from "next";
import Image from "next/image";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "速刷 — 期末题库,上传即刷",
  description: "上传 PDF / Word / TXT 题库,自动切题。速刷判分、速记背题、错题重刷,配 AI 解析。",
  // favicon.ico / icon.png / apple-icon.png 用 Next.js App Router 文件约定,自动生成
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f7f5f0",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen flex flex-col">
        <header className="sticky top-0 z-40 border-b border-line bg-paper/90 backdrop-blur">
          <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-4 sm:px-6">
            <Link href="/" className="flex items-center gap-2">
              <Image src="/logo.png" alt="速刷" width={28} height={28} className="rounded-lg" priority />
              <span className="font-display text-xl font-bold tracking-wide">速刷</span>
              <span className="hidden text-xs text-ink-faint sm:inline">期末题库 · 上传即刷</span>
            </Link>
            <Link
              href="/upload"
              className="rounded-lg bg-pine px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-pine-deep"
            >
              上传题库
            </Link>
          </div>
        </header>
        <main className="flex-1">{children}</main>
        <footer className="border-t border-line py-6">
          <div className="mx-auto w-full max-w-5xl px-4 text-xs text-ink-faint sm:px-6">
            速刷 · 数据仅用于刷题,请勿上传涉密内容
          </div>
        </footer>
      </body>
    </html>
  );
}
