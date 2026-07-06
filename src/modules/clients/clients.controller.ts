import { Request, Response } from 'express';
import { z } from 'zod';
import {
  listClients,
  getClientById,
  createClient,
  updateClient,
  deleteClient,
  rotateApiSecret,
  rotateWidgetKey,
  getDecryptedSecret,
} from './clients.service';
import { config } from '../../config';
import { logger } from '../../config/logger';
import { withBasePath } from '../../core/base-path';

const CreateClientSchema = z.object({
  name: z.string().min(1).max(100),
  panelCode: z
    .string()
    .min(1)
    .max(10)
    .regex(/^[A-Z0-9]+$/i, 'Panel code only alphanumeric characters'),
  callbackUrl: z.string().url().optional().or(z.literal('')),
  depositApiUrl: z.string().url().optional().or(z.literal('')),
  depositApiKey: z.string().max(255).optional(),
  widgetAllowedOrigins: z.string().max(1000).optional(),
});

const UpdateClientSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  callbackUrl: z.string().url().optional().or(z.literal('')),
  depositApiUrl: z.string().url().optional().or(z.literal('')),
  depositApiKey: z.string().max(255).optional(),
  widgetAllowedOrigins: z.string().max(1000).optional(),
});

export async function showClientList(req: Request, res: Response): Promise<void> {
  try {
    const clients = await listClients();
    res.render('clients/index', {
      title: 'Kelola Klien',
      clients,
    });
  } catch (err) {
    logger.error({ err }, 'showClientList error');
    res.status(500).render('error/500', { title: 'Error' });
  }
}

export async function showNewClientForm(req: Request, res: Response): Promise<void> {
  res.render('clients/form', {
    title: 'Tambah Klien',
    client: null,
    errors: null,
  });
}

export async function handleCreateClient(req: Request, res: Response): Promise<void> {
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
    const { client, rawSecret } = await createClient(parsed.data);
    req.session.flash = {
      type: 'success',
      message: `Klien "${client.name}" berhasil dibuat. API Secret: ${rawSecret} (simpan segera, tidak akan ditampilkan lagi)`,
    };
    res.redirect(withBasePath(`/clients/${client.id}`, config.APP_BASE_PATH));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Gagal membuat klien';
    res.render('clients/form', {
      title: 'Tambah Klien',
      client: null,
      errors: { _form: [message] },
    });
  }
}

export async function showClientDetail(req: Request, res: Response): Promise<void> {
  try {
    const client = await getClientById(req.params.id);
    if (!client) {
      res.status(404).render('error/404', { title: 'Tidak Ditemukan' });
      return;
    }
    res.render('clients/detail', {
      title: `Klien: ${client.name}`,
      client,
      newSecret: null,
    });
  } catch (err) {
    logger.error({ err }, 'showClientDetail error');
    res.status(500).render('error/500', { title: 'Error' });
  }
}

export async function showEditClientForm(req: Request, res: Response): Promise<void> {
  try {
    const client = await getClientById(req.params.id);
    if (!client) {
      res.status(404).render('error/404', { title: 'Tidak Ditemukan' });
      return;
    }
    res.render('clients/form', {
      title: `Edit Klien: ${client.name}`,
      client,
      errors: null,
    });
  } catch (err) {
    logger.error({ err }, 'showEditClientForm error');
    res.status(500).render('error/500', { title: 'Error' });
  }
}

export async function handleUpdateClient(req: Request, res: Response): Promise<void> {
  const parsed = UpdateClientSchema.safeParse(req.body);
  if (!parsed.success) {
    const client = await getClientById(req.params.id);
    res.render('clients/form', {
      title: 'Edit Klien',
      client,
      errors: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  try {
    await updateClient(req.params.id, parsed.data);
    req.session.flash = { type: 'success', message: 'Klien berhasil diperbarui.' };
    res.redirect(withBasePath(`/clients/${req.params.id}`, config.APP_BASE_PATH));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Gagal memperbarui klien';
    req.session.flash = { type: 'error', message };
    res.redirect(withBasePath(`/clients/${req.params.id}`, config.APP_BASE_PATH));
  }
}

export async function handleDeleteClient(req: Request, res: Response): Promise<void> {
  try {
    await deleteClient(req.params.id);
    req.session.flash = { type: 'success', message: 'Klien berhasil dihapus.' };
    res.redirect(withBasePath('/clients', config.APP_BASE_PATH));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Gagal menghapus klien';
    req.session.flash = { type: 'error', message };
    res.redirect(withBasePath('/clients', config.APP_BASE_PATH));
  }
}

export async function handleRotateSecret(req: Request, res: Response): Promise<void> {
  try {
    const newSecret = await rotateApiSecret(req.params.id);
    const client = await getClientById(req.params.id);
    res.render('clients/detail', {
      title: `Klien: ${client?.name}`,
      client,
      newSecret,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Gagal merotasi secret';
    req.session.flash = { type: 'error', message };
    res.redirect(withBasePath(`/clients/${req.params.id}`, config.APP_BASE_PATH));
  }
}

export async function handleRotateWidgetKey(req: Request, res: Response): Promise<void> {
  try {
    const widgetKey = await rotateWidgetKey(req.params.id);
    req.session.flash = {
      type: 'success',
      message: `Widget key baru: ${widgetKey}`,
    };
    res.redirect(withBasePath(`/clients/${req.params.id}`, config.APP_BASE_PATH));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Gagal membuat widget key';
    req.session.flash = { type: 'error', message };
    res.redirect(withBasePath(`/clients/${req.params.id}`, config.APP_BASE_PATH));
  }
}

export async function handleRevealSecret(req: Request, res: Response): Promise<void> {
  try {
    const secret = await getDecryptedSecret(req.params.id);
    res.json({ success: true, secret });
  } catch (err) {
    logger.error({ err }, 'handleRevealSecret error');
    res.status(500).json({ success: false, error: 'Gagal mengambil secret' });
  }
}
