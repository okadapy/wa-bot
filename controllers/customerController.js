// controllers/customerController.js
const fs = require("fs");
const path = require("path");
const xlsx = require("xlsx");
const whatsappService = require("../services/whatsappService"); // сервис работы с WhatsApp

module.exports = (app) => {
  const db = app.get("db");

  if (!db || !db.sequelize || !db.CustomerClient || !db.CustomerClientPhone || !db.Customer) {
    console.error("ERROR: customerController.js: Объект 'db' или одна из его моделей не найдена в app.settings.");
    throw new Error("Sequelize models not properly initialized or not set on app.settings.");
  }

  const sequelize = db.sequelize;
  const CustomerClient = db.CustomerClient;
  const CustomerClientPhone = db.CustomerClientPhone;
  const Customer = db.Customer;
  const TariffPlan = db.TariffPlan;

  /** Хелпер: слабая нормализация номера для сравнения */
  function normPhoneLoose(p) {
    if (!p) return "";
    let s = String(p).trim();
    s = s.replace(/[^\d+]/g, "");
    if (s.startsWith("00")) s = "+" + s.slice(2);
    if (!s.startsWith("+")) s = "+" + s.replace(/[^\d]/g, "");
    return s.replace(/(?!^)\+/g, "");
  }

  /** Хелпер: оставить только цифры (для «жёсткого» сравнения) */
  function stripDigits(p) {
    return String(p || "").replace(/\D+/g, "");
  }

  /** Рендер панели */
  exports.getDashboard = (req, res) => {
    const clientData = whatsappService.getWhatsAppClient();

    let isWhatsAppConnected = false;
    let qrCode = null;
    let sessionExistsInitially = false;

    if (clientData) {
      isWhatsAppConnected = clientData.status === "open";
      qrCode = clientData.qrCode;
      sessionExistsInitially = clientData.status !== "closed" && clientData.status !== "unauthenticated";
    }

    res.render("dashboard", {
      title: "Админ-панель",
      isWhatsAppConnected,
      qrCode,
      sessionExists: sessionExistsInitially,
    });
  };

  /** Парсер имени под разные варианты обращения (оставлено без изменений — используется в другой логике) */
  function parseClientName(fullName, addressingOption) {
    if (!fullName) return "";
    const trimmed = String(fullName).trim();
    if (!trimmed) return "";

    const words = trimmed.split(/\s+/).filter(Boolean);
    const asIs = () => trimmed;

    switch (addressingOption || "auto") {
      case "auto":
        if (words.length >= 3) return words[1];
        return asIs();
      case "first_name":
        if (words.length >= 3) return words[1];
        if (words.length === 1) return words[0];
        return asIs();
      case "name_patronymic":
        if (words.length >= 3) return `${words[1]} ${words[2]}`;
        return asIs();
      case "full_name":
        return asIs();
      case "as_is":
      default:
        return asIs();
    }
  }

  /**
   * ====== ТАЙМЗОНА: утилиты ======
   * toTzNumber — конвертирует разные форматы в ЧИСЛО часов, например:
   * "UTC+3" -> 3, "+03:00" -> 3, "-05:30" -> -5.5, "+5.5" -> 5.5, "3" -> 3
   * Возвращает null, если распарсить нельзя.
   */
  function toTzNumber(timezone) {
    if (timezone == null) return null;
    let s = String(timezone).trim();
    if (!s) return null;

    // Сносим префиксы UTC/GMT
    s = s.replace(/^(UTC|GMT)/i, "").trim();

    // Совместимость с видами "+03:00", "+0300", "-5:30", "+5.5", "+3", "3", "-04"
    const m = s.match(/^([+-])?\s*(\d{1,2})(?::?(\d{2}))?(?:\.(\d+))?$/);
    if (!m) return null;

    const sign = m[1] === "-" ? -1 : 1;
    const hours = Number(m[2]);

    if (!Number.isFinite(hours)) return null;
    let dec = hours;

    if (m[3] != null) {
      // формат HH:MM или HHMM
      const mm = Number(m[3]);
      if (!Number.isFinite(mm)) return null;
      dec += mm / 60;
    } else if (m[4] != null) {
      // формат H.fraction
      const frac = Number("0." + m[4]);
      if (!Number.isFinite(frac)) return null;
      dec += Math.round(frac * 60) / 60; // приводим к шагу 1/60 часа
    }

    return sign * dec;
  }

  /** Нормализованная строка для UI/логов вида "+3" / "-5.5" */
  function tzNumberToUiString(num) {
    if (num == null || !Number.isFinite(num)) return null;
    const str = Number.isInteger(num) ? String(num) : String(num);
    return (num >= 0 ? "+" : "") + str;
  }

  /** ====== Константы и утилиты парсинга Excel ====== */

  // Имена/токены, означающие «нет персонализации»
  const BAD_NAME_TOKENS = [
    "без имени",
    "нет имени",
    "неизвестно",
    "unknown",
    "n/a",
    "na",
    "—",
    "-",
    "нет данных",
    "без названия",
    "no name",
    "не указано",
    "пусто",
  ];

  // Похоже на юрлицо/компанию (для эвристики)
  const COMPANY_TOKENS = [
    "ооо",
    "зао",
    "оао",
    "ип",
    "ooo",
    "ao",
    "ltd",
    "llc",
    "gmbh",
    "inc",
    "corp",
    "компания",
    "фирма",
  ];

  // Разделители для нескольких телефонов в одной ячейке (не режем по пробелам/дефисам/точкам)
  const SPLIT_RE = /[,;|\/\\\n\t]+/;

  // Синонимы заголовков
  const NAME_HEADERS = ["Имя", "ФИО", "Клиент", "ФИО Клиента", "Контакт", "Наименование"];
  const PHONE_HEADERS = ["Телефон", "Номер телефона", "Мобильный", "Номер", "тел", "Phone", "Mobile"];

  const looksLikeBadName = (name) => {
    const s = String(name || "")
      .trim()
      .toLowerCase();
    if (!s) return true;
    return BAD_NAME_TOKENS.some((tok) => s === tok || s.includes(` ${tok} `));
  };

  const looksLikeCompany = (name) => {
    const s = String(name || "")
      .trim()
      .toLowerCase();
    return COMPANY_TOKENS.some((tok) => new RegExp(`(^|\\s)${tok}(\\.|\\s|$)`, "i").test(s));
  };

  // Нормализация телефона РФ (7/8)
  const normalizeRuPhone = (raw) => {
    const digits = String(raw || "").replace(/\D+/g, "");
    if (!digits) return null;
    let d = digits;
    if (d.length === 10) d = "7" + d; // 9xx... -> 79xx...
    else if (d.length === 11 && d.startsWith("8")) d = "7" + d.slice(1); // 8xxxxxxxxxx -> 7xxxxxxxxxx
    if (d.length !== 11 || !d.startsWith("7")) return null;
    return d;
    // Плюс не нужен — Baileys передаёт без '+'
  };

  /** Загрузка Excel с клиентами (+ сохранение исходника в ./client_data) */
  exports.uploadClients = async (req, res) => {
    const customerId = req.session ? req.session.customerId : null;

    if (!customerId) {
      console.error("uploadClients: нет customerId в сессии");
      return res
        .status(401)
        .json({ success: false, message: "Пожалуйста, войдите в систему, чтобы запустить рассылку." });
    }

    if (!req.files || Object.keys(req.files).length === 0) {
      console.error("uploadClients: req.files пуст");
      return res.status(400).json({ success: false, message: "Файл не был загружен." });
    }

    const clientFile = req.files.clientFile || req.files.clientsFile || req.files.file || req.files.upload;
    if (!clientFile) {
      console.error("uploadClients: не найдено поле файла (ожидалось clientFile)");
      return res.status(400).json({ success: false, message: "Не найден файл. Поле должно называться 'clientFile'." });
    }

    // ---- ограничение размера 20 МБ
    const MAX_SIZE = 20 * 1024 * 1024;
    if (clientFile.size && clientFile.size > MAX_SIZE) {
      return res.status(413).json({
        success: false,
        message: "Файл слишком большой. Максимальный размер — 20 МБ.",
      });
    }

    // принимаем только Excel
    const origName = String(clientFile.name || "").toLowerCase();
    if (!origName.endsWith(".xlsx") && !origName.endsWith(".xls")) {
      return res.status(400).json({
        success: false,
        message: "Поддерживаются только файлы Excel (.xlsx или .xls). CSV не принимается.",
      });
    }

    // сохраняем исходник (best-effort)
    try {
      const baseDir = path.resolve(process.cwd(), "client_data");
      if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });

      // получаем оригинальное имя в UTF-8
      let origName = clientFile.name;
      try {
        origName = Buffer.from(clientFile.name, "latin1").toString("utf8");
      } catch (_) {}
      const sanitizeName = (name) =>
        String(name || "upload.xlsx")
          .replace(/[/\\?%*:|"<>]/g, "_")
          .replace(/\s+/g, " ")
          .replace(/_+/g, "_")
          .trim();

      const safeName = sanitizeName(origName);
      const dt = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const stamp = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}_${pad(dt.getHours())}-${pad(
        dt.getMinutes()
      )}-${pad(dt.getSeconds())}`;
      const fileName = `${stamp}_${safeName}`;
      const destPath = path.join(baseDir, fileName);
      fs.writeFileSync(destPath, clientFile.data);
      console.log(`[uploadClients] исходный файл сохранён: ${destPath}`);
    } catch (e) {
      console.warn("[uploadClients] не удалось сохранить исходный файл в ./client_data:", e?.message || e);
    }

    // ==== ПАРСЕР EXCEL ====
    let parsedRecords = [];

    try {
      const workbook = xlsx.read(clientFile.data, { type: "buffer" });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];

      const headerRow = xlsx.utils.sheet_to_json(worksheet, { header: 1 })?.[0];
      if (!headerRow || headerRow.length === 0) {
        return res.status(400).json({ success: false, message: "Пустой файл или неверные заголовки." });
      }

      // Определяем первую подходящую колонку имени
      let nameCol = null;
      for (const h of headerRow) {
        if (!h) continue;
        const label = String(h).trim();
        if (NAME_HEADERS.some((n) => new RegExp(`^${n}$`, "i").test(label))) {
          nameCol = label;
          break;
        }
      }

      // Собираем все колоноки телефонов
      const phoneCols = [];
      for (const h of headerRow) {
        if (!h) continue;
        const label = String(h).trim();
        const isPhoneSyn = PHONE_HEADERS.some((n) => new RegExp(n, "i").test(label));
        const genericPhone = /тел|phone|моб|номер/i.test(label);
        if (isPhoneSyn || genericPhone) {
          phoneCols.push(label);
        }
      }

      if (!nameCol || phoneCols.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Нужны колонки 'Имя/ФИО' и хотя бы одна колонка с телефоном (Телефон/Мобильный/Номер).",
        });
      }

      const rows = xlsx.utils.sheet_to_json(worksheet);
      const globalSeen = new Set(); // номера, уже встреченные у предыдущих клиентов

      for (const row of rows) {
        const rawName = row[nameCol];
        const rawNameStr = String(rawName ?? "").trim();

        // собираем все номера из всех телефонных колонок
        let numbers = [];
        for (const col of phoneCols) {
          const val = row[col];
          if (val == null) continue;
          const tokens = String(val)
            .split(SPLIT_RE)
            .map((s) => s.trim())
            .filter(Boolean);
          for (const t of tokens) {
            const n = normalizeRuPhone(t);
            if (n) numbers.push(n);
          }
        }

        // удаляем локальные дубли по этому клиенту
        numbers = [...new Set(numbers)];
        if (numbers.length === 0) continue;

        // применяем глобальную дедупликацию: если номер уже был у другого клиента — игнорируем
        const accepted = numbers.filter((n) => !globalSeen.has(n));
        accepted.forEach((n) => globalSeen.add(n));
        if (accepted.length === 0) continue;

        // логируем нестандартные имена (для инфы)
        if (looksLikeBadName(rawNameStr) || looksLikeCompany(rawNameStr)) {
          console.log(
            `[uploadClients] имя выглядит неперсонализируемым/компания: "${rawNameStr}" — отправка будет без персонализации.`
          );
        }

        // раскладываем «клиент — телефон» в плоский список
        for (const ph of accepted) {
          parsedRecords.push({ name: rawNameStr, phone: ph });
        }
      }

      if (parsedRecords.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Нет валидных записей после обработки. Проверьте номера телефонов.",
        });
      }
    } catch (err) {
      console.error("uploadClients: ошибка парсинга Excel:", err);
      return res.status(500).json({
        success: false,
        message: "Ошибка чтения Excel. Проверьте формат и заголовки.",
      });
    }

    // ==== Запись в БД ====
    let transaction;
    try {
      transaction = await sequelize.transaction();

      let clientsAddedCount = 0;
      let clientsProcessedCount = 0;

      for (const { name, phone } of parsedRecords) {
        try {
          const [client] = await CustomerClient.findOrCreate({
            where: { customer_id: customerId, full_name: name },
            defaults: { customer_id: customerId, full_name: name },
            transaction,
          });

          const [, phoneCreated] = await CustomerClientPhone.findOrCreate({
            where: { customer_client_id: client.id, phone_number: phone },
            defaults: { customer_id: customerId, is_main: true, description: "Загружен из Excel" },
            transaction,
          });

          if (phoneCreated) {
            clientsAddedCount++;
            // console.log(`Добавлена запись: "${name}", Телефон "${phone}"`);
          } else {
            // console.log(`Дубликат: "${name}" — "${phone}" (пропущено)`);
          }
          clientsProcessedCount++;
        } catch (dbError) {
          if (dbError.name === "SequelizeUniqueConstraintError") {
            console.warn(`Дубликат при вставке "${name}" — "${phone}". Пропуск.`);
          } else {
            console.error(`Ошибка сохранения "${name}" (${phone}) в БД:`, dbError);
          }
          clientsProcessedCount++;
        }
      }

      await transaction.commit();

      return res.json({
        success: true,
        message: `База клиентов обновлена. В файле обработано: ${parsedRecords.length}. Новых добавлено: ${clientsAddedCount}.`,
        totalClients: parsedRecords.length,
        clientsAdded: clientsAddedCount,
      });
    } catch (error) {
      if (transaction) await transaction.rollback();
      console.error("uploadClients: ошибка записи в БД:", error);
      return res.status(500).json({
        success: false,
        message: "Ошибка при записи в базу. Повторите попытку позже.",
      });
    }
  };

  /** Краткая сводка по загруженной базе */
  exports.getUploadSummary = async (req, res) => {
    try {
      const customerId = req.session ? req.session.customerId : null;
      if (!customerId) {
        return res
          .status(401)
          .json({ success: false, message: "Пожалуйста, войдите в систему, чтобы запустить рассылку." });
      }

      const { CustomerClient, CustomerClientPhone } = req.app.get("db");

      const [totalClients, totalPhones, lastPhone] = await Promise.all([
        CustomerClient.count({ where: { customer_id: customerId } }),
        CustomerClientPhone.count({ where: { customer_id: customerId } }),
        CustomerClientPhone.findOne({
          where: { customer_id: customerId },
          order: [["created_at", "DESC"]],
          attributes: ["created_at", "description"],
        }),
      ]);

      return res.json({
        success: true,
        totalClients,
        totalPhones,
        lastUploadAt: lastPhone ? lastPhone.created_at : null,
      });
    } catch (err) {
      console.error("[getUploadSummary] error:", err);
      return res.status(500).json({ success: false, message: "Не удалось получить сводку." });
    }
  };

  /** Полная очистка базы клиентов для текущего пользователя */
  exports.purgeClients = async (req, res) => {
    try {
      const customerId = req.session?.customerId;
      if (!customerId) {
        return res.status(401).json({ success: false, message: "Не авторизован" });
      }

      // На всякий случай — можно было бы запретить, если кампания идёт (проверка CampaignStateStore)
      console.log(`[purgeClients] requested by customer ${customerId}`);

      await sequelize.transaction(async (t) => {
        await CustomerClientPhone.destroy({ where: { customer_id: customerId }, transaction: t });
        await CustomerClient.destroy({ where: { customer_id: customerId }, transaction: t });
      });

      return res.json({ success: true, message: "База клиентов очищена." });
    } catch (e) {
      console.error("[purgeClients] error:", e);
      return res.status(500).json({ success: false, message: "Не удалось очистить базу клиентов." });
    }
  };

  /** Запуск рассылки (через планировщик) — финальная версия + BLACKLIST */
  exports.startSending = async (req, res) => {
    try {
      console.log("[startSending] invoked");
      console.log("[startSending] session.customerId:", req?.session?.customerId);
    } catch (_) {}

    if (!req.session || !req.session.customerId) {
      console.warn("[startSending] 401 no session");
      return res
        .status(401)
        .json({ success: false, message: "Пожалуйста, войдите в систему, чтобы запустить рассылку." });
    }

    const customerId = req.session.customerId;
    const io = app.get("io");

    const { message, timezone, daily_limit, max_clients } = req.body || {};

    if (timezone == null || (typeof timezone === "string" && !timezone.trim())) {
      console.warn("[startSending] 400 no timezone");
      return res.status(400).json({ success: false, message: "Выберите часовой пояс в настройках перед запуском." });
    }
    if (!message || !message.trim()) {
      console.warn("[startSending] 400 no message");
      return res.status(400).json({ success: false, message: "Введите текст сообщения." });
    }

    const waClientData = whatsappService.getWhatsAppClient();
    if (!waClientData || waClientData.status !== "open") {
      console.warn("[startSending] 400 whatsapp not open. waClientData:", waClientData);
      return res
        .status(400)
        .json({ success: false, message: "WhatsApp-клиент не подключен. Подключите его и попробуйте снова." });
    }

    // === Новая логика таймзоны ===
    const tzNum = toTzNumber(timezone);
    if (tzNum == null || !Number.isFinite(tzNum)) {
      console.warn("[startSending] 400 bad timezone format:", timezone);
      return res.status(400).json({ success: false, message: "Некорректный формат часового пояса." });
    }
    const tzUi = tzNumberToUiString(tzNum); // например, "+3" или "-5.5"

    try {
      // 1) Собираем всех главных телефонов клиента
      const rows = await CustomerClientPhone.findAll({
        where: { customer_id: customerId, is_main: true },
        include: [{ model: CustomerClient, attributes: ["full_name"], where: { customer_id: customerId } }],
        order: [["id", "ASC"]],
      });

      let clients = rows
        .map((r) => ({
          name: r.CustomerClient && r.CustomerClient.full_name ? String(r.CustomerClient.full_name).trim() : "",
          phone: r.phone_number || "",
        }))
        .filter((c) => !!c.phone);

      console.log(`[startSending] found clients with main phones: ${clients.length}`);

      // 2) BLACKLIST: фильтруем прямо здесь перед отправкой в планировщик
      try {
        const [rowsBL] = await sequelize.query("SELECT phone FROM phone_blacklist");
        const blDigits = new Set(rowsBL.map((r) => stripDigits(r.phone)));
        const blLoose = new Set(rowsBL.map((r) => normPhoneLoose(r.phone)));

        let skipped = 0;
        const filtered = [];

        for (const c of clients) {
          // у нас в БД телефоны уже приведены к "79XXXXXXXXX" (только цифры, без '+')
          const pDigits = stripDigits(c.phone);
          // и «слабую» нормализацию с плюсом — для сравнения со строками из БЛ вида "+7...", "00...", "8..."
          const pLoose = normPhoneLoose(c.phone.startsWith("+") ? c.phone : `+${c.phone}`);

          const inBL = (pDigits && blDigits.has(pDigits)) || (pLoose && blLoose.has(pLoose));
          if (inBL) {
            skipped++;
            continue;
          }
          filtered.push(c);
        }

        if (skipped > 0) {
          console.log(`[startSending] blacklist filter applied: skipped ${skipped}, left ${filtered.length}`);
        }
        clients = filtered;
      } catch (e) {
        console.error("[startSending] blacklist check failed:", e?.message || e);
        // продолжаем без фильтра, если таблицы нет или ошибка — по ТЗ валидации не требуем
      }

      if (!clients.length) {
        console.warn("[startSending] 400 empty after blacklist");
        return res
          .status(400)
          .json({ success: false, message: "Список получателей пуст (все номера попали в blacklist)." });
      }

      // 3) Лимиты (тариф/входные)
      let limitDaily = Number.isFinite(Number(daily_limit)) ? Number(daily_limit) : null;
      let limitMaxClients = Number.isFinite(Number(max_clients)) ? Number(max_clients) : null;

      try {
        const customer = await Customer.findByPk(customerId);
        if (customer && customer.tariff_plan_id && TariffPlan) {
          const tariff = await TariffPlan.findByPk(customer.tariff_plan_id);
          if (tariff) {
            if (limitDaily == null) limitDaily = Number(tariff.message_limit_daily) || null;
            if (limitMaxClients == null) limitMaxClients = Number(tariff.max_clients) || null;
          }
        }
      } catch (e) {
        console.warn("Не удалось получить тариф пользователя:", e.message);
      }

      // 4) Payload в планировщик — уже ОТФИЛЬТРОВАННЫЕ клиенты
      const payload = {
        customerId,
        timezone: tzNum, // <=== В МИКРОСЕРВИС УХОДИТ ЧИСЛО, например 3 или -5.5
        clients,
        message: message,
        daily_limit: limitDaily ?? 100,
        max_clients: limitMaxClients ?? null,
      };

      console.log("[scheduler] POST /wh/campaign payload:");
      console.log(JSON.stringify({ ...payload, clients: `<<${clients.length} recipients>>` }, null, 2));

      const { startCampaignOnScheduler } = require("../services/schedulerClient");
      let resp;
      try {
        resp = await startCampaignOnScheduler(payload);
        console.log(
          "[scheduler] raw typeof:",
          typeof resp,
          Array.isArray(resp) ? "array" : resp && resp.constructor && resp.constructor.name
        );
        console.log("[scheduler] raw resp:", JSON.stringify(resp, null, 2));
        console.log("[scheduler] fields:", {
          campaignId_raw: resp && resp.campaignId,
          campaign_id_raw: resp && resp.campaign_id,
          id_raw: resp && resp.id,
        });
      } catch (e) {
        console.error("[scheduler] ERROR /wh/campaign:", e?.message || e);
        if (e?.response) {
          console.error("[scheduler] ERROR status:", e.response.status);
          console.error("[scheduler] ERROR data:", JSON.stringify(e.response.data, null, 2));
        }
        return res.status(502).json({
          success: false,
          message: "Планировщик недоступен или вернул ошибку.",
        });
      }

      const campaignId = resp?.campaignId || null;

      if (!campaignId) {
        console.error("[scheduler] ERROR: планировщик не вернул campaignId:", resp);
        return res.status(502).json({
          success: false,
          message: "Планировщик не вернул идентификатор кампании. Повторите попытку позже.",
          scheduler: resp,
        });
      }

      const { saveCampaignTimezoneDB } = require("../services/campaignStore");
      // В БД/состоянии для удобства людей храним человекочитаемую строку (+3 / -5.5)
      await saveCampaignTimezoneDB(campaignId, tzUi, customerId);

      if (io) io.emit("campaign_started", { campaignId, timezone: tzUi, total: clients.length });

      const { setOnStart } = require("../services/campaignStateStore");
      setOnStart({ customerId, campaignId, timezone: tzUi, message, total: clients.length });

      return res.status(202).json({ success: true, campaignId, scheduled: true });
    } catch (e) {
      console.error("[startSending] error:", e);
      return res
        .status(500)
        .json({ success: false, message: "Не удалось запустить кампанию. Попробуйте позже.", details: e.message });
    }
  };

  /** Стоп рассылки (через планировщик) */
  exports.stopSending = async (req, res) => {
    try {
      console.log("[stopSending] invoked");
      console.log("[stopSending] session.customerId:", req?.session?.customerId);
      console.log("[stopSending] body:", JSON.stringify(req.body, null, 2));
    } catch (_) {}
    const customerId = req.session ? req.session.customerId : null;
    if (!customerId) {
      return res
        .status(401)
        .json({ success: false, message: "Пожалуйста, войдите в систему, чтобы запустить рассылку." });
    }

    const { campaignId } = req.body || {};
    if (!campaignId) {
      return res
        .status(400)
        .json({ success: false, message: "Не найден идентификатор кампании. Обновите страницу и попробуйте снова." });
    }

    try {
      const { stopCampaignOnScheduler } = require("../services/schedulerClient");
      const resp = await stopCampaignOnScheduler(campaignId, { reason: "manual_stop", requestedBy: customerId });
      const io = app.get("io");
      if (io) io.emit("campaign_stopped", { campaignId });
      return res.status(200).json({ success: true, campaignId, scheduler: resp });
    } catch (e) {
      console.error("[stopSending] error:", e);
      return res
        .status(500)
        .json({ success: false, message: "Не удалось остановить кампанию. Попробуйте позже.", details: e.message });
    }
  };

  /** Инициализация WhatsApp */
  exports.initWhatsAppClient = async (req, res) => {
    if (!req.session.isCustomerAuthorized) {
      return res.status(401).json({ success: false, message: "Не авторизован." });
    }
    const io = app.get("io");

    try {
      const existingClientData = whatsappService.getWhatsAppClient();
      const st = existingClientData?.status;

      // Блокируем только если реально активен/в процессе.
      // Разрешаем запуск при 'closed' | 'unauthenticated' | 'logged_out'
      const canStart = !st || ["closed", "unauthenticated", "logged_out"].includes(st);

      if (!canStart) {
        console.log("WhatsAppService: Клиент уже в процессе или активен. Инициализация не требуется.");
        // Отдадим фронту текущее состояние (как и раньше)
        try {
          io.emit("whatsapp_status", st);
        } catch (_) {}
        if (st === "qr" && existingClientData.qrCode) {
          try {
            io.emit("qr_code", existingClientData.qrCode);
          } catch (_) {}
        }
        return res.json({ success: true, message: "Инициализация уже запущена/активна." });
      }

      // Важно: реальный старт новой сессии (получим 'connecting' -> 'qr')
      await whatsappService.connectToWhatsApp();
      return res.json({ success: true, message: "Подключение WhatsApp клиента запущено." });
    } catch (error) {
      console.error("Ошибка при инициализации WhatsApp:", error);
      return res
        .status(500)
        .json({ success: false, message: `Ошибка инициализации WhatsApp: ${error.message || error}` });
    }
  };

  /** Проверка наличия сохранённой сессии (для тихого автоконнекта) */
  exports.hasSavedSession = (req, res) => {
    try {
      const exists = whatsappService.hasSavedSession();
      return res.json({ success: true, exists });
    } catch (e) {
      return res.status(500).json({ success: false, message: "Не удалось проверить сессию" });
    }
  };

  /** Удаление сессии WhatsApp */
  exports.deleteWhatsAppSession = async (req, res) => {
    if (!req.session.isCustomerAuthorized) {
      return res.status(401).json({ success: false, message: "Не авторизован." });
    }
    try {
      const result = await whatsappService.deleteSession(true);
      res.json(result);
    } catch (error) {
      console.error(`Ошибка при удалении сессии WhatsApp:`, error);
      res.status(500).json({ success: false, message: `Ошибка удаления сессии: ${error.message}` });
    }
  };

  /** Получить сохранённые настройки пользователя */
  exports.getSettings = async (req, res) => {
    try {
      const customerId = req.session?.customerId;
      if (!customerId) return res.status(401).json({ success: false, message: "Не авторизован" });
      const { CustomerSetting } = req.app.get("db");
      let row = null;
      try {
        row = await CustomerSetting.findByPk(customerId);
      } catch (e) {
        console.warn("[getSettings] table may be missing:", e.message);
      }
      return res.json({
        success: true,
        data: row
          ? {
              timezone: row.timezone || null,
              message_draft: row.message_draft || "",
              addressing_option: row.addressing_option || "auto",
              daily_limit_pref: row.daily_limit_pref ?? null,
              max_clients_pref: row.max_clients_pref ?? null,
              updated_at: row.updated_at || null,
            }
          : null,
      });
    } catch (e) {
      console.error("[getSettings] error:", e);
      return res.status(500).json({ success: false });
    }
  };

  /** Сохранить настройки пользователя */
  exports.saveSettings = async (req, res) => {
    try {
      const customerId = req.session?.customerId;
      if (!customerId) return res.status(401).json({ success: false, message: "Не авторизован" });
      const b = req.body || {};

      // Принимаем и строку, и число
      let timezone = null;
      if (typeof b.timezone === "string") timezone = b.timezone.trim();
      else if (typeof b.timezone === "number" && Number.isFinite(b.timezone)) timezone = String(b.timezone);

      const message_draft = typeof b.message_draft === "string" ? b.message_draft : null;
      const addressing_option = typeof b.addressing_option === "string" ? b.addressing_option : null;
      const daily_limit_pref = Number.isFinite(Number(b.daily_limit_pref)) ? Number(b.daily_limit_pref) : null;
      const max_clients_pref =
        b.max_clients_pref === null || Number.isFinite(Number(b.max_clients_pref))
          ? b.max_clients_pref === null
            ? null
            : Number(b.max_clients_pref)
          : null;

      const { CustomerSetting } = req.app.get("db");
      if (!CustomerSetting) {
        return res.status(500).json({ success: false, message: "Модель CustomerSetting недоступна" });
      }
      await CustomerSetting.upsert({
        customer_id: customerId,
        timezone,
        message_draft,
        addressing_option,
        daily_limit_pref,
        max_clients_pref,
        updated_at: new Date(),
      });
      return res.json({ success: true });
    } catch (e) {
      console.error("[saveSettings] error:", e);
      return res.status(500).json({ success: false });
    }
  };

  // ==== CAMPAIGN SNAPSHOT ====
  exports.getCampaignState = async (req, res) => {
    try {
      const customerId = req.session?.customerId;
      if (!customerId) {
        return res.status(401).json({ success: false, message: "Не авторизован" });
      }

      let snap = null;
      try {
        const { getStateForCustomer } = require("../services/campaignStateStore");
        if (typeof getStateForCustomer === "function") {
          snap = getStateForCustomer(customerId);
        }
      } catch (_) {}

      const wa = require("../services/whatsappService").getWhatsAppClient?.() || {};
      const whatsapp = { state: wa.status || "closed" };

      // --- единожды подтягиваем max_clients из тарифа
      let maxClients = null;
      try {
        const customer = await Customer.findByPk(customerId);
        if (customer?.tariff_plan_id && TariffPlan) {
          const tariff = await TariffPlan.findByPk(customer.tariff_plan_id);
          if (tariff) maxClients = Number(tariff.max_clients) || null;
        }
      } catch (e) {
        console.warn("[getCampaignState] tariff lookup failed:", e.message);
      }

      const campaign = snap || {
        status: "stopped",
        campaignId: null,
        total: 0,
        sent: 0,
        failed: 0,
        remaining: 0,
        timezone: null,
        message: null,
        updatedAt: new Date().toISOString(),
      };

      return res.json({ success: true, campaign, whatsapp, max_clients: maxClients });
    } catch (e) {
      console.error("[getCampaignState] error:", e);
      return res.status(500).json({ success: false, message: "Не удалось получить состояние кампании" });
    }
  };

  return {
    getDashboard: exports.getDashboard,
    uploadClients: exports.uploadClients,
    getUploadSummary: exports.getUploadSummary,
    purgeClients: exports.purgeClients,
    startSending: exports.startSending,
    stopSending: exports.stopSending,
    initWhatsAppClient: exports.initWhatsAppClient,
    hasSavedSession: exports.hasSavedSession,
    deleteWhatsAppSession: exports.deleteWhatsAppSession,
    getSettings: exports.getSettings,
    saveSettings: exports.saveSettings,
    getCampaignState: exports.getCampaignState,
  };
};
