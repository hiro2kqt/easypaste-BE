const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = 8031;

app.use((req, res, next) => {
  const start = Date.now();
  console.log(
    `[REQ] ${req.method} ${req.originalUrl} | origin=${
      req.headers.origin || "-"
    }`
  );

  res.on("finish", () => {
    console.log(
      `[RES] ${req.method} ${req.originalUrl} | status=${res.statusCode} | ${
        Date.now() - start
      }ms`
    );
  });

  next();
});

app.use(cors());
app.use(bodyParser.json({ limit: "10mb" }));

const UPLOAD_DIR = path.join(__dirname, "uploads");
const STORE_FILE = path.join(__dirname, "store.json");
const FILESTORE_FILE = path.join(__dirname, "fileStore.json");

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  console.log("[INIT] Created upload dir:", UPLOAD_DIR);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    console.log("[UPLOAD] destination", {
      fieldname: file.fieldname,
      originalname: file.originalname,
      mimetype: file.mimetype,
    });
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    const finalName = `${unique}${ext}`;

    console.log("[UPLOAD] filename", {
      original: file.originalname,
      ext,
      finalName,
    });

    cb(null, finalName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

/* =====================================================
 * JSON STORE HELPERS
 * ===================================================== */
function loadJSON(filePath) {
  if (!fs.existsSync(filePath)) {
    console.log("[STORE] loadJSON missing file:", filePath);
    return {};
  }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    console.log("[STORE] loadJSON ok:", filePath);
    return data;
  } catch (e) {
    console.error("[STORE] loadJSON parse error:", filePath, e.message);
    return {};
  }
}

function saveJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log("[STORE] saveJSON:", filePath);
}

/* =====================================================
 * SESSION CODE
 * ===================================================== */
function generateSessionCode() {
  const letters = Array.from({ length: 2 }, () =>
    String.fromCharCode(65 + Math.floor(Math.random() * 26))
  ).join("");

  const digitLength = 4 + Math.floor(Math.random() * 3);
  let digits = "";
  for (let i = 0; i < digitLength; i++) {
    digits += Math.floor(Math.random() * 10).toString();
  }

  return `${letters}${digits}`;
}

/* =====================================================
 * API ROUTES
 * ===================================================== */
app.post("/api/session", (req, res) => {
  console.log("[API] create session");

  let store = loadJSON(STORE_FILE);
  let fileStore = loadJSON(FILESTORE_FILE);

  let code;
  do {
    code = generateSessionCode();
  } while (store[code] || fileStore[code]);

  const now = Date.now();
  store[code] = { type: "text", content: "", lastUpdated: now };

  saveJSON(STORE_FILE, store);

  console.log("[API] session created:", code);
  res.json({ code });
});

app.post("/api/publish", (req, res) => {
  console.log("[API] publish", {
    bodyKeys: Object.keys(req.body || {}),
  });

  const { code, type, content } = req.body;
  if (!code || !content || !type) {
    console.warn("[API] publish missing data");
    return res.status(400).json({ error: "Missing data" });
  }

  if (type !== "text") {
    console.warn("[API] publish invalid type:", type);
    return res
      .status(400)
      .json({ error: "Only type 'text' is supported for this endpoint" });
  }

  let store = loadJSON(STORE_FILE);
  const now = Date.now();

  store[code] = { type, content, lastUpdated: now };
  saveJSON(STORE_FILE, store);

  console.log("[API] publish ok:", code);
  res.json({ ok: true });
});

app.get("/api/get/:code", (req, res) => {
  console.log("[API] get:", req.params.code);

  const store = loadJSON(STORE_FILE);
  const data = store[req.params.code];

  if (!data) {
    console.warn("[API] get not found");
    return res.status(404).json({ error: "Not found" });
  }

  res.json(data);
});

app.post("/api/file/upload", upload.single("file"), (req, res) => {
  console.log("[API] file upload body:", req.body);

  const file = req.file;
  console.log(
    "[API] file upload file:",
    file
      ? {
          originalname: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          path: file.path,
        }
      : "NO FILE"
  );

  const { code } = req.body;

  if (!code) {
    console.warn("[API] upload missing code");
    if (file && file.path && fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
      console.warn("[API] orphan file deleted:", file.path);
    }
    return res.status(400).json({ error: "Missing code" });
  }

  if (!file) {
    console.warn("[API] upload missing file");
    return res.status(400).json({ error: "Missing file" });
  }

  let fileStore = loadJSON(FILESTORE_FILE);
  const now = Date.now();

  fileStore[code] = {
    originalName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
    path: file.path,
    uploadedAt: now,
    lastUpdated: now,
  };

  saveJSON(FILESTORE_FILE, fileStore);

  console.log("[API] upload success:", {
    code,
    mimeType: file.mimetype,
  });

  res.json({
    ok: true,
    file: {
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      uploadedAt: now,
    },
  });
});

app.get("/api/file/meta/:code", (req, res) => {
  console.log("[API] file meta:", req.params.code);

  const fileStore = loadJSON(FILESTORE_FILE);
  const data = fileStore[req.params.code];

  if (!data) {
    console.warn("[API] file meta not found");
    return res.status(404).json({ error: "Not found" });
  }

  res.json({
    file: {
      originalName: data.originalName,
      mimeType: data.mimeType,
      size: data.size,
      uploadedAt: data.uploadedAt,
    },
  });
});

app.get("/api/file/download/:code", (req, res) => {
  console.log("[API] file download:", req.params.code);

  const fileStore = loadJSON(FILESTORE_FILE);
  const data = fileStore[req.params.code];

  if (!data) {
    console.warn("[API] download not found");
    return res.status(404).json({ error: "Not found" });
  }

  const absolutePath = path.resolve(data.path);
  console.log("[API] download path:", absolutePath);

  if (!absolutePath.startsWith(UPLOAD_DIR)) {
    console.error("[API] invalid file path");
    return res.status(400).json({ error: "Invalid file path" });
  }

  if (!fs.existsSync(absolutePath)) {
    console.warn("[API] file missing on disk");
    return res.status(410).json({ error: "File no longer exists" });
  }

  res.download(absolutePath, data.originalName);
});

app.delete("/api/session/:code", (req, res) => {
  console.log("[API] delete session:", req.params.code);

  const code = req.params.code;
  let store = loadJSON(STORE_FILE);
  let fileStore = loadJSON(FILESTORE_FILE);

  let found = false;

  if (store[code]) {
    delete store[code];
    found = true;
  }

  const fileMeta = fileStore[code];
  if (fileMeta) {
    found = true;

    const absolutePath = path.resolve(fileMeta.path || "");
    if (
      absolutePath &&
      absolutePath.startsWith(UPLOAD_DIR) &&
      fs.existsSync(absolutePath)
    ) {
      try {
        fs.unlinkSync(absolutePath);
        console.log("[API] deleted file:", absolutePath);
      } catch (e) {
        console.error("[API] failed delete file:", e.message);
      }
    }

    delete fileStore[code];
  }

  if (!found) {
    console.warn("[API] delete not found");
    return res.status(404).json({ error: "Not found" });
  }

  saveJSON(STORE_FILE, store);
  saveJSON(FILESTORE_FILE, fileStore);

  res.json({ ok: true });
});

app.get("/api/ping", (req, res) => {
  console.log("[API] ping");
  res.json({ pong: true, message: "EasyCopy API is alive" });
});

app.use((err, req, res, next) => {
  console.error("[ERROR]", err);

  if (err && err.name === "MulterError" && err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ error: "File too large. Max 10MB." });
  }

  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`🚀 Backend running at http://localhost:${PORT}`);
});
