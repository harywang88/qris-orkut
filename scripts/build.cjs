const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const schemaPath = path.join(rootDir, 'prisma', 'schema.prisma');
const clientIndexPath = path.join(rootDir, 'node_modules', '.prisma', 'client', 'index.js');
const clientEnginePath = path.join(
  rootDir,
  'node_modules',
  '.prisma',
  'client',
  'query_engine-windows.dll.node',
);
const prismaBin = process.platform === 'win32'
  ? path.join(rootDir, 'node_modules', '.bin', 'prisma.cmd')
  : path.join(rootDir, 'node_modules', '.bin', 'prisma');
const tscBin = process.platform === 'win32'
  ? path.join(rootDir, 'node_modules', '.bin', 'tsc.cmd')
  : path.join(rootDir, 'node_modules', '.bin', 'tsc');

function run(command, args, options = {}) {
  if (process.platform === 'win32') {
    return spawnSync('cmd.exe', ['/c', command, ...args], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: 'pipe',
      ...options,
    });
  }

  return spawnSync(command, args, {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: 'pipe',
    ...options,
  });
}

function printResult(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function isEngineLockError(output) {
  return /EPERM: operation not permitted, rename .*query_engine-windows\.dll\.node/i.test(
    String(output || ''),
  );
}

function hasReusableClient() {
  if (!fs.existsSync(clientIndexPath) || !fs.existsSync(schemaPath)) {
    return false;
  }

  const schemaStat = fs.statSync(schemaPath);
  const clientStat = fs.statSync(clientIndexPath);
  if (clientStat.mtimeMs < schemaStat.mtimeMs) {
    return false;
  }

  return fs.existsSync(clientEnginePath);
}

function fail(result, fallbackMessage = '') {
  if (result.error) {
    process.stderr.write(`${String(result.error.message || result.error)}\n`);
  }
  printResult(result);
  if (fallbackMessage) {
    process.stderr.write(`${fallbackMessage}\n`);
  }
  process.exit(Number(result.status || 1));
}

const generate = run(prismaBin, ['generate']);
if (generate.status !== 0) {
  const combinedOutput = `${generate.stdout || ''}\n${generate.stderr || ''}`;
  if (isEngineLockError(combinedOutput) && hasReusableClient()) {
    printResult(generate);
    process.stdout.write(
      '\n[build] Prisma client sedang terkunci proses lain. Build dilanjutkan memakai client yang sudah valid.\n',
    );
  } else {
    fail(generate);
  }
} else {
  printResult(generate);
}

const tsc = run(tscBin, [], { stdio: 'inherit' });
if (tsc.error) {
  process.stderr.write(`${String(tsc.error.message || tsc.error)}\n`);
}
process.exit(Number(tsc.status || 0));
