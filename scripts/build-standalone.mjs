import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import postject from 'postject';

const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(
  readFileSync(join(projectRoot, 'package.json'), 'utf8'),
);
const executableName = process.platform === 'win32' ? 'hozamo.exe' : 'hozamo';
const outputPath = resolve(projectRoot, 'dist', executableName);
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'hozamo-sea-'));
const bundlePath = join(temporaryDirectory, 'hozamo.cjs');
const blobPath = join(temporaryDirectory, 'hozamo.blob');
const configPath = join(temporaryDirectory, 'sea-config.json');

try {
  await build({
    entryPoints: [join(projectRoot, 'src', 'standalone-entry.js')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    define: {
      __HOZAMO_STANDALONE__: 'true',
      __HOZAMO_VERSION__: JSON.stringify(packageJson.version),
    },
    // The source-only version fallback is unreachable after the constants
    // above are folded, but esbuild still sees its import.meta expression.
    logOverride: { 'empty-import-meta': 'silent' },
  });

  writeFileSync(configPath, JSON.stringify({
    main: bundlePath,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  }));

  execFileSync(process.execPath, ['--experimental-sea-config', configPath], {
    stdio: 'inherit',
  });

  mkdirSync(resolve(projectRoot, 'dist'), { recursive: true });
  copyFileSync(process.execPath, outputPath);

  if (process.platform === 'darwin') {
    execFileSync('codesign', ['--remove-signature', outputPath], {
      stdio: 'inherit',
    });
  }

  await postject.inject(
    outputPath,
    'NODE_SEA_BLOB',
    readFileSync(blobPath),
    {
      sentinelFuse: SEA_FUSE,
      ...(process.platform === 'darwin'
        ? { machoSegmentName: 'NODE_SEA' }
        : {}),
    },
  );

  if (process.platform === 'darwin') {
    execFileSync('codesign', ['--sign', '-', outputPath], {
      stdio: 'inherit',
    });
  } else if (process.platform !== 'win32') {
    chmodSync(outputPath, 0o755);
  }

  console.log(`Built ${basename(outputPath)} ${packageJson.version}`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
