// services/limitUsageStore.js
const { sequelize } = require("../models");
async function ensureRow(customerId) {
  await sequelize.query(
    `INSERT INTO customer_usage (customer_id, used_count)
     VALUES (?, 0)
     ON DUPLICATE KEY UPDATE customer_id = customer_id`,
    { replacements: [customerId] }
  );
}

async function getUsage(customerId) {
  const [rows] = await sequelize.query(`SELECT used_count FROM customer_usage WHERE customer_id = ?`, {
    replacements: [customerId],
  });
  return rows && rows.length ? Number(rows[0].used_count) : 0;
}

async function addUsage(customerId, delta = 1) {
  // гарантируем строку
  await ensureRow(customerId);

  // MySQL UPDATE не возвращает обновлённую строку — читаем отдельно
  await sequelize.query(
    `UPDATE customer_usage
       SET used_count = used_count + ?, updated_at = CURRENT_TIMESTAMP
     WHERE customer_id = ?`,
    { replacements: [Number(delta) || 0, customerId] }
  );

  // возвращаем актуальное значение
  return getUsage(customerId);
}

async function resetUsage(customerId) {
  await ensureRow(customerId);
  await sequelize.query(
    `UPDATE customer_usage
       SET used_count = 0,
           period_start = CURRENT_TIMESTAMP,
           updated_at   = CURRENT_TIMESTAMP
     WHERE customer_id = ?`,
    { replacements: [customerId] }
  );
  return 0;
}

module.exports = {
  ensureRow,
  getUsage,
  addUsage,
  resetUsage,
};
