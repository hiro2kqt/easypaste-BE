const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = 8031;

function getPositiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;

  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const MAX_FILE_SIZE = getPositiveIntEnv("MAX_FILE_SIZE", 20 * 1024 * 1024);
const MAX_CHUNK_SIZE = getPositiveIntEnv(
  "MAX_CHUNK_SIZE",
  2 * 1024 * 1024
);
const UPLOAD_STATE_FILE = path.join(__dirname, "uploadState.json");
const RATE_LIMIT_MS = 500;
const rateLimitStore = new Map();
let sessionCreateQueue = Promise.resolve();

function runExclusive(task) {
  const next = sessionCreateQueue.then(() => task());
  sessionCreateQueue = next.catch(() => {});
  return next;
}

function rateLimitByIpAgent(req, res, next) {
  if (req.method === "OPTIONS") return next();

  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.socket.remoteAddress ||
    "unknown";

  const agent = req.headers["user-agent"] || "unknown";
  const key = `${ip}|${agent}`;

  const now = Date.now();
  const last = rateLimitStore.get(key) || 0;

  if (now - last < RATE_LIMIT_MS) {
    return res.status(429).json({
      error: "Too many requests. Slow down.",
    });
  }

  rateLimitStore.set(key, now);
  next();
}

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
app.use(rateLimitByIpAgent);
app.use(cors());
app.use(bodyParser.json({ limit: "20mb" }));

const UPLOAD_DIR = path.join(__dirname, "uploads");
const TMP_UPLOAD_DIR = path.join(__dirname, "uploads_tmp");
const STORE_FILE = path.join(__dirname, "store.json");
const FILESTORE_FILE = path.join(__dirname, "fileStore.json");

for (const dir of [UPLOAD_DIR, TMP_UPLOAD_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log("[INIT] Created dir:", dir);
  }
}

function loadJSON(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    console.error("[STORE] parse error:", filePath, e.message);
    return {};
  }
}

function saveJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function loadUploadState() {
  if (!fs.existsSync(UPLOAD_STATE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(UPLOAD_STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveUploadState(data) {
  fs.writeFileSync(UPLOAD_STATE_FILE, JSON.stringify(data, null, 2));
}

function generateSessionCode() {
  return `${Math.floor(10000 + Math.random() * 90000)}`;
}

function isHoldLongerSession(store, code) {
  return store[code]?.holdLonger === true;
}

function parseHoldLonger(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }

  return undefined;
}

function setHoldLongerForCode(store, fileStore, uploadState, code, holdLonger) {
  if (!store[code]) return false;

  store[code].holdLonger = holdLonger;

  if (fileStore[code]) {
    fileStore[code].holdLonger = holdLonger;
  }

  for (const state of Object.values(uploadState)) {
    if (state?.code === code) {
      state.holdLonger = holdLonger;
    }
  }

  return true;
}

function touchSession(store, code) {
  if (!store[code]) return false;

  store[code].lastUpdated = Date.now();
  return true;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (_req, _file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(_file.originalname);
    cb(null, `${unique}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
});

const chunkUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const { fileId } = req.body;
      if (!fileId) return cb(new Error("Missing fileId"));

      const dir = path.join(TMP_UPLOAD_DIR, fileId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, _file, cb) => {
      cb(null, `${req.body.chunkIndex}.part`);
    },
  }),
  limits: {
    fileSize: MAX_CHUNK_SIZE,
  },
});

app.post("/api/session", async (req, res) => {
  const code = await runExclusive(() => {
    const store = loadJSON(STORE_FILE);
    const fileStore = loadJSON(FILESTORE_FILE);

    let code;
    do {
      code = generateSessionCode();
    } while (store[code] || fileStore[code]);

    store[code] = {
      type: "text",
      content: "",
      lastUpdated: Date.now(),
      holdLonger: false,
    };

    saveJSON(STORE_FILE, store);
    return code;
  });

  res.json({ code });
});

app.post("/api/session/:code/hold-longer", (req, res) => {
  const code = req.params.code;
  const holdLonger = parseHoldLonger(req.body?.holdLonger);

  if (holdLonger === undefined) {
    return res.status(400).json({ error: "Invalid data" });
  }

  const store = loadJSON(STORE_FILE);
  const fileStore = loadJSON(FILESTORE_FILE);
  const uploadState = loadUploadState();

  if (!setHoldLongerForCode(store, fileStore, uploadState, code, holdLonger)) {
    return res.status(404).json({ error: "Not found" });
  }

  saveJSON(STORE_FILE, store);
  saveJSON(FILESTORE_FILE, fileStore);
  saveUploadState(uploadState);

  res.json({ ok: true });
});

app.post("/api/publish", (req, res) => {
  const { code, type, content } = req.body;
  if (!code || !content || type !== "text") {
    return res.status(400).json({ error: "Invalid data" });
  }

  const store = loadJSON(STORE_FILE);
  store[code] = {
    ...store[code],
    type,
    content,
    lastUpdated: Date.now(),
  };
  saveJSON(STORE_FILE, store);

  res.json({ ok: true });
});

app.get("/api/get/:code", (req, res) => {
  const store = loadJSON(STORE_FILE);
  const data = store[req.params.code];
  if (!data) return res.status(404).json({ error: "Not found" });
  res.json(data);
});

app.post("/api/file/upload", upload.single("file"), (req, res) => {
  const { code } = req.body;
  const file = req.file;

  if (!code || !file) {
    return res.status(400).json({ error: "Missing code or file" });
  }

  const store = loadJSON(STORE_FILE);
  const fileStore = loadJSON(FILESTORE_FILE);
  if (touchSession(store, code)) saveJSON(STORE_FILE, store);
  fileStore[code] = {
    originalName: file.originalname,
    size: file.size,
    path: file.path,
    uploadedAt: Date.now(),
    holdLonger: isHoldLongerSession(store, code),
  };

  saveJSON(FILESTORE_FILE, fileStore);
  res.json({ ok: true });
});

app.post("/api/file/chunk", chunkUpload.single("file"), (req, res) => {
  const { code, fileId, chunkIndex, fileName } = req.body;
  const chunkSize = req.file?.size || 0;

  if (!code || !fileId || chunkIndex === undefined || !fileName) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const store = loadJSON(STORE_FILE);
  const state = loadUploadState();

  if (touchSession(store, code)) saveJSON(STORE_FILE, store);

  if (!state[fileId]) {
    state[fileId] = {
      code,
      totalSize: 0,
      chunks: {},
      createdAt: Date.now(),
      holdLonger: isHoldLongerSession(store, code),
    };
  }

  if (state[fileId].chunks[chunkIndex]) {
    return res.status(400).json({ error: "Chunk already uploaded" });
  }

  state[fileId].totalSize += chunkSize;
  state[fileId].chunks[chunkIndex] = chunkSize;

  if (state[fileId].totalSize > MAX_FILE_SIZE) {
    fs.unlinkSync(req.file.path);
    delete state[fileId].chunks[chunkIndex];
    state[fileId].totalSize -= chunkSize;
    saveUploadState(state);
    return res.status(413).json({ error: "File exceeds upload limit" });
  }

  saveUploadState(state);
  res.json({ ok: true });
});

app.post("/api/file/finalize", (req, res) => {
  const { code, fileId, totalChunks, fileName } = req.body;
  const store = loadJSON(STORE_FILE);
  const state = loadUploadState();
  const meta = state[fileId];

  if (!meta) return res.status(400).json({ error: "Upload state not found" });
  if (meta.totalSize > MAX_FILE_SIZE)
    return res.status(413).json({ error: "File too large" });

  const chunkDir = path.join(TMP_UPLOAD_DIR, fileId);
  const finalName = `${uuidv4()}${path.extname(fileName)}`;
  const finalPath = path.join(UPLOAD_DIR, finalName);

  const ws = fs.createWriteStream(finalPath);
  for (let i = 0; i < totalChunks; i++) {
    const p = path.join(chunkDir, `${i}.part`);
    if (!fs.existsSync(p))
      return res.status(400).json({ error: "Missing chunk" });
    ws.write(fs.readFileSync(p));
  }
  ws.end();

  ws.on("close", () => {
    fs.rmSync(chunkDir, { recursive: true, force: true });
    delete state[fileId];
    saveUploadState(state);

    touchSession(store, code);
    saveJSON(STORE_FILE, store);

    const effectiveHoldLonger =
      meta.holdLonger === true || isHoldLongerSession(store, code);

    const fileStore = loadJSON(FILESTORE_FILE);
    fileStore[code] = {
      originalName: fileName,
      storedName: finalName,
      path: finalPath,
      size: fs.statSync(finalPath).size,
      uploadedAt: Date.now(),
      holdLonger: effectiveHoldLonger,
    };
    saveJSON(FILESTORE_FILE, fileStore);

    res.json({ ok: true });
  });
});

app.get("/api/file/meta/:code", (req, res) => {
  const fileStore = loadJSON(FILESTORE_FILE);
  if (!fileStore[req.params.code])
    return res.status(404).json({ error: "Not found" });
  res.json({ file: fileStore[req.params.code] });
});

app.get("/api/file/download/:code", (req, res) => {
  const fileStore = loadJSON(FILESTORE_FILE);
  const data = fileStore[req.params.code];
  if (!data || !fs.existsSync(data.path))
    return res.status(404).json({ error: "Not found" });
  res.download(data.path, data.originalName);
});

app.delete("/api/session/:code", (req, res) => {
  const code = req.params.code;
  const store = loadJSON(STORE_FILE);
  const fileStore = loadJSON(FILESTORE_FILE);

  delete store[code];
  if (fileStore[code]?.path && fs.existsSync(fileStore[code].path)) {
    fs.unlinkSync(fileStore[code].path);
  }
  delete fileStore[code];

  saveJSON(STORE_FILE, store);
  saveJSON(FILESTORE_FILE, fileStore);
  res.json({ ok: true });
});

app.get("/api/ping", (_req, res) => {
  res.json({ pong: true });
});

app.use((err, _req, res, _next) => {
  console.error("[ERROR]", err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`🚀 Backend running at http://localhost:${PORT}`);
});
