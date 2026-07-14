const crypto = require('crypto');
const { getSetting, setSetting, getOrCreateSecret } = require('./db');

const VAPI_BASE = 'https://api.vapi.ai';
const COMPANY_NAME = process.env.COMPANY_NAME || 'Your Company';

// The default welcome-call script. Fully editable in Admin -> Call Script.
// Available variables: {{homeownerName}}, {{propertyAddress}}, {{phoneNumber}},
// {{agreementRef}}, {{terms}}, {{companyName}}
const DEFAULT_SCRIPT = `1. GREETING & RECORDING CONSENT
Say: "Hi {{homeownerName}}! Thanks so much for taking a couple of minutes for your welcome call with {{companyName}}. Before we get started, I just want to let you know this call is being recorded for quality and compliance purposes. Is that okay with you?"
- If they say yes: thank them warmly and continue.
- If they say no: politely explain the welcome call can only be completed on a recorded line, let them know a team member will reach out to help, thank them, and end the call.

2. VERIFY IDENTITY
Say: "Perfect! First, can you please confirm your full name for me?"
- Their name on file is {{homeownerName}}. A reasonable match is fine.

3. VERIFY PROPERTY ADDRESS
Say: "Great, thank you. And can you confirm the address of the property? I have it on file as {{propertyAddress}}. Is that correct?"

4. VERIFY PHONE NUMBER
Say: "And is {{phoneNumber}} still the best phone number to reach you?"

5. CONFIRM THE AGREEMENT
Say: "Wonderful. Now I just need to quickly confirm a few details about the agreement you signed. For each one, a simple 'yes' or 'I understand' is all we need. Ready?"
Then go through the agreement details one at a time, in plain friendly language, and get a clear "yes" or "I understand" for each:
{{terms}}
- Reference number on file (if any): {{agreementRef}}

6. FINAL CONFIRMATION
Say: "Amazing, that's everything! Just to wrap up: you confirm that you signed the agreement, that you understand its terms, and that all the information we just went over is accurate. Is that right?"

7. CLOSING
Say: "That's it, you're all set! Thank you so much, {{homeownerName}}. If you ever have any questions, just reach out to the {{companyName}} team any time. Have a wonderful day!"
Then end the call.`;

function buildSystemPrompt(script) {
  return `You are a warm, friendly, easy-going welcome-call specialist for {{companyName}}.
You are speaking with a homeowner to complete their official welcome call: a short, recorded verification that they understand the agreement they signed and that the information on file is accurate.

HOMEOWNER INFORMATION ON FILE:
- Name: {{homeownerName}}
- Property address: {{propertyAddress}}
- Phone number: {{phoneNumber}}
- Agreement reference: {{agreementRef}}
- Agreement details to verify: {{terms}}

STYLE:
- Sound like a friendly human, not a robot. Be upbeat, patient, and conversational.
- Keep every turn short: one question or one confirmation item at a time, then wait for the answer.
- Speak numbers, phone numbers, and addresses slowly and clearly.
- Never rush or pressure the homeowner.

RULES (very important):
- This call is recorded. You MUST get the homeowner's acknowledgment of the recording at the start before verifying anything. If they do not consent to recording, end the call politely.
- For each verification item, you need a clear affirmative like "yes", "that's right", or "I understand". A vague or hesitant answer does not count - gently re-ask once in simpler words.
- If the homeowner has a question you can answer directly from the information on file, answer it simply. NEVER invent, guess, or improvise details that are not in the information above.
- If the homeowner is confused, disagrees with any detail, has a question you cannot answer from the information on file, or seems hesitant or uncomfortable: reassure them that it's no problem at all and that a team member from {{companyName}} will personally follow up with them. Make a mental note of exactly what the issue was (it will be reported for human review). Then either continue with the remaining items or, if they prefer, end the call politely.
- If any information on file is wrong (name, address, phone, terms), note the correction they give, tell them the team will update it and follow up, and continue.
- Do not discuss anything unrelated to the welcome call. If asked, politely steer back.
- When the script is complete (or the homeowner wants to stop), thank them warmly and end the call.

CALL SCRIPT - follow this flow:
${script}`;
}

// Structured data the AI extracts after every call - powers the flag system.
const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    consented_to_recording: {
      type: 'boolean',
      description: 'Did the homeowner acknowledge and accept that the call is recorded?',
    },
    call_completed: {
      type: 'boolean',
      description: 'Did the homeowner make it through the entire welcome call script?',
    },
    confirmed_identity: { type: 'boolean', description: 'Homeowner confirmed their name.' },
    confirmed_address: { type: 'boolean', description: 'Homeowner confirmed the property address.' },
    confirmed_terms: {
      type: 'boolean',
      description: 'Homeowner clearly confirmed they understand the agreement terms.',
    },
    understood_everything: {
      type: 'boolean',
      description: 'True only if the homeowner showed no confusion or hesitation at any point.',
    },
    had_questions: {
      type: 'boolean',
      description: 'Did the homeowner ask any questions or raise any concerns?',
    },
    questions_or_concerns: {
      type: 'string',
      description: 'Exact summary of any questions or concerns the homeowner raised. Empty string if none.',
    },
    confused_about: {
      type: 'string',
      description: 'Which topics or terms the homeowner was confused or hesitant about. Empty string if none.',
    },
    info_corrections: {
      type: 'string',
      description: 'Any corrections the homeowner gave to the info on file. Empty string if none.',
    },
    flag_for_review: {
      type: 'boolean',
      description:
        'True if a human should review this call: confusion, unanswered questions, disagreement, wrong info on file, no recording consent, or an incomplete call.',
    },
    flag_reason: { type: 'string', description: 'Short reason for the flag. Empty string if not flagged.' },
  },
  required: ['call_completed', 'understood_everything', 'had_questions', 'flag_for_review'],
};

function getScript() {
  return getSetting('script_template') || DEFAULT_SCRIPT;
}

function buildAssistantPayload() {
  const appUrl = (process.env.APP_URL || '').replace(/\/+$/, '');
  const payload = {
    name: `${COMPANY_NAME} Welcome Call`,
    firstMessage: `Hi there! Am I speaking with {{homeownerName}}?`,
    model: {
      provider: 'openai',
      model: 'gpt-4o',
      temperature: 0.4,
      messages: [{ role: 'system', content: buildSystemPrompt(getScript()) }],
    },
    voice: { provider: 'vapi', voiceId: process.env.VAPI_VOICE_ID || 'Paige' },
    transcriber: { provider: 'deepgram', model: 'nova-3' },
    endCallFunctionEnabled: true,
    maxDurationSeconds: 900,
    artifactPlan: { recordingEnabled: true },
    analysisPlan: {
      summaryPlan: { enabled: true },
      structuredDataPlan: { enabled: true, schema: ANALYSIS_SCHEMA },
    },
  };
  if (appUrl) {
    payload.server = {
      url: `${appUrl}/api/vapi/webhook`,
      secret: getOrCreateSecret('webhook_secret'),
    };
  }
  return payload;
}

async function vapiRequest(method, path, body) {
  const key = process.env.VAPI_PRIVATE_KEY;
  if (!key) throw new Error('VAPI_PRIVATE_KEY is not set');
  const res = await fetch(`${VAPI_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Vapi API ${method} ${path} failed (${res.status}): ${text.slice(0, 500)}`);
  }
  return res.json();
}

// Creates the Vapi assistant on first use; updates it whenever the script,
// branding, or config changes (detected via a content hash).
async function ensureAssistant() {
  const payload = buildAssistantPayload();
  const hash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  let assistantId = getSetting('vapi_assistant_id');

  if (assistantId && getSetting('vapi_assistant_hash') === hash) return assistantId;

  if (assistantId) {
    try {
      await vapiRequest('PATCH', `/assistant/${assistantId}`, payload);
    } catch (err) {
      // Assistant may have been deleted in the Vapi dashboard - recreate it.
      console.warn('PATCH assistant failed, creating a new one:', err.message);
      assistantId = null;
    }
  }
  if (!assistantId) {
    const created = await vapiRequest('POST', '/assistant', payload);
    assistantId = created.id;
    setSetting('vapi_assistant_id', assistantId);
  }
  setSetting('vapi_assistant_hash', hash);
  return assistantId;
}

function variableValuesFor(call) {
  return {
    companyName: COMPANY_NAME,
    homeownerName: call.homeowner_name,
    propertyAddress: call.property_address,
    phoneNumber: call.phone,
    agreementRef: call.agreement_ref || 'none provided',
    terms: call.terms || 'No specific agreement details were provided; confirm they signed and understand their agreement in general.',
  };
}

// Outbound: the AI calls the homeowner's phone (requires VAPI_PHONE_NUMBER_ID).
async function startPhoneCall(call) {
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
  if (!phoneNumberId) throw new Error('VAPI_PHONE_NUMBER_ID is not configured');
  const assistantId = await ensureAssistant();
  return vapiRequest('POST', '/call', {
    assistantId,
    phoneNumberId,
    customer: { number: call.phone },
    assistantOverrides: { variableValues: variableValuesFor(call) },
  });
}

module.exports = {
  COMPANY_NAME,
  DEFAULT_SCRIPT,
  getScript,
  ensureAssistant,
  variableValuesFor,
  startPhoneCall,
};
