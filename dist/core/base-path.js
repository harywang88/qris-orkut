"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeBasePath = normalizeBasePath;
exports.withBasePath = withBasePath;
function normalizeBasePath(rawPath) {
    const value = String(rawPath ?? '').trim();
    if (!value || value === '/') {
        return '';
    }
    const normalized = `/${value.replace(/^\/+|\/+$/g, '')}`;
    return normalized === '/' ? '' : normalized;
}
function withBasePath(pathname, basePath) {
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
//# sourceMappingURL=base-path.js.map