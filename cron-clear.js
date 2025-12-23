// cron-loop.js
const fs = require("fs");
const path = require("path");

const UPLOAD_DIR = path.join(__dirname, "uploads");
const TMP_UPLOAD_DIR = path.join(__dirname, "uploads_tmp");

const STORE_FILE = path.join(__dirname, "store.json");
const FILESTORE_FILE = path.join(__dirname, "fileStore.json");
const UPLOAD_STATE_FILE = path.join(__dirname, "uploadState.json");

const EXPIRATION_MS = 10 * 60 * 1000;
const LOOP_INTERVAL_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadJSON(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    console.error("[CRON] Failed to parse", filePath, e.message);
    return {};
  }
}

function saveJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

async function cleanupLoop() {
  console.log("[CRON] Cleanup loop started.");

  while (true) {
    try {
      const now = Date.now();

      let store = loadJSON(STORE_FILE);
      let fileStore = loadJSON(FILESTORE_FILE);
      let uploadState = loadJSON(UPLOAD_STATE_FILE);

      let removedSessions = 0;
      let removedFiles = 0;
      let removedChunks = 0;

      for (const code of Object.keys(store)) {
        const last = store[code]?.lastUpdated || 0;
        if (now - last > EXPIRATION_MS) {
          delete store[code];
          removedSessions++;
        }
      }

      for (const code of Object.keys(fileStore)) {
        const meta = fileStore[code];
        const ts = meta.uploadedAt || 0;

        if (now - ts > EXPIRATION_MS) {
          const filePath = path.resolve(meta.path || "");

          if (filePath.startsWith(UPLOAD_DIR) && fs.existsSync(filePath)) {
            try {
              fs.unlinkSync(filePath);
            } catch (err) {
              console.error("[CRON] Failed to delete file:", filePath, err);
            }
          }

          delete fileStore[code];
          removedFiles++;
        }
      }

      for (const fileId of Object.keys(uploadState)) {
        const state = uploadState[fileId];
        const createdAt = state.createdAt || 0;

        if (now - createdAt > EXPIRATION_MS) {
          const chunkDir = path.join(TMP_UPLOAD_DIR, fileId);

          if (fs.existsSync(chunkDir)) {
            try {
              fs.rmSync(chunkDir, { recursive: true, force: true });
            } catch (err) {
              console.error("[CRON] Failed to remove chunk dir:", err);
            }
          }

          delete uploadState[fileId];
          removedChunks++;
        }
      }

      if (removedSessions || removedFiles || removedChunks) {
        console.log(
          `[CRON] Cleaned: sessions=${removedSessions}, files=${removedFiles}, chunks=${removedChunks}`
        );
      }

      saveJSON(STORE_FILE, store);
      saveJSON(FILESTORE_FILE, fileStore);
      saveJSON(UPLOAD_STATE_FILE, uploadState);
    } catch (err) {
      console.error("[CRON] Error in cleanup loop:", err);
    }

    await sleep(LOOP_INTERVAL_MS);
  }
}

cleanupLoop();
