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
  deleteCall,
} = require('./src/db');
const auth = require('./src/auth');
const vapi = require('./src/vapi');
const multer = require('multer');
const { parseWorkbook, hasChangeOrder } = require('./src/import');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const uploadAudio = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const { transcribeAudio, analyzeTranscript, extractIdentity } = require('./src/analyze');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
// Lets the shared navigation mark the active page.
app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  next();
});

// Guard against placeholder/unset company names leaking onto the live,
// homeowner-facing pages (COMPANY_NAME defaults to a template value on fresh
// deploys). Falls back to a neutral, presentable name until it's configured.
const PLACEHOLDER_NAMES = new Set(['', 'template', 'your company']);
const configuredCompany = (vapi.COMPANY_NAME || '').trim();
const BRAND = {
  companyName: PLACEHOLDER_NAMES.has(configuredCompany.toLowerCase()) ? 'Welcome Call Center' : configuredCompany,
  brandColor: (process.env.BRAND_COLOR || '#2563eb').trim(),
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
  res.render('landing', BRAND);
});

function extractCallFields(body, createdBy) {
  const clean = (v) => String(v || '').trim().slice(0, 2000);
  const script_variant = body.script_variant === 'pss' ? 'pss' : 'sw';
  // Each script version IS a specific installer, so derive the installer from
  // the chosen script. An explicit installer (e.g. from a recording upload)
  // still takes precedence when provided.
  const INSTALLER_BY_VARIANT = { sw: 'Southwest Solar', pss: 'Pacific Sky' };
  const data = {
    homeowner_name: clean(body.homeowner_name),
    phone: clean(body.phone),
    email: clean(body.email) || null,
    property_address: clean(body.property_address),
    installer: clean(body.installer) || INSTALLER_BY_VARIANT[script_variant],
    script_variant,
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

// Self-serve call creation is disabled: homeowners don't have the exact
// agreement terms, so all calls are created by admins or the board import.
app.post('/calls', (req, res) => res.redirect('/'));

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
  if (analysis.off_script_statements) {
    flags.push(`Caller went off script: ${analysis.off_script_statements}`);
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
  const recordingUrl = vapi.pickRecordingUrl(artifact) || vapi.pickRecordingUrl(message);
  if (recordingUrl && !recordingFile) {
    try {
      recordingFile = await downloadRecording(recordingUrl, record.id);
    } catch (err) {
      // The presigned link may already have lapsed by the time we get here;
      // ask Vapi for a fresh one before giving up.
      console.error('Failed to store recording locally:', err.message);
      try {
        const fresh = await vapi.fetchRecordingUrl(vapiCallId);
        if (fresh) recordingFile = await downloadRecording(fresh, record.id);
      } catch (retryErr) {
        console.error('Recording retry with a fresh URL also failed:', retryErr.message);
      }
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

// Pulls a call's audio down from Vapi using a freshly signed URL. Recovers
// recordings whose original download failed at end-of-call.
async function storeRecordingFromVapi(call) {
  if (!call.vapi_call_id) throw new Error('no Vapi call id on this record');
  const url = await vapi.fetchRecordingUrl(call.vapi_call_id);
  if (!url) throw new Error('Vapi has no recording for this call');
  const filename = await downloadRecording(url, call.id);
  db.prepare('UPDATE calls SET recording_file = ? WHERE id = ?').run(filename, call.id);
  return filename;
}

app.post('/admin/calls/:id/fetch-recording', auth.requireAdmin, async (req, res) => {
  const call = getCallById(Number(req.params.id));
  if (!call) return res.status(404).send('Not found');
  try {
    await storeRecordingFromVapi(call);
    res.redirect(`/admin/calls/${call.id}?notice=${encodeURIComponent('Recording retrieved from Vapi and stored.')}`);
  } catch (err) {
    res.redirect(`/admin/calls/${call.id}?notice=${encodeURIComponent('Could not retrieve the recording: ' + err.message)}`);
  }
});

// Bulk recovery for every finished call that never got its audio stored.
app.post('/admin/recordings/backfill', auth.requireAdmin, async (req, res) => {
  const missing = listCalls().filter((c) => c.vapi_call_id && !c.recording_file);
  let stored = 0;
  const failures = [];
  for (const call of missing) {
    try {
      await storeRecordingFromVapi(call);
      stored += 1;
    } catch (err) {
      failures.push(`${call.homeowner_name}: ${err.message}`);
    }
  }
  const summary = `Recording backfill: stored ${stored} of ${missing.length}.${
    failures.length ? ` Failed - ${failures.slice(0, 5).join('; ')}` : ''
  }`;
  res.redirect(`/admin?notice=${encodeURIComponent(summary)}`);
});

app.post('/admin/calls/:id/dial', auth.requireAdmin, async (req, res) => {
  const call = getCallById(Number(req.params.id));
  if (!call) return res.status(404).send('Not found');
  try {
    const overrideNumber = String(req.body.override_number || '').trim() || null;
    const result = await vapi.startPhoneCall(call, overrideNumber);
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
    const variant = /pacific|pss/i.test(fields.installer || '') ? 'pss' : 'sw';
    const call = createCall({ ...fields, created_by: 'import', deal_json: JSON.stringify(deal), script_variant: variant });
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

app.get('/admin/analyze', auth.requireAdmin, (req, res) => {
  res.render('admin-analyze', {
    ...BRAND,
    calls: listCalls(),
    hasKey: Boolean((process.env.OPENAI_API_KEY || '').trim()),
    error: req.query.error || null,
  });
});

// Fuzzy-match an extracted identity against existing client records.
// Phone digits are the strongest signal; name and address tokens back it up.
function matchClientByIdentity(identity) {
  const digits = (s) => String(s || '').replace(/\D/g, '');
  const tokens = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const idPhone = digits(identity.phone);
  const idName = tokens(identity.homeowner_name);
  const idAddr = tokens(identity.property_address);
  let best = null;
  let bestScore = 0;
  for (const c of listCalls()) {
    let score = 0;
    const cPhone = digits(c.phone);
    if (idPhone.length >= 7 && cPhone && (cPhone === idPhone || cPhone.endsWith(idPhone) || idPhone.endsWith(cPhone))) score += 3;
    const cName = tokens(c.homeowner_name);
    const nameHits = idName.filter((t) => t.length > 2 && cName.includes(t)).length;
    score += nameHits >= 2 ? 2 : nameHits === 1 ? 1 : 0;
    const cAddr = tokens(c.property_address);
    const addrHits = idAddr.filter((t) => cAddr.includes(t)).length;
    score += addrHits >= 2 ? 2 : addrHits === 1 ? 0.5 : 0;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return bestScore >= 3 ? best : null;
}

app.post('/admin/analyze', auth.requireAdmin, uploadAudio.single('audio'), async (req, res) => {
  const fail = (msg) => res.redirect(`/admin/analyze?error=${encodeURIComponent(msg)}`);
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) return fail('Set the OPENAI_API_KEY variable in Railway first (see the note on this page).');
  if (!req.file) return fail('Choose an audio file (.mp3, .m4a, .wav — up to 25MB).');

  try {
    console.log(`[analyze] received ${req.file.originalname} (${Math.round(req.file.size / 1024)} KB), transcribing...`);
    const transcript = await transcribeAudio(req.file.buffer, req.file.originalname, apiKey);
    console.log(`[analyze] transcript ${transcript.length} chars, resolving client (${req.body.call_id})...`);

    let call;
    let matchNotice = '';
    if (req.body.call_id === 'auto' || !req.body.call_id) {
      const identity = await extractIdentity({ transcript, apiKey });
      call = matchClientByIdentity(identity);
      if (call) {
        matchNotice = `Auto-matched this recording to ${call.homeowner_name}. `;
      } else if (
        identity.homeowner_name &&
        identity.property_address &&
        String(identity.phone || '').replace(/\D/g, '').length >= 10
      ) {
        call = createCall(
          extractCallFields(
            {
              homeowner_name: identity.homeowner_name,
              phone: identity.phone,
              property_address: identity.property_address,
              email: identity.email,
              installer: identity.installer,
              script_variant: /pacific|pss/i.test(identity.installer || '') ? 'pss' : 'sw',
            },
            'upload'
          )
        );
        matchNotice = `No existing client matched — created a new record for ${call.homeowner_name}. `;
      } else {
        return fail(
          `Couldn't auto-detect the client from this recording (heard name: "${identity.homeowner_name || 'none'}", address: "${identity.property_address || 'none'}", phone: "${identity.phone || 'none'}"). Pick the client manually and try again.`
        );
      }
    } else if (req.body.call_id === 'new') {
      call = createCall(
        extractCallFields(
          {
            homeowner_name: req.body.new_name,
            phone: req.body.new_phone,
            property_address: req.body.new_address,
            email: req.body.new_email,
            installer: req.body.new_installer,
            script_variant: req.body.new_script_variant,
          },
          'upload'
        )
      );
    } else {
      call = getCallById(Number(req.body.call_id));
    }
    if (!call) return fail('Pick which client this recording belongs to.');

    console.log(`[analyze] auditing against ${call.script_variant || 'sw'} script for call ${call.id}...`);
    const analysis = await analyzeTranscript({
      transcript,
      call,
      script: vapi.getScript(call.script_variant),
      apiKey,
    });
    console.log(`[analyze] audit complete for call ${call.id}`);
    const { flagged, flags } = computeFlags(analysis);

    const ext = (path.extname(req.file.originalname || '') || '.mp3').toLowerCase();
    const filename = `manual-upload-${call.id}-${Date.now()}${ext}`;
    fs.writeFileSync(path.join(RECORDINGS_DIR, filename), req.file.buffer);

    db.prepare(
      `UPDATE calls SET
         status = ?, transcript = ?, summary = ?, analysis_json = ?, flags_json = ?,
         recording_file = ?, ended_reason = 'manual-upload', completed_at = datetime('now')
       WHERE id = ?`
    ).run(
      flagged ? 'flagged' : 'completed',
      transcript,
      analysis.summary || null,
      JSON.stringify(analysis),
      JSON.stringify(flags),
      filename,
      call.id
    );
    res.redirect(`/admin/calls/${call.id}${matchNotice ? `?notice=${encodeURIComponent(matchNotice + 'Audit results below.')}` : ''}`);
  } catch (err) {
    console.error('Recording analysis failed:', err.message);
    fail(`Analysis failed: ${err.message}`);
  }
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

// Rewrites AI-specific lines of the call script for a human caller.
function humanizeScript(script, homeownerName) {
  return script
    .replace(
      /\(The call opens automatically with: "Hey there! Can you hear me okay\?"\)\s*\n/i,
      `Say: "Hi, is this ${homeownerName}?" (wait for a yes)\n`
    )
    .replace(
      /\(The call opens automatically with: "Hey ([^"]+), can you hear me okay\?"\)\s*\n/i,
      'Say: "Hi, is this $1?" (wait for a yes)\n'
    )
    .replace(/After they answer, say:/i, 'Then say:')
    .replace(
      /I['’]m the virtual assistant for the welcome team at ([^.]+)\./i,
      'This is [YOUR NAME] calling from the welcome team at $1.'
    )
    .replace(
      /I['’]m the virtual welcome assistant for ([^.]+)\./i,
      'This is [YOUR NAME] calling from $1 on the customer success team.'
    )
    .replace(
      /Then end the call\.\s*$/i,
      'Then wrap up, hang up, and file the recording per company policy.'
    );
}

// Print-ready script with this client's details filled in, for a human
// (e.g. the project manager) to conduct the welcome call personally.
app.get('/admin/calls/:id/script', auth.requireAdmin, (req, res) => {
  const call = getCallById(Number(req.params.id));
  if (!call) return res.status(404).send('Not found');
  const vars = vapi.overridesFor(call).variableValues;
  const filledScript = humanizeScript(
    vapi.getScript(call.script_variant).replace(/\{\{(\w+)\}\}/g, (match, key) => (vars[key] !== undefined ? vars[key] : match)),
    call.homeowner_name
  );
  res.render('admin-manual-script', { ...BRAND, call, filledScript });
});

app.post('/admin/calls/:id/delete', auth.requireAdmin, (req, res) => {
  const call = getCallById(Number(req.params.id));
  if (!call) return res.status(404).send('Not found');
  if (call.recording_file) {
    const filePath = path.join(RECORDINGS_DIR, path.basename(call.recording_file));
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
      console.error('Failed to delete recording file:', err.message);
    }
  }
  deleteCall(call.id);
  res.redirect(`/admin?notice=${encodeURIComponent(`Deleted the call record for ${call.homeowner_name}.`)}`);
});

app.get('/admin/script', auth.requireAdmin, (req, res) => {
  const variant = req.query.variant === 'pss' ? 'pss' : 'sw';
  res.render('admin-script', {
    ...BRAND,
    variant,
    script: vapi.getScript(variant),
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
  const variant = req.body.variant === 'pss' ? 'pss' : 'sw';
  const script = decodeHtmlEntities(String(req.body.script || '').trim());
  setSetting(vapi.scriptSettingKey(variant), script || vapi.DEFAULT_SCRIPT);
  try {
    if (process.env.VAPI_PRIVATE_KEY) await vapi.ensureAssistant();
    res.redirect(`/admin/script?variant=${variant}&saved=1`);
  } catch (err) {
    res.redirect(`/admin/script?variant=${variant}&error=${encodeURIComponent('Saved locally, but syncing to Vapi failed: ' + err.message)}`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`${BRAND.companyName} welcome-call platform listening on port ${PORT}`);
  if (!process.env.APP_URL) console.warn('WARNING: APP_URL is not set — Vapi webhooks (recordings, transcripts, flags) will not be delivered.');
  if (!process.env.ADMIN_PASSWORD) console.warn('WARNING: ADMIN_PASSWORD is not set — the admin dashboard is disabled.');
});
