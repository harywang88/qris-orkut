export function normalizeBasePath(rawPath: string | undefined | null): string {
  const value = String(rawPath ?? '').trim();
  if (!value || value === '/') {
    return '';
  }

  const normalized = `/${value.replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '' : normalized;
}

export function withBasePath(pathname: string, basePath?: string): string {
  const normalizedBasePath = normalizeBasePath(basePath);
  const cleanPath = pathname.startsWith('/') ? pathname : `/${pathname}`;

  if (!normalizedBasePath) {
    return cleanPath;
  }

  if (cleanPath === normalizedBasePath || cleanPath.startsWith(`${normalizedBasePath}/`)) {
    return cleanPath;
  }

  return `${normalizedBasePath}${cleanPath}`;
}
