// Pemetaan WEBSITE (Client API) -> SITE. Dipakai generateQr agar QR website hanya digenerate di akun site-nya
// (cegah deposit satu website nyasar ke akun site lain). Sidecar data/client-sites.json { "<clientId>": "<siteId>" }.
import fs from 'fs';
import path from 'path';

const FILE = path.join(process.cwd(), 'data', 'client-sites.json');
type ClientSiteMap = Record<string, string>; // clientId -> siteId

function load(): ClientSiteMap {
  try {
    return (JSON.parse(fs.readFileSync(FILE, 'utf8')) as ClientSiteMap) || {};
  } catch {
    return {};
  }
}

export function getSiteForClient(clientId: string | null | undefined): string | null {
  if (!clientId) return null;
  const v = load()[clientId];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function setSiteForClient(clientId: string, siteId: string | null | undefined): void {
  if (!clientId) throw new Error('clientId wajib diisi');
  const map = load();
  const sid = String(siteId || '').trim();
  if (!sid) delete map[clientId];
  else map[clientId] = sid;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(map, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}

export function listClientSites(): ClientSiteMap {
  return load();
}
