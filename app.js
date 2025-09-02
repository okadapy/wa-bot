require("dotenv").config();
const express = require("express");
const http = require("http");
const session = require("express-session");
const path = require("path");
const { Server } = require("socket.io");
const rawBody = require("./middleware/rawBody");
const SequelizeStore = require("connect-session-sequelize")(session.Store);
const QRCode = require("qrcode"); // для fallback-эндпоинта /qr.png
const { runMigrations } = require("./services/migrate");
const fileUpload = require("express-fileupload");

const MAX_UPLOAD_BYTES = Number(process.env.UPLOAD_MAX_BYTES) || 20 * 1024 * 1024;

// Глобальные перехватчики, чтобы приложение не падало от внезапных async ошибок
process.on("unhandledRejection", (reason, p) => {
  console.error("[process] Unhandled Rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[process] Uncaught Exception:", err);
});

// База и модели
const sequelizePromise = require("./config/db");
const initModels = require("./models");

// Сервисы и роуты
const whatsappService = require("./services/whatsappService");
const authRoutes = require("./routes/authRoutes");
const customerRoutes = require("./routes/customerRoutes");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// Делаем io доступным в контроллерах при необходимости
app.set("io", io);

// Убираем 404 по favicon, чтобы не шумело в консоли
app.get("/favicon.ico", (req, res) => res.status(204).end());

async function startServer() {
  try {
    // 1) Инициализация БД и моделей
    const sequelize = await sequelizePromise;
    const db = initModels(sequelize);

    // 2) Сессии
    const sessionStore = new SequelizeStore({
      db: sequelize,
      tableName: "sessions",
      expiration: 1000 * 60 * 60 * 24,
      checkExpirationInterval: 1000 * 60 * 10,
    });
    await sessionStore.sync();

    app.use(
      session({
        secret: process.env.SESSION_SECRET || "secret-key",
        store: sessionStore,
        resave: false,
        saveUninitialized: false,
        cookie: {
          maxAge: 1000 * 60 * 60 * 24,
          secure: process.env.NODE_ENV === "production",
        },
      })
    );

    // 3) Views
    const { engine } = require("express-handlebars");
    app.engine(
      "hbs",
      engine({
        extname: ".hbs",
        defaultLayout: "main",
        layoutsDir: path.join(__dirname, "views", "layouts"),
      })
    );
    app.set("view engine", "hbs");
    app.set("views", path.join(__dirname, "views"));

    // 4) Middleware
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    app.use(
      fileUpload({
        limits: { fileSize: MAX_UPLOAD_BYTES },
        abortOnLimit: true, // оборвать при превышении
        responseOnLimit: JSON.stringify({
          // тело ответа при 413
          success: false,
          message:
            "Файл слишком большой. Максимальный размер: " + (MAX_UPLOAD_BYTES / (1024 * 1024)).toFixed(0) + " МБ.",
        }),
      })
    );

    // 5) Статика
    app.use(express.static(path.join(__dirname, "public")));

    // 6) Пробрасываем db в app, чтобы использовать в контроллерах при необходимости
    app.set("db", db);

    // 7) Привязываем io к WhatsApp-сервису (без автоподключения)
    whatsappService.initializeWhatsApp(io);

    // 8) Роуты
    app.use("/", authRoutes(db));
    app.use("/customer", customerRoutes(app));

    // Webhook от планировщика
    const webhookRoutes = require("./routes/webhooks");
    app.use("/wh", webhookRoutes);

    // 9) Fallback-эндпоинт для получения текущего QR как PNG
    app.get("/qr.png", async (req, res) => {
      try {
        const state = whatsappService.getWhatsAppClient();
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        if (state.qrDataUrl && state.qrDataUrl.startsWith("data:image/png;base64,")) {
          const b64 = state.qrDataUrl.split(",")[1];
          const buf = Buffer.from(b64, "base64");
          res.setHeader("Content-Type", "image/png");
          return res.send(buf);
        }
        if (state.qrCode) {
          const buf = await QRCode.toBuffer(state.qrCode, { errorCorrectionLevel: "M", margin: 1, width: 256 });
          res.setHeader("Content-Type", "image/png");
          return res.send(buf);
        }
        res.status(404).send("QR not available");
      } catch (e) {
        console.error("[/qr.png] error:", e);
        res.status(500).send("QR render error");
      }
    });

    // 10) Socket.IO
    io.on("connection", (socket) => {
      console.log(`Socket.IO подключение: ${socket.id}`);

      // Отдаём текущее состояние и QR (если уже есть)
      const clientState = whatsappService.getWhatsAppClient();
      socket.emit("whatsapp_status", clientState.status);
      if (clientState.qrDataUrl) {
        socket.emit("qr_image", clientState.qrDataUrl);
      } else if (clientState.qrCode) {
        socket.emit("qr_code", clientState.qrCode);
      }

      // Клиент запросил актуальный статус (после ajax-операций)
      socket.on("request_whatsapp_status", () => {
        const state = whatsappService.getWhatsAppClient();
        socket.emit("whatsapp_status", state.status);
        if (state.qrDataUrl) {
          socket.emit("qr_image", state.qrDataUrl);
        } else if (state.qrCode) {
          socket.emit("qr_code", state.qrCode);
        }
      });

      // По клику «крестик» на модалке QR — корректно отменяем поток
      socket.on("cancel_qr_flow", async () => {
        await whatsappService.deleteSession(false);
      });

      socket.on("disconnect", (reason) => {
        console.log(`Socket.IO отключён: ${socket.id}, причина: ${reason}`);
      });
    });

    // 11) Запуск сервера
    const port = process.env.PORT || 3000;
    server.listen(port, () => {
      console.log(`Сервер запущен на http://localhost:${port}`);
    });


    try{
    await db.TariffPlan.create(
        {
            name: "Тестовый",
            max_clients: 10,
            message_limit_daily: 10,
            price: 0,
        }
    )

    await db.Customer.create(
        {
            name: process.env.CUSTOMER_NAME,
            login_phone: process.env.CUSTOMER_PHONE,
            hashed_password: process.env.CUSTOMER_PASSWORD,
            tariff_plan_id: 1
        }
    )
    } catch (e) {
        console.log("[app.js] не получилось создать пользователя и тестовый тариф.")
      }
  } catch (err) {
    console.error("Ошибка инициализации приложения:", err);
    process.exit(1);
  }
}

startServer();
