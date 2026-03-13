const statusEl = document.getElementById("status");
const audioInfo = document.getElementById("audioInfo");
const cacheMetaEl = document.getElementById("cacheMeta");
const trackListEl = document.getElementById("trackList");
const passwordEl = document.getElementById("password");
const unlockBtn = document.getElementById("unlockBtn");
const player = document.getElementById("player");
// const nowPlayingEl = document.getElementById("nowPlaying");
const topEl = document.querySelector(".top");
const coverEl = document.getElementById("cover");
const coverContainer = document.getElementById("coverContainer");
const coverPlaceholderEl = document.getElementById("coverPlaceholder");
const lyricsContentEl = document.getElementById("lyricsContent");
const lyricsPanel = document.getElementById("lyricsPanel")
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
// const modeSingleBtn = document.getElementById("modeSingleBtn");
// const modeListBtn = document.getElementById("modeListBtn");
// const modeShuffleBtn = document.getElementById("modeShuffleBtn");
const modeBtn = document.getElementById("modeBtn")
// const playModeLabelEl = document.getElementById("playModeLabel");

const MAX_CACHE_BYTES = 500 * 1024 * 1024;
const TRIM_TO_BYTES = 380 * 1024 * 1024;
const PREFETCH_AHEAD_SEGMENTS = 2;
const DB_NAME = "demo-stream-cache-v1";
const SEGMENT_STORE = "segments";
// const PLAY_MODES = {
//   SINGLE: "single",
//   LIST: "list",
//   SHUFFLE: "shuffle",
// };
const PLAY_MODE = {
  LIST: 0,
  SINGLE: 1,
  SHUFFLE: 2
}

const state = {
  catalog: null,
  manifestSec: null,
  payload: null,
  unlocked: false,
  currentIndex: -1,
  playMode: PLAY_MODE.LIST,
  shuffleHistory: [],
  trackBundleCache: new Map(), // stem -> { coverUrl, lrcText, txtText }
  currentLrc: [],
  currentLrcIndex: -1,
  db: null,
  streamSession: null,
  cacheUsageBytes: 0,
};

function setStatus(text) {
  statusEl.textContent = text;
}

function setAudioInfo(text){
  audioInfo.textContent = text;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function bytesToMB(n) {
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

function updateCacheMeta() {
  cacheMetaEl.textContent = `缓存：${bytesToMB(state.cacheUsageBytes)} / ${bytesToMB(MAX_CACHE_BYTES)}`;
}

// function updatePlayModeUI() {
//   // if (!playModeLabelEl) return;

//   const mapping = {
//     [PLAY_MODE.SINGLE]: {
//       label: "播放模式：单曲循环"
//     },
//     [PLAY_MODE.LIST]: {
//       label: "播放模式：列表循环"
//     },
//     [PLAY_MODE.SHUFFLE]: {
//       label: "播放模式：随机播放"
//     },
//   };

  // const current = mapping[state.playMode];
  // playModeLabelEl.textContent = current.label;

  // [modeSingleBtn, modeListBtn, modeShuffleBtn].forEach((btn) => {
  //   btn?.classList.toggle("active", btn === current.activeBtn);
  // });
// }

function setPlayMode(mode) {
  state.playMode = mode;
  if (mode !== PLAY_MODE.SHUFFLE) {
    state.shuffleHistory = [];
  } else if (state.currentIndex >= 0) {
    state.shuffleHistory = [state.currentIndex];
  }
  // updatePlayModeUI();
}

function getTrackCount() {
  return state.catalog?.tracks?.length || 0;
}

function loadJson(path) {
  return fetch(path, { cache: "no-store" }).then((resp) => {
    if (!resp.ok) throw new Error(`无法读取 ${path}`);
    return resp.json();
  });
}

async function deriveManifestKey(password, kdfInfo) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: b64ToBytes(kdfInfo.salt),
      iterations: kdfInfo.iterations,
      hash: kdfInfo.hash,
    },
    baseKey,
    {
      name: "AES-GCM",
      length: 256,
    },
    false,
    ["decrypt"]
  );
}

async function decryptManifest(password) {
  const key = await deriveManifestKey(password, state.manifestSec.kdf);
  const cipher = state.manifestSec.cipher;

  const plainBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(cipher.nonce) },
    key,
    b64ToBytes(cipher.ciphertext)
  );

  const text = new TextDecoder("utf-8").decode(plainBuffer);
  return JSON.parse(text);
}

async function importAesKeyFromRaw(rawKeyBytes) {
  return await crypto.subtle.importKey(
    "raw",
    rawKeyBytes,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
}

async function decryptBinaryAsset(asset) {
  const resp = await fetch(asset.file, { cache: "no-store" });
  if (!resp.ok) throw new Error(`无法读取文件：${asset.file}`);

  const cipherBuffer = await resp.arrayBuffer();
  const dekKey = await importAesKeyFromRaw(b64ToBytes(asset.dek));

  return await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(asset.nonce) },
    dekKey,
    cipherBuffer
  );
}

/* -------------------- IndexedDB segment cache -------------------- */

function openCacheDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);

    req.onupgradeneeded = () => {
      const db = req.result;
      const store = db.createObjectStore(SEGMENT_STORE, { keyPath: "key" });
      store.createIndex("atime", "atime", { unique: false });
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(storeName, mode = "readonly") {
  return state.db.transaction(storeName, mode).objectStore(storeName);
}

function idbGet(key) {
  return new Promise((resolve, reject) => {
    const req = tx(SEGMENT_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(value) {
  return new Promise((resolve, reject) => {
    const req = tx(SEGMENT_STORE, "readwrite").put(value);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(key) {
  return new Promise((resolve, reject) => {
    const req = tx(SEGMENT_STORE, "readwrite").delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function idbGetAllByAtime() {
  return new Promise((resolve, reject) => {
    const store = tx(SEGMENT_STORE);
    const idx = store.index("atime");
    const req = idx.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function refreshCacheUsage() {
  const all = await idbGetAllByAtime();
  state.cacheUsageBytes = all.reduce((sum, item) => sum + (item.size || 0), 0);
  updateCacheMeta();
}

async function touchSegmentCacheRecord(record) {
  record.atime = Date.now();
  await idbPut(record);
}

async function enforceCacheBudget() {
  await refreshCacheUsage();
  if (state.cacheUsageBytes <= MAX_CACHE_BYTES) return;

  const all = await idbGetAllByAtime();
  let usage = state.cacheUsageBytes;

  for (const item of all) {
    if (usage <= TRIM_TO_BYTES) break;
    await idbDelete(item.key);
    usage -= item.size || 0;
  }

  state.cacheUsageBytes = Math.max(0, usage);
  updateCacheMeta();
}

async function getCachedSegment(trackId, segIndex) {
  const key = `${trackId}:${segIndex}`;
  const record = await idbGet(key);
  if (!record) return null;
  await touchSegmentCacheRecord(record);
  return record.data;
}

async function putCachedSegment(trackId, segIndex, buffer) {
  const key = `${trackId}:${segIndex}`;
  const size = buffer.byteLength || 0;

  await idbPut({
    key,
    trackId,
    segIndex,
    size,
    atime: Date.now(),
    data: buffer,
  });

  state.cacheUsageBytes += size;
  updateCacheMeta();

  if (state.cacheUsageBytes > MAX_CACHE_BYTES) {
    await enforceCacheBudget();
  }
}

async function getOrFetchDecryptedSegment(track, segment) {
  const cached = await getCachedSegment(track.id, segment.index);
  if (cached) return cached;

  const resp = await fetch(segment.file, { cache: "no-store" });
  if (!resp.ok) throw new Error(`无法读取分段：${segment.file}`);
  const cipherBuffer = await resp.arrayBuffer();

  const dekKey = await importAesKeyFromRaw(b64ToBytes(segment.dek));
  const plainBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(segment.nonce) },
    dekKey,
    cipherBuffer
  );

  await putCachedSegment(track.id, segment.index, plainBuffer);
  return plainBuffer;
}

/* -------------------- cover / lyrics -------------------- */

function revokeTrackBundle(stem) {
  const bundle = state.trackBundleCache.get(stem);
  if (!bundle) return;
  if (bundle.coverUrl) URL.revokeObjectURL(bundle.coverUrl);
  state.trackBundleCache.delete(stem);
}

async function getTrackBundle(stem) {
  const cached = state.trackBundleCache.get(stem);
  if (cached) return cached;

  const track = state.payload.tracks[stem];
  const result = {
    coverUrl: null,
    lrcText: null,
    txtText: null,
  };

  if (track.cover) {
    const coverBuffer = await decryptBinaryAsset(track.cover);
    const coverBlob = new Blob([coverBuffer], { type: track.cover.mime || "image/jpeg" });
    result.coverUrl = URL.createObjectURL(coverBlob);
  }

  if (track.lrc) {
    const lrcBuffer = await decryptBinaryAsset(track.lrc);
    result.lrcText = new TextDecoder("utf-8").decode(lrcBuffer);
  }

  if (track.txt) {
    const txtBuffer = await decryptBinaryAsset(track.txt);
    result.txtText = new TextDecoder("utf-8").decode(txtBuffer);
  }

  state.trackBundleCache.set(stem, result);
  return result;
}

function parseLRC(lrcText) {
  const lines = lrcText.split(/\r?\n/);
  const result = [];

  for (const line of lines) {
    const matches = [...line.matchAll(/\[(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\]/g)];
    if (!matches.length) continue;

    const text = line.replace(/\[(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\]/g, "").trim();
    if (!text) continue;

    for (const m of matches) {
      const mm = parseInt(m[1], 10);
      const ss = parseInt(m[2], 10);
      const fracRaw = m[3] || "0";
      const frac = parseInt(fracRaw.padEnd(3, "0").slice(0, 3), 10);
      const time = mm * 60 + ss + frac / 1000;
      result.push({ time, text });
    }
  }

  result.sort((a, b) => a.time - b.time);
  return result;
}

function renderPlainLyrics(text) {
  state.currentLrc = [];
  state.currentLrcIndex = -1;
  lyricsContentEl.className = "lyrics-plain";
  lyricsContentEl.textContent = text || "暂无歌词";
}

function renderLrcLines(lines) {
  state.currentLrc = lines;
  state.currentLrcIndex = -1;
  lyricsContentEl.className = "";
  if (!lines.length) {
    lyricsContentEl.textContent = "暂无歌词";
    return;
  }

  lyricsContentEl.innerHTML = lines
    .map((line, i) => `<div class="lrc-line" data-lrc-index="${i}">${escapeHtml(line.text)}</div>`)
    .join("");
}

function updateLyricsByTime(currentTime) {
  if (!state.currentLrc.length) return;

  let active = -1;
  for (let i = 0; i < state.currentLrc.length; i++) {
    if (currentTime >= state.currentLrc[i].time) active = i;
    else break;
  }

  if (active === state.currentLrcIndex) return;
  state.currentLrcIndex = active;

  const nodes = lyricsContentEl.querySelectorAll(".lrc-line");
  nodes.forEach((node, i) => {
    node.classList.toggle("active", i === active);
  });

  // if (active >= 0 && nodes[active]) {
  //   nodes[active].scrollIntoView({ block: "center", behavior: "smooth" });
  // }
  if (active >= 0 && nodes[active]) {
    const node = nodes[active];
    const container = lyricsPanel;

    const nodeRect = node.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    const targetTop =
      container.scrollTop +
      (nodeRect.top - containerRect.top) -
      container.clientHeight / 2 +
      node.clientHeight / 2;

    container.scrollTo({
      top: Math.max(0, targetTop),
      behavior: "smooth"
    });
  }
}

function applyCover(coverUrl) {
  if (coverUrl) {
    coverEl.src = coverUrl;
    coverEl.style.display = "block";
    coverPlaceholderEl.style.display = "none";
  } else {
    coverEl.removeAttribute("src");
    coverEl.style.display = "none";
    coverPlaceholderEl.style.display = "block";
  }
}

function applyLyrics(bundle) {
  if (bundle.lrcText) {
    renderLrcLines(parseLRC(bundle.lrcText));
    return;
  }
  if (bundle.txtText) {
    renderPlainLyrics(bundle.txtText);
    return;
  }
  renderPlainLyrics("暂无歌词");
}

/* -------------------- list UI -------------------- */

function renderTrackList() {
  trackListEl.innerHTML = "";

  state.catalog.tracks.forEach((track, index) => {
    const li = document.createElement("li");
    li.className = "track";
    li.dataset.index = String(index);
    li.dataset.stem = track.stem;

    const num = document.createElement("div");
    num.className = "small";
    num.textContent = String(index + 1).padStart(2, "0");

    const info = document.createElement("div");
    const badges = [];
    // badges.push(`<span class="badge">${track.segment_count} seg</span>`);
    if (track.has_lrc) badges.push(`<span class="badge">LRC</span>`);
    else if (track.has_txt) badges.push(`<span class="badge">TXT</span>`);
    if (track.has_cover) badges.push(`<span class="badge">Cover</span>`);

    info.innerHTML = `
      <div class="track-title">${escapeHtml(track.title)}</div>
      <div class="badges">${badges.join("")}</div>
    `;

    const btn = document.createElement("button");
    btn.textContent = "播放";
    btn.addEventListener("click", () => playTrackByIndex(index));

    li.appendChild(num);
    li.appendChild(info);
    li.appendChild(btn);
    trackListEl.appendChild(li);
  });

  trackListEl.classList.remove("hidden");
}

function markActiveTrack(index) {
  [...trackListEl.querySelectorAll(".track")].forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.index) === index);
  });
}

/* -------------------- play mode / navigation -------------------- */

function getRandomIndexExcluding(excludeIndex) {
  const count = getTrackCount();
  if (count <= 1) return excludeIndex;

  let candidate = excludeIndex;
  while (candidate === excludeIndex) {
    candidate = Math.floor(Math.random() * count);
  }
  return candidate;
}

function rememberShuffleIndex(index) {
  if (state.playMode !== PLAY_MODE.SHUFFLE) return;
  const history = state.shuffleHistory;
  if (history[history.length - 1] !== index) {
    history.push(index);
  }
}

async function playPreviousTrack() {
  if (!state.unlocked || getTrackCount() === 0) {
    setStatus("请先输入正确口令。");
    return;
  }

  let targetIndex = state.currentIndex;

  if (state.playMode === PLAY_MODE.SHUFFLE && state.shuffleHistory.length > 1) {
    state.shuffleHistory.pop();
    targetIndex = state.shuffleHistory[state.shuffleHistory.length - 1];
  } else if (state.currentIndex > 0) {
    targetIndex = state.currentIndex - 1;
  } else {
    targetIndex = getTrackCount() - 1;
  }

  await playTrackByIndex(targetIndex, { pushShuffleHistory: false });
}

async function playNextTrack({ auto = false } = {}) {
  if (!state.unlocked || getTrackCount() === 0) {
    setStatus("请先输入正确口令。");
    return;
  }

  let targetIndex = state.currentIndex;

  if (state.playMode === PLAY_MODE.SINGLE && auto && state.currentIndex >= 0) {
    targetIndex = state.currentIndex;
  } else if (state.playMode === PLAY_MODE.SHUFFLE) {
    targetIndex = getRandomIndexExcluding(state.currentIndex >= 0 ? state.currentIndex : 0);
  } else if (state.currentIndex < 0) {
    targetIndex = 0;
  } else {
    targetIndex = (state.currentIndex + 1) % getTrackCount();
  }

  await playTrackByIndex(targetIndex, { pushShuffleHistory: state.playMode === PLAY_MODE.SHUFFLE });
}

/* -------------------- audio streaming -------------------- */

function stopCurrentStreamSession() {
  if (!state.streamSession) return;
  state.streamSession.aborted = true;
  if (state.streamSession.objectUrl) {
    URL.revokeObjectURL(state.streamSession.objectUrl);
  }
  state.streamSession = null;
}

function appendBufferAsync(sourceBuffer, arrayBuffer) {
  return new Promise((resolve, reject) => {
    const onUpdateEnd = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("SourceBuffer append 失败"));
    };
    const cleanup = () => {
      sourceBuffer.removeEventListener("updateend", onUpdateEnd);
      sourceBuffer.removeEventListener("error", onError);
    };
    sourceBuffer.addEventListener("updateend", onUpdateEnd, { once: true });
    sourceBuffer.addEventListener("error", onError, { once: true });
    sourceBuffer.appendBuffer(arrayBuffer);
  });
}

async function streamTrackWithMSE(track) {
  const mime = track.audio.mime;
  if (!window.MediaSource || !MediaSource.isTypeSupported(mime)) {
    throw new Error("MSE 不可用或当前 MIME 不支持");
  }

  stopCurrentStreamSession();

  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);
  const session = {
    aborted: false,
    mediaSource,
    objectUrl,
    trackId: track.id,
  };
  state.streamSession = session;
  player.src = objectUrl;

  await new Promise((resolve, reject) => {
    mediaSource.addEventListener("sourceopen", resolve, { once: true });
    mediaSource.addEventListener("error", () => reject(new Error("MediaSource 打开失败")), { once: true });
  });

  if (session.aborted) return;

  const sourceBuffer = mediaSource.addSourceBuffer(mime);
  const segments = track.audio.segments;

  for (let i = 0; i < segments.length; i++) {
    if (session.aborted) return;
    const plainBuffer = await getOrFetchDecryptedSegment(track, segments[i]);
    await appendBufferAsync(sourceBuffer, plainBuffer);

    for (let p = 1; p <= PREFETCH_AHEAD_SEGMENTS; p++) {
      const next = segments[i + p];
      if (!next) continue;
      void getOrFetchDecryptedSegment(track, next).catch(() => {});
    }

    if (i === 0) {
      try {
        await player.play();
      } catch (_) {}
    }
  }

  if (!session.aborted && mediaSource.readyState === "open") {
    await new Promise((resolve) => {
      if (sourceBuffer.updating) {
        sourceBuffer.addEventListener("updateend", resolve, { once: true });
      } else {
        resolve();
      }
    });
    try {
      mediaSource.endOfStream();
    } catch (_) {}
  }
}

async function fallbackAssembleWholeTrack(track) {
  const parts = [];
  for (const seg of track.audio.segments) {
    const buf = await getOrFetchDecryptedSegment(track, seg);
    parts.push(buf);
  }

  const blob = new Blob(parts, { type: track.audio.mime || "audio/mpeg" });
  const url = URL.createObjectURL(blob);

  stopCurrentStreamSession();
  state.streamSession = {
    aborted: false,
    objectUrl: url,
    trackId: track.id,
  };

  player.src = url;
  await player.play();
}

async function prefetchTrackSegments(track, startSegIndex = 0, count = 2) {
  const segs = track.audio.segments.slice(startSegIndex, startSegIndex + count);
  for (const seg of segs) {
    void getOrFetchDecryptedSegment(track, seg).catch(() => {});
  }
}

async function playTrackByIndex(index, { pushShuffleHistory = state.playMode === PLAY_MODE.SHUFFLE } = {}) {
  if (!state.unlocked || !state.payload) {
    setStatus("请先输入正确口令。");
    return;
  }

  const meta = state.catalog.tracks[index];
  if (!meta) return;

  const track = state.payload.tracks[meta.stem];
  if (!track || !track.audio) return;

  try {
    // setStatus(`正在准备：${meta.title}`);
    setStatus(`正在准备……`);

    const bundle = await getTrackBundle(meta.stem);
    applyCover(bundle.coverUrl);
    applyLyrics(bundle);

    state.currentIndex = index;
    if (pushShuffleHistory) rememberShuffleIndex(index);
    else if (state.playMode === PLAY_MODE.SHUFFLE && state.shuffleHistory.length === 0) {
      state.shuffleHistory = [index];
    }

    markActiveTrack(index);
    // nowPlayingEl.textContent = `正在播放：${meta.title}`;
    // nowPlayingEl.textContent = `正在播放……`;

    try {
      await streamTrackWithMSE(track);
      setStatus('');
      setAudioInfo(`♪${meta.title}`);
      topEl.classList.remove("no-cover");
      coverContainer.style.display = "flex";
    } catch (err) {
      console.warn("MSE 路径失败，回退整首拼接：", err);
      setStatus('');
      setAudioInfo(`♪${meta.title}`);
      topEl.classList.remove("no-cover");
      coverContainer.style.display = "flex";
      await fallbackAssembleWholeTrack(track);
    }

    if (state.playMode === PLAY_MODE.SHUFFLE) {
      const upcomingIndex = getRandomIndexExcluding(index);
      const nextMeta = state.catalog.tracks[upcomingIndex];
      const nextTrack = nextMeta ? state.payload.tracks[nextMeta.stem] : null;
      if (nextTrack?.audio) {
        void prefetchTrackSegments(nextTrack, 0, 2);
      }
      return;
    }

    const nextIndex = (index + 1) % getTrackCount();
    const nextMeta = state.catalog.tracks[nextIndex];
    if (nextMeta) {
      const nextTrack = state.payload.tracks[nextMeta.stem];
      if (nextTrack?.audio) {
        void prefetchTrackSegments(nextTrack, 0, 2);
      }
    }
  } catch (err) {
    console.error(err);
    setStatus(`播放失败：${meta.title}`);
  }
}

/* -------------------- unlock / init -------------------- */

async function unlock() {
  const password = passwordEl.value;
  if (!password) {
    setStatus("请输入口令。");
    return;
  }

  try {
    setStatus("正在解锁…");
    state.payload = await decryptManifest(password);
    state.unlocked = true;

    if (navigator.storage?.persisted) {
      try {
        const persisted = await navigator.storage.persisted();
        if (!persisted && navigator.storage.persist) {
          await navigator.storage.persist();
        }
      } catch (_) {}
    }

    if (navigator.storage?.estimate) {
      try {
        const info = await navigator.storage.estimate();
        console.log("storage estimate", info);
      } catch (_) {}
    }

    setStatus("解锁成功。");
    if (getTrackCount() > 0) {
      await playTrackByIndex(0);
    }

  } catch (err) {
    console.error(err);
    state.payload = null;
    state.unlocked = false;
    setStatus("口令错误或索引已损坏。");
  }
}

modeBtn.onclick = () => {

  state.playMode = (state.playMode + 1) % 3

  switch (state.playMode) {

    case PLAY_MODE.LIST:
      modeBtn.textContent = "🔁"
      break

    case PLAY_MODE.SINGLE:
      modeBtn.textContent = "🔂"
      break

    case PLAY_MODE.SHUFFLE:
      modeBtn.textContent = "🔀"
      break

  }
}

player.addEventListener("ended", async () => {

  if (!state.unlocked || getTrackCount() === 0) return;

  if (state.playMode === PLAY_MODE.SINGLE) {

    player.currentTime = 0;
    await player.play();

  }
  else if (state.playMode === PLAY_MODE.SHUFFLE) {

    const next = Math.floor(Math.random() * getTrackCount());
    await playTrackByIndex(next);

  }
  else {

    await playNextTrack({ auto: true });

  }

});

player.addEventListener("timeupdate", () => {
  updateLyricsByTime(player.currentTime);
});

unlockBtn.addEventListener("click", unlock);
passwordEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") unlock();
});
prevBtn?.addEventListener("click", () => {
  void playPreviousTrack();
});
nextBtn?.addEventListener("click", () => {
  void playNextTrack({ auto: false });
});
// modeSingleBtn?.addEventListener("click", () => setPlayMode(PLAY_MODE.SINGLE));
// modeListBtn?.addEventListener("click", () => setPlayMode(PLAY_MODE.LIST));
// modeShuffleBtn?.addEventListener("click", () => setPlayMode(PLAY_MODE.SHUFFLE));

window.addEventListener("pagehide", async () => {
  try {
    const db = await openCacheDb();
    const tx = db.transaction(SEGMENT_STORE, "readwrite");
    const store = tx.objectStore(SEGMENT_STORE);
    store.clear();
  } catch (e) {
    console.warn(e);
    setStatus("清理缓存失败。");
  }
});

(async function init() {
  try {
    topEl.classList.add("no-cover");
    coverEl.style.display = "none";
    coverContainer.style.display = "none";
    coverPlaceholderEl.style.display = "none";
    // updatePlayModeUI();
    state.db = await openCacheDb();
    await refreshCacheUsage();

    state.catalog = await loadJson("./catalog.json");
    state.manifestSec = await loadJson("./manifest.sec.json");
    renderTrackList();
    setStatus(`已加载 ${state.catalog.tracks.length} 首。请输入口令。`);
  } catch (err) {
    console.error(err);
    setStatus("初始化失败。");
  }
})();
