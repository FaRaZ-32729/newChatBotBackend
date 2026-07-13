/**
 * Visiting-card OCR via Mindee (replaces Gemini vision card scan).
 */
const fs = require('fs/promises');
const path = require('path');
const { PathInput, Client, product } = require('mindee');
const { assertMindeeConfigured } = require('../config/mindeeConfig');

function normalizeFieldValue(field) {
  if (field == null) return '';
  if (typeof field === 'string') return field.trim();
  if (typeof field === 'number' || typeof field === 'boolean') return String(field);

  if (Array.isArray(field)) {
    return field.map((item) => normalizeFieldValue(item)).filter(Boolean).join(', ');
  }

  if (typeof field === 'object') {
    if (typeof field.stringValue === 'string' && field.stringValue.trim()) {
      return field.stringValue.trim();
    }
    if (field.value !== undefined && field.value !== null) {
      return normalizeFieldValue(field.value);
    }
    if (typeof field.content === 'string' && field.content.trim()) {
      return field.content.trim();
    }
    if (typeof field.raw_value === 'string' && field.raw_value.trim()) {
      return field.raw_value.trim();
    }
    if (typeof field.toString === 'function') {
      const text = field.toString();
      if (text && text !== '[object Object]') return text.trim();
    }
  }

  return '';
}

function labelFromKey(key) {
  return String(key || '')
    .replace(/_/g, ' ')
    .replace(/([A-Z])/g, ' $1')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function extractAllFields(obj) {
  if (!obj || typeof obj !== 'object') return [];

  const result = [];
  const entries = obj instanceof Map ? [...obj.entries()] : Object.entries(obj);

  for (const [key, val] of entries) {
    if (key.startsWith('_') || key === 'extras' || key === 'raw_value') continue;
    const value = normalizeFieldValue(val);
    if (value) {
      result.push({ key, label: labelFromKey(key), value });
    }
  }

  return result;
}

function mapToCardData(fields) {
  const f = {};
  for (const { key, value } of fields) {
    f[String(key).toLowerCase()] = value;
  }

  const pick = (...keys) => {
    for (const k of keys) {
      if (f[k]) return f[k];
    }
    return '';
  };

  return {
    firstName: pick('first_name', 'firstname', 'given_name', 'first name'),
    lastName: pick('last_name', 'lastname', 'surname', 'family_name', 'last name'),
    fullName: pick('name', 'full_name', 'fullname', 'contact_name'),
    company: pick('company', 'company_name', 'organization', 'organisation', 'employer'),
    designation: pick(
      'designation',
      'job_title',
      'jobtitle',
      'job_position',
      'position',
      'title',
      'role'
    ),
    jobTitle: pick(
      'job_title',
      'jobtitle',
      'job_position',
      'position',
      'title',
      'role',
      'designation'
    ),
    email: pick('email', 'email_address', 'e_mail', 'mail'),
    phone: pick(
      'phone_number',
      'phone',
      'mobile',
      'tel',
      'telephone',
      'contact_number',
      'cell'
    ),
    website: pick('website', 'url', 'web', 'linkedin'),
    address: pick('address', 'location', 'city', 'country'),
  };
}

function parseCardTextFallback(text) {
  const source = String(text || '').replace(/\r/g, '\n');
  const lines = source
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const email = source.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
  const phone = source.match(/(?:\+?\d[\d\s().-]{6,}\d)/)?.[0]?.trim() || '';
  const website =
    source.match(/\b(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+\.[a-z]{2,}(?:\/\S*)?\b/i)?.[0] || '';

  const ignored =
    /(email|mail|phone|mobile|tel|cell|www\.|http|address|street|road|linkedin|facebook|instagram)/i;

  const likelyName =
    lines.find((line) => {
      if (ignored.test(line)) return false;
      if (email && line.includes(email)) return false;
      if (phone && line.includes(phone)) return false;
      const words = line.split(/\s+/);
      return (
        words.length >= 2
        && words.length <= 4
        && words.every((word) => /^[A-Za-z][A-Za-z.'-]*$/.test(word))
      );
    }) || '';

  const company =
    lines.find((line) => {
      if (line === likelyName || ignored.test(line)) return false;
      return /(pvt|ltd|llc|inc|company|solutions|technologies|systems|group|enterprises|distribution)/i.test(
        line
      );
    }) || '';

  const address =
    lines.find((line) => {
      if (line === likelyName || line === company) return false;
      return /(karachi|lahore|islamabad|rawalpindi|pakistan|road|street|sector|floor|office|suite|block|city)/i.test(
        line
      );
    }) || '';

  const [firstName = '', ...restName] = likelyName.split(/\s+/);

  return {
    firstName,
    lastName: restName.join(' '),
    fullName: likelyName,
    company,
    designation: '',
    jobTitle: '',
    email,
    phone,
    website,
    address,
  };
}

function mergeCardData(primary, fallback) {
  const merged = { ...primary };
  for (const [key, value] of Object.entries(fallback || {})) {
    if (!merged[key] && value) merged[key] = value;
  }
  return merged;
}

function toPredictionObject(response) {
  return response?.inference?.result?.fields || response?.inference?.prediction || {};
}

function toLeadShape(cardData) {
  const fullName =
    cardData.fullName
    || [cardData.firstName, cardData.lastName].filter(Boolean).join(' ').trim();

  return {
    name: fullName,
    company: cardData.company || '',
    designation: cardData.designation || cardData.jobTitle || '',
    phone: cardData.phone || '',
    email: cardData.email || '',
  };
}

async function runMindeeExtractionWithSdk({ mindeeClient, modelId, inputPath }) {
  const inputSource = new PathInput({ inputPath });

  return mindeeClient.enqueueAndGetResult(
    product.Extraction,
    inputSource,
    { modelId: String(modelId).trim() },
    { initialDelaySec: 2, delaySec: 1.5, maxRetries: 40 }
  );
}

async function enqueueViaHttp({ apiKey, modelId, filePath, mimeType, filename }) {
  const bytes = await fs.readFile(filePath);
  const form = new FormData();
  form.set('model_id', modelId);
  form.set(
    'file',
    new Blob([bytes], { type: mimeType || 'application/octet-stream' }),
    filename || 'card.jpg'
  );

  const res = await fetch('https://api-v2.mindee.net/v2/products/extraction/enqueue', {
    method: 'POST',
    headers: { Authorization: apiKey },
    body: form,
  });

  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const code = payload?.code || '';
    const detail = payload?.detail || payload?.title || `HTTP ${res.status}`;
    if (res.status === 402 || code.startsWith('402')) {
      throw new Error(
        `Mindee subscription inactive (${code || '402'}). `
          + 'Save the renewed API key + model ID in backend/.env, then restart the server. '
          + `Detail: ${detail}`
      );
    }
    throw new Error(`Mindee enqueue failed: ${detail}`);
  }

  const jobId = payload?.job?.id;
  if (!jobId) {
    throw new Error('Mindee enqueue succeeded but no job ID was returned.');
  }

  return jobId;
}

async function pollJobAndFetchResult({
  apiKey,
  jobId,
  mindeeClient,
  maxRetries = 45,
  delayMs = 1500,
}) {
  let lastPollError = null;

  for (let i = 0; i < maxRetries; i += 1) {
    let jobPayload;
    try {
      const jobResponse = await mindeeClient.getJob(jobId);
      jobPayload = { job: jobResponse?.job };
    } catch (pollErr) {
      lastPollError = pollErr?.message || 'Unknown polling error';
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }

    const status = jobPayload?.job?.status;
    const resultUrl = jobPayload?.job?.result_url || jobPayload?.job?.resultUrl;
    const remoteError = jobPayload?.job?.error;

    if (remoteError) {
      throw new Error(remoteError?.detail || remoteError?.message || 'Mindee job failed.');
    }

    if ((status === 'Processed' || status === 'Completed') && resultUrl) {
      const resultRes = await fetch(resultUrl, {
        headers: { Authorization: apiKey },
      });
      const resultPayload = await resultRes.json().catch(() => null);
      if (!resultRes.ok) {
        const detail = resultPayload?.detail || resultPayload?.title || `HTTP ${resultRes.status}`;
        throw new Error(`Mindee result fetch failed: ${detail}`);
      }
      return resultPayload;
    }

    if (status === 'Failed') {
      throw new Error('Mindee job status is Failed.');
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error(
    `Mindee polling timed out.${lastPollError ? ` Last poll error: ${lastPollError}` : ''}`
  );
}

/**
 * Extract visiting-card fields from a local image file path.
 */
async function extractCardFromFile({ filePath, mimeType, originalName }) {
  const { apiKey, modelId } = assertMindeeConfigured();
  const mindeeClient = new Client({ apiKey });

  console.log(
    `[card-scan] Mindee extract — file=${filePath} mime=${mimeType || 'unknown'}`
  );

  let response;
  try {
    response = await runMindeeExtractionWithSdk({
      mindeeClient,
      modelId,
      inputPath: filePath,
    });
  } catch (sdkErr) {
    console.warn('[card-scan] SDK failed, falling back to HTTP enqueue:', sdkErr.message);
    const jobId = await enqueueViaHttp({
      apiKey,
      modelId,
      filePath,
      mimeType,
      filename: originalName || path.basename(filePath),
    });
    response = await pollJobAndFetchResult({ apiKey, jobId, mindeeClient });
  }

  const prediction = toPredictionObject(response);
  const allFields = extractAllFields(prediction);
  console.log(`[card-scan] Extracted ${allFields.length} field(s)`);

  let cardData = mapToCardData(allFields);

  if (!cardData.firstName && !cardData.lastName && cardData.fullName) {
    const parts = cardData.fullName.trim().split(/\s+/);
    cardData.firstName = parts[0] || '';
    cardData.lastName = parts.slice(1).join(' ') || '';
  }

  let fieldList = allFields.length > 0 ? allFields : [];
  let summaryText = fieldList.map((f) => `${f.label}: ${f.value}`).join('\n');

  // Only run regex fallback when SDK returned real fields (avoids fake data from empty scans)
  if (allFields.length > 0 && summaryText.trim()) {
    const fallbackData = parseCardTextFallback(summaryText);
    cardData = mergeCardData(cardData, fallbackData);

    const fallbackFields = Object.entries(cardData)
      .filter(([, value]) => value)
      .map(([key, value]) => ({ key, label: labelFromKey(key), value }));

    if (fallbackFields.length > fieldList.length) {
      fieldList = fallbackFields;
      summaryText = fieldList.map((f) => `${f.label}: ${f.value}`).join('\n');
    }
  }

  const lead = toLeadShape(cardData);
  const hasMeaningfulData = Boolean(
    lead.name || lead.phone || lead.email || cardData.firstName || cardData.lastName
  );

  if (allFields.length === 0 || !summaryText.trim() || !hasMeaningfulData) {
    return {
      ...cardData,
      ...lead,
      text: summaryText || '',
      displayText: 'No data could be extracted. Try a clearer photo.',
      fields: fieldList,
      noData: true,
      rawText: summaryText || '',
    };
  }

  return {
    ...cardData,
    ...lead,
    text: summaryText,
    displayText: summaryText,
    fields: fieldList,
    noData: false,
    rawText: summaryText,
  };
}

/**
 * Extract from base64 (socket / legacy callers) — writes temp file then uses Mindee.
 */
async function extractCardFromBase64(base64Data, mimeType = 'image/jpeg') {
  const { ensureUploadDir, uploadDir } = require('../middlewares/cardUpload');
  ensureUploadDir();

  const clean = String(base64Data || '').replace(/^data:[^;]+;base64,/, '');
  const ext = mimeType.includes('png') ? '.png' : '.jpg';
  const filePath = path.join(
    uploadDir,
    `card_b64_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`
  );

  try {
    await fs.writeFile(filePath, Buffer.from(clean, 'base64'));
    return await extractCardFromFile({
      filePath,
      mimeType,
      originalName: `card${ext}`,
    });
  } finally {
    try {
      await fs.unlink(filePath);
    } catch {
      /* ignore */
    }
  }
}

module.exports = {
  extractCardFromFile,
  extractCardFromBase64,
  toLeadShape,
};
