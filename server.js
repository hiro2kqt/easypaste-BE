const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = 8031;

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const UPLOAD_STATE_FILE = path.join(__dirname, "uploadState.json");

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
  const digitLength = 4 + Math.floor(Math.random() * 3);
  let digits = "";
  for (let i = 0; i < digitLength; i++) {
    digits += Math.floor(Math.random() * 10).toString();
  }

  return `${digits}`;
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
    fileSize: 2 * 1024 * 1024,
  },
});

app.post("/api/session", (_req, res) => {
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
  };

  saveJSON(STORE_FILE, store);
  res.json({ code });
});

app.post("/api/publish", (req, res) => {
  const { code, type, content } = req.body;
  if (!code || !content || type !== "text") {
    return res.status(400).json({ error: "Invalid data" });
  }

  const store = loadJSON(STORE_FILE);
  store[code] = { type, content, lastUpdated: Date.now() };
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

  const fileStore = loadJSON(FILESTORE_FILE);
  fileStore[code] = {
    originalName: file.originalname,
    size: file.size,
    path: file.path,
    uploadedAt: Date.now(),
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

  const state = loadUploadState();

  if (!state[fileId]) {
    state[fileId] = {
      code,
      totalSize: 0,
      chunks: {},
      createdAt: Date.now(),
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
    return res.status(413).json({ error: "File exceeds 10MB limit" });
  }

  saveUploadState(state);
  res.json({ ok: true });
});

app.post("/api/file/finalize", (req, res) => {
  const { code, fileId, totalChunks, fileName } = req.body;
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

    const fileStore = loadJSON(FILESTORE_FILE);
    fileStore[code] = {
      originalName: fileName,
      storedName: finalName,
      path: finalPath,
      size: fs.statSync(finalPath).size,
      uploadedAt: Date.now(),
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
