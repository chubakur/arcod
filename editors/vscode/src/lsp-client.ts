// A minimal, dependency-free LSP client over stdio (JSON-RPC). VS Code has no
// built-in LSP transport, so this speaks the wire protocol directly. The server
// is 'arcod lsp' (see ../../bin/arcod-lsp.mjs); every editor can use the same
// server, this file is only the VS Code glue.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

interface Message {
  jsonrpc: string;
  id?: number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export type NotificationHandler = (params: any) => void;

export class LspClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, NotificationHandler[]>();
  private exitHandlers: Array<(code: number | null) => void> = [];
  private stderr = '';

  get stderrLog(): string {
    return this.stderr;
  }

  start(command: string, args: string[]): void {
    this.proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    this.proc.on('exit', (code) => {
      for (const h of this.exitHandlers) h(code);
    });
    this.proc.on('error', (error) => {
      this.stderr += 'spawn error: ' + String(error) + '\n';
      for (const [, p] of this.pending) p.reject(error);
      this.pending.clear();
    });
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.proc) {
        reject(new Error('arcod lsp is not running'));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  onNotification(method: string, handler: NotificationHandler): void {
    const list = this.handlers.get(method) ?? [];
    list.push(handler);
    this.handlers.set(method, list);
  }

  onExit(handler: (code: number | null) => void): void {
    this.exitHandlers.push(handler);
  }

  dispose(): void {
    if (this.proc) {
      try {
        this.notify('shutdown');
        this.notify('exit');
      } catch {
        // ignore
      }
      this.proc.kill();
      this.proc = null;
    }
  }

  private send(message: Message): void {
    const body = JSON.stringify(message);
    this.proc?.stdin.write('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      if (this.buffer.length < headerEnd + 4 + length) break;
      const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
      this.buffer = this.buffer.subarray(headerEnd + 4 + length);
      this.handle(JSON.parse(body) as Message);
    }
  }

  private handle(message: Message): void {
    if (message.method && message.id === undefined) {
      for (const h of this.handlers.get(message.method) ?? []) h(message.params);
      return;
    }
    if (message.id !== undefined && message.id !== null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    }
  }
}
