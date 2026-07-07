"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const path_1 = __importDefault(require("path"));
const dotenv_1 = __importDefault(require("dotenv"));
const child_process_1 = require("child_process");
const util_1 = require("util");
dotenv_1.default.config({ path: path_1.default.join(process.cwd(), '.env'), override: true });
const execAsync = (0, util_1.promisify)(child_process_1.exec);
const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
const GROUP_ID = (process.env.TELEGRAM_GROUP_ID ?? '').trim();
const PM2_HOME = (process.env.PM2_HOME ?? path_1.default.join(process.cwd(), 'data', 'pm2')).trim();
const PM2_WRAPPER = (process.env.TELEGRAM_CONTROL_PM2_WRAPPER ?? 'scripts\\pm2.cmd').trim();
const STACK_TARGETS = (process.env.TELEGRAM_CONTROL_STACK_TARGETS ?? 'qris-app,qris-worker')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
const STACK_TARGETS_ARG = STACK_TARGETS.join(' ');
const ALL_STACK_TARGETS = (process.env.TELEGRAM_CONTROL_ALL_STACK_TARGETS ?? 'qris-app,qris-worker,qris-telegram-bot')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
const ALL_STACK_TARGETS_ARG = ALL_STACK_TARGETS.join(' ');
const START_COMMAND = (process.env.TELEGRAM_CONTROL_START_COMMAND ??
    `${PM2_WRAPPER} start ecosystem.config.cjs --only qris-app,qris-worker`).trim();
const STOP_COMMAND = (process.env.TELEGRAM_CONTROL_STOP_COMMAND ??
    `${PM2_WRAPPER} stop ${STACK_TARGETS_ARG}`).trim();
const RESTART_COMMAND = (process.env.TELEGRAM_CONTROL_RESTART_COMMAND ??
    `${PM2_WRAPPER} restart ${STACK_TARGETS_ARG}`).trim();
const STATUS_COMMAND = (process.env.TELEGRAM_CONTROL_STATUS_COMMAND ??
    `${PM2_WRAPPER} list --no-color`).trim();
const PM2_LIST_COMMAND = (process.env.TELEGRAM_CONTROL_PM2_LIST_COMMAND ??
    `${PM2_WRAPPER} jlist`).trim();
const PM2_RAW_COMMAND = (process.env.TELEGRAM_CONTROL_PM2_RAW_COMMAND ??
    `${PM2_WRAPPER} list --no-color`).trim();
const START_ALL_COMMAND = (process.env.TELEGRAM_CONTROL_START_ALL_COMMAND ??
    `${PM2_WRAPPER} start ecosystem.config.cjs`).trim();
const STOP_ALL_COMMAND = (process.env.TELEGRAM_CONTROL_STOP_ALL_COMMAND ??
    `${PM2_WRAPPER} stop ${ALL_STACK_TARGETS_ARG}`).trim();
const RESTART_ALL_COMMAND = (process.env.TELEGRAM_CONTROL_RESTART_ALL_COMMAND ??
    `${PM2_WRAPPER} restart ${ALL_STACK_TARGETS_ARG}`).trim();
const COMMAND_TIMEOUT_MS = Number(process.env.TELEGRAM_CONTROL_TIMEOUT_MS ?? '60000');
if (!BOT_TOKEN) {
    console.error('[telegram-control-bot] TELEGRAM_BOT_TOKEN wajib diisi.');
    process.exit(1);
}
if (!GROUP_ID) {
    console.error('[telegram-control-bot] TELEGRAM_GROUP_ID wajib diisi.');
    process.exit(1);
}
function isAllowedChat(chatId) {
    return String(chatId) === GROUP_ID;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function escapeHtml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
function trimOutput(value, limit = 3500) {
    const text = value.trim();
    if (!text)
        return '(tanpa output)';
    if (text.length <= limit)
        return text;
    return `${text.slice(0, limit)}\n... (output dipotong)`;
}
function stripAnsi(value) {
    return value.replace(/\u001b\[[0-9;]*m/g, '');
}
function sanitizeOutput(value) {
    return stripAnsi(value)
        .replace(/\r\n/g, '\n')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}
function extractJsonPayload(value) {
    const cleaned = sanitizeOutput(value).trim();
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start >= 0 && end >= start) {
        return cleaned.slice(start, end + 1);
    }
    return cleaned;
}
function formatJakartaTime() {
    const now = new Date();
    return new Intl.DateTimeFormat('id-ID', {
        timeZone: 'Asia/Jakarta',
        dateStyle: 'medium',
        timeStyle: 'medium',
    }).format(now);
}
function toFiniteNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return 0;
}
function formatUptime(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0)
        return '-';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (d > 0)
        return `${d}d ${h}h ${m}m`;
    if (h > 0)
        return `${h}h ${m}m ${s}s`;
    if (m > 0)
        return `${m}m ${s}s`;
    return `${s}s`;
}
function formatMemory(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0)
        return '0 MB';
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function statusIcon(status) {
    const normalized = status.toLowerCase();
    if (normalized === 'online')
        return '[OK]';
    if (normalized === 'stopped')
        return '[STOP]';
    if (normalized === 'launching')
        return '[BOOT]';
    if (normalized === 'errored')
        return '[ERR]';
    return '[?]';
}
async function telegramCall(method, payload) {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const body = (await response.json());
    if (!response.ok || !body.ok || body.result === undefined) {
        const detail = body.description ?? response.statusText;
        throw new Error(`Telegram API ${method} gagal: ${detail}`);
    }
    return body.result;
}
function controlKeyboard() {
    return {
        inline_keyboard: [
            [
                { text: 'Start', callback_data: 'control:start' },
                { text: 'Restart', callback_data: 'control:restart' },
            ],
            [
                { text: 'Stop', callback_data: 'control:stop' },
                { text: 'Live Status', callback_data: 'control:status' },
            ],
            [
                { text: 'Start All Services', callback_data: 'control:start-all' },
                { text: 'Restart All Services', callback_data: 'control:restart-all' },
            ],
            [
                { text: 'Stop All Services', callback_data: 'control:stop-all' },
            ],
            [
                { text: 'Refresh Panel', callback_data: 'control:panel' },
                { text: 'PM2 Raw', callback_data: 'control:raw' },
            ],
        ],
    };
}
async function sendPanel(chatId, text) {
    const panelText = text ?? [
        '<b>WANGPAY Control Center</b>',
        '<i>PM2 runtime control</i>',
        '',
        `Managed stack: <code>${escapeHtml(STACK_TARGETS.join(', '))}</code>`,
        `All services: <code>${escapeHtml(ALL_STACK_TARGETS.join(', '))}</code>`,
        `PM2_HOME: <code>${escapeHtml(PM2_HOME)}</code>`,
        `Update: <code>${escapeHtml(formatJakartaTime())}</code>`,
    ].join('\n');
    await telegramCall('sendMessage', {
        chat_id: chatId,
        text: panelText,
        parse_mode: 'HTML',
        reply_markup: controlKeyboard(),
    });
}
function isCommand(text, command) {
    const firstToken = text.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? '';
    return firstToken === `/${command}` || firstToken.startsWith(`/${command}@`);
}
async function runCommand(command, options = {}) {
    const { trim = true } = options;
    try {
        const { stdout, stderr } = await execAsync(command, {
            cwd: process.cwd(),
            env: {
                ...process.env,
                PM2_HOME,
            },
            timeout: Math.max(5000, COMMAND_TIMEOUT_MS),
            windowsHide: true,
        });
        const rawOutput = sanitizeOutput([stdout, stderr].filter(Boolean).join('\n')).trim();
        const output = trim ? trimOutput(rawOutput) : rawOutput || '(tanpa output)';
        return { success: true, output, rawOutput };
    }
    catch (error) {
        const err = error;
        const rawOutput = sanitizeOutput([err.stdout, err.stderr, err.message].filter(Boolean).join('\n')).trim();
        const output = trim ? trimOutput(rawOutput) : rawOutput || 'Perintah gagal tanpa detail output.';
        return { success: false, output, rawOutput };
    }
}
function buildPm2StatusText(list) {
    if (!Array.isArray(list) || list.length === 0) {
        return 'Tidak ada proses PM2 aktif.';
    }
    const lines = [];
    let online = 0;
    let stopped = 0;
    let errored = 0;
    for (const processInfo of list) {
        const name = processInfo.name ?? '-';
        const status = (processInfo.pm2_env?.status ?? 'unknown').toLowerCase();
        const uptimeRaw = toFiniteNumber(processInfo.pm2_env?.pm_uptime);
        const uptimeSec = uptimeRaw > 0 ? Math.floor((Date.now() - uptimeRaw) / 1000) : 0;
        const restarts = toFiniteNumber(processInfo.pm2_env?.restart_time);
        const cpu = toFiniteNumber(processInfo.monit?.cpu);
        const memory = toFiniteNumber(processInfo.monit?.memory);
        const pid = processInfo.pid && processInfo.pid > 0 ? String(processInfo.pid) : '-';
        if (status === 'online')
            online += 1;
        if (status === 'stopped')
            stopped += 1;
        if (status === 'errored')
            errored += 1;
        lines.push(`${statusIcon(status)} ${name}\n` +
            `status=${status} | uptime=${formatUptime(uptimeSec)} | restart=${restarts} | cpu=${cpu}% | mem=${formatMemory(memory)} | pid=${pid}`);
    }
    return [
        '<b>Live Server Status</b>',
        '<i>Realtime PM2 snapshot</i>',
        '',
        `<b>Total:</b> ${list.length} | <b>Online:</b> ${online} | <b>Stopped:</b> ${stopped} | <b>Errored:</b> ${errored}`,
        `<b>Updated:</b> <code>${escapeHtml(formatJakartaTime())}</code>`,
        '',
        `<pre>${escapeHtml(lines.join('\n\n'))}</pre>`,
    ].join('\n');
}
async function fetchPm2Snapshot() {
    const raw = await runCommand(PM2_LIST_COMMAND, { trim: false });
    if (!raw.success) {
        return {
            success: false,
            text: [
                '<b>PM2 list gagal</b>',
                `<b>Perintah:</b> <code>${escapeHtml(PM2_LIST_COMMAND)}</code>`,
                '',
                `<pre>${escapeHtml(trimOutput(raw.rawOutput || raw.output))}</pre>`,
            ].join('\n'),
        };
    }
    try {
        const payload = extractJsonPayload(raw.rawOutput);
        const list = JSON.parse(payload);
        return { success: true, text: buildPm2StatusText(list) };
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
            success: false,
            text: [
                '<b>PM2 status parse gagal</b>',
                `<b>Perintah:</b> <code>${escapeHtml(PM2_LIST_COMMAND)}</code>`,
                '',
                `<pre>${escapeHtml(trimOutput(raw.rawOutput))}</pre>`,
                '',
                `<i>${escapeHtml(msg)}</i>`,
            ].join('\n'),
        };
    }
}
async function executeAction(action) {
    const commandMap = {
        start: START_COMMAND,
        stop: STOP_COMMAND,
        restart: RESTART_COMMAND,
    };
    const command = commandMap[action];
    const result = await runCommand(command);
    return { success: result.success, output: result.output, command };
}
async function executeAllAction(action) {
    const commandMap = {
        'start-all': START_ALL_COMMAND,
        'stop-all': STOP_ALL_COMMAND,
        'restart-all': RESTART_ALL_COMMAND,
    };
    const command = commandMap[action];
    const result = await runCommand(command);
    return { success: result.success, output: result.output, command };
}
async function sendCommandOutput(chatId, title, command, output) {
    const text = [
        `<b>${escapeHtml(title)}</b>`,
        '',
        `<b>Perintah:</b> <code>${escapeHtml(command)}</code>`,
        `<b>Waktu:</b> <code>${escapeHtml(formatJakartaTime())}</code>`,
        '',
        `<pre>${escapeHtml(output)}</pre>`,
    ].join('\n');
    await telegramCall('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: controlKeyboard(),
    });
}
async function sendTransientAllServicesNotice(chatId, title, command) {
    const text = [
        `<b>${escapeHtml(title)}</b>`,
        '',
        '<i>Perintah sedang dijalankan untuk seluruh service, termasuk bot Telegram ini.</i>',
        '<i>Kalau bot sempat offline sebentar, itu normal dan akan balik lagi setelah PM2 selesai.</i>',
        '',
        `<b>Perintah:</b> <code>${escapeHtml(command)}</code>`,
        `<b>Waktu:</b> <code>${escapeHtml(formatJakartaTime())}</code>`,
    ].join('\n');
    await telegramCall('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: controlKeyboard(),
    });
}
async function handleMessage(update) {
    const msg = update.message;
    if (!msg || !msg.text)
        return;
    if (!isAllowedChat(msg.chat.id)) {
        return;
    }
    if (isCommand(msg.text, 'start') ||
        isCommand(msg.text, 'panel') ||
        isCommand(msg.text, 'server') ||
        isCommand(msg.text, 'pm2')) {
        await sendPanel(msg.chat.id);
        return;
    }
    if (isCommand(msg.text, 'status') || isCommand(msg.text, 'pm2list')) {
        const status = await fetchPm2Snapshot();
        await telegramCall('sendMessage', {
            chat_id: msg.chat.id,
            text: status.text,
            parse_mode: 'HTML',
            reply_markup: controlKeyboard(),
        });
        return;
    }
    if (isCommand(msg.text, 'pm2raw')) {
        const result = await runCommand(PM2_RAW_COMMAND);
        await sendCommandOutput(msg.chat.id, `PM2 RAW ${result.success ? 'SUKSES' : 'GAGAL'}`, PM2_RAW_COMMAND, result.output);
    }
}
async function handleCallbackQuery(update) {
    const callback = update.callback_query;
    if (!callback || !callback.data)
        return;
    const chatId = callback.message?.chat.id;
    if (!chatId)
        return;
    if (!isAllowedChat(chatId)) {
        await telegramCall('answerCallbackQuery', {
            callback_query_id: callback.id,
            text: 'Akses ditolak untuk chat ini.',
            show_alert: true,
        });
        return;
    }
    const action = callback.data.replace('control:', '');
    if (!['start', 'stop', 'restart', 'status', 'panel', 'raw', 'start-all', 'stop-all', 'restart-all'].includes(action)) {
        await telegramCall('answerCallbackQuery', {
            callback_query_id: callback.id,
            text: 'Aksi tidak dikenal.',
        });
        return;
    }
    if (action === 'panel') {
        await telegramCall('answerCallbackQuery', {
            callback_query_id: callback.id,
            text: 'Panel diperbarui.',
        });
        await sendPanel(chatId);
        return;
    }
    if (action === 'status') {
        await telegramCall('answerCallbackQuery', {
            callback_query_id: callback.id,
            text: 'Mengambil status terbaru...',
        });
        const status = await fetchPm2Snapshot();
        await telegramCall('sendMessage', {
            chat_id: chatId,
            text: status.text,
            parse_mode: 'HTML',
            reply_markup: controlKeyboard(),
        });
        return;
    }
    if (action === 'raw') {
        await telegramCall('answerCallbackQuery', {
            callback_query_id: callback.id,
            text: 'Mengambil output PM2 raw...',
        });
        const result = await runCommand(PM2_RAW_COMMAND);
        await sendCommandOutput(chatId, `PM2 RAW ${result.success ? 'SUKSES' : 'GAGAL'}`, PM2_RAW_COMMAND, result.output);
        return;
    }
    if (action === 'start-all' || action === 'stop-all' || action === 'restart-all') {
        await telegramCall('answerCallbackQuery', {
            callback_query_id: callback.id,
            text: `Menjalankan ${action.toUpperCase()}...`,
        });
        const actionLabel = action.replace('-', ' ').toUpperCase();
        const commandMap = {
            'start-all': START_ALL_COMMAND,
            'stop-all': STOP_ALL_COMMAND,
            'restart-all': RESTART_ALL_COMMAND,
        };
        await sendTransientAllServicesNotice(chatId, `${actionLabel} DIMULAI`, commandMap[action]);
        const result = await executeAllAction(action);
        if (action === 'stop-all' || action === 'restart-all') {
            return;
        }
        await sendCommandOutput(chatId, `${actionLabel} ${result.success ? 'SUKSES' : 'GAGAL'}`, result.command, result.output);
        return;
    }
    await telegramCall('answerCallbackQuery', {
        callback_query_id: callback.id,
        text: `Menjalankan ${action.toUpperCase()}...`,
    });
    const result = await executeAction(action);
    await sendCommandOutput(chatId, `${action.toUpperCase()} ${result.success ? 'SUKSES' : 'GAGAL'}`, result.command, result.output);
}
async function bootstrapOffset() {
    try {
        const updates = await telegramCall('getUpdates', {
            timeout: 0,
            limit: 100,
            allowed_updates: ['message', 'callback_query'],
        });
        if (!updates.length)
            return 0;
        return updates[updates.length - 1].update_id + 1;
    }
    catch (error) {
        console.error('[telegram-control-bot] Gagal bootstrap offset:', error);
        return 0;
    }
}
async function poll() {
    let offset = await bootstrapOffset();
    console.log(`[telegram-control-bot] Start polling. group=${GROUP_ID}, offset=${offset}`);
    while (true) {
        try {
            const updates = await telegramCall('getUpdates', {
                offset,
                timeout: 30,
                allowed_updates: ['message', 'callback_query'],
            });
            for (const update of updates) {
                offset = update.update_id + 1;
                await handleMessage(update);
                await handleCallbackQuery(update);
            }
        }
        catch (error) {
            console.error('[telegram-control-bot] Polling error:', error);
            await sleep(3000);
        }
    }
}
async function startBot() {
    const chatId = Number(GROUP_ID);
    if (!Number.isNaN(chatId)) {
        try {
            await sendPanel(chatId);
        }
        catch (error) {
            console.error('[telegram-control-bot] Gagal kirim panel awal:', error);
        }
    }
    await poll();
}
startBot().catch((error) => {
    console.error('[telegram-control-bot] Fatal error:', error);
    process.exit(1);
});
//# sourceMappingURL=telegram-control-bot.js.map