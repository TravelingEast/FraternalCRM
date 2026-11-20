import { el, toast } from './dom.js';

export const MERGE_FIELDS = [
  ['first_name', 'First name'],
  ['last_name', 'Last name'],
  ['name', 'Full name'],
  ['valley', 'Valley name'],
  ['unsubscribe_url', 'Unsubscribe link'],
];

// WYSIWYG editor for email bodies. Produces HTML; the server sanitises it again before saving.
export function createEditor({ placeholder = 'Write your message…' } = {}) {
  const area = el('div', { class: 'area', contenteditable: 'true', 'data-placeholder': placeholder, role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Message body' });
  const previewHost = el('div', { class: 'preview', hidden: true });
  let mode = 'edit';

  const run = (command, value = null) => {
    area.focus();
    document.execCommand(command, false, value);
  };
  // mousedown is cancelled so clicking a toolbar button does not drop the text selection.
  const button = (label, title, onclick, extra = {}) =>
    el('button', { type: 'button', title, 'aria-label': title, onmousedown: (e) => e.preventDefault(), onclick, ...extra }, label);

  const blockSelect = el(
    'select',
    { title: 'Text style', 'aria-label': 'Text style', onchange: (e) => { run('formatBlock', e.target.value); e.target.value = ''; } },
    el('option', { value: '' }, 'Style'),
    el('option', { value: 'p' }, 'Paragraph'),
    el('option', { value: 'h1' }, 'Heading'),
    el('option', { value: 'h2' }, 'Subheading'),
    el('option', { value: 'blockquote' }, 'Quote'),
  );

  const mergeSelect = el(
    'select',
    {
      title: 'Insert a field that is filled in for each person',
      'aria-label': 'Insert merge field',
      onchange: (e) => {
        if (e.target.value) run('insertText', `{{${e.target.value}}}`);
        e.target.value = '';
      },
    },
    el('option', { value: '' }, 'Insert field…'),
    MERGE_FIELDS.map(([key, label]) => el('option', { value: key }, label)),
  );

  const addLink = () => {
    const url = (prompt('Link address (https://… or mailto:…)') || '').trim();
    if (!url) return;
    if (!/^(https?:\/\/|mailto:)/i.test(url)) return toast('Links must start with https://, http:// or mailto:', 'error');
    if (window.getSelection().isCollapsed) run('insertHTML', `<a href="${url.replace(/"/g, '&quot;')}">${url.replace(/[<>&"]/g, '')}</a>`);
    else run('createLink', url);
  };

  const addImage = () => {
    const url = (prompt('Image address (https://…). The image must already be hosted online.') || '').trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) return toast('Image addresses must start with https:// or http://', 'error');
    run('insertImage', url);
  };

  const toolbar = el(
    'div',
    { class: 'toolbar' },
    blockSelect,
    button(el('b', {}, 'B'), 'Bold', () => run('bold')),
    button(el('i', {}, 'I'), 'Italic', () => run('italic')),
    button(el('u', {}, 'U'), 'Underline', () => run('underline')),
    el('span', { class: 'sep' }),
    button('• List', 'Bulleted list', () => run('insertUnorderedList')),
    button('1. List', 'Numbered list', () => run('insertOrderedList')),
    el('span', { class: 'sep' }),
    button('Left', 'Align left', () => run('justifyLeft')),
    button('Center', 'Center', () => run('justifyCenter')),
    el('span', { class: 'sep' }),
    button('Link', 'Add a link', addLink),
    button('Image', 'Add an image from a web address', addImage),
    button('Line', 'Horizontal line', () => run('insertHorizontalRule')),
    button('Clear', 'Remove formatting', () => run('removeFormat')),
    el('span', { class: 'sep' }),
    mergeSelect,
    el(
      'span',
      { class: 'tabs' },
      button('Edit', 'Edit', () => setMode('edit'), { class: 'on', 'data-tab': 'edit' }),
      button('Preview', 'Preview', () => setMode('preview'), { 'data-tab': 'preview' }),
    ),
  );

  // Pasted content is reduced to plain text. This avoids dragging in hidden markup from Word or web pages.
  area.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text);
  });

  function sampleHtml() {
    const sample = { first_name: 'Alex', last_name: 'Sample', name: 'Alex Sample', valley: 'Your Valley', unsubscribe_url: '#' };
    return area.innerHTML.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, k) => sample[k] ?? '');
  }

  function setMode(next) {
    mode = next;
    toolbar.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === next));
    if (next === 'preview') {
      // A sandboxed iframe with no permissions: nothing in the preview can run code.
      const frame = el('iframe', { sandbox: '', style: 'width:100%;min-height:340px;border:0;background:#fff', title: 'Email preview' });
      frame.srcdoc = `<body style="font-family:Georgia,serif;font-size:16px;line-height:1.5;padding:16px;max-width:640px;margin:auto">${sampleHtml()}<hr><p style="font-size:12px;color:#555">Unsubscribe link appears here.</p></body>`;
      previewHost.replaceChildren(frame);
    }
    area.hidden = next === 'preview';
    previewHost.hidden = next !== 'preview';
  }

  const root = el('div', { class: 'editor' }, toolbar, area, previewHost);
  return {
    node: root,
    getHtml: () => area.innerHTML,
    isEmpty: () => !area.textContent.trim() && !area.querySelector('img'),
    focus: () => area.focus(),
    get mode() { return mode; },
  };
}
