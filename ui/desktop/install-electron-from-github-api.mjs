import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, renameSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';

const packageDir = dirname(fileURLToPath(import.meta.url));
const electronDir = join(packageDir, 'node_modules', 'electron');
const { version } = JSON.parse(readFileSync(join(electronDir, 'package.json'), 'utf8'));
const platform = process.platform;
const arch = process.arch;
const archive = `electron-v${version}-${platform}-${arch}.zip`;
const checksums = JSON.parse(readFileSync(join(electronDir, 'checksums.json'), 'utf8'));
const expectedHash = checksums[archive];
const executable = platform === 'win32' ? 'electron.exe' : platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : null;
const token = process.env.GH_TOKEN;

if (!executable || !expectedHash || !token) {
  throw new Error(`Official Electron API fallback needs a supported archive and GH_TOKEN (${archive})`);
}

const apiHeaders = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'harnessy-electron-ci',
};
const releaseResponse = await fetch(`https://api.github.com/repos/electron/electron/releases/tags/v${version}`, {
  headers: apiHeaders,
  signal: AbortSignal.timeout(30_000),
});
if (!releaseResponse.ok) throw new Error(`Electron release API returned ${releaseResponse.status}`);
const release = await releaseResponse.json();
const asset = release.assets.find((entry) => entry.name === archive);
if (!asset || asset.digest !== `sha256:${expectedHash}` || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 300 * 1024 * 1024) {
  throw new Error(`Electron asset or SHA-256 metadata mismatch for ${archive}`);
}

const downloadSignal = AbortSignal.timeout(300_000);
const assetResponse = await fetch(asset.url, {
  headers: { ...apiHeaders, Accept: 'application/octet-stream' },
  signal: downloadSignal,
});
if (!assetResponse.ok || !assetResponse.body) throw new Error(`Electron asset API returned ${assetResponse.status}`);
const archivePath = join(await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), 'harnessy-electron-')), archive);
let downloaded = 0;
const bounded = new Transform({
  transform(chunk, _encoding, callback) {
    downloaded += chunk.length;
    callback(downloaded > asset.size ? new Error(`Electron asset exceeds published size: ${archive}`) : null, chunk);
  },
});
await pipeline(Readable.fromWeb(assetResponse.body), bounded, createWriteStream(archivePath), { signal: downloadSignal });
if (downloaded !== asset.size) throw new Error(`Electron asset size mismatch for ${archive}`);

const hash = createHash('sha256');
for await (const chunk of createReadStream(archivePath)) hash.update(chunk);
if (hash.digest('hex') !== expectedHash) throw new Error(`Electron archive SHA-256 mismatch for ${archive}`);

const { extract } = await import('@electron-internal/extract-zip');
const distDir = join(electronDir, 'dist');
await mkdir(distDir, { recursive: true });
await extract(archivePath, { dir: distDir });
const typeDefinition = join(distDir, 'electron.d.ts');
if (existsSync(typeDefinition)) renameSync(typeDefinition, join(electronDir, 'electron.d.ts'));
await writeFile(join(electronDir, 'path.txt'), executable);
if (!existsSync(join(distDir, executable))) throw new Error(`Electron executable is missing after extraction: ${archive}`);
console.log(`Installed verified official Electron ${version} via GitHub API (${archive})`);
