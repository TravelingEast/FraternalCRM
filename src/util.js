export const nowIso = () => new Date().toISOString();

export const str = (value) => (value === null || value === undefined ? '' : String(value).trim());

export function cleanText(value, max = 255) {
  return str(value).slice(0, max);
}

export function optionalInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function flag(value) {
  return value === true || value === 'true' || value === '1' || value === 'yes';
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
