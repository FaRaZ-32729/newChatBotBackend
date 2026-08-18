/**
 * Backfill vector chunks for chatbots that already have PDFs.
 * Usage (from backend/):  node scripts/backfillKnowledgeChunks.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const dbConnection = require('../src/config/dbConnection');
const ChatbotModel = require('../src/models/chatbotModel');
const { buildKnowledgeChunksForChatbot } = require('../src/llm/services/chunkingService');

const DELAY_MS = 800;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  await dbConnection();
  if (mongoose.connection.readyState !== 1) {
    throw new Error('MongoDB is not connected — check MONGODB_URL');
  }

  const bots = await ChatbotModel.find({
    knowledgeChunksBuilt: { $ne: true },
    'knowledgeBasePdfs.0': { $exists: true },
  });

  console.log(`[backfill] ${bots.length} chatbot(s) need knowledge chunks`);

  let ok = 0;
  let failed = 0;

  for (let i = 0; i < bots.length; i += 1) {
    const bot = bots[i];
    console.log(`[backfill] (${i + 1}/${bots.length}) ${bot.name} [${bot._id}]`);
    try {
      const result = await buildKnowledgeChunksForChatbot(bot);
      console.log(`[backfill] OK — ${result.total} chunk(s)`);
      ok += 1;
    } catch (err) {
      failed += 1;
      console.error(`[backfill] FAIL ${bot._id}:`, err.message);
    }
    if (i < bots.length - 1) await sleep(DELAY_MS);
  }

  console.log(`[backfill] done — ok=${ok} failed=${failed}`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[backfill] aborted:', err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
