// services/schedulerClient.js
const axios = require("axios");

const BASE = process.env.SCHEDULER_BASE_URL || "http://scheduler:80";
const RESULT_URL = process.env.SCHEDULER_RESULT_URL || `${BASE}/wh/campaign/result/`;

function normalizeResponsePayload(raw) {
  // если пришла строка — попробуем распарсить
  let data = raw;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      /* оставим как есть */
    }
  }
  // если и после этого не объект — завернём в объект
  if (data === null || typeof data !== "object") {
    data = { value: data };
  }
  // добавим универсальное поле campaignId
  const campaignId = data.campaignId ?? data.campaign_id ?? data.id ?? null;
  return { ...data, campaignId };
}

async function startCampaignOnScheduler(payload) {
  const url = `${BASE}/wh/campaign`;
  const { data } = await axios.post(url, payload, { timeout: 15000, validateStatus: () => true });
  return normalizeResponsePayload(data);
}

async function stopCampaignOnScheduler(campaignId, body = {}) {
  const url = `${BASE}/wh/campaign/${encodeURIComponent(campaignId)}/stop`;
  const { data } = await axios.post(url, body, { timeout: 15000, validateStatus: () => true });
  return normalizeResponsePayload(data);
}

/**
 * Репорт результата назад в планировщик.
 * Для MVP taskId не используем — микросервис его игнорирует.
 */
async function postResultToScheduler(resultPayload) {
  const { data } = await axios.post(RESULT_URL, resultPayload, { timeout: 15000, validateStatus: () => true });
  return normalizeResponsePayload(data);
}

module.exports = {
  startCampaignOnScheduler,
  stopCampaignOnScheduler,
  postResultToScheduler,
};
