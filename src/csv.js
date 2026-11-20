// RFC 4180 parser: quoted fields, embedded commas/newlines, doubled quotes, CRLF or LF, UTF-8 BOM.
export function parseCsv(text) {
  const s = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += c;
        i += 1;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r' || c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += c === '\r' && s[i + 1] === '\n' ? 2 : 1;
      continue;
    } else {
      field += c;
    }
    i += 1;
  }
  if (inQuotes) throw new Error('CSV has an unclosed quoted field');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop fully blank lines.
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  // Neutralise spreadsheet formulas (=, @, leading tab/CR, or +/- not followed by a digit).
  if (/^[=@\t\r]/.test(s) || /^[+-](?!\d)/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
