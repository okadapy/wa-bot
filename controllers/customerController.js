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

  let formattedClientsData = [];
  let isSending = false;

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

  /** Парсер имени под разные варианты обращения */
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

    const body = req.body || {};
    const addressingOption = (body.addressingOption || "").trim() || "auto";

    // 1) Сохраняем исходный файл в ./client_data/YYYYMMDD_HHMMSS_originalName.ext
    try {
      const baseDir = path.resolve(process.cwd(), "client_data");
      if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });

      const sanitizeName = (name) =>
        String(name || "upload.xlsx")
          .replace(/[/\\?%*:|"<>]/g, "_")
          .replace(/\s+/g, " ")
          .trim();

      const safeName = sanitizeName(clientFile.name);
      const dt = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const stamp = `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}_${pad(dt.getHours())}${pad(
        dt.getMinutes()
      )}${pad(dt.getSeconds())}`;
      const fileName = `${stamp}_${safeName}`;
      const destPath = path.join(baseDir, fileName);

      fs.writeFileSync(destPath, clientFile.data);
      console.log(`[uploadClients] исходный файл сохранён: ${destPath}`);
    } catch (e) {
      console.warn("[uploadClients] не удалось сохранить исходный файл в ./client_data:", e?.message || e);
    }

    // 2) Разбор Excel и запись в БД
    let transaction;
    try {
      const workbook = xlsx.read(clientFile.data, { type: "buffer" });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];

      const columnMapping = {
        name: ["Имя", "ФИО", "Клиент", "ФИО Клиента", "Контакт", "Наименование"],
        phone: ["Телефон", "Номер телефона", "Мобильный", "Номер", "тел"],
      };

      const excelHeaders = xlsx.utils.sheet_to_json(worksheet, { header: 1 })[0];
      if (!excelHeaders || excelHeaders.length === 0) {
        return res.status(400).json({ success: false, message: "Пустой файл или неверные заголовки." });
      }

      const foundColumns = {};
      for (const logicalField in columnMapping) {
        const possibleNames = columnMapping[logicalField];
        const regexPattern = possibleNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
        const regex = new RegExp(regexPattern, "i");
        for (const header of excelHeaders) {
          if (!header) continue;
          const trimmedHeader = String(header).trim();
          if (regex.test(trimmedHeader)) {
            foundColumns[logicalField] = trimmedHeader;
            break;
          }
        }
      }

      if (!foundColumns.name || !foundColumns.phone) {
        return res.status(400).json({
          success: false,
          message: "Нужны колонки 'Имя/ФИО' и 'Телефон' (можно синонимы).",
        });
      }

      const rawClients = xlsx.utils.sheet_to_json(worksheet);

      formattedClientsData = [];
      rawClients.forEach((row) => {
        const customerName = row[foundColumns.name];
        const customerPhone = row[foundColumns.phone];

        if (!customerPhone) {
          console.log(`Пропуск записи из-за отсутствия телефона: ${customerName}`);
          return;
        }

        const cleanedPhone = String(customerPhone).replace(/[^0-9]/g, "");
        if (!cleanedPhone) {
          console.log(`Пропуск из-за невалидного номера: ${customerName} (Исходный: ${customerPhone})`);
          return;
        }

        const formattedName = parseClientName(customerName, addressingOption);
        formattedClientsData.push({ name: formattedName, phone: cleanedPhone });
      });

      if (formattedClientsData.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Нет валидных записей после обработки.",
        });
      }

      transaction = await sequelize.transaction();

      let clientsAddedCount = 0;
      let clientsProcessedCount = 0;

      for (const clientData of formattedClientsData) {
        const { name, phone } = clientData;

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
            console.log(`Добавлена запись: "${name}", Телефон "${phone}"`);
          } else {
            console.log(`Дубликат: "${name}" — "${phone}" (пропущено)`);
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

      res.json({
        success: true,
        message: `База клиентов обновлена. В файле: ${formattedClientsData.length}. Новых добавлено: ${clientsAddedCount}.`,
        totalClients: formattedClientsData.length,
        clientsAdded: clientsAddedCount,
      });
    } catch (error) {
      if (transaction) await transaction.rollback();
      console.error("uploadClients: ошибка обработки/сохранения файла:", error);
      return res.status(500).json({
        success: false,
        message: "Ошибка при обработке файла или записи в базу. Проверьте формат Excel.",
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

      // На всякий случай — запретим, если кампания идёт
      // (если у тебя есть CampaignStateStore — можно проверить и вернуть 409)
      // Сейчас не блокируем, но логируем:
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

  /** Запуск рассылки (через планировщик) — финальная версия */
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
    // Преобразуем в ЧИСЛО часов для микросервиса, и отдельную строку для UI/логов/хранилища.
    const tzNum = toTzNumber(timezone);
    if (tzNum == null || !Number.isFinite(tzNum)) {
      console.warn("[startSending] 400 bad timezone format:", timezone);
      return res.status(400).json({ success: false, message: "Некорректный формат часового пояса." });
    }
    const tzUi = tzNumberToUiString(tzNum); // например, "+3" или "-5.5"

    try {
      const rows = await CustomerClientPhone.findAll({
        where: { customer_id: customerId, is_main: true },
        include: [{ model: CustomerClient, attributes: ["full_name"], where: { customer_id: customerId } }],
        order: [["id", "ASC"]],
      });

      const clients = rows
        .map((r) => ({
          name: r.CustomerClient && r.CustomerClient.full_name ? String(r.CustomerClient.full_name).trim() : "",
          phone: r.phone_number || "",
        }))
        .filter((c) => !!c.phone);

      console.log(`[startSending] found clients with main phones: ${clients.length}`);

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

      const payload = {
        customerId,
        timezone: tzNum, // <=== В МИКРОСЕРВИС УХОДИТ ЧИСЛО, например 3 или -5.5
        clients,
        message: message,
        daily_limit: limitDaily ?? 100,
        max_clients: limitMaxClients ?? null,
      };

      if (!clients.length) {
        console.warn("[startSending] 400 empty clients");
        return res.status(400).json({ success: false, message: "Список клиентов пуст или у них нет телефонов." });
      }

      console.log("[scheduler] POST /wh/campaign payload:");
      console.log(JSON.stringify(payload, null, 2));

      const { startCampaignOnScheduler } = require("../services/schedulerClient");
      let resp;
      try {
        resp = await startCampaignOnScheduler(payload);
        console.log("[scheduler] RESPONSE /wh/campaign:");
        console.log(JSON.stringify(resp, null, 2));
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

      if (!resp || !resp.campaignId) {
        console.error("[scheduler] ERROR: планировщик не вернул campaignId:", resp);
        return res.status(502).json({
          success: false,
          message: "Планировщик не вернул идентификатор кампании. Повторите попытку позже.",
          scheduler: resp,
        });
      }

      const { saveCampaignTimezoneDB } = require("../services/campaignStore");
      // В БД/состоянии для удобства людей храним человекочитаемую строку (+3 / -5.5)
      await saveCampaignTimezoneDB(resp.campaignId, tzUi, customerId);

      if (io) io.emit("campaign_started", { campaignId: resp.campaignId, timezone: tzUi, total: clients.length });

      const { setOnStart } = require("../services/campaignStateStore");
      setOnStart({ customerId, campaignId: resp.campaignId, timezone: tzUi, message, total: clients.length });

      return res.status(202).json({ success: true, campaignId: resp.campaignId, scheduled: true });
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
      if (
        existingClientData &&
        existingClientData.status !== "closed" &&
        existingClientData.status !== "unauthenticated"
      ) {
        console.log(`WhatsAppService: Клиент уже в процессе или активен. Инициализация не требуется.`);
        io.emit("whatsapp_status", existingClientData.status);
        if (existingClientData.status === "qr" && existingClientData.qrCode) {
          io.emit("qr_code", existingClientData.qrCode);
        }
        return res.json({ success: true, message: "Инициализация WhatsApp клиента уже запущена/активна." });
      }
      await whatsappService.connectToWhatsApp();
      res.json({ success: true, message: "Подключение WhatsApp клиента запущено." });
    } catch (error) {
      console.error(`Ошибка при инициализации WhatsApp:`, error);
      res.status(500).json({ success: false, message: `Ошибка инициализации WhatsApp: ${error.message}` });
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

      return res.json({ success: true, campaign, whatsapp });
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
