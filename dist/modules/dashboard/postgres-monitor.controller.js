"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.showPostgresMonitor = showPostgresMonitor;
exports.getPostgresMonitorJson = getPostgresMonitorJson;
const config_1 = require("../../config");
const logger_1 = require("../../config/logger");
const base_path_1 = require("../../core/base-path");
const postgres_monitor_service_1 = require("../../shared/postgres-monitor.service");
async function showPostgresMonitor(req, res) {
    try {
        const snapshot = await (0, postgres_monitor_service_1.getPostgresMonitorSnapshot)();
        res.render('settings/postgres-monitor', {
            title: 'PostgreSQL Monitor',
            snapshot,
            apiUrl: (0, base_path_1.withBasePath)('/dashboard/api/postgres-monitor', config_1.config.APP_BASE_PATH),
        });
    }
    catch (err) {
        logger_1.logger.error({ err }, 'showPostgresMonitor error');
        res.status(500).render('error/500', { title: 'Error' });
    }
}
async function getPostgresMonitorJson(req, res) {
    try {
        const snapshot = await (0, postgres_monitor_service_1.getPostgresMonitorSnapshot)();
        res.json({ ok: true, snapshot });
    }
    catch (err) {
        logger_1.logger.error({ err }, 'getPostgresMonitorJson error');
        res.status(500).json({ ok: false, error: 'Gagal mengambil monitor PostgreSQL' });
    }
}
//# sourceMappingURL=postgres-monitor.controller.js.map