// services/blacklistStore.js

module.exports = function (sequelize, QueryTypes) {
  const TABLE = "phone_blacklist";

  const toDigits = (s) => String(s || "").replace(/\D+/g, "");

  // нормализация RU-номера -> "+7XXXXXXXXXX"
  function normalizeRuPhone(input) {
    let core = toDigits(input);

    if (!core) return "";

    // 8XXXXXXXXXX/7XXXXXXXXXX -> 7XXXXXXXXXX
    if (core.length === 11 && (core.startsWith("7") || core.startsWith("8"))) {
      core = "7" + core.slice(1);
    }
    // 10 цифр -> добавим 7
    if (core.length === 10) core = "7" + core;

    if (core.length !== 11 || core[0] !== "7") return "";
    return "+" + core;
  }

  async function listBlacklist(_customerId, { page = 0, limit = 25 } = {}) {
    const p = Math.max(0, parseInt(page) || 0);
    const l = Math.max(1, Math.min(200, parseInt(limit) || 25));
    const offset = p * l;

    const totalRows = await sequelize.query(`SELECT COUNT(*) AS total FROM ${TABLE}`, { type: QueryTypes.SELECT });
    const total = Number(totalRows?.[0]?.total || 0);

    const items = await sequelize.query(
      `SELECT id, phone, created_at
       FROM ${TABLE}
       ORDER BY id DESC
       LIMIT :limit OFFSET :offset`,
      {
        replacements: { limit: l, offset },
        type: QueryTypes.SELECT,
      }
    );

    return { total, items };
  }

  async function addToBlacklist(_customerId, phoneRaw) {
    const phone = normalizeRuPhone(phoneRaw);
    if (!phone) {
      const err = new Error("Введите корректный российский номер в формате +7XXXXXXXXXX");
      err.statusCode = 400;
      throw err;
    }

    // вставка или апдейт updated_at при дубликате
    await sequelize.query(
      `INSERT INTO ${TABLE} (phone)
       VALUES (:phone)
       ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP`,
      { replacements: { phone } }
    );

    const row = await sequelize.query(`SELECT id, phone, created_at FROM ${TABLE} WHERE phone = :phone LIMIT 1`, {
      replacements: { phone },
      type: QueryTypes.SELECT,
    });

    return row?.[0] || null;
  }

  async function deleteFromBlacklist(_customerId, id) {
    const affected = await sequelize.query(`DELETE FROM ${TABLE} WHERE id = :id`, {
      replacements: { id },
      type: QueryTypes.RAW,
    });
    // для совместимости с разными драйверами просто вернём true, если команду выполнили
    return true;
  }

  return {
    listBlacklist,
    addToBlacklist,
    deleteFromBlacklist,
    normalizeRuPhone,
  };
};
