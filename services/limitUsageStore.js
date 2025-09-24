// services/limitUsageStore.js
const { QueryTypes } = require("sequelize");

module.exports = function initLimitUsageStore(sequelize) {
  if (!sequelize || typeof sequelize.query !== "function") {
    throw new Error("limitUsageStore: требуется инициализированный sequelize экземпляр");
  }

  async function ensureRow(customerId) {
    await sequelize.query(
      `
      INSERT INTO customer_usage (customer_id, used_count, period_start)
      VALUES (?, 0, NOW())
      ON DUPLICATE KEY UPDATE customer_id = customer_id
      `,
      { replacements: [customerId] }
    );
  }

  async function getUsage(customerId) {
    const rows = await sequelize.query(`SELECT used_count FROM customer_usage WHERE customer_id = ? LIMIT 1`, {
      replacements: [customerId],
      type: QueryTypes.SELECT,
    });
    if (!rows || !rows.length) return 0;
    return Number(rows[0].used_count) || 0;
  }

  async function addUsage(customerId, delta) {
    const d = Number(delta) || 0;
    if (d <= 0) return;
    await ensureRow(customerId);
    await sequelize.query(
      `UPDATE customer_usage SET used_count = used_count + ?, updated_at = NOW() WHERE customer_id = ?`,
      { replacements: [d, customerId] }
    );
  }

  async function resetUsage(customerId) {
    await sequelize.query(
      `UPDATE customer_usage SET used_count = 0, period_start = NOW(), updated_at = NOW() WHERE customer_id = ?`,
      { replacements: [customerId] }
    );
  }

  return { ensureRow, getUsage, addUsage, resetUsage };
};
