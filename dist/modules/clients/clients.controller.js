"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.showClientList = showClientList;
exports.showNewClientForm = showNewClientForm;
exports.handleCreateClient = handleCreateClient;
exports.showClientDetail = showClientDetail;
exports.showEditClientForm = showEditClientForm;
exports.handleUpdateClient = handleUpdateClient;
exports.handleDeleteClient = handleDeleteClient;
exports.handleRotateSecret = handleRotateSecret;
exports.handleRotateWidgetKey = handleRotateWidgetKey;
exports.handleRevealSecret = handleRevealSecret;
const zod_1 = require("zod");
const clients_service_1 = require("./clients.service");
const config_1 = require("../../config");
const logger_1 = require("../../config/logger");
const base_path_1 = require("../../core/base-path");
const CreateClientSchema = zod_1.z.object({
    name: zod_1.z.string().min(1).max(100),
    panelCode: zod_1.z
        .string()
        .min(1)
        .max(10)
        .regex(/^[A-Z0-9]+$/i, 'Panel code only alphanumeric characters'),
    callbackUrl: zod_1.z.string().url().optional().or(zod_1.z.literal('')),
    depositApiUrl: zod_1.z.string().url().optional().or(zod_1.z.literal('')),
    depositApiKey: zod_1.z.string().max(255).optional(),
    widgetAllowedOrigins: zod_1.z.string().max(1000).optional(),
});
const UpdateClientSchema = zod_1.z.object({
    name: zod_1.z.string().min(1).max(100).optional(),
    status: zod_1.z.enum(['active', 'inactive']).optional(),
    callbackUrl: zod_1.z.string().url().optional().or(zod_1.z.literal('')),
    depositApiUrl: zod_1.z.string().url().optional().or(zod_1.z.literal('')),
    depositApiKey: zod_1.z.string().max(255).optional(),
    widgetAllowedOrigins: zod_1.z.string().max(1000).optional(),
});
async function showClientList(req, res) {
    try {
        const clients = await (0, clients_service_1.listClients)();
        res.render('clients/index', {
            title: 'Kelola Klien',
            clients,
        });
    }
    catch (err) {
        logger_1.logger.error({ err }, 'showClientList error');
        res.status(500).render('error/500', { title: 'Error' });
    }
}
async function showNewClientForm(req, res) {
    res.render('clients/form', {
        title: 'Tambah Klien',
        client: null,
        errors: null,
    });
}
async function handleCreateClient(req, res) {
    const parsed = CreateClientSchema.safeParse(req.body);
    if (!parsed.success) {
        res.render('clients/form', {
            title: 'Tambah Klien',
            client: null,
            errors: parsed.error.flatten().fieldErrors,
        });
        return;
    }
    try {
        const { client, rawSecret } = await (0, clients_service_1.createClient)(parsed.data);
        req.session.flash = {
            type: 'success',
            message: `Klien "${client.name}" berhasil dibuat. API Secret: ${rawSecret} (simpan segera, tidak akan ditampilkan lagi)`,
        };
        res.redirect((0, base_path_1.withBasePath)(`/clients/${client.id}`, config_1.config.APP_BASE_PATH));
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Gagal membuat klien';
        res.render('clients/form', {
            title: 'Tambah Klien',
            client: null,
            errors: { _form: [message] },
        });
    }
}
async function showClientDetail(req, res) {
    try {
        const client = await (0, clients_service_1.getClientById)(req.params.id);
        if (!client) {
            res.status(404).render('error/404', { title: 'Tidak Ditemukan' });
            return;
        }
        res.render('clients/detail', {
            title: `Klien: ${client.name}`,
            client,
            newSecret: null,
        });
    }
    catch (err) {
        logger_1.logger.error({ err }, 'showClientDetail error');
        res.status(500).render('error/500', { title: 'Error' });
    }
}
async function showEditClientForm(req, res) {
    try {
        const client = await (0, clients_service_1.getClientById)(req.params.id);
        if (!client) {
            res.status(404).render('error/404', { title: 'Tidak Ditemukan' });
            return;
        }
        res.render('clients/form', {
            title: `Edit Klien: ${client.name}`,
            client,
            errors: null,
        });
    }
    catch (err) {
        logger_1.logger.error({ err }, 'showEditClientForm error');
        res.status(500).render('error/500', { title: 'Error' });
    }
}
async function handleUpdateClient(req, res) {
    const parsed = UpdateClientSchema.safeParse(req.body);
    if (!parsed.success) {
        const client = await (0, clients_service_1.getClientById)(req.params.id);
        res.render('clients/form', {
            title: 'Edit Klien',
            client,
            errors: parsed.error.flatten().fieldErrors,
        });
        return;
    }
    try {
        await (0, clients_service_1.updateClient)(req.params.id, parsed.data);
        req.session.flash = { type: 'success', message: 'Klien berhasil diperbarui.' };
        res.redirect((0, base_path_1.withBasePath)(`/clients/${req.params.id}`, config_1.config.APP_BASE_PATH));
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Gagal memperbarui klien';
        req.session.flash = { type: 'error', message };
        res.redirect((0, base_path_1.withBasePath)(`/clients/${req.params.id}`, config_1.config.APP_BASE_PATH));
    }
}
async function handleDeleteClient(req, res) {
    try {
        await (0, clients_service_1.deleteClient)(req.params.id);
        req.session.flash = { type: 'success', message: 'Klien berhasil dihapus.' };
        res.redirect((0, base_path_1.withBasePath)('/clients', config_1.config.APP_BASE_PATH));
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Gagal menghapus klien';
        req.session.flash = { type: 'error', message };
        res.redirect((0, base_path_1.withBasePath)('/clients', config_1.config.APP_BASE_PATH));
    }
}
async function handleRotateSecret(req, res) {
    try {
        const newSecret = await (0, clients_service_1.rotateApiSecret)(req.params.id);
        const client = await (0, clients_service_1.getClientById)(req.params.id);
        res.render('clients/detail', {
            title: `Klien: ${client?.name}`,
            client,
            newSecret,
        });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Gagal merotasi secret';
        req.session.flash = { type: 'error', message };
        res.redirect((0, base_path_1.withBasePath)(`/clients/${req.params.id}`, config_1.config.APP_BASE_PATH));
    }
}
async function handleRotateWidgetKey(req, res) {
    try {
        const widgetKey = await (0, clients_service_1.rotateWidgetKey)(req.params.id);
        req.session.flash = {
            type: 'success',
            message: `Widget key baru: ${widgetKey}`,
        };
        res.redirect((0, base_path_1.withBasePath)(`/clients/${req.params.id}`, config_1.config.APP_BASE_PATH));
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Gagal membuat widget key';
        req.session.flash = { type: 'error', message };
        res.redirect((0, base_path_1.withBasePath)(`/clients/${req.params.id}`, config_1.config.APP_BASE_PATH));
    }
}
async function handleRevealSecret(req, res) {
    try {
        const secret = await (0, clients_service_1.getDecryptedSecret)(req.params.id);
        res.json({ success: true, secret });
    }
    catch (err) {
        logger_1.logger.error({ err }, 'handleRevealSecret error');
        res.status(500).json({ success: false, error: 'Gagal mengambil secret' });
    }
}
//# sourceMappingURL=clients.controller.js.map