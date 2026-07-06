const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const rootDir = __dirname;
const envPath = path.join(rootDir, '.env');
let localEnv = {};

try {
  if (fs.existsSync(envPath)) {
    localEnv = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
  }
} catch {
  localEnv = {};
}

function firstExistingPath(paths) {
  for (const candidate of paths) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Ignore invalid filesystem probes and keep searching.
    }
  }
  return null;
}

function resolvePythonInterpreter() {
  const explicit = process.env.PYTHON_EXECUTABLE || localEnv.PYTHON_EXECUTABLE;
  if (explicit) {
    return explicit;
  }

  const directCandidates = [
    path.join(rootDir, '.venv', 'Scripts', 'python.exe'),
    process.env.VIRTUAL_ENV ? path.join(process.env.VIRTUAL_ENV, 'Scripts', 'python.exe') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python311', 'python.exe') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python312', 'python.exe') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python313', 'python.exe') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python314', 'python.exe') : null,
  ];

  const directMatch = firstExistingPath(directCandidates);
  if (directMatch) {
    return directMatch;
  }

  const uvRoot = process.env.APPDATA ? path.join(process.env.APPDATA, 'uv', 'python') : null;
  if (uvRoot) {
    try {
      const uvCandidates = fs
        .readdirSync(uvRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(uvRoot, entry.name, 'python.exe'))
        .filter((candidate) => fs.existsSync(candidate))
        .sort()
        .reverse();

      if (uvCandidates.length > 0) {
        return uvCandidates[0];
      }
    } catch {
      // Fall through to PATH lookup below.
    }
  }

  return 'python';
}

function buildQrisEnv(extra = {}) {
  return {
    ...process.env,
    ...localEnv,
    NODE_ENV: 'production',
    ...extra,
  };
}

const pythonInterpreter = resolvePythonInterpreter();
const configuredDatabaseProvider = String(process.env.DATABASE_PROVIDER || localEnv.DATABASE_PROVIDER || '').trim().toLowerCase();
const configuredDatabaseUrl = String(process.env.DATABASE_URL || localEnv.DATABASE_URL || '').trim().toLowerCase();
const pythonWatcherEnabled = String(process.env.ENABLE_PYTHON_WATCHER || localEnv.ENABLE_PYTHON_WATCHER || '').trim().toLowerCase() === 'true';
const shouldRunPythonWatcher =
  pythonWatcherEnabled ||
  configuredDatabaseProvider === 'postgres' ||
  configuredDatabaseProvider === 'postgresql' ||
  configuredDatabaseUrl.startsWith('postgres://') ||
  configuredDatabaseUrl.startsWith('postgresql://');

const apps = [
  {
    name: 'qris-app',
    cwd: rootDir,
    script: path.join(rootDir, 'dist', 'server.js'),
    instances: 1,
    autorestart: true,
    watch: false,
    env: buildQrisEnv({
      PORT: 3333,
    }),
  },
  {
    name: 'qris-worker',
    cwd: rootDir,
    script: path.join(rootDir, 'dist', 'worker.js'),
    instances: 1,
    autorestart: true,
    watch: false,
    env: buildQrisEnv(),
  },
  {
    name: 'qris-telegram-bot',
    cwd: rootDir,
    script: path.join(rootDir, 'dist', 'telegram-control-bot.js'),
    instances: 1,
    autorestart: true,
    watch: false,
    env: buildQrisEnv(),
  },
];

if (shouldRunPythonWatcher) {
  apps.push({
    name: 'qris-python-watcher',
    cwd: rootDir,
    script: path.join(rootDir, 'python', 'qris_balance_watcher.py'),
    interpreter: pythonInterpreter,
    instances: 1,
    autorestart: true,
    watch: false,
    max_restarts: 20,
    restart_delay: 3000,
    min_uptime: '5s',
    env: buildQrisEnv(),
  });
}

module.exports = { apps };
