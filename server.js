const express = require('express');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');

const {
  db,
  RECORDINGS_DIR,
  getSetting,
  setSetting,
  getOrCreateSecret,
  createCall,
  getCallByToken,
  getCallById,
  getCallByVapiId,
  listCalls,
} = require('./src/db');
const auth = require('./src/auth');
const vapi = require('./src/vapi');
const multer = require('multer');
const { parseWorkbook, hasChangeOrder } = require('./src/import');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const BRAND = {
  companyName: vapi.COMPANY_NAME,
  brandColor: (process.env.BRAND_COLOR || '#0284c7').trim(),
};

function appUrl(req) {
  const configured = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  return configured || `${req.protocol}://${req.get('host')}`;
}

app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Public: landing page + call page
// ---------------------------------------------------------------------------

app.get('/', (req, res) => {
  res.render('landing', { ...BRAND, error: null, values: {} });
});

function extractCallFields(body, createdBy) {
  const clean = (v) => String(v || '').trim().slice(0, 2000);
  const data = {
    homeowner_name: clean(body.homeowner_name),
    phone: clean(body.phone),
    email: clean(body.email) || null,
    property_address: clean(body.property_address),
    installer: clean(body.installer) || null,
    monthly_payment: clean(body.monthly_payment) || null,
    escalator: clean(body.escalator) || null,
    offset_percent: clean(body.offset_percent) || null,
    created_by: createdBy,
  };
  if (!data.homeowner_name || !data.phone || !data.property_address) {
    throw new Error('Please fill in your name, phone number, and property address.');
  }
  return data;
}

app.post('/calls', (req, res) => {
  try {
    const call = createCall(extractCallFields(req.body, 'homeowner'));
    res.redirect(`/call/${call.token}`);
  } catch (err) {
    res.status(400).render('landing', { ...BRAND, error: err.message, values: req.body });
  }
});

app.get('/call/:token', (req, res) => {
  const call = getCallByToken(req.params.token);
  if (!call) return res.status(404).render('message', { ...BRAND, title: 'Link not found', body: 'This welcome call link is invalid or has been removed. Please contact us for a new link.' });
  res.render('call', { ...BRAND, call, done: ['completed', 'flagged'].includes(call.status) });
});

// Config the browser needs to start the web call for this homeowner.
app.get('/api/call-config/:token', async (req, res) => {
  const call = getCallByToken(req.params.token);
  if (!call) return res.status(404).json({ error: 'Unknown call link' });
  if (!process.env.VAPI_PUBLIC_KEY || !process.env.VAPI_PRIVATE_KEY) {
    return res.status(503).json({ error: 'Voice service is not configured yet. Please contact support.' });
  }
  try {
    const assistantId = await vapi.ensureAssistant();
    res.json({
      publicKey: (process.env.VAPI_PUBLIC_KEY || '').trim(),
      assistantId,
      overrides: vapi.overridesFor(call),
    });
  } catch (err) {
    console.error('call-config failed:', err.message);
    res.status(502).json({ error: 'Could not start the call service. Please try again shortly.' });
  }
});

// Browser tells us which Vapi call id belongs to this token, so the
// end-of-call webhook can be matched back to the homeowner record.
app.post('/api/call-linked', (req, res) => {
  const { token, vapiCallId } = req.body || {};
  const call = token && getCallByToken(token);
  if (!call || !vapiCallId || typeof vapiCallId !== 'string') {
    return res.status(400).json({ error: 'Invalid request' });
  }
  db.prepare(
    `UPDATE calls SET vapi_call_id = ?, status = 'in_progress', started_at = datetime('now') WHERE id = ?`
  ).run(vapiCallId.slice(0, 100), call.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Vapi webhook: stores transcript, analysis flags, and the recording
// ---------------------------------------------------------------------------

async function downloadRecording(url, callId) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`recording download failed: ${res.status}`);
  const ext = (new URL(url).pathname.match(/\.(wav|mp3|m4a|ogg)$/i) || [, 'wav'])[1].toLowerCase();
  const filename = `welcome-call-${callId}-${Date.now()}.${ext}`;
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(path.join(RECORDINGS_DIR, filename), buf);
  return filename;
}

function computeFlags(analysis) {
  const flags = [];
  if (!analysis) return { flagged: true, flags: ['No post-call analysis was returned'] };
  if (analysis.consented_to_recording === false) flags.push('Homeowner did not consent to recording');
  if (analysis.call_completed === false) flags.push('Call was not completed');
  if (analysis.confirmed_identity === false) flags.push('Identity was not confirmed');
  if (analysis.confirmed_address === false) flags.push('Address was not confirmed');
  if (analysis.confirmed_terms === false) flags.push('Agreement terms were not confirmed');
  if (analysis.understood_everything === false) flags.push('Homeowner showed confusion or hesitation');
  if (analysis.had_questions === true) {
    const detail = analysis.questions_or_concerns || 'see transcript';
    flags.push(
      analysis.questions_fully_answered === true
        ? `Homeowner had questions (answered from approved FAQ): ${detail}`
        : `Homeowner had questions the assistant could not fully answer: ${detail}`
    );
  }
  if (analysis.confused_about) flags.push(`Confused about: ${analysis.confused_about}`);
  if (analysis.info_corrections) flags.push(`Info corrections given: ${analysis.info_corrections}`);
  if (analysis.confirmed_no_side_promises === false) {
    flags.push(`Promises/incentives outside the contract were mentioned: ${analysis.side_promise_details || 'see transcript'}`);
  }
  if (analysis.is_primary_decision_maker === false) {
    flags.push(`Not the primary decision maker — support person: ${analysis.support_person_details || 'details not captured'}`);
  }
  if (analysis.senior_without_support === true) {
    flags.push('Senior citizen with no family member or support person involved');
  }
  if (analysis.possible_coercion === true) {
    flags.push(`Possible coercion or pressure observed: ${analysis.coercion_notes || 'see transcript'}`);
  }
  if (analysis.flag_for_review === true) {
    flags.push(`AI flagged for review: ${analysis.flag_reason || 'see transcript'}`);
  }
  return { flagged: flags.length > 0, flags };
}

app.post('/api/vapi/webhook', async (req, res) => {
  const secret = getOrCreateSecret('webhook_secret');
  if (!auth.safeEqual(req.headers['x-vapi-secret'], secret)) {
    return res.status(401).json({ error: 'bad secret' });
  }

  const message = req.body && req.body.message;
  if (!message || message.type !== 'end-of-call-report') return res.json({ ok: true });

  const vapiCallId = message.call && message.call.id;
  const record = vapiCallId && getCallByVapiId(vapiCallId);
  if (!record) {
    console.warn('end-of-call-report for unknown call id:', vapiCallId);
    return res.json({ ok: true });
  }

  const artifact = message.artifact || {};
  const analysis = message.analysis || {};
  const structured = analysis.structuredData || null;
  const { flagged, flags } = computeFlags(structured);

  let recordingFile = record.recording_file;
  const recordingUrl = artifact.stereoRecordingUrl || artifact.recordingUrl || message.stereoRecordingUrl || message.recordingUrl || null;
  if (recordingUrl && !recordingFile) {
    try {
      recordingFile = await downloadRecording(recordingUrl, record.id);
    } catch (err) {
      console.error('Failed to store recording locally:', err.message);
    }
  }

  db.prepare(
    `UPDATE calls SET
       status = ?,
       transcript = ?,
       summary = ?,
       analysis_json = ?,
       flags_json = ?,
       recording_file = COALESCE(?, recording_file),
       recording_url = COALESCE(?, recording_url),
       duration_seconds = ?,
       ended_reason = ?,
       completed_at = datetime('now')
     WHERE id = ?`
  ).run(
    flagged ? 'flagged' : 'completed',
    artifact.transcript || message.transcript || null,
    analysis.summary || null,
    structured ? JSON.stringify(structured) : null,
    JSON.stringify(flags),
    recordingFile || null,
    recordingUrl,
    typeof message.durationSeconds === 'number' ? message.durationSeconds : null,
    message.endedReason || null,
    record.id
  );

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Admin (password protected)
// ---------------------------------------------------------------------------

app.get('/admin/login', (req, res) => {
  if (auth.isAuthed(req)) return res.redirect('/admin');
  res.render('admin-login', { ...BRAND, error: null });
});

app.post('/admin/login', (req, res) => {
  const adminPassword = (process.env.ADMIN_PASSWORD || '').trim();
  if (adminPassword && auth.safeEqual(String(req.body.password || '').trim(), adminPassword)) {
    auth.login(res);
    return res.redirect('/admin');
  }
  res.status(401).render('admin-login', { ...BRAND, error: 'Incorrect password.' });
});

app.post('/admin/logout', (req, res) => {
  auth.logout(res);
  res.redirect('/admin/login');
});

app.get('/admin', auth.requireAdmin, (req, res) => {
  const calls = listCalls().map((c) => {
    const deal = c.deal_json ? JSON.parse(c.deal_json) : null;
    return { ...c, flags: JSON.parse(c.flags_json || '[]'), deal, changeOrder: hasChangeOrder(deal) };
  });
  const stats = {
    total: calls.length,
    completed: calls.filter((c) => c.status === 'completed').length,
    flagged: calls.filter((c) => c.status === 'flagged').length,
    pending: calls.filter((c) => ['pending', 'in_progress'].includes(c.status)).length,
  };
  res.render('admin-dashboard', {
    ...BRAND,
    calls,
    stats,
    appUrl: appUrl(req),
    phoneCallsEnabled: Boolean(process.env.VAPI_PHONE_NUMBER_ID),
    created: req.query.created ? getCallById(Number(req.query.created)) : null,
    notice: req.query.notice || null,
  });
});

app.post('/admin/calls/new', auth.requireAdmin, (req, res) => {
  try {
    const call = createCall(extractCallFields(req.body, 'admin'));
    res.redirect(`/admin?created=${call.id}`);
  } catch (err) {
    res.redirect(`/admin?notice=${encodeURIComponent(err.message)}`);
  }
});

app.get('/admin/calls/:id', auth.requireAdmin, (req, res) => {
  const call = getCallById(Number(req.params.id));
  if (!call) return res.status(404).send('Not found');
  const deal = call.deal_json ? JSON.parse(call.deal_json) : null;
  res.render('admin-call', {
    ...BRAND,
    call,
    deal,
    changeOrder: hasChangeOrder(deal),
    flags: JSON.parse(call.flags_json || '[]'),
    analysis: call.analysis_json ? JSON.parse(call.analysis_json) : null,
    appUrl: appUrl(req),
    phoneCallsEnabled: Boolean(process.env.VAPI_PHONE_NUMBER_ID),
    notice: req.query.notice || null,
  });
});

// Recordings are ONLY served through this authenticated route.
app.get('/admin/calls/:id/recording', auth.requireAdmin, (req, res) => {
  const call = getCallById(Number(req.params.id));
  if (!call || !call.recording_file) return res.status(404).send('No recording stored for this call.');
  const filePath = path.join(RECORDINGS_DIR, path.basename(call.recording_file));
  if (!fs.existsSync(filePath)) return res.status(404).send('Recording file is missing from storage.');
  if (req.query.download) {
    const safeName = call.homeowner_name.replace(/[^a-z0-9 _-]/gi, '').replace(/\s+/g, '-');
    return res.download(filePath, `welcome-call-${safeName || call.id}${path.extname(filePath)}`);
  }
  res.sendFile(filePath);
});

app.post('/admin/calls/:id/dial', auth.requireAdmin, async (req, res) => {
  const call = getCallById(Number(req.params.id));
  if (!call) return res.status(404).send('Not found');
  try {
    const result = await vapi.startPhoneCall(call);
    db.prepare(
      `UPDATE calls SET vapi_call_id = ?, status = 'in_progress', started_at = datetime('now') WHERE id = ?`
    ).run(result.id, call.id);
    res.redirect(`/admin/calls/${call.id}?notice=${encodeURIComponent('Phone call started — the AI is dialing the homeowner now.')}`);
  } catch (err) {
    console.error('Outbound dial failed:', err.message);
    res.redirect(`/admin/calls/${call.id}?notice=${encodeURIComponent('Could not start phone call: ' + err.message)}`);
  }
});

function importedCalls(req) {
  return listCalls()
    .filter((c) => c.created_by === 'import')
    .map((c) => {
      const deal = c.deal_json ? JSON.parse(c.deal_json) : null;
      return { ...c, deal, changeOrder: hasChangeOrder(deal), link: `${appUrl(req)}/call/${c.token}` };
    });
}

app.get('/admin/import', auth.requireAdmin, (req, res) => {
  res.render('admin-import', { ...BRAND, result: null, error: null, appUrl: appUrl(req), imported: importedCalls(req) });
});

app.post('/admin/import', auth.requireAdmin, upload.single('file'), (req, res) => {
  const render = (data) =>
    res.render('admin-import', { ...BRAND, result: null, error: null, appUrl: appUrl(req), ...data, imported: importedCalls(req) });
  if (!req.file) return render({ error: 'Please choose a spreadsheet file (.xlsx or .csv) to upload.' });

  let parsed;
  try {
    parsed = parseWorkbook(req.file.buffer);
  } catch (err) {
    console.error('import parse failed:', err.message);
    return render({ error: 'Could not read that file. Make sure it is a valid .xlsx or .csv export.' });
  }
  if (parsed.rows.length === 0) {
    return render({ error: 'No usable rows found. The sheet needs at least homeowner name, address, and phone columns.' });
  }

  // Skip homeowners who already have a call record (matched by phone digits).
  const existingPhones = new Set(
    db.prepare('SELECT phone FROM calls').all().map((r) => String(r.phone).replace(/\D/g, ''))
  );

  const created = [];
  let skippedExisting = 0;
  const seenInFile = new Set();
  for (const row of parsed.rows) {
    const digits = row.phone.replace(/\D/g, '');
    if (seenInFile.has(digits)) continue;
    seenInFile.add(digits);
    if (existingPhones.has(digits)) {
      skippedExisting++;
      continue;
    }
    const { deal, ...fields } = row;
    const call = createCall({ ...fields, created_by: 'import', deal_json: JSON.stringify(deal) });
    created.push({
      name: call.homeowner_name,
      phone: call.phone,
      email: call.email || '',
      changeOrder: hasChangeOrder(deal),
      link: `${appUrl(req)}/call/${call.token}`,
    });
  }

  render({
    result: {
      created,
      skippedExisting,
      missingContact: parsed.problems.missingContact,
      badPhone: parsed.problems.badPhone,
      changeOrders: created.filter((c) => c.changeOrder).length,
    },
  });
});

app.get('/admin/diagnostics', auth.requireAdmin, async (req, res) => {
  const checks = [];
  const add = (name, ok, detail, hint) => checks.push({ name, ok, detail, hint: ok ? null : hint });

  const priv = (process.env.VAPI_PRIVATE_KEY || '').trim();
  const pub = (process.env.VAPI_PUBLIC_KEY || '').trim();

  add('VAPI_PRIVATE_KEY is set', Boolean(priv), priv ? `present (ends in …${priv.slice(-4)})` : 'missing',
    'Add it in Railway → Variables. It is on the Vapi dashboard API Keys page, labeled "Private Key".');
  add('VAPI_PUBLIC_KEY is set', Boolean(pub), pub ? `present (ends in …${pub.slice(-4)})` : 'missing',
    'Add it in Railway → Variables. It is on the Vapi dashboard API Keys page, labeled "Public Key".');
  if (priv && pub) {
    add('Private and public keys are different values', priv !== pub, priv === pub ? 'the SAME key is in both variables' : 'ok',
      'You pasted one key into both variables. Go back to the Vapi API Keys page and copy the other key — there are two.');
  }

  const appU = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  add('APP_URL is set and looks valid', /^https:\/\/[^/]+$/.test(appU), appU || 'missing',
    'Set APP_URL in Railway → Variables to your site address, e.g. https://welcomecall.solar — https, no trailing slash, no path.');
  if (appU) {
    let sameHost = false;
    try { sameHost = new URL(appU).host === req.get('host'); } catch {}
    add('APP_URL matches the address you are browsing', sameHost, `APP_URL is ${appU}, you are on https://${req.get('host')}`,
      'Not necessarily a problem (you may be on the railway.app address while APP_URL is your custom domain), but share links and Vapi webhooks will use APP_URL — make sure that is the address that works.');
  }

  try {
    const probe = path.join(RECORDINGS_DIR, '.diagnostic-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    add('Recording storage is writable', true, RECORDINGS_DIR);
  } catch (err) {
    add('Recording storage is writable', false, err.message,
      'Check that the Railway volume is attached at /data and the DATA_DIR variable is /data.');
  }

  if (priv) {
    try {
      await vapi.testPrivateKey();
      add('Vapi accepts the private key', true, 'authenticated successfully');
    } catch (err) {
      add('Vapi accepts the private key', false, err.message,
        err.status === 401 || err.status === 403
          ? 'Vapi rejected this key for server use — you most likely put the PUBLIC key in VAPI_PRIVATE_KEY. Swap in the key labeled "Private Key" from the Vapi dashboard.'
          : 'Vapi could not be reached or returned an unexpected error — see the detail text.');
    }

    try {
      const assistantId = await vapi.ensureAssistant();
      add('Voice assistant is created and in sync', true, `assistant ${assistantId}`);
    } catch (err) {
      add('Voice assistant is created and in sync', false, err.message,
        'This is the exact error stopping calls from starting. Fix the items above first; if they are all green, send this error text to your developer.');
    }
  }

  res.render('admin-diagnostics', { ...BRAND, checks, allOk: checks.every((c) => c.ok) });
});

app.get('/admin/faq', auth.requireAdmin, (req, res) => {
  res.render('admin-faq', {
    ...BRAND,
    faq: vapi.getFaq(),
    saved: Boolean(req.query.saved),
    error: req.query.error || null,
  });
});

app.post('/admin/faq', auth.requireAdmin, async (req, res) => {
  setSetting('faq_content', String(req.body.faq || '').trim() || vapi.DEFAULT_FAQ);
  try {
    if (process.env.VAPI_PRIVATE_KEY) await vapi.ensureAssistant();
    res.redirect('/admin/faq?saved=1');
  } catch (err) {
    res.redirect(`/admin/faq?error=${encodeURIComponent('Saved locally, but syncing to Vapi failed: ' + err.message)}`);
  }
});

app.get('/admin/script', auth.requireAdmin, (req, res) => {
  res.render('admin-script', {
    ...BRAND,
    script: vapi.getScript(),
    defaultScript: vapi.DEFAULT_SCRIPT,
    saved: Boolean(req.query.saved),
    error: req.query.error || null,
  });
});

// Repair text that was accidentally saved with HTML entity escapes
// (a past Reset-to-default bug could paste &#34; etc. into the editor).
function decodeHtmlEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

app.post('/admin/script', auth.requireAdmin, async (req, res) => {
  const script = decodeHtmlEntities(String(req.body.script || '').trim());
  setSetting('script_template', script || vapi.DEFAULT_SCRIPT);
  try {
    if (process.env.VAPI_PRIVATE_KEY) await vapi.ensureAssistant();
    res.redirect('/admin/script?saved=1');
  } catch (err) {
    res.redirect(`/admin/script?error=${encodeURIComponent('Saved locally, but syncing to Vapi failed: ' + err.message)}`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`${BRAND.companyName} welcome-call platform listening on port ${PORT}`);
  if (!process.env.APP_URL) console.warn('WARNING: APP_URL is not set — Vapi webhooks (recordings, transcripts, flags) will not be delivered.');
  if (!process.env.ADMIN_PASSWORD) console.warn('WARNING: ADMIN_PASSWORD is not set — the admin dashboard is disabled.');
});
