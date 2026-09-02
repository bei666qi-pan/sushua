import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

export type ContainerProbe = {
  role: string;
  name: string;
  probePath?: string;
};

type EvidenceOptions = {
  redact: (value: string) => string;
};

export function withContainerDiagnostics<T>(
  error: T,
  containers: ContainerProbe[],
  options: EvidenceOptions,
): T {
  try {
    const diagnostics = containers.map(({ role, name, probePath }) => {
      const state = spawnSync("docker", [
        "inspect", name, "--format",
        "status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} finished={{.State.FinishedAt}}",
      ], { encoding: "utf8" });
      const logs = spawnSync("docker", ["logs", "--tail", "200", name], {
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
      });
      const stateText = state.status === 0
        ? outputText(state.stdout).trim()
        : `inspect unavailable: ${describeCommandFailure(state)}`;
      const logBytes = Buffer.byteLength(
        `${outputText(logs.stdout)}${outputText(logs.stderr)}`,
        "utf8",
      );
      const logText = logs.status === 0
        ? `container logs omitted (${logBytes} bytes)`
        : `container logs unavailable: ${describeCommandFailure(logs)}`;
      let probeText = "";
      if (probePath) {
        const probe = spawnSync("docker", [
          "exec", "--env", `PROBE_PATH=${probePath}`, name, "python", "-c",
          [
            "import os, stat",
            "path = os.environ['PROBE_PATH']",
            "value = os.stat(path)",
            "print(f'readable={os.access(path, os.R_OK)} mode={stat.S_IMODE(value.st_mode):04o} uid={value.st_uid} gid={value.st_gid} size={value.st_size}')",
          ].join("; "),
        ], { encoding: "utf8" });
        probeText = probe.status === 0
          ? outputText(probe.stdout).trim()
          : `path probe unavailable: ${describeCommandFailure(probe)}`;
      }
      return [
        `${role} (${name})`,
        stateText,
        probeText,
        logText || "<no logs>",
      ].filter(Boolean).join("\n");
    });
    console.error(`Container diagnostics:\n${options.redact(diagnostics.join("\n\n"))}`);
  } catch {
    try {
      console.error("Container diagnostics unavailable");
    } catch {
      // Diagnostics must never replace the primary contract failure.
    }
  }
  return error;
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

export function describeCommandFailure(result: {
  status?: unknown;
  signal?: unknown;
  error?: unknown;
}): string {
  const error = typeof result.error === "object" && result.error !== null
    ? result.error as Record<string, unknown>
    : {};
  const rawCode = typeof error.code === "string" ? error.code : "";
  const code = /^[A-Z0-9_]{1,32}$/.test(rawCode) ? rawCode : "none";
  const status = typeof result.status === "number" && Number.isInteger(result.status)
    ? result.status
    : "unavailable";
  const rawSignal = typeof result.signal === "string" ? result.signal : "";
  const signal = /^SIG[A-Z0-9]{1,16}$/.test(rawSignal) ? rawSignal : "none";
  return [
    `exit=${status}`,
    `signal=${signal}`,
    `error=${code}`,
  ].join(" ");
}

export function reportCleanupFailures(
  failures: string[],
  primaryError: unknown,
  options: EvidenceOptions,
): void {
  if (failures.length === 0) return;
  const message = `Container cleanup failures:\n${failures.join("\n")}`;
  if (primaryError !== undefined) {
    try {
      console.error(options.redact(message));
    } catch {
      // Cleanup reporting must never replace the primary contract failure.
    }
    return;
  }
  assert.fail(options.redact(message));
}

export function formatPrimaryFailure(error: unknown): string {
  const record = typeof error === "object" && error !== null
    ? error as Record<string, unknown>
    : {};
  const stderr = outputText(record.stderr);
  const marker = stderr.match(
    /SUSHUA_HTTP_ERROR status=(\d{3}) code=([a-z0-9_.-]{1,64}) retryable=(true|false)/,
  );
  const nameCandidate = error instanceof Error ? error.name : "UnknownError";
  const name = /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(nameCandidate)
    ? nameCandidate
    : "UnknownError";
  const status = typeof record.status === "number" && Number.isInteger(record.status)
    ? record.status
    : "unavailable";
  const fields = [`name=${name}`, `exit=${status}`];
  if (marker) {
    fields.push(
      `http_status=${marker[1]}`,
      `error_code=${marker[2]}`,
      `retryable=${marker[3]}`,
    );
  }
  return `Container contract failed: ${fields.join(" ")}`;
}
