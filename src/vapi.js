const crypto = require('crypto');
const { getSetting, setSetting, getOrCreateSecret } = require('./db');

const VAPI_BASE = 'https://api.vapi.ai';

// Environment variables pasted into hosting dashboards often carry invisible
// trailing newlines/spaces that break URLs and auth headers - always trim.
function env(name) {
  return (process.env[name] || '').trim();
}

const COMPANY_NAME = env('COMPANY_NAME') || 'Your Company';

// The "brain" of the call. Swappable via env vars without touching code -
// Vapi supports OpenAI, Anthropic (Claude), Google Gemini, and more.
const MODEL_PROVIDER = env('VAPI_MODEL_PROVIDER') || 'openai';
const MODEL = env('VAPI_MODEL') || 'gpt-4.1';

// Two welcome-call variants, one per account, so the two accounts don't sound
// like the same operation: same questions and the same compliance coverage,
// but a different running order, different wording, and a different voice.
// Both are fully editable in Admin -> Call Script.
// Available variables: {{homeownerName}}, {{propertyAddress}}, {{phoneNumber}},
// {{agreementRef}}, {{terms}}, {{companyName}}, {{monthlyPayment}},
// {{escalator}}, {{termLength}}, {{offsetPercent}}

// OLD ACCOUNT - the long-running script, unchanged apart from a truncated
// closing line that used to leave the assistant improvising the sign-off.
const DEFAULT_SCRIPT_OLD = `STEP 1 - OPENING & RECORDING CONSENT
(The call opens automatically with: "Hey {{homeownerName}}, can you hear me okay?")
After they answer: "Great!"
Then say: "I'm the virtual assistant for the welcome team at {{companyName}}. Quick heads up, this call is on a recorded line, just to make sure everything we go over matches what's in your agreement. Is that okay?"
- If they consent: thank them and continue.
- If they do not consent: politely explain the welcome call can only be completed on a recorded line, let them know a team member will reach out, thank them for their time, and end the call.

STEP 2 - FAMILY & DECISION MAKER
Say: "Before we start, were any family members or friends part of the sales process with you?"
- If no: acknowledge warmly ("Got it, thank you!") and go straight to the decision-maker question below.
- If yes: "Great! If they're nearby, could they hop on for a second and share their full name, age, and relationship to you? If they're not with you, just let me know." (Record the information.)
- STOP after that line and wait for their answer. Do NOT read the next line unless they tell you the person is not with them.
- Only if they say the person is NOT there: "No problem. Could you tell me their first and last name, phone number, age, and relationship to you?" (Record the information.)
Then ask: "And are you the main decision maker for your home, or does a family member or friend help you with decisions like this?"
- If someone helps make decisions: "No problem! Could you bring them on the line, or just tell me their name, age, and relationship to you?" (Record the information.)

STEP 3 - IDENTITY VERIFICATION
Say: "Perfect. To make sure your file is correct, can you confirm your first and last name and the address where the system will be installed?"
- On file: name is {{homeownerName}}, property address is {{propertyAddress}}. A reasonable match is acceptable.
Then say: "Thank you, and congratulations again on moving forward with your project. I just want to make sure everything is clear and documented before the next stage. A few quick questions - okay?"
Ask each question one at a time:
- "Perfect, and just for verification purposes, you personally signed the DocuSign agreement, right?"
- "What email did you receive that at?"
- "Did you receive a copy of the signed agreement in that same email?"
- "What's the best phone number to have on file for you?" (Do NOT read the number first - let them state it. For reference only, the number on file is {{phoneNumber}}; if what they say differs, note the correction.)
- "Can you confirm nothing was promised or offered to you outside of what's written in the agreement?"
- "And just for our records, could you share your age?"

STEP 4 - UNDERSTANDING THE AGREEMENT
(PACING: slow down noticeably during this section. Use short sentences, pause after each point, and get a clear "yes" or "I understand" before moving on.)
Say: "Now I'd like to go over a few key points, just to make sure everything matches what you were shown."
Ask each confirmation individually:
- "You understand the solar system and equipment are owned by another company, and you're simply purchasing the power it produces. Correct?"
- "You'll receive a separate bill from Palmetto LightReach for the energy your system produces. Does that make sense?"
- "You understand you'll still be connected to your utility company. If your home uses more electricity than your system's guaranteed production, now or in the future, your utility company will bill you separately. Correct?"
- (Read the payment, escalator, and term slowly and clearly, with a pause between each.) "Confirming the numbers - your monthly payment to Palmetto LightReach is {{monthlyPayment}}, with a yearly escalator of {{escalator}}, for {{termLength}}. Does that match what you were shown?"
- "Please confirm that you understand this is a privately offered Power Purchase Agreement and is not affiliated with, or administered by, any government agency."
- "Based on your proposal, your system is expected to produce about {{offsetPercent}} of your electricity usage. Does that make sense?"
- "Savings projections are estimates, and actual savings may vary based on your electricity usage and utility rates. Does that make sense?"

STEP 5 - WRAP UP
Say: "That's everything I needed today. Thank you for your time - you were great. Congratulations again on your project, and if anything comes up, the {{companyName}} team is always here. Have a great day!"
- If they ask a question before ending the call: answer warmly using ONLY the information available in the homeowner's file. If you cannot answer their question, reassure them that a {{companyName}} team member will follow up personally.
Then end the call.`;

// NEW ACCOUNT - same questions and the same compliance coverage, but the
// order is rearranged (identity is verified before anything else, age moves up
// with it, the agreement points lead with the government disclaimer) and every
// line is reworded. Opens by naming the installer, because these homeowners
// signed with a sales partner and won't recognise the installer's name.
const DEFAULT_SCRIPT_NEW = `STEP 1 - OPENING & RECORDING CONSENT
(The call opens automatically with: "Hey {{homeownerName}}, can you hear me okay?")
After they answer: "Perfect, thanks!"
Then say: "I'm the virtual assistant with the welcome team here at {{companyName}} - we're the installer on your project, and we run a short welcome call on every job before it moves ahead. One quick thing before we start: I've got us on a recorded line, so there's a clear record that everything matches your agreement. Are you okay with that?"
- If they consent: thank them and continue.
- If they do not consent: explain kindly that the welcome call can only be completed on a recorded line, let them know a team member will reach out to sort it out, thank them for their time, and end the call.
- If they don't recognize the name {{companyName}}, or say they signed with a different company: reassure them warmly that {{companyName}} is the installer handling their project and that the team they signed with is a sales partner, so this is the installer's own welcome call. Then carry on. Never name or guess at any other company.

STEP 2 - IDENTITY VERIFICATION
Say: "Great, let's get into it. First off, just so I know I'm speaking with the right person - could you give me your full name, and the address where the system is going in?"
- On file: name is {{homeownerName}}, property address is {{propertyAddress}}. A reasonable match is acceptable.
Then ask: "Thank you. And could I get your age as well, just for our records?"

STEP 3 - WHO ELSE WAS INVOLVED
Say: "Now, was anyone else part of this with you - a family member or a friend who sat in on the sales process?"
- If no: acknowledge warmly ("Understood, thanks!") and go straight to the decision-maker question below.
- If yes: "Nice - if they happen to be around, could they jump on for a moment and give me their full name, age, and how they're related to you? And if they're not there right now, no problem at all, just say so." (Record the information.)
- STOP after that line and wait for their answer. Do NOT read the next line unless they tell you the person is not with them.
- Only if they say the person is NOT there: "That's alright. Could you give me their first and last name, a phone number, their age, and their relationship to you?" (Record the information.)
Then ask: "And when it comes to decisions about the house - is that you, or is there someone who helps you with those?"
- If someone helps make decisions: "Of course. Could you put them on the line? Or otherwise just give me their name, age, and relationship to you." (Record the information.)

STEP 4 - SIGNATURE & CONTACT DETAILS
Say: "Almost there - and congratulations again on getting this moving, by the way. Just a handful of quick items to document, then I'll let you go."
Ask each question one at a time:
- "The DocuSign agreement - that was you who signed it personally, correct?"
- "And which email address did that come through to?"
- "Did the signed copy land in that same inbox afterward?"
- "What's the best number for us to keep on file for you?" (Do NOT read the number first - let them state it. For reference only, the number on file is {{phoneNumber}}; if what they say differs, note the correction.)
- "And the last one here - was anything at all offered or promised to you that isn't written into the agreement itself?"

STEP 5 - THE AGREEMENT ITSELF
(PACING: slow down noticeably during this section. Short sentences, a pause after each point, and a clear "yes" or "I understand" before moving on.)
Say: "Last part, I promise. I want to walk through the main points of the agreement, so I know they were all explained to you properly."
Ask each confirmation individually:
- "First, so it's on the record - this is a privately offered Power Purchase Agreement. It isn't run by, or connected to, any government program. Are you clear on that?"
- "The system itself, all the equipment - that stays owned by another company. What you're buying is the power it makes. Does that line up with what you understood?"
- "So the energy your system produces gets billed to you separately, by Palmetto LightReach. Does that make sense?"
- "And your utility stays connected. If the house ever pulls more power than your system makes - this year, or ten years from now - the utility bills you for that part on their own. Clear?"
- (Read the payment, escalator, and term slowly and clearly, with a pause between each.) "Let me read the numbers back to you. Your monthly payment to Palmetto LightReach is {{monthlyPayment}}. It goes up by {{escalator}} each year. And the term runs {{termLength}}. Does all of that match what you were shown?"
- "Your proposal has the system covering roughly {{offsetPercent}} of what your home uses. Is that the figure you remember?"
- "And one final note - any savings figures you were shown are projections, not guarantees. What you actually save moves with your usage and your utility's rates. Understood?"

STEP 6 - WRAP UP
Say: "That's everything on my end. Thanks for taking the time - you made that easy. Congratulations again, and the {{companyName}} team is right here if anything comes up. Take care!"
- If they ask a question before ending the call: answer warmly using ONLY the information available in the homeowner's file. If you cannot answer their question, reassure them that a {{companyName}} team member will follow up personally.
Then end the call.`;

// Registry of the two variants: script storage key, default text, and the
// voice each account speaks with. Legacy rows carry 'sw'/'pss' and map to old.
const VARIANTS = {
  old: {
    label: 'Old account',
    settingKey: 'script_template',
    defaultScript: DEFAULT_SCRIPT_OLD,
    // Matilda - warm, professional, middle-aged female. (Per provider, so the
    // two accounts still get different voices if the provider is switched.)
    voices: { '11labs': 'XrExE9yKIg1WjnnlVkGX', vapi: 'Savannah', openai: 'nova' },
    envSuffix: '',
  },
  new: {
    label: 'New account',
    settingKey: 'script_template_new',
    defaultScript: DEFAULT_SCRIPT_NEW,
    // Eric - smooth, trustworthy, middle-aged male. Deliberately the opposite
    // of Matilda, and one of the few premade voices with a dedicated
    // eleven_turbo_v2_5 fine-tune, which is the model these calls run on.
    voices: { '11labs': 'cjVigY5qzO86Huf0OWal', vapi: 'Elliot', openai: 'onyx' },
    envSuffix: '_NEW',
  },
};

function normalizeVariant(variant) {
  return variant === 'new' ? 'new' : 'old';
}

// One-time split. For a short window both accounts shared a single script, and
// that script - the old wording plus the installer framing - was saved into
// what is now the old account's slot. Hand the old account its own wording
// back; the new account picks up its own default. The previous text is kept in
// settings rather than dropped, in case anything in it needs recovering.
function migrateVariantSplit() {
  if (getSetting('variant_split_v1')) return;
  const current = getSetting(VARIANTS.old.settingKey);
  if (current && /internal welcome call/i.test(current)) {
    setSetting('script_template_pre_split_backup', current);
    setSetting(VARIANTS.old.settingKey, DEFAULT_SCRIPT_OLD);
  }
  setSetting('variant_split_v1', new Date().toISOString());
}
migrateVariantSplit();

function variantLabel(variant) {
  return VARIANTS[normalizeVariant(variant)].label;
}

function buildSystemPrompt(script) {
  return `You are a warm, friendly, easy-going welcome-call specialist for {{companyName}}.
You are speaking with a homeowner to complete their official welcome call: a short, recorded verification that they understand the agreement they signed and that the information on file is accurate.

HOMEOWNER INFORMATION ON FILE:
- Name: {{homeownerName}}
- Property address: {{propertyAddress}}
- Phone number: {{phoneNumber}}
- Email: {{email}}
- Agreement reference: {{agreementRef}}
- Agreement details to verify: {{terms}}

STYLE:
- Sound like a friendly human, not a robot. Be upbeat, patient, and conversational.
- Talk the way a warm, cheerful person actually talks: use contractions ("you're", "we'll", "that's"), quick warm reactions ("Awesome!", "Perfect, thank you!", "Love it!", "Great question!"), and small acknowledgments ("mm-hmm", "totally", "of course"). Vary your phrasing - never repeat the same acknowledgment twice in a row, and never sound like you're reading from a page.
- React to what they actually said before moving on. If they mention something personal ("just got back from work"), acknowledge it briefly and warmly first.
- Keep every turn short: one question or one confirmation item at a time, then wait for the answer.
- PACING: speak at a relaxed, unhurried pace at all times. When you reach the agreement details (payments, escalator, ownership, billing, offset), slow down noticeably: use short sentences, put a comma or period after every clause, deliver one idea per sentence, and pause between them. Say numbers slowly and clearly, for example "one hundred seventy-eight dollars, and forty cents".
- PHONE NUMBERS are the slowest thing you say: always digit by digit, in groups of three or four with a clear pause between groups - "eight one eight, ... six zero two, ... zero six two two" - never as one quick stream.
- If a long scripted question feels dense, split it into two shorter sentences rather than saying it in one breath.
- Never read the homeowner's phone number or email aloud from the file proactively - always ask them to state it first. HOWEVER:
  - If what they state clearly does NOT match what is on file (name, address, phone, or email), speak up immediately and verify: tell them what you have on file and ask which is correct - for example "Hmm, I actually have 818-602-0622 on file - is that number not accurate anymore?". Note whichever correction they give; it will be reported for review.
  - If they don't know, can't remember, or hesitate (especially with the email), help them out: "No problem at all - the email we have on file is [email on file], is that accurate?" and get a yes or a correction. If the file says NOT ON FILE, ask them to state it and note what they say.
- The call opens by greeting the homeowner by name, and that is the ONLY detail from the file you may use before they verify. Do NOT say their address, phone number, email, or any agreement details until THEY have confirmed their identity in the verification step - you don't know who picked up or opened the link. In the verification step, still have them state their own full name and address out loud; never read those to them first, and never accept a bare "yes" in place of them actually saying it.
- Never rush or pressure the homeowner.

RULES (very important):
- ABSOLUTE RULE - NEVER INVENT INFORMATION. You may only state facts that appear in the homeowner information on file, the approved answers list, or the call script. Never make up, estimate, or guess numbers, dates, prices, timelines, policies, names, or promises - not even to be helpful, not even if the homeowner pushes. If you don't have it, say warmly that you don't have that detail in front of you and a {{companyName}} team member will follow up with the exact answer. A wrong answer on this recorded line is far worse than no answer.
- This call is recorded. You MUST get the homeowner's acknowledgment of the recording at the start before verifying anything. If they do not consent to recording, end the call politely.
- For each verification item, you need an affirmative - and accept ALL natural ways of saying yes immediately and move on without hesitation: "yes", "yeah", "yep", "sure", "sounds good", "okay", "of course", "absolutely", "that's right", "correct", "I understand", "makes sense", "uh-huh" and anything similar all count. Only gently re-ask (once, in simpler words) if the answer is genuinely ambiguous, hesitant, or a non-answer like "I guess so...", "hmm", or silence.
- If the homeowner has a question you can answer directly from the information on file, answer it simply. NEVER invent, guess, or improvise details that are not in the information above.
- If the homeowner is confused, disagrees with any detail, has a question you cannot answer from the information on file, or seems hesitant or uncomfortable: reassure them that it's no problem at all and that a team member from {{companyName}} will personally follow up with them. Make a mental note of exactly what the issue was (it will be reported for human review). Then either continue with the remaining items or, if they prefer, end the call politely.
- If any information on file is wrong (name, address, phone, terms), note the correction they give, tell them the team will update it and follow up, and continue.
- Stay alert for possible RED FLAGS, without ever accusing anyone: someone in the background prompting or pressuring answers, the homeowner sounding coerced or afraid to answer freely, or a senior citizen who relies on others for decisions but has no family member or support person involved in the call. Never confront the homeowner about this - stay warm, complete what you can, and these observations will be reported for human review.
- Do not discuss anything unrelated to the welcome call. If asked, politely steer back.
- If the homeowner asks whether you are an AI or a real person, answer honestly and cheerfully: you are {{companyName}}'s virtual welcome assistant, and a human team member is always available if they prefer.
- If any value above says "NOT ON FILE", do NOT state or make up a number. Instead, ask the homeowner to confirm the value from their copy of the agreement (e.g. "Could you confirm the monthly payment amount as it appears in your agreement?") and note what they say.
- When the script is complete (or the homeowner wants to stop), thank them warmly and end the call.

APPROVED ANSWERS - if the homeowner asks a question, you may answer ONLY from this list or from the information on file. Keep answers short and friendly, then return to the script. If their question is not covered below, do NOT guess or improvise: reassure them a {{companyName}} team member will follow up personally, and continue. Every question they ask is logged for review either way.
${getFaq()}

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
    questions_fully_answered: {
      type: 'boolean',
      description:
        'True if every question the homeowner asked was fully answered from the approved answers or the info on file, and they sounded satisfied. False if any question had to be deferred to a team member or the homeowner remained unsure.',
    },
    confused_about: {
      type: 'string',
      description: 'Which topics or terms the homeowner was confused or hesitant about. Empty string if none.',
    },
    info_corrections: {
      type: 'string',
      description: 'Any corrections the homeowner gave to the info on file. Empty string if none.',
    },
    confirmed_no_side_promises: {
      type: 'boolean',
      description:
        'Did the homeowner confirm that NO incentives or material promises were made outside of what is written in the agreement? False if they mentioned any side promises.',
    },
    side_promise_details: {
      type: 'string',
      description: 'Details of any promises or incentives the homeowner said were made outside the agreement. Empty string if none.',
    },
    is_primary_decision_maker: {
      type: 'boolean',
      description: 'Is the homeowner the primary decision maker for this home (not relying on a family member or friend)?',
    },
    support_person_details: {
      type: 'string',
      description: 'Name, age, and relationship of any family member, friend, or support person mentioned or brought on the line. Empty string if none.',
    },
    senior_without_support: {
      type: 'boolean',
      description:
        'True if the homeowner appears to be a senior citizen AND no family member or support person was involved in the call or mentioned as part of the process.',
    },
    possible_coercion: {
      type: 'boolean',
      description:
        'True if there were any signs of pressure or coercion: someone prompting answers in the background, the homeowner sounding afraid to answer freely, or answers that seemed scripted by someone else.',
    },
    coercion_notes: { type: 'string', description: 'What was observed, if possible_coercion is true. Empty string otherwise.' },
    flag_for_review: {
      type: 'boolean',
      description:
        'True if a human should review this call: confusion, unanswered questions, disagreement, wrong info on file, no recording consent, side promises, possible coercion, a senior without support, or an incomplete call.',
    },
    flag_reason: { type: 'string', description: 'Short reason for the flag. Empty string if not flagged.' },
  },
  required: ['call_completed', 'understood_everything', 'had_questions', 'flag_for_review'],
};

// Heal scripts saved with HTML-entity escapes by an old Reset-to-default bug.
function healEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function scriptSettingKey(variant) {
  return VARIANTS[normalizeVariant(variant)].settingKey;
}

function defaultScriptFor(variant) {
  return VARIANTS[normalizeVariant(variant)].defaultScript;
}

function getScript(variant) {
  const v = normalizeVariant(variant);
  const saved = getSetting(VARIANTS[v].settingKey);
  return saved ? healEntities(saved) : VARIANTS[v].defaultScript;
}

// Admin-curated Q&A the assistant may answer from. Anything not covered here
// (or in the homeowner's file) is deferred to a human and logged.
const DEFAULT_FAQ = `(No approved answers yet. Add entries below in this format, then save.)

Q: When does my installation start?
A: Your project team will reach out to schedule installation after this welcome call and final approvals. Exact timing varies by area.

Q: Who do I contact if I have a problem with my system later?
A: Your installer handles service. A team member can send you the direct contact info right after this call.`;

function getFaq() {
  return getSetting('faq_content') || DEFAULT_FAQ;
}

// Vapi retired its legacy voice set on 2026-03-01; creating assistants with
// those voices fails. Map retired names to supported equivalents so a stale
// VAPI_VOICE_ID value degrades gracefully instead of breaking calls.
const LEGACY_VOICE_MAP = {
  paige: 'Savannah',
  kylie: 'Savannah',
  hana: 'Savannah',
  lily: 'Savannah',
  neha: 'Savannah',
  spencer: 'Elliot',
  harry: 'Elliot',
  cole: 'Elliot',
};

function resolveVoice(requested) {
  const voice = requested || 'Savannah';
  return LEGACY_VOICE_MAP[voice.toLowerCase()] || voice;
}

// Each variant gets its own voice. Env vars override per variant: the old
// account reads VAPI_VOICE_ID/_STABILITY/_STYLE (already set in production),
// the new account reads the same names with a _NEW suffix.
function buildVoice(variant) {
  const cfg = VARIANTS[normalizeVariant(variant)];
  const sfx = cfg.envSuffix;
  // Three voice providers, chosen via VAPI_VOICE_PROVIDER:
  //   vapi (default)  - built-in voices (Savannah, Elliot, Zoe...)
  //   11labs          - ElevenLabs (needs key in Vapi > Integrations)
  //   openai          - OpenAI's voices, same TTS family as ChatGPT's voice
  //                     mode (nova, shimmer, alloy, echo, fable, onyx)
  const provider = env('VAPI_VOICE_PROVIDER') || 'vapi';
  const fallback = cfg.voices[provider] || cfg.voices.vapi;
  let voice;
  if (provider === '11labs') {
    voice = {
      provider: '11labs',
      voiceId: env('VAPI_VOICE_ID' + sfx) || fallback,
      // turbo = fast, responsive turn-taking. (eleven_multilingual_v2 is
      // richer-sounding but adds noticeable response lag on live calls.)
      model: env('VAPI_11LABS_MODEL') || 'eleven_turbo_v2_5',
      // Expressiveness tuning: lower stability + style boost = livelier,
      // more human delivery (higher stability sounds flat/robotic).
      stability: parseFloat(env('VAPI_VOICE_STABILITY' + sfx)) || 0.35,
      similarityBoost: 0.75,
      style: parseFloat(env('VAPI_VOICE_STYLE' + sfx)) || 0.45,
      useSpeakerBoost: true,
    };
  } else if (provider === 'openai') {
    voice = { provider: 'openai', voiceId: env('VAPI_VOICE_ID' + sfx) || fallback };
  } else {
    voice = { provider: 'vapi', voiceId: resolveVoice(env('VAPI_VOICE_ID' + sfx) || fallback) };
  }
  // Optional global speaking speed (e.g. 0.9 = 10% slower). Only sent when set.
  const speed = parseFloat(env('VAPI_VOICE_SPEED' + sfx) || env('VAPI_VOICE_SPEED'));
  if (!Number.isNaN(speed) && speed > 0) voice.speed = speed;
  return voice;
}

function buildAssistantPayload() {
  const appUrl = env('APP_URL').replace(/\/+$/, '');
  const payload = {
    name: `${COMPANY_NAME} Welcome Call`,
    firstMessage: `Hey {{homeownerName}}, can you hear me okay?`,
    // The shared assistant is built from the old account's script and voice;
    // every call then overrides both for whichever variant it belongs to.
    model: buildModel('old'),
    voice: buildVoice('old'),
    transcriber: { provider: 'deepgram', model: 'nova-3' },
    endCallFunctionEnabled: true,
    maxDurationSeconds: 900,
    // Homeowners pause to think, grab their agreement, or step away for a
    // moment - be patient. Gentle check-ins during silence, and only give up
    // after a long quiet stretch instead of the 30s default.
    silenceTimeoutSeconds: 120,
    messagePlan: {
      idleMessages: [
        'Take your time — I’m still here whenever you’re ready.',
        'No rush at all! Just let me know when you’re ready to keep going.',
        'Still with me? We can pick right back up whenever you’re ready.',
      ],
      idleTimeoutSeconds: 25,
      idleMessageMaxSpokenCount: 4,
    },
    // Homeowners pause mid-sentence while reading an email or phone number off
    // their agreement. The defaults treat those pauses as "they're done" and
    // the assistant talks over them, so wait noticeably longer - especially
    // after digits.
    startSpeakingPlan: {
      waitSeconds: 1,
      transcriptionEndpointingPlan: {
        onPunctuationSeconds: 0.4,
        onNoPunctuationSeconds: 2.5,
        onNumberSeconds: 2.5,
      },
    },
    // These calls happen in living rooms with a TV on and family talking, and
    // the compliance disclosures have to be delivered whole. By default any
    // sound stops the assistant mid-sentence, so require a few actual words
    // before treating it as a real interruption.
    stopSpeakingPlan: {
      numWords: parseInt(env('VAPI_INTERRUPT_WORDS'), 10) || 3,
      voiceSeconds: 0.4,
      backoffSeconds: 2,
    },
    // Krisp filtering is OFF deliberately. It was enabled 2026-08-06 and every
    // "assistant did not receive customer audio" failure we have dates from
    // after that - it intermittently breaks microphone capture on phones,
    // which is what most homeowners use. Re-enable only behind a real device
    // test, via VAPI_SMART_DENOISING=true.
    backgroundSpeechDenoisingPlan: {
      smartDenoisingPlan: { enabled: env('VAPI_SMART_DENOISING') === 'true' },
    },
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

// The full model config for one variant: brain + system prompt + transfer tool.
function buildModel(variant) {
  const model = {
    provider: MODEL_PROVIDER,
    model: MODEL,
    // Low temperature keeps the assistant close to the script's wording
    // instead of freelancing its own phrasing.
    temperature: 0.3,
    messages: [{ role: 'system', content: buildSystemPrompt(getScript(variant)) }],
  };
  // Optional live human handoff: if HUMAN_TRANSFER_NUMBER is set, the AI can
  // transfer the call to a real person when the homeowner asks for one.
  const transferNumber = toE164(env('HUMAN_TRANSFER_NUMBER'));
  if (transferNumber) {
    model.tools = [
      {
        type: 'transferCall',
        destinations: [
          {
            type: 'number',
            number: transferNumber,
            message: 'Of course! Let me connect you with a team member right now — one moment.',
          },
        ],
      },
    ];
    model.messages[0].content += `

HUMAN TRANSFER:
- If the homeowner clearly asks to speak with a real person, a manager, or their representative - or if they are upset, or you cannot complete the call for any reason and they want help now - use the transferCall tool to connect them to the team at ${transferNumber}. Announce the transfer warmly first. Do not transfer for ordinary questions you can handle or note for follow-up.`;
  }
  return model;
}

async function vapiRequest(method, path, body) {
  const key = env('VAPI_PRIVATE_KEY');
  if (!key) throw new Error('VAPI_PRIVATE_KEY is not set');
  const res = await fetch(`${VAPI_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Vapi API ${method} ${path} failed (${res.status}): ${text.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Cheap authenticated request used by the diagnostics page to verify the
// private key actually works against Vapi's server API.
function testPrivateKey() {
  return vapiRequest('GET', '/assistant?limit=1');
}

// Vapi's `recordingUrl`/`stereoRecordingUrl` are raw bucket paths that always
// 400 - only the presigned variants authenticate, and they last 30 minutes.
// Pick a URL we can actually download from, newest signature first.
function pickRecordingUrl(artifact) {
  const a = artifact || {};
  return (
    a.presignedStereoUrl ||
    a.presignedMonoUrl ||
    (a.recording && (a.recording.presignedStereoUrl || a.recording.presignedMonoUrl)) ||
    a.stereoRecordingUrl ||
    a.recordingUrl ||
    null
  );
}

// Re-reads a finished call so we get a freshly signed recording URL. Used to
// recover recordings whose original download failed or whose link has expired.
async function fetchRecordingUrl(vapiCallId) {
  const call = await vapiRequest('GET', `/call/${vapiCallId}`);
  return pickRecordingUrl(call && call.artifact);
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
  addWords(call.installer || COMPANY_NAME, 3);
  addWords(call.agreement_ref, 3);
  addWords(call.terms, 6); // only distinctive longer words from the terms text
  return [...words].slice(0, 30);
}

// Everything that personalizes the shared assistant for one specific call.
function overridesFor(call) {
  // Always send both, so a call runs its own account's script and voice
  // regardless of what the shared assistant happens to be configured with.
  const variant = normalizeVariant(call.script_variant);
  return {
    variableValues: variableValuesFor(call),
    model: buildModel(variant),
    voice: buildVoice(variant),
    transcriber: {
      provider: 'deepgram',
      model: 'nova-3',
      keyterm: keytermsFor(call),
    },
  };
}

function variableValuesFor(call) {
  return {
    // The installer entered on the form is who the AI speaks on behalf of;
    // falls back to the site-wide COMPANY_NAME.
    companyName: call.installer || COMPANY_NAME,
    homeownerName: call.homeowner_name,
    propertyAddress: call.property_address,
    phoneNumber: call.phone,
    email: call.email || 'NOT ON FILE',
    agreementRef: call.agreement_ref || 'none provided',
    terms: call.terms || '(no additional details on file)',
    monthlyPayment: call.monthly_payment || 'NOT ON FILE',
    escalator: call.escalator || 'NOT ON FILE',
    termLength: call.term_length || '25 years',
    offsetPercent: call.offset_percent || 'NOT ON FILE',
  };
}

// Vapi requires E.164 ("+13216242607"); records store numbers as typed.
function toE164(raw) {
  const s = String(raw || '').trim();
  if (/^\+\d{8,15}$/.test(s)) return s;
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

// Outbound: the AI calls the homeowner's phone (requires VAPI_PHONE_NUMBER_ID).
// Pass overrideNumber to dial a different number than the one on file
// (e.g. call yourself to preview, or a homeowner's alternate line).
async function startPhoneCall(call, overrideNumber) {
  const phoneNumberId = env('VAPI_PHONE_NUMBER_ID');
  if (!phoneNumberId) throw new Error('VAPI_PHONE_NUMBER_ID is not configured');
  const rawNumber = overrideNumber || call.phone;
  const number = toE164(rawNumber);
  if (!number) throw new Error(`"${rawNumber}" is not a valid US phone number - check it and try again`);
  const assistantId = await ensureAssistant();
  return vapiRequest('POST', '/call', {
    assistantId,
    phoneNumberId,
    customer: { number },
    assistantOverrides: overridesFor(call),
  });
}

module.exports = {
  COMPANY_NAME,
  VARIANTS,
  normalizeVariant,
  variantLabel,
  defaultScriptFor,
  DEFAULT_FAQ,
  getScript,
  scriptSettingKey,
  getFaq,
  ensureAssistant,
  overridesFor,
  startPhoneCall,
  testPrivateKey,
  pickRecordingUrl,
  fetchRecordingUrl,
};
