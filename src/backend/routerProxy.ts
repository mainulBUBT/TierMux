import * as http from 'http';
import type { Router, RouteOptions } from '../router/router';
import type { Catalog } from '../catalog/catalog';
import type { SettingsStore } from '../config/settingsStore';
import type { SecretStore } from '../config/secrets';
import type { ChatMessage } from '../shared/types';

export interface ProxyRequest {
  messages: ChatMessage[];
  model?: string;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
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

  private async handleChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const proxyReq: ProxyRequest = JSON.parse(body);
    const { messages, stream, temperature, model: requestedModel } = proxyReq;
    const useStream = stream !== false;

    if (!messages || !messages.length) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'messages_required' }));
      return;
    }

    const routeOpts: RouteOptions = {
      model: !requestedModel || requestedModel === '__tiermux__/auto' ? 'auto' : requestedModel,
      temperature,
      requireTools: true,
      onChunk: useStream ? (text: string) => {
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

    if (!useStream) {
      try {
        const result = await this.router.route(messages, routeOpts);
        const response: ProxyResponse = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: `${result.platform}/${result.model}`,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: String(result.response.choices?.[0]?.message?.content ?? '') },
            finish_reason: 'stop',
          }],
          usage: {
            prompt_tokens: result.response.usage?.prompt_tokens || 0,
            completion_tokens: result.response.usage?.completion_tokens || 0,
            total_tokens: result.response.usage?.total_tokens || 0,
          },
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
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
      const result = await this.router.route(messages, routeOpts);
      const finalChunk: ProxyResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: `${result.platform}/${result.model}`,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: result.response.usage?.prompt_tokens || 0,
          completion_tokens: result.response.usage?.completion_tokens || 0,
          total_tokens: result.response.usage?.total_tokens || 0,
        },
      };
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err: any) {
      if (useStream) {
        res.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'server_error' } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message, type: 'server_error' } }));
      }
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
