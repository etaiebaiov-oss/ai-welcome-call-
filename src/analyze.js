const OPENAI_BASE = 'https://api.openai.com/v1';

// Transcribe an uploaded recording (mp3/m4a/wav...) with OpenAI Whisper.
async function transcribeAudio(buffer, filename, apiKey) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), filename || 'recording.mp3');
  form.append('model', 'whisper-1');
  const res = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Transcription failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return (await res.json()).text;
}

// Audit a transcript against the official script + customer file, producing
// the same structured analysis the live-call webhook produces (plus
// off-script detection, since human callers can drift).
async function analyzeTranscript({ transcript, call, script, apiKey }) {
  const systemPrompt = `You are a meticulous compliance auditor for solar welcome calls. You are given the OFFICIAL SCRIPT the caller was required to follow, the CUSTOMER FILE, and the TRANSCRIPT of a recorded welcome call (which may have been conducted by a human agent). Audit the call strictly. Respond with STRICT JSON only - every field below must be present:
{
  "summary": string (3-4 sentence summary of the call),
  "consented_to_recording": boolean,
  "call_completed": boolean (did the call cover the entire script?),
  "confirmed_identity": boolean,
  "confirmed_address": boolean,
  "confirmed_terms": boolean (clear yes/I-understand on the agreement points),
  "understood_everything": boolean (no confusion or hesitation at any point),
  "had_questions": boolean,
  "questions_or_concerns": string ("" if none),
  "questions_fully_answered": boolean,
  "confused_about": string ("" if none),
  "info_corrections": string (corrections to name/address/phone/email, "" if none),
  "confirmed_no_side_promises": boolean,
  "side_promise_details": string ("" if none),
  "is_primary_decision_maker": boolean,
  "support_person_details": string ("" if none),
  "senior_without_support": boolean,
  "possible_coercion": boolean,
  "coercion_notes": string ("" if none),
  "off_script_statements": string (quote anything the AGENT said that deviates from the official script in substance: extra promises, claims, prices, timelines, or facts not present in the script or customer file; "" if the agent stayed on script),
  "flag_for_review": boolean,
  "flag_reason": string ("" if not flagged)
}`;

  const userMessage = `OFFICIAL SCRIPT:\n${script}\n\nCUSTOMER FILE:\n- Name: ${call.homeowner_name}\n- Address: ${call.property_address}\n- Phone: ${call.phone}\n- Email: ${call.email || 'not on file'}\n- Installer: ${call.installer || 'not on file'}\n- Monthly payment: ${call.monthly_payment || 'not on file'}\n- Escalator: ${call.escalator || 'not on file'}\n- Energy offset: ${call.offset_percent || 'not on file'}\n\nTRANSCRIPT:\n${transcript}`;

  const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4.1',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Analysis failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

// Pull the homeowner's stated identity out of a transcript so the recording
// can be auto-matched to a client record.
async function extractIdentity({ transcript, apiKey }) {
  const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4.1',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'Extract the HOMEOWNER\'s identity from this welcome-call transcript. Respond with STRICT JSON: {"homeowner_name": string, "property_address": string, "phone": string, "email": string, "installer": string} - use "" for anything not stated. Use what the homeowner themselves confirmed or stated, not what the agent guessed.',
        },
        { role: 'user', content: transcript },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Identity extraction failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return JSON.parse((await res.json()).choices[0].message.content);
}

module.exports = { transcribeAudio, analyzeTranscript, extractIdentity };
