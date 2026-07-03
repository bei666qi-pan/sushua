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
          <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
            <Link href="/" className="group flex items-center gap-2">
              <Image
                src="/logo.png"
                alt="速刷"
                width={28}
                height={28}
                className="rounded-lg transition-transform group-hover:-rotate-6"
                priority
              />
              <span className="font-display text-xl font-bold tracking-wide">速刷</span>
              <span className="hidden text-xs text-ink-faint sm:inline">期末题库 · 上传即刷</span>
            </Link>
            <nav className="flex items-center gap-1.5 sm:gap-3">
              <Link
                href="/b/demo"
                className="hidden rounded-lg px-3 py-1.5 text-sm text-ink-soft transition-colors hover:bg-pine-soft hover:text-pine sm:inline-block"
              >
                示例题库
              </Link>
              <a
                href="https://github.com/bei666qi-pan/sushua"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="GitHub 仓库"
                title="GitHub 开源仓库"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-soft transition-colors hover:bg-pine-soft hover:text-pine"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="h-[18px] w-[18px]" aria-hidden>
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
                </svg>
              </a>
              <Link
                href="/upload"
                className="rounded-lg bg-pine px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-pine-deep"
              >
                上传题库
              </Link>
            </nav>
          </div>
        </header>
        <main className="flex-1">{children}</main>
        <footer className="border-t border-line py-8">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div className="flex items-center gap-2 text-sm text-ink-soft">
              <span className="font-display font-bold text-ink">速刷</span>
              <span className="text-ink-faint">—</span>
              <span>把题库文件,变成能刷的题</span>
            </div>
            <nav className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-faint">
              <Link href="/upload" className="transition-colors hover:text-pine">
                上传题库
              </Link>
              <Link href="/b/demo" className="transition-colors hover:text-pine">
                示例题库
              </Link>
              <a
                href="https://github.com/bei666qi-pan/sushua"
                target="_blank"
                rel="noopener noreferrer"
                className="transition-colors hover:text-pine"
              >
                GitHub 开源
              </a>
              <span>数据仅用于刷题,请勿上传涉密内容</span>
            </nav>
          </div>
        </footer>
      </body>
    </html>
  );
}
