"use client";

import React from "react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createSourceReviewClient,
  SourceReviewApiError,
  type SourceReviewBlock,
  type SourceReviewLocation,
  type SourceReviewPage,
} from "./source-review-client";

const client = createSourceReviewClient();
const LOW_CONFIDENCE_THRESHOLD = 0.8;

export function SourceReviewPanel({ documentVersionId }: { documentVersionId: string }) {
  const [pages, setPages] = useState<SourceReviewPage[]>([]);
  const [selectedPageId, setSelectedPageId] = useState<string>();
  const [blocks, setBlocks] = useState<SourceReviewBlock[]>([]);
  const [selectedSource, setSelectedSource] = useState<SourceReviewLocation>();
  const [pagesLoading, setPagesLoading] = useState(true);
  const [blocksLoading, setBlocksLoading] = useState(false);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [mobilePreviewOpen, setMobilePreviewOpen] = useState(false);
  const [showLowConfidence, setShowLowConfidence] = useState(false);
  const [error, setError] = useState("");

  const loadPages = useCallback(async () => {
    setPagesLoading(true);
    setError("");
    try {
      const result = await client.listPages(documentVersionId);
      setPages(result.items);
      setSelectedPageId((current) => current && result.items.some((page) => page.id === current) ? current : result.items[0]?.id);
    } catch (caught) {
      setError(messageFor(caught));
      setPages([]);
      setSelectedPageId(undefined);
    } finally {
      setPagesLoading(false);
    }
  }, [documentVersionId]);

  const loadBlocks = useCallback(async (pageId: string) => {
    setBlocksLoading(true);
    setError("");
    try {
      const result = await client.listBlocks(pageId);
      setBlocks(result.items);
    } catch (caught) {
      setError(messageFor(caught));
      setBlocks([]);
    } finally {
      setBlocksLoading(false);
    }
  }, []);

  useEffect(() => { void loadPages(); }, [loadPages]);

  useEffect(() => {
    if (!selectedPageId) {
      setBlocks([]);
      return;
    }
    setSelectedSource(undefined);
    void loadBlocks(selectedPageId);
  }, [loadBlocks, selectedPageId]);

  const selectedPage = pages.find((page) => page.id === selectedPageId);
  const visibleBlocks = useMemo(
    () => showLowConfidence ? blocks.filter((block) => block.confidence < LOW_CONFIDENCE_THRESHOLD) : blocks,
    [blocks, showLowConfidence],
  );

  async function selectBlock(block: SourceReviewBlock) {
    setSourceLoading(true);
    setError("");
    try {
      setSelectedSource(await client.getBlockSource(block.id));
      setMobilePreviewOpen(true);
    } catch (caught) {
      setSelectedSource(undefined);
      setError(messageFor(caught));
    } finally {
      setSourceLoading(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 sm:py-10">
      <header className="max-w-3xl">
        <span className="inline-flex rounded-full bg-pine-soft px-3 py-1 text-xs font-medium text-pine">人工复核</span>
        <h1 className="mt-4 font-display text-3xl font-bold sm:text-4xl">原文核对</h1>
        <p className="mt-3 leading-relaxed text-ink-soft">点击内容块后，会显示原件页码、引用和临时预览链接。低置信内容需要人工确认，系统不会把它悄悄当作可靠资料。</p>
        <Link href="/workspaces" className="mt-4 inline-flex min-h-10 items-center text-sm font-medium text-pine hover:underline">← 返回资料库</Link>
      </header>

      {error && (
        <div role="alert" className="mt-6 flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 sm:flex-row sm:items-center sm:justify-between">
          <span>{error}</span>
          <button type="button" onClick={() => void loadPages()} className="min-h-10 shrink-0 rounded-lg border border-red-300 px-3 py-2 font-medium hover:bg-red-100">重新读取</button>
        </div>
      )}

      <section className="mt-7 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.85fr)]" aria-label="来源核对工作区">
        <div className="hidden lg:block"><SourcePreview location={selectedSource} loading={sourceLoading} /></div>

        <section className="rounded-2xl border border-line bg-card shadow-card" aria-busy={pagesLoading || blocksLoading}>
          <div className="border-b border-line px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-xl font-bold">结构化内容</h2>
                <p className="mt-1 text-sm text-ink-soft">
                  {pagesLoading ? "正在读取资料页面…" : selectedPage ? `第 ${selectedPage.pageNumber} 页 · ${visibleBlocks.length} 个可见内容块` : "没有可核对的资料页面"}
                </p>
              </div>
              <label className="inline-flex min-h-10 items-center gap-2 text-sm text-ink-soft">
                <input
                  type="checkbox"
                  checked={showLowConfidence}
                  onChange={(event) => setShowLowConfidence(event.target.checked)}
                  className="h-4 w-4 rounded border-line-strong text-pine focus:ring-pine"
                />
                仅看低置信内容
              </label>
            </div>

            {!pagesLoading && pages.length > 0 && (
              <nav className="mt-4 flex gap-2 overflow-x-auto pb-1" aria-label="选择资料页">
                {pages.map((page) => (
                  <button
                    key={page.id}
                    type="button"
                    aria-current={page.id === selectedPageId ? "page" : undefined}
                    onClick={() => setSelectedPageId(page.id)}
                    className={`min-h-10 shrink-0 rounded-lg border px-3 text-sm font-medium transition ${page.id === selectedPageId ? "border-pine bg-pine text-white" : "border-line bg-paper text-ink-soft hover:border-pine/40 hover:text-pine"}`}
                  >
                    第 {page.pageNumber} 页
                  </button>
                ))}
              </nav>
            )}

            {selectedSource && (
              <button
                type="button"
                onClick={() => setMobilePreviewOpen(true)}
                className="mt-4 inline-flex min-h-10 items-center rounded-lg border border-pine/35 bg-pine-soft px-3 text-sm font-medium text-pine lg:hidden"
              >
                查看原文第 {selectedSource.page.pageNumber} 页
              </button>
            )}
          </div>

          <div className="max-h-[42rem] overflow-y-auto p-3 sm:p-4">
            {pagesLoading || blocksLoading ? (
              <div className="grid gap-3" aria-label="正在读取内容块">
                {[0, 1, 2].map((item) => <div key={item} className="h-24 rounded-xl border border-line bg-paper motion-safe:animate-pulse" />)}
              </div>
            ) : visibleBlocks.length === 0 ? (
              <p className="rounded-xl border-2 border-dashed border-line-strong px-4 py-10 text-center text-sm text-ink-soft">
                {showLowConfidence ? "这一页没有低置信内容。" : "这一页没有可展示的内容块。"}
              </p>
            ) : (
              <ol className="grid gap-3" aria-label="内容块列表">
                {visibleBlocks.map((block) => <BlockButton key={block.id} block={block} selected={selectedSource?.block.id === block.id} onSelect={selectBlock} />)}
              </ol>
            )}
          </div>
        </section>
      </section>
      <MobileSourceDrawer open={mobilePreviewOpen} location={selectedSource} onClose={() => setMobilePreviewOpen(false)} />
    </div>
  );
}

export function MobileSourceDrawer({ open, location, onClose }: { open: boolean; location?: SourceReviewLocation; onClose(): void }) {
  if (!open || !location) return null;
  const previewUrl = sourceUrlForPage(location.sourceUrl, location.page.pageNumber);
  return (
    <div id="source-preview-drawer" role="dialog" aria-modal="true" aria-label={`原文第 ${location.page.pageNumber} 页预览`} className="fixed inset-0 z-50 flex flex-col bg-paper lg:hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <p className="text-xs font-medium text-pine">资料内依据</p>
          <h2 className="font-display text-lg font-bold">第 {location.page.pageNumber} 页原文</h2>
        </div>
        <button type="button" onClick={onClose} className="min-h-10 rounded-lg border border-line-strong px-3 text-sm font-medium text-ink-soft hover:border-pine hover:text-pine">关闭</button>
      </div>
      <p className="border-b border-line px-4 py-3 text-sm leading-relaxed text-ink-soft">{location.sourceQuote || "此内容块没有可展示的文字摘录。"}</p>
      <iframe src={previewUrl} title={`原文第 ${location.page.pageNumber} 页预览`} sandbox="" referrerPolicy="no-referrer" className="min-h-0 flex-1 bg-card" />
      <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
        <span className="text-xs text-ink-faint">坐标：{formatBbox(location.block.bbox)}</span>
        <a href={previewUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center rounded-lg bg-pine px-3 text-sm font-medium text-white hover:bg-pine-deep">打开原件</a>
      </div>
    </div>
  );
}

function SourcePreview({ location, loading }: { location?: SourceReviewLocation; loading: boolean }) {
  if (loading) {
    return <section className="min-h-[30rem] rounded-2xl border border-line bg-card p-5 shadow-card" aria-busy="true" aria-label="正在定位原文"><p className="text-sm text-ink-soft">正在定位原文…</p></section>;
  }
  if (!location) {
    return (
      <section className="flex min-h-[30rem] flex-col justify-center rounded-2xl border border-dashed border-line-strong bg-paper px-7 py-10 text-center" aria-label="原文预览">
        <h2 className="font-display text-xl font-bold">原文预览</h2>
        <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-ink-soft">从右侧选择内容块，系统会按其来源记录定位页码。原文件会通过短时链接打开，不会公开固定地址。</p>
      </section>
    );
  }
  const previewUrl = sourceUrlForPage(location.sourceUrl, location.page.pageNumber);
  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-card shadow-card" aria-label="原文预览">
      <div className="border-b border-line px-5 py-4">
        <p className="text-xs font-medium text-pine">资料内依据</p>
        <h2 className="mt-1 font-display text-xl font-bold">第 {location.page.pageNumber} 页</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">{location.sourceQuote || "此内容块没有可展示的文字摘录。"}</p>
      </div>
      <iframe
        src={previewUrl}
        title={`原文第 ${location.page.pageNumber} 页预览`}
        sandbox=""
        referrerPolicy="no-referrer"
        className="h-[28rem] w-full bg-paper"
      />
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <span className="text-xs text-ink-faint">坐标：{formatBbox(location.block.bbox)}</span>
        <a href={previewUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center rounded-lg bg-pine px-3 text-sm font-medium text-white hover:bg-pine-deep">打开原件</a>
      </div>
    </section>
  );
}

function BlockButton({ block, selected, onSelect }: { block: SourceReviewBlock; selected: boolean; onSelect(block: SourceReviewBlock): void }) {
  const text = block.text ?? block.markdown ?? "未识别文字内容";
  return (
    <li style={{ contentVisibility: "auto" }}>
      <button
        type="button"
        aria-pressed={selected}
        onClick={() => onSelect(block)}
        className={`w-full rounded-xl border p-4 text-left transition focus:outline-none focus:ring-2 focus:ring-pine/30 ${selected ? "border-pine bg-pine-soft" : "border-line bg-paper hover:border-pine/40"}`}
      >
        <span className="flex items-center justify-between gap-3 text-xs">
          <span className="rounded-full bg-card px-2 py-1 font-medium text-ink-soft">{block.blockType}</span>
          <span className={block.confidence < LOW_CONFIDENCE_THRESHOLD ? "font-medium text-amber-700" : "text-ink-faint"}>置信度 {Math.round(block.confidence * 100)}%</span>
        </span>
        <span className="mt-3 block whitespace-pre-wrap text-sm leading-relaxed text-ink">{text}</span>
      </button>
    </li>
  );
}

function messageFor(caught: unknown) {
  return caught instanceof SourceReviewApiError ? caught.message : "来源读取失败，请稍后重试";
}

export function sourceUrlForPage(sourceUrl: string, pageNumber: number): string {
  const url = new URL(sourceUrl);
  url.hash = `page=${pageNumber}`;
  return url.toString();
}

function formatBbox([x, y, width, height]: [number, number, number, number]) {
  return `${Math.round(x * 100)}%, ${Math.round(y * 100)}%, ${Math.round(width * 100)}% × ${Math.round(height * 100)}%`;
}
