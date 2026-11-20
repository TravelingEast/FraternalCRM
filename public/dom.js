// Tiny DOM helpers. Text is always set as text nodes, never as HTML, so user data cannot inject markup.
export function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'value') node.value = value;
    else if (key === 'checked') node.checked = true;
    else if (key === 'disabled') node.disabled = true;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export async function api(path, { method = 'GET', body, csv } = {}) {
  const init = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (csv !== undefined) {
    init.headers['Content-Type'] = 'text/csv';
    init.body = csv;
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function toast(message, kind = 'info') {
  const node = el('div', { class: `toast ${kind === 'error' ? 'error' : ''}`, role: 'status' }, message);
  document.body.append(node);
  setTimeout(() => node.remove(), kind === 'error' ? 6000 : 3000);
}

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function field(label, input) {
  return el('label', { class: 'field' }, label, input);
}
