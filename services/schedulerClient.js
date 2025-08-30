const axios = require('axios');

const BASE = process.env.SCHEDULER_BASE_URL || 'http://scheduler:80';
const RESULT_URL = process.env.SCHEDULER_RESULT_URL || `${BASE}/wh/campaign/result/`;

async function startCampaignOnScheduler(payload) {
  const url = `${BASE}/wh/campaign`;
  const { data } = await axios.post(url, payload, { timeout: 15000 });
  return data;
}

async function stopCampaignOnScheduler(campaignId, body = {}) {
  const url = `${BASE}/wh/campaign/${encodeURIComponent(campaignId)}/stop`;
  const { data } = await axios.post(url, body, { timeout: 15000 });
  return data;
}

async function postResultToScheduler(resultPayload) {
  const { data } = await axios.post(RESULT_URL, resultPayload, { timeout: 15000 });
  return data;
}

module.exports = {
  startCampaignOnScheduler,
  stopCampaignOnScheduler,
  postResultToScheduler
};
