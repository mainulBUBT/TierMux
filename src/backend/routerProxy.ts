import * as http from 'http';
import type { Router, RouteOptions } from '../router/router';
import type { Catalog } from '../catalog/catalog';
import type { SettingsStore } from '../config/settingsStore';
import type { SecretStore } from '../config/secrets';
import type { ChatMessage, ChatToolDefinition, ChatToolChoice } from '../shared/types';

export interface ProxyRequest {
  messages: ChatMessage[];
  model?: string;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  reasoning_effort?: string;
  tools?: ChatToolDefinition[];
  tool_choice?: ChatToolChoice;
  parallel_tool_calls?: boolean;
}

export interface ProxyResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message?: { role: string; content?: string };
    delta?: { role?: string; content?: string };
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export class RouterProxy {
  private server: http.Server = null!;
  private port = 0;

  constructor(
    private router: Router,
    private catalog: Catalog,
    private settings: SettingsStore,
    _secrets: SecretStore,
  ) {}

  async start(): Promise<number> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        this.handle(req, res);
      });
      this.server.listen(0, '127.0.0.1', () => {
        this.port = (this.server.address() as import('net').AddressInfo).port;
        resolve(this.port);
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) { resolve(); return; }
      this.server.close(() => resolve());
    });
  }

  get portNumber(): number { return this.port; }

  get baseUrl(): string { return `http://127.0.0.1:${this.port}`; }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;

    if (req.method === 'GET' && path === '/v1/models') {
      return this.handleModels(req, res);
    }

    if (req.method === 'POST' && path === '/v1/chat/completions') {
      void this.handleChat(req, res);
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not_found', message: `No route: ${req.method} ${path}` }));
  }

  private handleModels(_req: http.IncomingMessage, res: http.ServerResponse): void {
    const enabled = new Set(
      this.settings.enabledByPriority()
        .filter((e) => e.enabled)
        .map((e) => `${e.platform}::${e.modelId}`),
    );

    const tiermuxAuto = {
      id: '__tiermux__/auto',
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'tiermux',
    };

    const models = this.catalog.all()
      .filter((m) => enabled.has(`${m.platform}::${m.modelId}`))
      .map((m) => ({
        id: `${m.platform}/${m.modelId}`,
        object: 'model',
        created: Math.floor(new Date(m.released || '2024-01-01').getTime() / 1000),
        owned_by: m.platform,
      }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [tiermuxAuto, ...models] }));
  }

  /** Trim tool/assistant content in historical messages to cap token explosion.
   *  OC accumulates every tool result in the history; large file reads (10k+ chars each)
   *  push 128k-context models past their limit after ~30 tool calls.
   *  We keep recent messages untouched and truncate only older ones. */
  private trimHistory(messages: ChatMessage[]): ChatMessage[] {
    const KEEP_TAIL = 6;        // last N messages always kept verbatim
    const MAX_CHARS = 3000;     // older tool/assistant content cap
    if (messages.length <= KEEP_TAIL) return messages;
    return messages.map((m, i) => {
      if (i >= messages.length - KEEP_TAIL) return m;
      if (m.role !== 'tool' && m.role !== 'assistant') return m;
      const content = typeof m.content === 'string' ? m.content : '';
      if (content.length <= MAX_CHARS) return m;
      return { ...m, content: content.slice(0, MAX_CHARS) + `\n…[truncated ${content.length - MAX_CHARS} chars]` };
    });
  }

  private async handleChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const proxyReq: ProxyRequest = JSON.parse(body);
    const { stream, temperature, model: requestedModel, reasoning_effort: bodyEffort,
            tools, tool_choice, parallel_tool_calls, max_tokens } = proxyReq;
    const messages = this.trimHistory(proxyReq.messages);
    const useStream = stream !== false;

    // Decode model name → reasoning effort. OpenCode sends the model variant as configured
    // in the provider config (tiermux-auto / tiermux-high / tiermux-low / tiermux-off).
    const TEMP: Record<string, number> = { off: 0.7, low: 0.5, medium: 0.1, high: 0.0 };
    const modelMatch = (requestedModel ?? '').match(/^tiermux-(auto|off|low|medium|high)$/) as [string, string] | null;
    const effortFromModel = modelMatch?.[1] as 'auto' | 'off' | 'low' | 'medium' | 'high' | undefined;
    const effort = bodyEffort ?? effortFromModel ?? 'auto';
    const resolvedTemp = effort === 'auto' ? temperature : (TEMP[effort] ?? temperature);

    const hasTools = !!(tools?.length);

    const routeOpts: RouteOptions = {
      model: 'auto',
      temperature: resolvedTemp,
      max_tokens,
      reasoningEffort: effort === 'auto' ? undefined : effort as RouteOptions['reasoningEffort'],
      requireTools: hasTools,
      tools,
      tool_choice,
      parallel_tool_calls,
      // Only stream text turns — tool_call turns return structured JSON that must arrive whole.
      onChunk: (useStream && !hasTools) ? (text: string) => {
        const chunk: ProxyResponse = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: '__tiermux__',
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      } : undefined,
    };

    const sendResult = (result: Awaited<ReturnType<Router['route']>>, isStream: boolean) => {
      const msg = result.response.choices?.[0]?.message;
      const toolCalls = msg?.tool_calls;
      const finishReason = toolCalls?.length ? 'tool_calls' : 'stop';
      const usage = {
        prompt_tokens: result.response.usage?.prompt_tokens || 0,
        completion_tokens: result.response.usage?.completion_tokens || 0,
        total_tokens: result.response.usage?.total_tokens || 0,
      };

      if (!isStream) {
        const response: ProxyResponse = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: `${result.platform}/${result.model}`,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: msg?.content ?? null, ...(toolCalls?.length ? { tool_calls: toolCalls } : {}) } as any,
            finish_reason: finishReason,
          }],
          usage,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } else {
        // Stream: if tool_calls, send them in the final delta; text was already streamed via onChunk.
        const finalDelta: Record<string, unknown> = toolCalls?.length
          ? { role: 'assistant', tool_calls: toolCalls }
          : {};
        const finalChunk: ProxyResponse = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: `${result.platform}/${result.model}`,
          choices: [{ index: 0, delta: finalDelta as any, finish_reason: finishReason }],
          usage,
        };
        res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    };

    const sendError = (err: any, isStream: boolean) => {
      if (isStream) {
        res.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'server_error' } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'router_error', message: err.message }));
      }
    };

    if (!useStream) {
      try {
        sendResult(await this.router.route(messages, routeOpts), false);
      } catch (err: any) {
        res.writeHead(502);
        res.end(JSON.stringify({ error: 'router_error', message: err.message }));
      }
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    try {
      sendResult(await this.router.route(messages, routeOpts), true);
    } catch (err: any) {
      sendError(err, true);
    }
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });
  }
}
