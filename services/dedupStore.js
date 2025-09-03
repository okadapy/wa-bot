// services/dedupStore.js
// Простейший in-memory дедуп с TTL.
// Ключом делаем строку вида `${campaignId}|${normalizedPhone}`.

const store = new Map();

/**
 * Пытаемся "зайти" по ключу один раз.
 * @param {string} key - уникальный ключ задачи
 * @param {number} ttlMs - время жизни записи в миллисекундах
 * @returns {boolean} true — если ключ был установлен (не дубликат); false — если уже есть (дубликат)
 */
function enterOnce(key, ttlMs) {
  if (!key) return false;
  if (store.has(key)) return false;

  const timer = setTimeout(() => {
    store.delete(key);
  }, Math.max(1, Number(ttlMs) || 300_000)); // дефолт 5 минут

  // узел очистки, чтобы GC мог собрать таймер при удалении вручную
  store.set(key, timer);
  return true;
}

/** Принудительно удалить ключ (обычно не нужно — TTL сам почистит) */
function remove(key) {
  const timer = store.get(key);
  if (timer) clearTimeout(timer);
  store.delete(key);
}

function has(key) {
  return store.has(key);
}

module.exports = { enterOnce, remove, has };
