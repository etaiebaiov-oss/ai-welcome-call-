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
  brandColor: process.env.BRAND_COLOR || '#0f4c81',
};

function appUrl(req) {
  const configured = (process.env.APP_URL || '').replace(/\/+$/, '');
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
    agreement_ref: clean(body.agreement_ref) || null,
    terms: clean(body.terms) || null,
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
      publicKey: process.env.VAPI_PUBLIC_KEY,
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
    flags.push(`Homeowner had questions/concerns: ${analysis.questions_or_concerns || 'see transcript'}`);
  }
  if (analysis.confused_about) flags.push(`Confused about: ${analysis.confused_about}`);
  if (analysis.info_corrections) flags.push(`Info corrections given: ${analysis.info_corrections}`);
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
  if (process.env.ADMIN_PASSWORD && auth.safeEqual(req.body.password, process.env.ADMIN_PASSWORD)) {
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
  const calls = listCalls().map((c) => ({ ...c, flags: JSON.parse(c.flags_json || '[]') }));
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
  res.render('admin-call', {
    ...BRAND,
    call,
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

app.get('/admin/script', auth.requireAdmin, (req, res) => {
  res.render('admin-script', {
    ...BRAND,
    script: vapi.getScript(),
    defaultScript: vapi.DEFAULT_SCRIPT,
    saved: Boolean(req.query.saved),
    error: req.query.error || null,
  });
});

app.post('/admin/script', auth.requireAdmin, async (req, res) => {
  const script = String(req.body.script || '').trim();
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
