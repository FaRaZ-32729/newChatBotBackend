const {
  buildNumberedImageCatalog,
} = require('./chatbotImageService');

function cleanTopicDisplayName(name) {
  return String(name || '')
    .replace(/\.pdf$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b(pvt\.?\s*ltd\.?|private\s+limited|profile\s*\d{2,4}|rag)\b/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*[.,;]+\s*$/g, '')
    .trim();
}

function buildTopicGreeting(topics) {
  if (!topics.length) return 'our products and services';
  const names = topics.map((t) => cleanTopicDisplayName(t.displayName)).filter(Boolean);
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} aur ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, aur ${names[names.length - 1]}`;
}

function splitKnowledgeDocuments(knowledgeText) {
  const raw = String(knowledgeText || '');
  const parts = raw.split(/\n*===== DOCUMENT:\s*/i);
  const docs = [];

  for (let i = 1; i < parts.length; i += 1) {
    const chunk = parts[i];
    const nl = chunk.indexOf('\n');
    const nameLine = (nl >= 0 ? chunk.slice(0, nl) : chunk)
      .replace(/=+/g, '')
      .replace(/\.pdf$/i, '')
      .trim();
    const body = (nl >= 0 ? chunk.slice(nl + 1) : '')
      .replace(/----------------Page.*?----------------/gi, '\n')
      .trim();
    if (nameLine || body) {
      docs.push({ name: nameLine || `Document ${i}`, body });
    }
  }

  if (!docs.length && raw.trim()) {
    docs.push({ name: 'Knowledge', body: raw.trim() });
  }
  return docs;
}

function compressWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function extractProductIdentity(body, maxLen = 220) {
  const cleaned = compressWhitespace(body);
  if (!cleaned) return '';

  const window = cleaned.slice(0, Math.min(cleaned.length, 3500));
  const patterns = [
    /comp\s*anion\s+for\s+hajj\s*(?:&|and)\s*umrah[^.!?]{0,100}/i,
    /mushaba\s+is\s+a\s+mobile\s+app[^.!?]{10,140}/i,
    /during\s+hajj\s+or\s+umrah[^.!?]{10,140}/i,
    /every\s+year[^.!?]{0,40}(?:hajj|umrah)[^.!?]{10,120}/i,
    /(?:is a|helps|designed to|made to)\s+(?:mobile\s+)?(?:app|platform|solution|companion)[^.!?]{10,120}/i,
    /(?:tagline|overview)\s*[:\-–]?\s*[^.!?]{8,100}/i,
  ];

  for (const re of patterns) {
    const m = window.match(re);
    if (!m) continue;
    const start = Math.max(0, m.index - 30);
    let snippet = compressWhitespace(window.slice(start, m.index + m[0].length + 40));
    return snippet.slice(0, maxLen);
  }

  return cleaned.slice(0, maxLen);
}

function pickDocumentExcerpt(body, budget) {
  const cleaned = compressWhitespace(body);
  if (!cleaned) return '';
  if (cleaned.length <= budget) return cleaned;

  const identity = extractProductIdentity(body, Math.min(200, Math.floor(budget * 0.4)));
  const anchors = [
    /companion\s+for\s+hajj/i,
    /during\s+hajj\s+or\s+umrah/i,
    /the\s+problem\s+\w+\s+solves/i,
    /key\s+features/i,
    /overview/i,
  ];

  const chunks = [];
  const pushUnique = (piece) => {
    const p = compressWhitespace(piece);
    if (!p || p.length < 30) return;
    if (chunks.some((c) => c.includes(p.slice(0, 40)))) return;
    chunks.push(p);
  };

  if (identity) pushUnique(identity);
  for (const re of anchors) {
    const m = cleaned.match(re);
    if (!m || m.index == null) continue;
    pushUnique(cleaned.slice(Math.max(0, m.index - 20), m.index + Math.min(420, budget)));
    if (chunks.join(' ').length >= budget) break;
  }

  let out = chunks.join(' … ');
  if (out.length < budget * 0.4) out = cleaned.slice(0, budget);
  return out.slice(0, budget);
}

/**
 * Keep live prompt small — large context = slow first audio (20s+).
 */
function buildBalancedKnowledgeForLive(knowledgeText, maxChars = 4500) {
  const docs = splitKnowledgeDocuments(knowledgeText);
  if (!docs.length) return '';

  const overhead = docs.length * 70;
  const perDoc = Math.max(550, Math.floor((maxChars - overhead) / docs.length));

  const sections = docs.map((doc) => {
    const identity = extractProductIdentity(doc.body, 180);
    const bodyBudget = Math.max(350, perDoc - identity.length - 30);
    const body = pickDocumentExcerpt(doc.body, bodyBudget);
    return [
      `===== ${cleanTopicDisplayName(doc.name)} =====`,
      identity ? `PURPOSE: ${identity}` : null,
      body,
    ].filter(Boolean).join('\n');
  });

  let out = sections.join('\n\n');
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n…`;
  return out;
}

function trimKnowledgeForLive(text, maxChars = 4500) {
  return buildBalancedKnowledgeForLive(text, maxChars);
}

/** Compact image index for speed — unique sections only, short labels. */
function formatImageIndexForPrompt(catalog, _knowledgeText, maxImages = 36) {
  if (!catalog.length) return '(none)';

  const byPdf = new Map();
  for (const img of catalog) {
    if (!byPdf.has(img.pdfKey)) byPdf.set(img.pdfKey, []);
    byPdf.get(img.pdfKey).push(img);
  }

  const lines = [];
  let count = 0;
  for (const [pdfKey, imgs] of byPdf) {
    lines.push(`--- ${pdfKey} ---`);
    const seen = new Set();
    for (const img of imgs) {
      if (count >= maxImages) {
        lines.push(`(+ ids up to ${catalog.length})`);
        return lines.join('\n');
      }
      const topicKey = String(img.topic || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (seen.has(topicKey)) continue;
      seen.add(topicKey);
      lines.push(`[${img.id}] ${String(img.topic || '').slice(0, 70)}`);
      count += 1;
    }
  }
  return lines.join('\n');
}

function buildChatbotLiveInstruction(chatbot, knowledgeText) {
  const botName = chatbot.name || 'Assistant';
  const activationKey = (chatbot.activationKey || '').trim();
  const extraInstructions = (chatbot.specificInstructions || '').trim();
  const scanCardRequired = Boolean(chatbot.scanCardRequired);
  // Enough context for detailed answers; still capped for latency
  const context = buildBalancedKnowledgeForLive(knowledgeText, 5500);
  const { catalog, topics } = buildNumberedImageCatalog(chatbot);

  const topicListText = topics.length
    ? topics.map((t) => `- "${t.pdfKey}" = ${cleanTopicDisplayName(t.displayName)}`).join('\n')
    : '(none)';

  const greetingTopics = buildTopicGreeting(topics);
  const spokenTopicBullets = topics.length
    ? topics.map((t) => `• ${cleanTopicDisplayName(t.displayName)}`).join('\n')
    : '• (none)';
  const imageListText = formatImageIndexForPrompt(catalog, knowledgeText, 48);

  const leadSection = scanCardRequired
    ? `LEAD CAPTURE (when user wants to end / leave details / goodbye):
- FIRST ask: verbally share details, or scan visiting card on camera?
- PATH A (Voice): Ask Name, then Company, Designation, Phone, Email — one at a time.
  As soon as you have Name + Phone (or Name + Email), emit EXACTLY:
  [SHOW_LEAD_FORM|Name|Company|Designation|Phone|Email]
  Then READ the details aloud and ask: "Kya yeh details sahi hain?"
  On YES → call submitLead. On NO → correct fields, show form again, re-confirm.
- PATH B (Card): Say you will open the camera, then emit [ACTIVATE_CAMERA] and STOP talking.
- On [CARD_SCANNED]: form is already on screen — read the fields aloud, ask confirm, then submitLead on YES.
- Never invent contact fields. Never skip the on-screen form.`
    : `LEAD CAPTURE (when user wants to end / leave details / goodbye):
- Collect Name, Company, Designation, Phone, Email one at a time.
- When you have Name + Phone (or Name + Email), emit:
  [SHOW_LEAD_FORM|Name|Company|Designation|Phone|Email]
- Read details aloud, ask confirm. YES → submitLead. NO → fix and re-show form.
- Never invent fields. Always show the form before saving.`;

  return `You are "${botName}" — a warm, professional kiosk voice expert. AUDIO ONLY. Speak like a knowledgeable human host.

STYLE:
- Natural, clear, polite. Never say PDF, AI, knowledge base, markers, or image numbers aloud.
- Match the user's language (Urdu / English / Roman Urdu).
- Answers must be DETAILED and helpful — not short one-liners.

WAKE / INTRODUCTION (4–6 spoken sentences — warm & complete):
- Wake ONLY on the activation phrase "${activationKey}" (do not treat hi/hello/other greetings as wake unless that is the activation phrase).
- Introduce yourself properly: who you are, what you cover by NAME (not "and more"), what kind of help you give (features, benefits, how it works), then invite a question.
- Example style: "Assalam o alaikum! Main ${botName} hoon. Main aapki ${greetingTopics} ke bare mein detail se batata hoon — features, benefits, aur kaise kaam karta hai. Aap kisi bhi product ya service ke bare mein poochhein, main clear jawab dunga."
- Name the real topics. Never say vague "and more" / "aur more".
- [[TOPIC: General]] only on greeting. No SHOW_IMAGE on greeting. Never greet twice.
- After [SESSION_ENDED]: stay silent until a new wake / [USER_ACTIVATED].

TOPICS (speak these names):
${spokenTopicBullets}

TOPIC KEYS (hidden [[TOPIC: pdfKey]]):
${topicListText}

CONTEXT (PURPOSE is authoritative):
${context || '(empty)'}

IMAGES (hidden — [[SHOW_IMAGE:N]] only; match what YOU are saying right now):
${imageListText}

NOTES: ${extraInstructions || 'none'}

RULES:
0) Never speak: [[TOPIC:]] [[SHOW_IMAGE:N]] [SHOW_LEAD_FORM|…] [ACTIVATE_CAMERA]
1) Every reply starts with [[TOPIC:pdfKey]] or [[TOPIC: General]] matching YOUR answer content.
2) PRODUCT IDENTITY: "kya hai / what is" → open with PURPOSE from CONTEXT (e.g. Mushaba = Hajj & Umrah companion). Do NOT lead with B2B/SaaS/Premium unless user asked business/pricing.
3) IMAGE SYNC (critical): As YOU speak each point, emit [[SHOW_IMAGE:N]] whose title best matches that exact point (lost assistance → Lost Assistance ids; tracking → tracking; overview → Overview). Switch SHOW_IMAGE when you change sub-topic. Prefer exact title match. Never invent ids.
4) DETAILED ANSWERS (required):
   - Identity / overview: 5–8 clear sentences with concrete facts from CONTEXT.
   - Features / how-it-works: up to ~10 sentences, structured (direct answer → key points → benefit → short follow-up).
   - Do NOT give shallow 1–2 sentence replies for product questions.
5) Unknown topic → polite sorry + redirect to ${greetingTopics}.
6) Garbled STT → answer the meaning; don't repeat garbage.
7) [INACTIVITY_CHECK] → ask if they want to end. [SESSION_ENDED] → absolute silence until wake.
${leadSection}`;
}

module.exports = {
  buildChatbotLiveInstruction,
  buildBalancedKnowledgeForLive,
  trimKnowledgeForLive,
  splitKnowledgeDocuments,
  extractProductIdentity,
  buildTopicGreeting,
  cleanTopicDisplayName,
};
