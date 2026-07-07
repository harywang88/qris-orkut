"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startRuntimeHeartbeat = startRuntimeHeartbeat;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const runtimeDir = path_1.default.join(process.cwd(), 'data', 'runtime');
function ensureRuntimeDir() {
    fs_1.default.mkdirSync(runtimeDir, { recursive: true });
}
function getHeartbeatPath(serviceName) {
    return path_1.default.join(runtimeDir, `${serviceName}.json`);
}
function writeHeartbeatFile(serviceName, startedAt, extra) {
    ensureRuntimeDir();
    const payload = {
        service: serviceName,
        pid: process.pid,
        startedAt,
        lastSeenAt: new Date().toISOString(),
        ...extra,
    };
    fs_1.default.writeFileSync(getHeartbeatPath(serviceName), JSON.stringify(payload, null, 2), 'utf8');
}
function startRuntimeHeartbeat(serviceName, intervalMs = 5000, extra) {
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
//# sourceMappingURL=runtime-heartbeat.js.map