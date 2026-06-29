// Thin HTTP proxy that injects Basic auth on every request forwarded to the OC server.
// The webview iframe loads from this proxy port; OC's JS makes same-origin API calls
// that also go through the proxy — so auth is transparent to the browser and OC's UI.
import * as http from 'http';
import * as net from 'net';

export interface OcProxyServer {
  port: number;
  close(): void;
}

/** Start a proxy on a random port that forwards all requests to OC with Basic auth. */
export function startOcWebguiProxy(ocPort: number, ocPassword: string): Promise<OcProxyServer> {
  const authHeader = `Basic ${Buffer.from(`opencode:${ocPassword}`).toString('base64')}`;

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const options: http.RequestOptions = {
        hostname: '127.0.0.1',
        port: ocPort,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: `127.0.0.1:${ocPort}`,
          authorization: authHeader,
        },
      };

      const proxy = http.request(options, (proxyRes) => {
        // Strip frame-blocking headers so the iframe can render OC's content.
        const headers = { ...proxyRes.headers };
        delete headers['x-frame-options'];
        // Replace OC's restrictive CSP with one that allows our webview context.
        delete headers['content-security-policy'];
        res.writeHead(proxyRes.statusCode ?? 200, headers);
        proxyRes.pipe(res);
      });

      proxy.on('error', (err) => {
        res.writeHead(502);
        res.end(`OC proxy error: ${err.message}`);
      });

      req.pipe(proxy);
    });

    // Handle WebSocket upgrades (OC uses SSE + WS for live events).
    server.on('upgrade', (req, socket, head) => {
      const client = net.connect(ocPort, '127.0.0.1', () => {
        // Inject auth into the upgrade request.
        const authLine = `Authorization: ${authHeader}\r\n`;
        const raw = `${req.method} ${req.url} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${ocPort}\r\n` +
          authLine +
          Object.entries(req.headers)
            .filter(([k]) => k.toLowerCase() !== 'host' && k.toLowerCase() !== 'authorization')
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
            .join('\r\n') +
          '\r\n\r\n';
        client.write(raw);
        client.write(head);
        client.pipe(socket);
        socket.pipe(client);
      });
      client.on('error', () => socket.destroy());
      socket.on('error', () => client.destroy());
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        port: addr.port,
        close: () => server.close(),
      });
    });

    server.on('error', reject);
  });
}
