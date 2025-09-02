// services/schedulerClient.js
const axios = require("axios");

const BASE = process.env.SCHEDULER_BASE_URL || "http://scheduler:80";
const RESULT_URL = process.env.SCHEDULER_RESULT_URL || `${BASE}/wh/campaign/result/`;

async function startCampaignOnScheduler(payload) {
  const url = `${BASE}/wh/campaign`;
  const { data } = await axios.post(url, payload, { timeout: 15000 });
  // нормализуем campaignId из любых кейсов (camel/snake)
  return { ...data, campaignId: data.campaignId ?? data.campaign_id ?? data.id ?? null };
}

async function stopCampaignOnScheduler(campaignId, body = {}) {
  const url = `${BASE}/wh/campaign/${encodeURIComponent(campaignId)}/stop`;
  const { data } = await axios.post(url, body, { timeout: 15000 });
  return { ...data, campaignId: data.campaignId ?? data.campaign_id ?? data.id ?? null };
}

/**
 * Репорт результата назад в планировщик.
 * Для MVP taskId не используем — микросервис его игнорирует.
 */
async function postResultToScheduler(resultPayload) {
  const { data } = await axios.post(RESULT_URL, resultPayload, { timeout: 15000 });
  return data;
}

module.exports = {
  startCampaignOnScheduler,
  stopCampaignOnScheduler,
  postResultToScheduler,
};
