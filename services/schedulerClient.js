// services/schedulerClient.js
const axios = require("axios");

const BASE = process.env.SCHEDULER_BASE_URL || "http://scheduler:8080";
const RESULT_URL = process.env.SCHEDULER_RESULT_URL || `${BASE}/wh/campaign/result`;

function normalizeResponsePayload(raw) {
  // Buffer? -> попробуем распарсить как JSON
  if (raw && Buffer.isBuffer(raw)) {
    const s = raw.toString("utf8");
    try {
      return normalizeResponsePayload(JSON.parse(s));
    } catch {
      return { value: s, campaignId: null };
    }
  }

  let data = raw;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      /* оставим строку */
    }
  }
  if (data === null || typeof data !== "object") {
    data = { value: data };
  }
  const campaignId = data.campaignId ?? data.campaign_id ?? data.id ?? null;
  return { ...data, campaignId };
}

async function startCampaignOnScheduler(payload) {
  const url = `${BASE}/wh/campaign`;
  const { data } = await axios.post(url, payload, {
    timeout: 15000,
    validateStatus: () => true,
    headers: { "Content-Type": "application/json" },
  });
  return normalizeResponsePayload(data);
}

async function stopCampaignOnScheduler(campaignId, body = {}) {
  const url = `${BASE}/wh/campaign/${encodeURIComponent(campaignId)}/stop`;
  const { data } = await axios.post(url, body, {
    timeout: 15000,
    validateStatus: () => true,
    headers: { "Content-Type": "application/json" },
  });
  return normalizeResponsePayload(data);
}
const SCHEDULER_RESULT_DISABLED = true;
async function postResultToScheduler(resultPayload) {
  if (SCHEDULER_RESULT_DISABLED) return { skipped: true };
  const { data } = await axios.post(RESULT_URL, resultPayload, {
    timeout: 15000,
    validateStatus: () => true,
    headers: { "Content-Type": "application/json" },
  });
  return normalizeResponsePayload(data);
}

module.exports = { startCampaignOnScheduler, stopCampaignOnScheduler, postResultToScheduler };
