import { createConnection, type Socket } from "node:net";

const INSTREAM_COMMAND = Buffer.from("zINSTREAM\0");
const TERMINATOR = Buffer.alloc(4);
const MAX_CHUNK_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 4096;
const MAX_SCAN_BYTES = 200 * 1024 * 1024;

export type ClamAvScanResult =
  | { status: "clean" }
  | { status: "infected"; signature: string };

export interface ClamAvAdapter {
  scan(
    source: AsyncIterable<Uint8Array>,
    input: { maxBytes: number; signal?: AbortSignal },
  ): Promise<ClamAvScanResult>;
}

export class ClamAvAdapterError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable: boolean) {
    super(code);
    this.name = "ClamAvAdapterError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function createClamAvAdapter(input: {
  host: string;
  port: number;
  timeoutMs?: number;
}): ClamAvAdapter {
  if (!validHost(input.host)) throw new Error("invalid_clamav_host");
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new Error("invalid_clamav_port");
  }
  const timeoutMs = input.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) {
    throw new Error("invalid_clamav_timeout");
  }

  return {
    async scan(source, options) {
      if (!Number.isSafeInteger(options.maxBytes)
        || options.maxBytes < 1
        || options.maxBytes > MAX_SCAN_BYTES) {
        throw new Error("invalid_clamav_scan_size");
      }
      const socket = createConnection({ host: input.host, port: input.port });
      socket.setTimeout(timeoutMs, () => socket.destroy(new Error("clamav_timeout")));
      let response: Promise<Buffer> | undefined;
      try {
        await waitForConnect(socket, options.signal);
        response = readResponse(socket, options.signal);
        await write(socket, INSTREAM_COMMAND, options.signal);
        let total = 0;
        for await (const rawChunk of source) {
          if (!(rawChunk instanceof Uint8Array)) throw new ClamAvAdapterError("clamav_stream_error", true);
          if (rawChunk.byteLength === 0) continue;
          if (total + rawChunk.byteLength > options.maxBytes) {
            throw new ClamAvAdapterError("clamav_size_limit", false);
          }
          total += rawChunk.byteLength;
          for (let offset = 0; offset < rawChunk.byteLength; offset += MAX_CHUNK_BYTES) {
            const chunk = rawChunk.subarray(offset, Math.min(offset + MAX_CHUNK_BYTES, rawChunk.byteLength));
            const header = Buffer.allocUnsafe(4);
            header.writeUInt32BE(chunk.byteLength);
            await write(socket, header, options.signal);
            await write(socket, chunk, options.signal);
          }
        }
        await write(socket, TERMINATOR, options.signal);
        return parseResponse(await response);
      } catch (error) {
        socket.destroy();
        await response?.catch(() => undefined);
        if (error instanceof ClamAvAdapterError) throw error;
        throw new ClamAvAdapterError("clamav_unavailable", true);
      } finally {
        socket.destroy();
      }
    },
  };
}

function waitForConnect(socket: Socket, signal?: AbortSignal) {
  if (signal?.aborted) throw new ClamAvAdapterError("clamav_aborted", true);
  return new Promise<void>((resolve, reject) => {
    const connected = () => {
      cleanup();
      resolve();
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const aborted = () => {
      cleanup();
      reject(new ClamAvAdapterError("clamav_aborted", true));
    };
    const cleanup = () => {
      socket.off("connect", connected);
      socket.off("error", failed);
      signal?.removeEventListener("abort", aborted);
    };
    socket.once("connect", connected);
    socket.once("error", failed);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function readResponse(socket: Socket, signal?: AbortSignal) {
  return new Promise<Buffer>((resolve, reject) => {
    let response = Buffer.alloc(0);
    const received = (chunk: Buffer) => {
      response = Buffer.concat([response, chunk]);
      if (response.length > MAX_RESPONSE_BYTES) {
        finish(new ClamAvAdapterError("clamav_protocol_error", false));
        return;
      }
      const terminator = response.indexOf(0);
      if (terminator >= 0) {
        if (terminator !== response.length - 1) {
          finish(new ClamAvAdapterError("clamav_protocol_error", false));
          return;
        }
        finish(undefined, response.subarray(0, terminator));
      }
    };
    const failed = (error: Error) => finish(error);
    const closed = () => finish(new Error("clamav_closed"));
    const aborted = () => finish(new ClamAvAdapterError("clamav_aborted", true));
    const cleanup = () => {
      socket.off("data", received);
      socket.off("error", failed);
      socket.off("close", closed);
      signal?.removeEventListener("abort", aborted);
    };
    const finish = (error?: Error, value?: Buffer) => {
      cleanup();
      if (error) reject(error);
      else resolve(value ?? Buffer.alloc(0));
    };
    socket.on("data", received);
    socket.once("error", failed);
    socket.once("close", closed);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function write(socket: Socket, value: Uint8Array, signal?: AbortSignal) {
  if (signal?.aborted) throw new ClamAvAdapterError("clamav_aborted", true);
  return new Promise<void>((resolve, reject) => {
    const aborted = () => {
      cleanup();
      reject(new ClamAvAdapterError("clamav_aborted", true));
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("error", failed);
      signal?.removeEventListener("abort", aborted);
    };
    socket.once("error", failed);
    signal?.addEventListener("abort", aborted, { once: true });
    socket.write(value, (error) => {
      cleanup();
      if (error) reject(error);
      else resolve();
    });
  });
}

function parseResponse(value: Buffer): ClamAvScanResult {
  const text = value.toString("utf8");
  if (text === "stream: OK") return { status: "clean" };
  const infected = /^stream: ([\x20-\x7e]{1,200}) FOUND$/.exec(text);
  if (infected?.[1]) return { status: "infected", signature: infected[1] };
  if (/^stream: [\x20-\x7e]{1,400} ERROR$/.test(text)) {
    throw new ClamAvAdapterError("clamav_scan_error", true);
  }
  throw new ClamAvAdapterError("clamav_protocol_error", false);
}

function validHost(value: string) {
  return value.length >= 1
    && value.length <= 253
    && /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value);
}
