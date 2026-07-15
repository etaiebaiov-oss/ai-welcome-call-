const XLSX = require('xlsx');

// Fuzzy header matching so the import survives small column renames.
const COLUMN_MATCHERS = {
  name: (h) => h.includes('homeowner name') || h === 'name' || h.includes('customer name'),
  address: (h) => h.includes('address'),
  phone: (h) => h.includes('phone'),
  email: (h) => h.includes('email'),
  installer: (h) => h.includes('installer'),
  offset: (h) => h.includes('offset'),
  monthly_payment: (h) => h.includes('monthly payment') || h === 'payment',
  escalator: (h) => h.includes('escalator'),
  stage: (h) => h === 'stage' || h.includes('deal stage'),
  finance: (h) => h.includes('finance'),
  ntp: (h) => h.includes('ntp'),
  submitted: (h) => h.includes('submitted'),
  notes: (h) => h.includes('note'),
  panels: (h) => h.includes('panel'),
  usage: (h) => h.includes('usage'),
  production: (h) => h.includes('production'),
  survey: (h) => h.includes('survey'),
  change_order: (h) => h.includes('change order') || h.includes('resign'),
  rep: (h) => h === 'rep' || h.includes('sales rep'),
};

const EMPTY_VALUES = new Set(['', '—', '-', '–', 'n/a', 'na', 'none', 'null']);

function cleanCell(value) {
  const s = String(value == null ? '' : value).trim();
  return EMPTY_VALUES.has(s.toLowerCase()) ? '' : s;
}

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (national.length !== 10) return null;
  return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
}

// Offsets arrive as ratios (1.1162), percentages (111.62) or strings ("112%").
function normalizeOffset(raw) {
  const s = cleanCell(raw);
  if (!s) return null;
  if (s.includes('%')) return s;
  const v = parseFloat(s);
  if (Number.isNaN(v) || v <= 0) return null;
  if (v <= 3) return `${Math.round(v * 100)}%`;
  return `${Math.round(v)}%`;
}

function hasChangeOrder(deal) {
  return Boolean(deal && cleanCell(deal.change_order));
}

// Parses every sheet in the workbook, finds the header row (it is not always
// the first row - the Admin Board has a title row above it), and returns
// normalized homeowner rows ready to become welcome calls.
function parseWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const rows = [];
  const problems = { missingContact: 0, badPhone: 0 };

  for (const sheetName of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: false, defval: '' });

    let headerIdx = -1;
    let cols = null;
    for (let i = 0; i < Math.min(grid.length, 10); i++) {
      const headers = grid[i].map((c) => String(c).toLowerCase().trim());
      if (headers.some((h) => COLUMN_MATCHERS.name(h)) && headers.some((h) => COLUMN_MATCHERS.address(h))) {
        headerIdx = i;
        cols = {};
        for (const [field, matcher] of Object.entries(COLUMN_MATCHERS)) {
          const idx = headers.findIndex((h) => h && matcher(h));
          if (idx !== -1) cols[field] = idx;
        }
        break;
      }
    }
    if (headerIdx === -1) continue;

    for (let i = headerIdx + 1; i < grid.length; i++) {
      const row = grid[i];
      const get = (field) => (cols[field] === undefined ? '' : cleanCell(row[cols[field]]));

      const name = get('name');
      const address = get('address');
      const rawPhone = get('phone');
      if (!name && !address && !rawPhone) continue; // blank spacer row
      if (!name || !address || !rawPhone) {
        problems.missingContact++;
        continue;
      }
      const phone = normalizePhone(rawPhone);
      if (!phone) {
        problems.badPhone++;
        continue;
      }

      const deal = {
        stage: get('stage'),
        finance_type: get('finance'),
        ntp_status: get('ntp'),
        date_submitted: get('submitted'),
        panels: get('panels'),
        current_usage_kwh: get('usage'),
        sold_production_kwh: get('production'),
        site_survey: get('survey'),
        change_order: get('change_order'),
        rep: get('rep'),
        notes: get('notes'),
        source_sheet: sheetName,
      };

      rows.push({
        homeowner_name: name,
        property_address: address,
        phone,
        email: get('email') || null,
        installer: get('installer') || null,
        offset_percent: normalizeOffset(row[cols.offset] !== undefined ? row[cols.offset] : ''),
        monthly_payment: get('monthly_payment') || null,
        escalator: get('escalator') || null,
        deal,
      });
    }
  }

  return { rows, problems };
}

module.exports = { parseWorkbook, hasChangeOrder, cleanCell };
