import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { promisify } from 'util';

const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);

interface PkgJson {
  dependencies?: Record<string, string>;
}

export async function writeOpenCodeConfig(
  proxyPort: number,
  extensionPath: string,
): Promise<string> {
  const configDir = path.join(extensionPath, '.tiermux', 'opencode');
  const configPath = path.join(configDir, 'config.json');
  const pkgPath = path.join(configDir, 'package.json');

  // Ensure the provider npm package is available.
  const pkg: PkgJson = { dependencies: {} };
  try {
    const existing = JSON.parse(await readFileAsync(pkgPath, 'utf-8')) as PkgJson;
    if (existing.dependencies) pkg.dependencies = { ...existing.dependencies };
  } catch { /* will create new */ }

  if (!pkg.dependencies!['@ai-sdk/openai-compatible']) {
    pkg.dependencies!['@ai-sdk/openai-compatible'] = 'latest';
    await writeFileAsync(pkgPath, JSON.stringify(pkg, null, 2), 'utf-8');
    try {
      execSync('bun install', { cwd: configDir, stdio: 'pipe', timeout: 60000 });
    } catch {
      execSync('npm install --no-package-lock', { cwd: configDir, stdio: 'pipe', timeout: 60000 });
    }
  }

  // Write the TierMux provider config.
  // `model` (singular) is the OpenCode 1.2.15 default-model key.
  // TierMux always sends a `model` in each message body, so this is just the fallback.
  const config = {
    provider: {
      tiermux: {
        npm: '@ai-sdk/openai-compatible',
        name: 'TierMux Router',
        options: {
          baseURL: `http://127.0.0.1:${proxyPort}/v1`,
        },
        models: {
          'tiermux-auto': {},
        },
      },
    },
    model: 'tiermux/tiermux-auto',
  };

  await writeFileAsync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  return configDir;
}
