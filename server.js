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
const FILESTORE_FILE = path.join(__dirname, "fileStore.json");

for (const dir of [UPLOAD_DIR, TMP_UPLOAD_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log("[INIT] Created dir:", dir);
  }
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

const chunkUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const { fileId } = req.body;
      if (!fileId) return cb(new Error("Missing fileId"));

      const dir = path.join(TMP_UPLOAD_DIR, fileId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      cb(null, `${req.body.chunkIndex}.part`);
    },
  }),
  limits: {
    fileSize: 2 * 1024 * 1024,
  },
});

function loadJSON(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function saveJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

app.post("/api/file/chunk", chunkUpload.single("file"), (req, res) => {
  const { code, fileId, chunkIndex, totalChunks, fileName } = req.body;
  const chunkSize = req.file?.size || 0;

  if (
    !code ||
    !fileId ||
    chunkIndex === undefined ||
    !totalChunks ||
    !fileName
  ) {
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
    const chunkPath = req.file.path;
    if (fs.existsSync(chunkPath)) fs.unlinkSync(chunkPath);

    delete state[fileId].chunks[chunkIndex];
    state[fileId].totalSize -= chunkSize;

    saveUploadState(state);

    console.warn("[CHUNK] size limit exceeded", {
      fileId,
      totalSize: state[fileId].totalSize,
    });

    return res.status(413).json({ error: "File exceeds 10MB limit" });
  }

  saveUploadState(state);

  console.log("[CHUNK]", {
    code,
    fileId,
    chunkIndex,
    size: chunkSize,
    totalSize: state[fileId].totalSize,
  });

  res.json({ ok: true });
});

app.post("/api/file/finalize", (req, res) => {
  const { code, fileId, totalChunks, fileName } = req.body;

  if (!code || !fileId || !totalChunks || !fileName) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const state = loadUploadState();
  const meta = state[fileId];

  if (!meta) {
    return res.status(400).json({ error: "Upload state not found" });
  }

  if (meta.totalSize > MAX_FILE_SIZE) {
    return res.status(413).json({ error: "File too large" });
  }

  const uploadedChunkCount = Object.keys(meta.chunks).length;
  if (uploadedChunkCount !== Number(totalChunks)) {
    return res.status(400).json({
      error: "Missing chunks",
      uploadedChunkCount,
    });
  }

  const chunkDir = path.join(TMP_UPLOAD_DIR, fileId);
  if (!fs.existsSync(chunkDir)) {
    return res.status(400).json({ error: "Chunk dir not found" });
  }

  const ext = path.extname(fileName);
  const finalName = `${uuidv4()}${ext}`;
  const finalPath = path.join(UPLOAD_DIR, finalName);
  const writeStream = fs.createWriteStream(finalPath);

  try {
    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = path.join(chunkDir, `${i}.part`);
      if (!fs.existsSync(chunkPath)) {
        writeStream.close();
        return res.status(400).json({ error: `Missing chunk ${i}` });
      }
      writeStream.write(fs.readFileSync(chunkPath));
    }
  } catch (e) {
    writeStream.close();
    return res.status(500).json({ error: "Merge failed" });
  }

  writeStream.end();

  writeStream.on("close", () => {
    fs.rmSync(chunkDir, { recursive: true, force: true });
    delete state[fileId];
    saveUploadState(state);

    const fileStore = loadJSON(FILESTORE_FILE);
    const now = Date.now();

    fileStore[code] = {
      fileId,
      originalName: fileName,
      storedName: finalName,
      path: finalPath,
      size: fs.statSync(finalPath).size,
      uploadedAt: now,
      lastUpdated: now,
    };

    saveJSON(FILESTORE_FILE, fileStore);

    console.log("[FINALIZE] done:", finalPath);

    res.json({
      ok: true,
      file: {
        originalName: fileName,
        storedName: finalName,
        size: fileStore[code].size,
      },
    });
  });
});

app.get("/api/ping", (req, res) => {
  res.json({ pong: true });
});

app.use((err, req, res, next) => {
  console.error("[ERROR]", err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`🚀 Backend running at http://localhost:${PORT}`);
});
