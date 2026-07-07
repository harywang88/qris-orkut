"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.crc16Ccitt = crc16Ccitt;
exports.buildDynamicQrisPayload = buildDynamicQrisPayload;
function encodeField(field) {
    return `${field.tag}${field.value.length.toString().padStart(2, '0')}${field.value}`;
}
function parseTlv(payload) {
    const fields = [];
    let index = 0;
    while (index + 4 <= payload.length) {
        const tag = payload.slice(index, index + 2);
        const lenRaw = payload.slice(index + 2, index + 4);
        const length = Number.parseInt(lenRaw, 10);
        if (!Number.isFinite(length) || length < 0) {
            throw new Error(`Invalid TLV length for tag ${tag}`);
        }
        const valueStart = index + 4;
        const valueEnd = valueStart + length;
        if (valueEnd > payload.length) {
            throw new Error(`TLV value for tag ${tag} exceeds payload length`);
        }
        fields.push({ tag, value: payload.slice(valueStart, valueEnd) });
        index = valueEnd;
    }
    if (index !== payload.length) {
        throw new Error('Trailing bytes found in QRIS payload');
    }
    return fields;
}
function crc16Ccitt(payload) {
    let crc = 0xffff;
    for (let i = 0; i < payload.length; i += 1) {
        crc ^= payload.charCodeAt(i) << 8;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) : (crc << 1);
            crc &= 0xffff;
        }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
}
function upsertPointOfInitiationMethod(fields) {
    const next = [...fields];
    const existingIndex = next.findIndex((field) => field.tag === '01');
    if (existingIndex >= 0) {
        next[existingIndex] = { tag: '01', value: '12' };
        return next;
    }
    const merchantPayloadIndex = next.findIndex((field) => field.tag === '00');
    const insertAt = merchantPayloadIndex >= 0 ? merchantPayloadIndex + 1 : 0;
    next.splice(insertAt, 0, { tag: '01', value: '12' });
    return next;
}
function upsertTransactionAmount(fields, amount) {
    const next = fields.filter((field) => field.tag !== '54' && field.tag !== '63');
    const amountField = { tag: '54', value: String(amount) };
    const insertBeforeTags = new Set(['55', '56', '57', '58', '59', '60', '61', '62']);
    const insertAt = next.findIndex((field) => insertBeforeTags.has(field.tag));
    if (insertAt >= 0) {
        next.splice(insertAt, 0, amountField);
    }
    else {
        next.push(amountField);
    }
    return next;
}
function buildDynamicQrisPayload(staticPayload, amount) {
    if (!Number.isInteger(amount) || amount < 1) {
        throw new Error('QRIS amount must be a positive integer');
    }
    const parsed = parseTlv(staticPayload);
    const withPoiMethod = upsertPointOfInitiationMethod(parsed.filter((field) => field.tag !== '63'));
    const withAmount = upsertTransactionAmount(withPoiMethod, amount);
    const withoutCrc = withAmount.map(encodeField).join('');
    const payloadForCrc = `${withoutCrc}6304`;
    return `${payloadForCrc}${crc16Ccitt(payloadForCrc)}`;
}
//# sourceMappingURL=qris-payload.js.map