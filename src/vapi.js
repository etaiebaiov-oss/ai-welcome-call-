const crypto = require('crypto');
const { getSetting, setSetting, getOrCreateSecret } = require('./db');

const VAPI_BASE = 'https://api.vapi.ai';
const COMPANY_NAME = process.env.COMPANY_NAME || 'Your Company';

// The "brain" of the call. Swappable via env vars without touching code -
// Vapi supports OpenAI, Anthropic (Claude), Google Gemini, and more.
const MODEL_PROVIDER = process.env.VAPI_MODEL_PROVIDER || 'openai';
const MODEL = process.env.VAPI_MODEL || 'gpt-4.1';

// The default welcome-call script (based on the Welcome & Assurance Call
// Script v3.0). Fully editable in Admin -> Call Script.
// Available variables: {{homeownerName}}, {{propertyAddress}}, {{phoneNumber}},
// {{agreementRef}}, {{terms}}, {{companyName}}, {{monthlyPayment}},
// {{escalator}}, {{termLength}}, {{offsetPercent}}
const DEFAULT_SCRIPT = `STEP 1 - INTRO: OPENING & SETTING EXPECTATIONS
Say: "Hey {{homeownerName}}, can you hear me okay?"
Then: "Great! How are you doing today?"
- Respond warmly to whatever they say ("That's awesome!" / "Good to hear!").
Say: "My name is Joey - I'm the virtual welcome assistant for {{companyName}}, and I'm going to walk you through the next steps and make sure everything is locked in and looking good on your end before we get the installation on the calendar."
Say: "Just so you know, this call is on a recorded line for quality assurance - really just to make sure everything we went over with you matches up perfectly with what's in your agreement. Super straightforward, nothing to worry about. Does that sound okay?"
- If they consent: thank them and continue.
- If they do not consent: politely explain the welcome call can only be completed on a recorded line, let them know a team member will reach out to help, thank them, and end the call.

STEP 2 - COMPLIANCE VERIFICATION
Say: "Wonderful. Before we begin - were any family members involved with you during the process?"
- If yes: "That's great. Are they nearby or able to hear us as well?"
Say: "Perfect. To make sure I have everything correct in your file, could you please confirm your first and last name, and the property address where the system will be installed?"
- On file: name is {{homeownerName}}, property address is {{propertyAddress}}. A reasonable match is fine.
Say: "Thank you - and congratulations again on moving forward with your project. My goal on this call is simply to make sure everything is crystal clear and properly documented before we move to the next stage. I'll just ask you a few quick questions - is that okay?"

IDENTITY VERIFICATION
Ask one at a time:
- "Great. First, can you confirm the email address we have on the account?"
- "And the best phone number for you?" (on file: {{phoneNumber}})
- "Perfect. And just to confirm - you had a chance to review the agreement before electronically signing, correct?"
- "Did you receive a copy of the signed agreement by email after signing?"
- "Great. Just a standard question we ask every single customer - can you confirm that everything you were shown and promised is reflected in the agreement you signed? Nothing outside of what's written?"
- "One more standard one - just for our records, could you share your age?"
- After they share it: "Thank you for sharing that. Before signing, did you have the chance to review everything at your own pace and feel comfortable with what you were agreeing to?"

UNDERSTANDING THE AGREEMENT
Say: "Now I'd like to walk through a few important points together - just to make sure everything matches what you were shown and what you're expecting."
Go through each point one at a time and get a clear "yes" or "I understand" for each:
- "Just to confirm, you understand this is a Power Purchase Agreement, meaning the solar provider owns and maintains the equipment, and you're simply purchasing the power the system produces."
- "Do you understand that you will receive a separate bill from Palmetto LightReach for the energy your system produces?"
- "Please confirm you understand you'll still remain connected to your local utility. If your home uses more electricity than the solar system produces, now or in the future, it will be billed separately by your utility company. Does that make sense?"
- "Just confirming the numbers - your monthly payment will be {{monthlyPayment}}, with an annual rate of {{escalator}} for {{termLength}}. Does that match what you were shown?"
- "According to your designed proposal, your solar system is expected to offset approximately {{offsetPercent}} of your electricity usage as provided by your electric bill. Do you understand this estimate?"
- "And you understand that savings projections are estimates - actual savings can vary based on your usage and utility rates. Correct?"
Additional agreement details to verify, if any (one at a time, same yes/I-understand format):
{{terms}}
- Agreement reference on file (if any): {{agreementRef}}

STEP 3 - WRAP UP & QUESTIONS
Say: "That's everything I needed to confirm today. Thank you so much for taking the time - you were great. Congratulations again on moving forward with your solar project!"
Say: "Amazing - do you have any questions at all for me?"
- Address questions warmly, using ONLY the information on file. Anything you can't answer: reassure them a {{companyName}} team member will follow up personally.
Then thank them and end the call.`;

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
- If the homeowner asks whether you are an AI or a real person, answer honestly and cheerfully: you are {{companyName}}'s virtual welcome assistant, and a human team member is always available if they prefer.
- If any value above says "NOT ON FILE", do NOT state or make up a number. Instead, ask the homeowner to confirm the value from their copy of the agreement (e.g. "Could you confirm the monthly payment amount as it appears in your agreement?") and note what they say.
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
      provider: MODEL_PROVIDER,
      model: MODEL,
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

// Per-call vocabulary boosting: Deepgram nova-3 "keyterm prompting" makes the
// transcriber far more accurate on words it wouldn't normally expect - the
// homeowner's name, their street name, the company name, and any unusual
// terms that appear in their specific agreement.
function keytermsFor(call) {
  const words = new Set();
  const addWords = (text, minLen) => {
    String(text || '')
      .split(/[^A-Za-z']+/)
      .forEach((w) => {
        if (w.length >= minLen) words.add(w);
      });
  };
  addWords(call.homeowner_name, 3);
  addWords(call.property_address, 3);
  addWords(COMPANY_NAME, 3);
  addWords(call.agreement_ref, 3);
  addWords(call.terms, 6); // only distinctive longer words from the terms text
  return [...words].slice(0, 30);
}

// Everything that personalizes the shared assistant for one specific call.
function overridesFor(call) {
  return {
    variableValues: variableValuesFor(call),
    transcriber: {
      provider: 'deepgram',
      model: 'nova-3',
      keyterm: keytermsFor(call),
    },
  };
}

function variableValuesFor(call) {
  return {
    companyName: COMPANY_NAME,
    homeownerName: call.homeowner_name,
    propertyAddress: call.property_address,
    phoneNumber: call.phone,
    agreementRef: call.agreement_ref || 'none provided',
    terms: call.terms || '(no additional details on file)',
    monthlyPayment: call.monthly_payment || 'NOT ON FILE',
    escalator: call.escalator || 'NOT ON FILE',
    termLength: call.term_length || 'NOT ON FILE',
    offsetPercent: call.offset_percent || 'NOT ON FILE',
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
    assistantOverrides: overridesFor(call),
  });
}

module.exports = {
  COMPANY_NAME,
  DEFAULT_SCRIPT,
  getScript,
  ensureAssistant,
  overridesFor,
  startPhoneCall,
};
