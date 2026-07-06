import fs from 'fs';
import path from 'path';

const runtimeDir = path.join(process.cwd(), 'data', 'runtime');

function ensureRuntimeDir(): void {
  fs.mkdirSync(runtimeDir, { recursive: true });
}

function getHeartbeatPath(serviceName: string): string {
  return path.join(runtimeDir, `${serviceName}.json`);
}

function writeHeartbeatFile(
  serviceName: string,
  startedAt: string,
  extra?: Record<string, unknown>,
): void {
  ensureRuntimeDir();
  const payload = {
    service: serviceName,
    pid: process.pid,
    startedAt,
    lastSeenAt: new Date().toISOString(),
    ...extra,
  };
  fs.writeFileSync(getHeartbeatPath(serviceName), JSON.stringify(payload, null, 2), 'utf8');
}

export function startRuntimeHeartbeat(
  serviceName: string,
  intervalMs = 5000,
  extra?: () => Record<string, unknown>,
): () => void {
  const startedAt = new Date().toISOString();
  const write = () => {
    writeHeartbeatFile(serviceName, startedAt, extra ? extra() : undefined);
  };

  write();
  const timer = setInterval(write, Math.max(1000, Number(intervalMs || 5000)));
  timer.unref();

  return () => {
    clearInterval(timer);
    writeHeartbeatFile(serviceName, startedAt, {
      ...(extra ? extra() : {}),
      stoppedAt: new Date().toISOString(),
      stopping: true,
    });
  };
}
