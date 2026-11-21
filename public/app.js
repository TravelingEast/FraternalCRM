import { el, api, toast, fmtDate, field } from './dom.js';
import { createEditor, MERGE_FIELDS } from './editor.js';

const root = document.getElementById('app');
const state = { me: null, valleys: [], valleyId: null, orient: 'Orient' };
let timer = null;
let leaveHook = null; // set by a screen that needs to save before the user navigates away

const isSuper = () => state.me?.role === 'super_admin';

function remember(key, value) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } }
function recall(key) { try { return localStorage.getItem(key); } catch { return null; } }

// Query string for valley-scoped calls.
function q(extra = {}) {
  const params = new URLSearchParams();
  if (state.valleyId) params.set('valley_id', state.valleyId);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && v !== '') params.set(k, v);
  return `?${params}`;
}

async function guard(fn) {
  try { return await fn(); } catch (err) {
    if (err.status === 401) { state.me = null; return render(); }
    toast(err.message, 'error');
  }
}

// --- Shell ---------------------------------------------------------------------------

const NAV = [
  ['#/', 'Dashboard'], ['#/contacts', 'Contacts'], ['#/lists', 'Lists'],
  ['#/campaigns', 'Campaigns'], ['#/connect', 'Connect'],
];

function shell(main) {
  const hash = location.hash || '#/';
  const links = [...NAV, ...(isSuper() ? [['#/admin', 'Admin']] : [])].map(([href, label]) =>
    el('a', { href, class: hash === href || (href !== '#/' && hash.startsWith(href)) ? 'active' : '' }, label));
  const valleyPicker = isSuper() && state.valleys.length
    ? el('select', {
        'aria-label': 'Valley',
        onchange: (e) => { state.valleyId = Number(e.target.value); remember('frc_valley', state.valleyId); render(); },
      }, state.valleys.map((v) => el('option', { value: v.id, selected: v.id === state.valleyId }, v.name)))
    : !isSuper() ? el('span', {}, state.valleys[0]?.name) : null;
  root.replaceChildren(
    el('header', { class: 'top' },
      el('span', { class: 'title' }, state.orient),
      el('nav', {}, links),
      valleyPicker,
      el('span', { class: 'who' }, state.me.name),
      el('button', { onclick: changePassword }, 'Password'),
      el('button', { onclick: async () => { await api('/api/logout', { method: 'POST' }); state.me = null; render(); } }, 'Sign out')),
    el('main', {}, main));
}

async function changePassword() {
  const current_password = prompt('Current password');
  if (!current_password) return;
  const new_password = prompt('New password (at least 10 characters)');
  if (!new_password) return;
  await guard(async () => { await api('/api/me/password', { method: 'POST', body: { current_password, new_password } }); toast('Password changed'); });
}

function needValley() {
  return el('div', { class: 'card' }, el('h1', {}, 'No valley selected'),
    el('p', {}, isSuper() ? 'Create a valley under Admin, then choose it from the menu at the top.' : 'Your account is not linked to a valley.'));
}

// --- Login -----------------------------------------------------------------------------

function loginPage() {
  const email = el('input', { type: 'email', required: true, autocomplete: 'username' });
  const password = el('input', { type: 'password', required: true, autocomplete: 'current-password' });
  root.replaceChildren(el('div', { class: 'login card' },
    el('h1', {}, 'Sign in'),
    el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try { await api('/api/login', { method: 'POST', body: { email: email.value, password: password.value } }); await boot(); }
        catch (err) { toast(err.message, 'error'); }
      },
    }, field('Email', email), field('Password', password), el('button', { class: 'primary', type: 'submit' }, 'Sign in'))));
}

// --- Dashboard ---------------------------------------------------------------------------

const stat = (n, label) => el('div', { class: 'stat' }, el('b', {}, Number(n ?? 0).toLocaleString()), el('span', {}, label));

async function dashboardPage() {
  if (isSuper()) {
    const { valleys } = await api('/api/stats');
    const sum = (k) => valleys.reduce((a, v) => a + v[k], 0);
    return el('div', {},
      el('h1', {}, 'Statewide overview'),
      el('div', { class: 'stats' }, stat(valleys.length, 'Valleys'), stat(sum('contacts'), 'Contacts'),
        stat(sum('email_reachable'), 'Reachable by email'), stat(sum('sms_reachable'), 'Reachable by text'), stat(sum('sent_30d'), 'Messages, last 30 days')),
      el('div', { class: 'card', style: 'margin-top:16px' }, el('h2', {}, 'By valley'),
        el('div', { class: 'table-wrap' }, el('table', {},
          el('thead', {}, el('tr', {}, ['Valley', 'Contacts', 'Email', 'Text', 'Campaigns sent', 'Last 30 days', ''].map((h) => el('th', {}, h)))),
          el('tbody', {}, valleys.map((v) => el('tr', {},
            el('td', {}, v.name), el('td', {}, v.contacts), el('td', {}, v.email_reachable), el('td', {}, v.sms_reachable),
            el('td', {}, v.campaigns_sent), el('td', {}, v.sent_30d),
            el('td', {}, el('button', { onclick: () => { state.valleyId = v.id; remember('frc_valley', v.id); location.hash = '#/contacts'; } }, 'Open'))))))),
        el('p', { class: 'muted' }, '"Reachable" counts people who agreed to that channel and have not opted out.')));
  }
  if (!state.valleyId) return needValley();
  const { valley: v } = await api(`/api/stats${q()}`);
  return el('div', {}, el('h1', {}, v.name),
    el('div', { class: 'stats' }, stat(v.contacts, 'Contacts'), stat(v.email_reachable, 'Reachable by email'),
      stat(v.sms_reachable, 'Reachable by text'), stat(v.campaigns_sent, 'Campaigns sent'), stat(v.sent_30d, 'Messages, last 30 days')),
    el('div', { class: 'row', style: 'margin-top:16px' },
      el('button', { class: 'primary', onclick: () => { location.hash = '#/campaigns/new'; } }, 'New campaign'),
      el('button', { onclick: () => { location.hash = '#/contacts'; } }, 'Import contacts')));
}

// --- Contacts ------------------------------------------------------------------------------

function consentPill(optIn, suppressed) {
  if (suppressed) return el('span', { class: 'pill bad' }, 'Opted out');
  return optIn ? el('span', { class: 'pill ok' }, 'Agreed') : el('span', { class: 'pill warn' }, 'No consent');
}

async function contactsPage(params) {
  if (!state.valleyId) return needValley();
  const { lists } = await api(`/api/lists${q()}`);
  const view = { offset: 0, search: '', listId: params.get('list') || '' };
  const limit = 50;
  const selected = new Set();
  const tableHost = el('div');
  const pager = el('div', { class: 'row' });
  const bulkList = el('select', {}, el('option', { value: '' }, 'Add selected to list…'), lists.map((l) => el('option', { value: l.id }, l.name)));

  async function load() {
    const data = await api(`/api/contacts${q({ q: view.search, list_id: view.listId, limit, offset: view.offset })}`);
    tableHost.replaceChildren(el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['', 'Name', 'Email', 'Phone', 'Email consent', 'Text consent', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, data.rows.length ? data.rows.map((c) => el('tr', {},
        el('td', {}, el('input', { type: 'checkbox', 'aria-label': 'Select', checked: selected.has(c.id), onchange: (e) => (e.target.checked ? selected.add(c.id) : selected.delete(c.id)) })),
        el('td', {}, [c.first_name, c.last_name].filter(Boolean).join(' ') || '(no name)'),
        el('td', {}, c.email || ''), el('td', {}, c.phone || ''),
        el('td', {}, c.email ? consentPill(c.email_opt_in, c.email_suppressed) : ''),
        el('td', {}, c.phone ? consentPill(c.sms_opt_in, c.sms_suppressed) : ''),
        el('td', {}, el('button', { class: 'danger', onclick: () => guard(async () => {
          if (!confirm('Delete this contact?')) return;
          await api(`/api/contacts/${c.id}${q()}`, { method: 'DELETE' }); load();
        }) }, 'Delete')))) : el('tr', {}, el('td', { colspan: 7, class: 'muted' }, 'No contacts yet. Add one or import a CSV.'))))));
    pager.replaceChildren(
      el('span', { class: 'muted' }, `${data.total.toLocaleString()} contact${data.total === 1 ? '' : 's'}`),
      el('button', { disabled: view.offset === 0, onclick: () => { view.offset -= limit; guard(load); } }, 'Previous'),
      el('button', { disabled: view.offset + limit >= data.total, onclick: () => { view.offset += limit; guard(load); } }, 'Next'));
  }

  // Add form
  const f = Object.fromEntries(['first_name', 'last_name', 'email', 'phone'].map((k) => [k, el('input', { type: k === 'email' ? 'email' : 'text' })]));
  const cEmail = el('input', { type: 'checkbox' });
  const cSms = el('input', { type: 'checkbox' });
  const addForm = el('form', { class: 'card', hidden: true, onsubmit: (e) => { e.preventDefault(); guard(async () => {
    await api('/api/contacts', { method: 'POST', body: { valley_id: state.valleyId, first_name: f.first_name.value, last_name: f.last_name.value,
      email: f.email.value, phone: f.phone.value, email_opt_in: cEmail.checked, sms_opt_in: cSms.checked, list_id: view.listId || undefined } });
    addForm.reset(); toast('Contact saved'); load();
  }); } },
    el('h2', {}, 'Add a contact'),
    el('div', { class: 'row' }, el('div', { class: 'grow' }, field('First name', f.first_name)), el('div', { class: 'grow' }, field('Last name', f.last_name))),
    el('div', { class: 'row' }, el('div', { class: 'grow' }, field('Email', f.email)), el('div', { class: 'grow' }, field('Mobile phone', f.phone))),
    el('label', { class: 'check' }, cEmail, 'This person has agreed to receive email from us'),
    el('label', { class: 'check' }, cSms, 'This person has agreed to receive text messages from us'),
    el('button', { class: 'primary', type: 'submit' }, 'Save contact'));

  // Import form
  const file = el('input', { type: 'file', accept: '.csv,text/csv' });
  const impList = el('select', {}, el('option', { value: '' }, 'Do not add to a list'), lists.map((l) => el('option', { value: l.id }, `Add to: ${l.name}`)));
  const iEmail = el('input', { type: 'checkbox' });
  const iSms = el('input', { type: 'checkbox' });
  const result = el('div');
  const importForm = el('form', { class: 'card', hidden: true, onsubmit: (e) => { e.preventDefault(); guard(async () => {
    if (!file.files[0]) throw new Error('Choose a CSV file first.');
    const s = await api(`/api/contacts/import${q({ list_id: impList.value, consent_email: iEmail.checked ? 1 : '', consent_sms: iSms.checked ? 1 : '' })}`, { method: 'POST', csv: await file.files[0].text() });
    result.replaceChildren(el('div', { class: 'notice' },
      `Read ${s.total} rows: ${s.created} new, ${s.matched} already existed, ${s.skipped} skipped.`,
      s.opted_out_not_resubscribed ? ` ${s.opted_out_not_resubscribed} people had opted out earlier and stay opted out.` : '',
      s.warnings.length ? el('ul', {}, s.warnings.slice(0, 10).map((w) => el('li', {}, `Row ${w.line}: ${w.message}`))) : null));
    load();
  }); } },
    el('h2', {}, 'Import from CSV'),
    el('p', { class: 'muted' }, 'First row must be headings. Recognised columns: first name, last name, name, email, phone, notes. Matching email or phone updates blank fields only.'),
    field('File', file), field('List', impList),
    el('label', { class: 'check' }, iEmail, 'Everyone in this file with an email address has agreed to receive email from us'),
    el('label', { class: 'check' }, iSms, 'Everyone in this file with a phone number has agreed to receive text messages from us'),
    el('p', { class: 'muted' }, 'Only tick these if it is true. Texting people without their permission can violate federal law. Leave both unticked to import without consent; you can add it later.'),
    el('button', { class: 'primary', type: 'submit' }, 'Import'), result);

  const search = el('input', { type: 'search', placeholder: 'Search name, email or phone', class: 'grow', oninput: (e) => { view.search = e.target.value; view.offset = 0; clearTimeout(search._t); search._t = setTimeout(() => guard(load), 250); } });
  const listFilter = el('select', { onchange: (e) => { view.listId = e.target.value; view.offset = 0; guard(load); } },
    el('option', { value: '' }, 'All contacts'), lists.map((l) => el('option', { value: l.id, selected: String(l.id) === String(view.listId) }, l.name)));
  bulkList.addEventListener('change', () => guard(async () => {
    if (!bulkList.value) return;
    if (!selected.size) { bulkList.value = ''; throw new Error('Tick at least one contact first.'); }
    const r = await api(`/api/lists/${bulkList.value}/members${q()}`, { method: 'POST', body: { contact_ids: [...selected] } });
    toast(`Added ${r.added} to the list`); selected.clear(); bulkList.value = ''; load();
  }));

  const page = el('div', {},
    el('h1', {}, 'Contacts'),
    el('div', { class: 'row', style: 'margin-bottom:12px' }, search, listFilter, bulkList,
      el('button', { onclick: () => { addForm.hidden = !addForm.hidden; importForm.hidden = true; } }, 'Add contact'),
      el('button', { onclick: () => { importForm.hidden = !importForm.hidden; addForm.hidden = true; } }, 'Import CSV'),
      el('a', { href: `/api/contacts/export${q({ list_id: view.listId })}` }, el('button', { type: 'button' }, 'Export CSV'))),
    addForm, importForm, tableHost, pager);
  await load();
  return page;
}

// --- Lists -----------------------------------------------------------------------------------

async function listsPage() {
  if (!state.valleyId) return needValley();
  const name = el('input', { placeholder: 'e.g. Stated meeting reminders', class: 'grow' });
  const { lists } = await api(`/api/lists${q()}`);
  return el('div', {}, el('h1', {}, 'Lists'),
    el('form', { class: 'row card', onsubmit: (e) => { e.preventDefault(); guard(async () => {
      await api('/api/lists', { method: 'POST', body: { valley_id: state.valleyId, name: name.value } }); render();
    }); } }, name, el('button', { class: 'primary', type: 'submit' }, 'Create list')),
    el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['List', 'People', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, lists.length ? lists.map((l) => el('tr', {}, el('td', {}, l.name), el('td', {}, l.members),
        el('td', { class: 'row' },
          el('a', { href: `#/contacts?list=${l.id}` }, 'View'),
          el('button', { class: 'danger', onclick: () => guard(async () => {
            if (!confirm(`Delete the list "${l.name}"? The people stay in your contacts.`)) return;
            await api(`/api/lists/${l.id}${q()}`, { method: 'DELETE' }); render();
          }) }, 'Delete')))) : el('tr', {}, el('td', { colspan: 3, class: 'muted' }, 'No lists yet.'))))));
}

// --- Campaigns ---------------------------------------------------------------------------------

const STATUS_PILL = { draft: 'pill', scheduled: 'pill warn', sending: 'pill warn', sent: 'pill ok' };

async function campaignsPage() {
  if (!state.valleyId) return needValley();
  const { campaigns } = await api(`/api/campaigns${q()}`);
  return el('div', {}, el('div', { class: 'row', style: 'margin-bottom:12px' }, el('h1', { class: 'grow', style: 'margin:0' }, 'Campaigns'),
    el('button', { class: 'primary', onclick: () => { location.hash = '#/campaigns/new'; } }, 'New campaign')),
    el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['Name', 'Type', 'Audience', 'Status', 'Sent', 'When'].map((h) => el('th', {}, h)))),
      el('tbody', {}, campaigns.length ? campaigns.map((c) => el('tr', {},
        el('td', {}, el('a', { href: c.status === 'draft' ? `#/campaigns/${c.id}/edit` : `#/campaigns/${c.id}` }, c.name || '(untitled draft)')), el('td', {}, c.channel === 'sms' ? 'Text' : 'Email'),
        el('td', {}, c.list_name || 'All contacts'), el('td', {}, el('span', { class: STATUS_PILL[c.status] }, c.status)),
        el('td', {}, c.recipients ? `${c.sent} of ${c.recipients}${c.failed ? `, ${c.failed} failed` : ''}` : ''),
        el('td', {}, fmtDate(c.sent_at || c.scheduled_at || c.created_at)))) : el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'No campaigns yet.'))))));
}

function smsSegments(text) {
  const unicode = /[^\x00-\x7F]/.test(text);
  const [single, multi] = unicode ? [70, 67] : [160, 153];
  return text.length <= single ? 1 : Math.ceil(text.length / multi);
}

// New and edit share one screen. Everything is autosaved to a server-side draft, so it survives a closed tab or another device.
async function composePage(draftId) {
  let draft = null;
  if (draftId) {
    draft = (await api(`/api/campaigns/${draftId}`)).campaign;
    if (draft.status !== 'draft') { location.hash = `#/campaigns/${draftId}`; return el('div'); }
    if (draft.valley_id !== state.valleyId) { state.valleyId = draft.valley_id; remember('frc_valley', state.valleyId); }
  }
  if (!state.valleyId) return needValley();
  const { lists } = await api(`/api/lists${q()}`);

  let channel = draft?.channel || 'email';
  const name = el('input', { required: true, placeholder: 'e.g. December stated meeting', value: draft?.name || '' });
  const subject = el('input', { placeholder: 'Subject line', value: draft?.subject || '' });
  const audience = el('select', {}, el('option', { value: '' }, 'All contacts'),
    lists.map((l) => el('option', { value: l.id, selected: l.id === draft?.list_id }, `${l.name} (${l.members})`)));
  const when = el('input', { type: 'datetime-local' });
  const editor = createEditor();
  if (draft?.body_html) editor.setHtml(draft.body_html);
  const sms = el('textarea', { placeholder: 'Write your text message', maxlength: 1600 });
  if (draft && draft.channel === 'sms') sms.value = draft.body;
  const counter = el('div', { class: 'counter' });
  const status = el('span', { class: 'muted' }, draft ? 'Draft loaded' : 'Not saved yet');

  const smsBox = el('div', { hidden: channel !== 'sms' }, sms, counter,
    el('div', { class: 'row' }, MERGE_FIELDS.filter(([k]) => k !== 'unsubscribe_url').map(([k, label]) => el('button', { type: 'button', onclick: () => {
      const pos = sms.selectionStart ?? sms.value.length; sms.setRangeText(`{{${k}}}`, pos, sms.selectionEnd ?? pos, 'end'); sms.focus(); sms.dispatchEvent(new Event('input'));
    } }, `+ ${label}`))),
    el('p', { class: 'muted' }, '"Reply STOP to opt out." is added to every text automatically.'));
  const emailBox = el('div', { hidden: channel !== 'email' }, field('Subject', subject), el('div', { class: 'field' }, 'Message', editor.node));
  sms.addEventListener('input', () => { const n = smsSegments(sms.value); counter.textContent = `${sms.value.length} characters, about ${n} text segment${n === 1 ? '' : 's'}`; });
  sms.dispatchEvent(new Event('input'));

  // --- autosave ---
  let id = draftId ? Number(draftId) : null;
  let dirty = false;
  let timer2 = null;
  let chain = Promise.resolve();
  const isBlank = () => !name.value.trim() && !subject.value.trim() && editor.isEmpty() && !sms.value.trim();
  const payload = () => ({
    valley_id: state.valleyId, name: name.value, channel, subject: subject.value, list_id: audience.value || null,
    ...(channel === 'email' ? { body: '', body_html: editor.isEmpty() ? '' : editor.getHtml() } : { body: sms.value, body_html: '' }),
  });
  async function doSave() {
    if (!dirty) return;
    if (!id && isBlank()) { dirty = false; return; }
    status.textContent = 'Saving…';
    const body = payload();
    dirty = false;
    try {
      const res = id
        ? await api(`/api/campaigns/${id}`, { method: 'PATCH', body })
        : await api('/api/campaigns', { method: 'POST', body: { ...body, draft: true } });
      if (!id) { id = res.campaign.id; history.replaceState(null, '', `#/campaigns/${id}/edit`); }
      status.textContent = `Saved ${new Date().toLocaleTimeString([], { timeStyle: 'short' })}`;
    } catch (err) {
      dirty = true;
      status.textContent = `Not saved: ${err.message}`;
      throw err;
    }
  }
  // Saves run one at a time, in order, so a slow save never overwrites a newer one.
  const save = () => { clearTimeout(timer2); chain = chain.catch(() => {}).then(doSave); return chain; };
  const touch = () => {
    dirty = true; status.textContent = 'Unsaved changes';
    clearTimeout(timer2); timer2 = setTimeout(() => save().catch(() => {}), 1500);
  };
  [name, subject, sms].forEach((n) => n.addEventListener('input', touch));
  audience.addEventListener('change', touch);
  editor.onChange(touch);
  window.onbeforeunload = () => (dirty ? true : undefined);
  leaveHook = async () => { try { await save(); } catch { /* status line already shows the error */ } };

  const radio = (value, label) => el('label', { class: 'check' }, el('input', { type: 'radio', name: 'channel', value, checked: value === channel, onchange: () => {
    channel = value; emailBox.hidden = value !== 'email'; smsBox.hidden = value !== 'sms'; touch(); } }), label);

  const leaveTo = (hash) => { dirty = false; leaveHook = null; location.hash = hash; };
  const saveNow = async () => { dirty = true; await save(); if (!id) throw new Error('Add a name and a message first.'); };

  return el('div', {}, el('div', { class: 'row', style: 'margin-bottom:12px' }, el('h1', { class: 'grow', style: 'margin:0' }, draftId ? 'Edit draft' : 'New campaign'), status),
    el('div', { class: 'card' },
      field('Name (only you see this)', name),
      el('div', { class: 'row' }, radio('email', 'Email'), radio('sms', 'Text message')),
      field('Send to', audience), emailBox, smsBox,
      el('p', { class: 'muted' }, 'Insert fields like first name from the editor. They are filled in for each person. Your work saves automatically.'),
      field('Schedule for later (optional)', when),
      el('div', { class: 'row' },
        el('button', { onclick: () => guard(async () => { await saveNow(); toast('Draft saved'); }) }, 'Save draft'),
        el('button', { onclick: () => guard(async () => {
          if (!when.value) throw new Error('Pick a date and time to schedule.');
          await saveNow();
          await api(`/api/campaigns/${id}/schedule`, { method: 'POST', body: { scheduled_at: new Date(when.value).toISOString() } });
          leaveTo(`#/campaigns/${id}`);
        }) }, 'Schedule'),
        el('button', { class: 'primary', onclick: () => guard(async () => {
          const who = audience.options[audience.selectedIndex].text;
          if (!confirm(`Send "${name.value}" now to ${who}? People who have not agreed to receive ${channel === 'sms' ? 'texts' : 'email'}, or who opted out, are skipped automatically.`)) return;
          await saveNow();
          await api(`/api/campaigns/${id}/send`, { method: 'POST' });
          leaveTo(`#/campaigns/${id}`);
        }) }, 'Send now'))));
}

async function campaignDetailPage(id) {
  const { campaign: c } = await api(`/api/campaigns/${id}`);
  const filter = el('select', { onchange: () => guard(loadMessages) }, ['', 'failed', 'skipped', 'sent', 'pending'].map((s) => el('option', { value: s }, s ? `Show ${s}` : 'Show all')));
  const tbody = el('tbody');
  async function loadMessages() {
    const { messages } = await api(`/api/campaigns/${id}/messages${q({ status: filter.value })}`);
    tbody.replaceChildren(...messages.map((m) => el('tr', {}, el('td', {}, [m.first_name, m.last_name].filter(Boolean).join(' ')), el('td', {}, m.to_address || ''),
      el('td', {}, el('span', { class: m.status === 'sent' ? 'pill ok' : m.status === 'failed' ? 'pill bad' : 'pill' }, m.status)), el('td', {}, m.reason || ''))));
  }
  const canStart = c.status === 'draft' || c.status === 'scheduled';
  if (c.status === 'sending') timer = setInterval(() => guard(render), 5000);
  const page = el('div', {}, el('h1', {}, c.name),
    c.status === 'scheduled' ? el('div', { class: 'notice' }, 'To change a scheduled campaign, cancel the schedule first. It returns to a draft you can edit.') : null,
    el('p', {}, el('span', { class: STATUS_PILL[c.status] }, c.status), ` ${c.channel === 'sms' ? 'Text message' : 'Email'} to ${c.list_name || 'all contacts'}`,
      c.scheduled_at && c.status === 'scheduled' ? ` · goes out ${fmtDate(c.scheduled_at)}` : ''),
    el('div', { class: 'stats' }, stat(c.counts.sent, 'Sent'), stat(c.counts.pending, 'Waiting'), stat(c.counts.failed, 'Failed'), stat(c.counts.skipped, 'Skipped')),
    el('div', { class: 'card', style: 'margin-top:16px' }, c.channel === 'email' ? el('h2', {}, c.subject) : null,
      c.channel === 'email' && c.body_html ? el('iframe', { sandbox: '', title: 'Message', style: 'width:100%;height:320px;border:1px solid var(--line);background:#fff', srcdoc: c.body_html }) : el('pre', { style: 'white-space:pre-wrap' }, c.body)),
    el('div', { class: 'row', style: 'margin-bottom:16px' },
      c.status === 'draft' ? el('button', { onclick: () => { location.hash = `#/campaigns/${id}/edit`; } }, 'Edit') : null,
      canStart ? el('button', { class: 'primary', onclick: () => guard(async () => { if (!confirm('Send this campaign now?')) return; await api(`/api/campaigns/${id}/send`, { method: 'POST' }); render(); }) }, 'Send now') : null,
      c.status === 'scheduled' ? el('button', { onclick: () => guard(async () => { await api(`/api/campaigns/${id}/cancel`, { method: 'POST' }); render(); }) }, 'Cancel schedule') : null,
      canStart ? el('button', { class: 'danger', onclick: () => guard(async () => { if (!confirm('Delete this campaign?')) return; await api(`/api/campaigns/${id}`, { method: 'DELETE' }); location.hash = '#/campaigns'; }) }, 'Delete') : null),
    c.total ? el('div', {}, el('div', { class: 'row', style: 'margin-bottom:8px' }, el('h2', { class: 'grow', style: 'margin:0' }, 'Recipients (first 500)'), filter),
      el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['Name', 'Sent to', 'Status', 'Note'].map((h) => el('th', {}, h)))), tbody))) : null);
  if (c.total) await loadMessages();
  return page;
}

// --- Connect (API keys) -----------------------------------------------------------------------------

async function connectPage() {
  if (!state.valleyId) return needValley();
  const label = el('input', { placeholder: 'e.g. Membership database', class: 'grow' });
  const shown = el('div');
  const { keys } = await api(`/api/api-keys${q()}`);
  const origin = location.origin;
  return el('div', {}, el('h1', {}, 'Connect to other systems'),
    el('p', {}, 'API keys let your membership database, website forms or Zapier-style tools add contacts and send campaigns for this valley. Each key only works for this valley.'),
    el('form', { class: 'row card', onsubmit: (e) => { e.preventDefault(); guard(async () => {
      const k = await api('/api/api-keys', { method: 'POST', body: { valley_id: state.valleyId, label: label.value } });
      shown.replaceChildren(el('div', { class: 'notice' }, 'Copy this key now. It will not be shown again.', el('pre', {}, k.key))); label.value = '';
    }); } }, label, el('button', { class: 'primary', type: 'submit' }, 'Create key')), shown,
    el('div', { class: 'table-wrap', style: 'margin-bottom:16px' }, el('table', {}, el('thead', {}, el('tr', {}, ['Label', 'Created', 'Last used', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, keys.length ? keys.map((k) => el('tr', {}, el('td', {}, k.label), el('td', {}, fmtDate(k.created_at)), el('td', {}, fmtDate(k.last_used_at) || 'never'),
        el('td', {}, k.revoked_at ? el('span', { class: 'pill bad' }, 'revoked') : el('button', { class: 'danger', onclick: () => guard(async () => { if (!confirm('Revoke this key?')) return; await api(`/api/api-keys/${k.id}${q()}`, { method: 'DELETE' }); render(); }) }, 'Revoke')))) : el('tr', {}, el('td', { colspan: 4, class: 'muted' }, 'No keys yet.'))))),
    el('div', { class: 'card' }, el('h2', {}, 'Example: add a contact'),
      el('pre', {}, `curl -X POST ${origin}/api/v1/contacts \\\n  -H "Authorization: Bearer YOUR_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"first_name":"Sam","email":"sam@example.org","phone":"555-123-4567","email_opt_in":true}'`),
      el('p', { class: 'muted' }, 'Set email_opt_in or sms_opt_in to true only when the person agreed to that channel. Endpoints: GET/POST /api/v1/contacts, GET/POST /api/v1/lists, POST /api/v1/lists/:id/members, POST /api/v1/campaigns, POST /api/v1/campaigns/:id/send, GET /api/v1/campaigns/:id.')));
}

// --- Admin (statewide) --------------------------------------------------------------------------------

async function adminPage() {
  if (!isSuper()) return el('div', { class: 'card' }, 'Statewide administrators only.');
  const [{ valleys }, { users }] = await Promise.all([api('/api/valleys'), api('/api/users')]);
  const vName = el('input', { required: true, class: 'grow', placeholder: 'Valley name' });
  const vCity = el('input', { class: 'grow', placeholder: 'City' });
  const u = { email: el('input', { type: 'email', required: true }), name: el('input', { required: true }), password: el('input', { type: 'password', required: true, minlength: 10, autocomplete: 'new-password' }),
    role: el('select', {}, el('option', { value: 'valley_admin' }, 'Valley admin'), el('option', { value: 'super_admin' }, 'Statewide admin')),
    valley: el('select', {}, valleys.map((v) => el('option', { value: v.id }, v.name))) };
  return el('div', {}, el('h1', {}, 'Administration'),
    el('div', { class: 'card' }, el('h2', {}, 'Valleys'),
      el('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); guard(async () => {
        await api('/api/valleys', { method: 'POST', body: { name: vName.value, city: vCity.value } }); await boot(); location.hash = '#/admin'; }); } },
        vName, vCity, el('button', { class: 'primary', type: 'submit' }, 'Add valley')),
      el('ul', {}, valleys.map((v) => el('li', {}, v.name, v.city ? ` (${v.city})` : '')))),
    el('div', { class: 'card' }, el('h2', {}, 'Add an administrator'),
      el('form', { onsubmit: (e) => { e.preventDefault(); guard(async () => {
        await api('/api/users', { method: 'POST', body: { email: u.email.value, name: u.name.value, password: u.password.value, role: u.role.value, valley_id: u.role.value === 'valley_admin' ? u.valley.value : undefined } });
        toast('Administrator added'); render(); }); } },
        el('div', { class: 'row' }, el('div', { class: 'grow' }, field('Name', u.name)), el('div', { class: 'grow' }, field('Email', u.email))),
        el('div', { class: 'row' }, el('div', { class: 'grow' }, field('Role', u.role)), el('div', { class: 'grow' }, field('Valley', u.valley)), el('div', { class: 'grow' }, field('Temporary password (10+ characters)', u.password))),
        el('button', { class: 'primary', type: 'submit' }, 'Add administrator'))),
    el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['Name', 'Email', 'Role', 'Valley', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, users.map((x) => el('tr', {}, el('td', {}, x.name), el('td', {}, x.email), el('td', {}, x.role === 'super_admin' ? 'Statewide' : 'Valley'), el('td', {}, x.valley_name || ''),
        el('td', { class: 'row' },
          el('button', { onclick: () => guard(async () => { const p = prompt(`New password for ${x.email} (10+ characters)`); if (!p) return; await api(`/api/users/${x.id}`, { method: 'PATCH', body: { password: p } }); toast('Password reset'); }) }, 'Reset password'),
          x.id === state.me.id ? null : el('button', { class: x.active ? 'danger' : '', onclick: () => guard(async () => { await api(`/api/users/${x.id}`, { method: 'PATCH', body: { active: !x.active } }); render(); }) }, x.active ? 'Disable' : 'Enable'))))))));
}

// --- Router -----------------------------------------------------------------------------------------------

async function render() {
  clearInterval(timer);
  if (leaveHook) { const hook = leaveHook; leaveHook = null; await hook(); }
  window.onbeforeunload = null;
  if (!state.me) return loginPage();
  const [path, query = ''] = (location.hash.slice(1) || '/').split('?');
  const params = new URLSearchParams(query);
  const campaignId = /^\/campaigns\/(\d+)$/.exec(path)?.[1];
  const editId = /^\/campaigns\/(\d+)\/edit$/.exec(path)?.[1];
  const routes = {
    '/': dashboardPage, '/contacts': () => contactsPage(params), '/lists': listsPage, '/campaigns': campaignsPage,
    '/campaigns/new': () => composePage(null), '/connect': connectPage, '/admin': adminPage,
  };
  const handler = editId ? () => composePage(editId) : campaignId ? () => campaignDetailPage(campaignId) : routes[path] || dashboardPage;
  try { shell(await handler()); } catch (err) {
    if (err.status === 401) { state.me = null; return loginPage(); }
    shell(el('div', { class: 'card' }, el('h1', {}, 'Something went wrong'), el('p', {}, err.message)));
  }
}

async function boot() {
  try {
    const me = await api('/api/me');
    state.me = me.user; state.valleys = me.valleys; state.orient = me.orient;
    const saved = Number(recall('frc_valley'));
    state.valleyId = me.valleys.find((v) => v.id === saved)?.id ?? me.valleys[0]?.id ?? null;
  } catch { state.me = null; }
  render();
}

window.addEventListener('hashchange', render);
boot();
