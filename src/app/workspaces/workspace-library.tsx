"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  WorkspaceApiError,
  createWorkspaceClient,
  type WorkspaceListItem,
} from "@/features/workspace/client";
import { claimReturnPath } from "@/features/workspace/navigation";

const client = createWorkspaceClient();
const visibilityLabels = { private: "仅自己", link: "持链接可见", public: "公开" } as const;

export function WorkspaceLibrary({ pendingClaimId }: { pendingClaimId?: string }) {
  const [items, setItems] = useState<WorkspaceListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [title, setTitle] = useState("");
  const [visibility, setVisibility] = useState<WorkspaceListItem["visibility"]>("private");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [claimingId, setClaimingId] = useState<string>();
  const createKey = useRef("");
  const claimKeys = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setItems(await client.list());
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!event.currentTarget.checkValidity()) {
      event.currentTarget.reportValidity();
      return;
    }
    setPending(true);
    setError("");
    setNotice("");
    createKey.current ||= crypto.randomUUID();
    try {
      const workspace = await client.create({ title, visibility }, createKey.current);
      setItems((current) => current.some((item) => item.id === workspace.id) ? current : [workspace, ...current]);
      setTitle("");
      createKey.current = "";
      setNotice("资料库已建立。下一阶段接入文件上传后，可把资料直接放进这里。");
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setPending(false);
    }
  }

  async function claim(workspaceId: string) {
    setClaimingId(workspaceId);
    setError("");
    setNotice("");
    const key = claimKeys.current.get(workspaceId) ?? crypto.randomUUID();
    claimKeys.current.set(workspaceId, key);
    try {
      const result = await client.claim(workspaceId, key);
      claimKeys.current.delete(workspaceId);
      setNotice(result.status === "already_claimed" ? "这份资料已经属于当前账号。" : "认领成功，学习身份与资料记录保持不变。");
      if (pendingClaimId === workspaceId) window.history.replaceState(null, "", "/workspaces");
      await load();
    } catch (caught) {
      if (caught instanceof WorkspaceApiError && caught.code === "authentication_required") {
        window.location.assign(`/login?next=${encodeURIComponent(claimReturnPath(workspaceId))}`);
        return;
      }
      setError(messageFor(caught));
    } finally {
      setClaimingId(undefined);
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
      <section className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
        <div>
          <span className="inline-flex rounded-full bg-pine-soft px-3 py-1 text-xs font-medium text-pine">个人学习空间</span>
          <h1 className="mt-4 font-display text-3xl font-bold sm:text-4xl">我的资料库</h1>
          <p className="mt-3 max-w-2xl leading-relaxed text-ink-soft">
            题目、资料和后续生成的讲解都会归在同一个资料库里。未登录资料会从最后活动时间起保留 30 天，登录后可认领并跨设备同步。
          </p>
          <div className="mt-5 flex flex-wrap gap-3 text-sm">
            <Link href="/login?next=/workspaces" className="inline-flex min-h-10 items-center font-medium text-pine hover:underline">登录或切换账号</Link>
            <span className="text-ink-faint">认领不会改写已有学习身份</span>
          </div>
        </div>

        <form onSubmit={create} className="rounded-2xl border border-line bg-card p-5 shadow-card" aria-busy={pending}>
          <h2 className="font-display text-xl font-bold">新建资料库</h2>
          <label htmlFor="workspace-title" className="mt-4 block text-sm font-medium">名称</label>
          <input
            id="workspace-title"
            required
            maxLength={80}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="例如：高等数学期末复习"
            className="mt-2 w-full rounded-xl border border-line-strong bg-card px-3.5 py-2.5 outline-none transition focus:border-pine focus:ring-2 focus:ring-pine/15"
          />
          <label htmlFor="workspace-visibility" className="mt-4 block text-sm font-medium">可见性</label>
          <select
            id="workspace-visibility"
            value={visibility}
            onChange={(event) => setVisibility(event.target.value as WorkspaceListItem["visibility"])}
            className="mt-2 w-full rounded-xl border border-line-strong bg-card px-3.5 py-2.5 outline-none focus:border-pine focus:ring-2 focus:ring-pine/15"
          >
            <option value="private">仅自己</option>
            <option value="link">持链接可见</option>
            <option value="public">公开</option>
          </select>
          <button disabled={pending || !title.trim()} className="mt-5 w-full rounded-xl bg-pine px-4 py-2.5 font-medium text-white transition hover:bg-pine-deep disabled:cursor-not-allowed disabled:opacity-50">
            {pending ? "正在建立…" : "建立资料库"}
          </button>
        </form>
      </section>

      {pendingClaimId && (
        <section className="mt-7 flex flex-col gap-3 rounded-2xl border border-pine/25 bg-pine-soft px-4 py-4 sm:flex-row sm:items-center sm:justify-between" aria-labelledby="pending-claim-title">
          <div>
            <h2 id="pending-claim-title" className="font-medium text-pine-deep">登录完成，继续认领游客资料</h2>
            <p className="mt-1 text-sm text-ink-soft">确认后保持原 learner_id，不会覆盖账号中已有资料；如有冲突会先给出报告。</p>
          </div>
          <button
            type="button"
            onClick={() => void claim(pendingClaimId)}
            disabled={claimingId === pendingClaimId}
            className="min-h-11 shrink-0 rounded-xl bg-pine px-5 py-2.5 text-sm font-medium text-white transition hover:bg-pine-deep disabled:cursor-wait disabled:opacity-60"
          >
            {claimingId === pendingClaimId ? "正在认领…" : "完成认领"}
          </button>
        </section>
      )}
      {error && (
        <div role="alert" className="mt-7 flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 sm:flex-row sm:items-center sm:justify-between">
          <span>{error}</span>
          <button type="button" onClick={() => void load()} className="min-h-10 shrink-0 rounded-lg border border-red-300 px-3 py-2 font-medium hover:bg-red-100">重新读取</button>
        </div>
      )}
      {notice && <p role="status" className="mt-7 rounded-xl border border-pine/20 bg-pine-soft px-4 py-3 text-sm text-pine-deep">{notice}</p>}

      <section className="mt-10" aria-labelledby="workspace-list-title" aria-busy={loading}>
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="workspace-list-title" className="font-display text-2xl font-bold">资料库</h2>
          <span className="text-xs text-ink-faint">{loading ? "读取中…" : `${items.length} 个`}</span>
        </div>
        {loading ? (
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="正在读取资料库">
            {[0, 1, 2].map((item) => <div key={item} className="h-36 rounded-2xl border border-line bg-card motion-safe:animate-pulse" />)}
          </div>
        ) : items.length === 0 ? (
          <div className="mt-5 rounded-2xl border-2 border-dashed border-line-strong px-6 py-12 text-center">
            <p className="font-medium">这里还没有资料</p>
            <p className="mt-2 text-sm text-ink-soft">先建立一个资料库；文件上传会在异步文档阶段接入。</p>
          </div>
        ) : (
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((workspace) => (
              <article key={workspace.id} className="rounded-2xl border border-line bg-card p-5 shadow-card">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="font-display text-lg font-bold leading-snug">{workspace.title}</h3>
                  <span className="shrink-0 rounded-full bg-paper px-2.5 py-1 text-[11px] text-ink-soft">{visibilityLabels[workspace.visibility]}</span>
                </div>
                <p className="mt-3 text-sm leading-relaxed text-ink-soft">资料、题目和学习记录将在后续阶段逐步汇入此空间。</p>
                <button
                  type="button"
                  onClick={() => void claim(workspace.id)}
                  disabled={claimingId === workspace.id}
                  className="mt-4 inline-flex min-h-10 items-center rounded-lg text-sm font-medium text-pine hover:underline disabled:cursor-wait disabled:opacity-60"
                >
                  {claimingId === workspace.id ? "正在认领…" : "认领到当前账号 →"}
                </button>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function messageFor(caught: unknown) {
  return caught instanceof Error ? caught.message : "请求失败，请稍后重试";
}
