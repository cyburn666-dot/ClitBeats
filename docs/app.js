const statusEl = document.getElementById("status");
const trackListEl = document.getElementById("trackList");
const passwordEl = document.getElementById("password");
const unlockBtn = document.getElementById("unlockBtn");
const player = document.getElementById("player");
const nowPlayingEl = document.getElementById("nowPlaying");
const coverEl = document.getElementById("cover");
const coverPlaceholderEl = document.getElementById("coverPlaceholder");
const lyricsContentEl = document.getElementById("lyricsContent");

const state = {
  catalog: null,
  manifestSec: null,
  payload: null,
  unlocked: false,
  currentIndex: -1,
  cache: new Map(), // stem -> { audioUrl, coverUrl, lrcText, txtText }
  currentLrc: [],
  currentLrcIndex: -1,
};

function setStatus(text) {
  statusEl.textContent = text;
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

async function loadJson(path) {
  const resp = await fetch(path, { cache: "no-store" });
  if (!resp.ok) throw new Error(`无法读取 ${path}`);
  return await resp.json();
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
    {
      name: "AES-GCM",
      iv: b64ToBytes(cipher.nonce),
    },
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

async function decryptAssetToBuffer(asset) {
  const resp = await fetch(asset.file, { cache: "no-store" });
  if (!resp.ok) throw new Error(`无法读取文件：${asset.file}`);
  const cipherBuffer = await resp.arrayBuffer();

  const dekKey = await importAesKeyFromRaw(b64ToBytes(asset.dek));

  return await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: b64ToBytes(asset.nonce),
    },
    dekKey,
    cipherBuffer
  );
}

function revokeCacheEntry(stem) {
  const cached = state.cache.get(stem);
  if (!cached) return;
  if (cached.audioUrl) URL.revokeObjectURL(cached.audioUrl);
  if (cached.coverUrl) URL.revokeObjectURL(cached.coverUrl);
  state.cache.delete(stem);
}

function pruneCache(keepStems) {
  for (const stem of state.cache.keys()) {
    if (!keepStems.has(stem)) {
      revokeCacheEntry(stem);
    }
  }
}

async function getTrackBundle(stem) {
  const cached = state.cache.get(stem);
  if (cached) return cached;

  const track = state.payload.tracks[stem];
  if (!track) throw new Error(`未找到曲目：${stem}`);

  const result = {
    audioUrl: null,
    coverUrl: null,
    lrcText: null,
    txtText: null,
  };

  if (track.audio) {
    const audioBuffer = await decryptAssetToBuffer(track.audio);
    const audioBlob = new Blob([audioBuffer], { type: track.audio.mime || "audio/mpeg" });
    result.audioUrl = URL.createObjectURL(audioBlob);
  }

  if (track.cover) {
    const coverBuffer = await decryptAssetToBuffer(track.cover);
    const coverBlob = new Blob([coverBuffer], { type: track.cover.mime || "image/jpeg" });
    result.coverUrl = URL.createObjectURL(coverBlob);
  }

  if (track.lrc) {
    const lrcBuffer = await decryptAssetToBuffer(track.lrc);
    result.lrcText = new TextDecoder("utf-8").decode(lrcBuffer);
  }

  if (track.txt) {
    const txtBuffer = await decryptAssetToBuffer(track.txt);
    result.txtText = new TextDecoder("utf-8").decode(txtBuffer);
  }

  state.cache.set(stem, result);
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
    if (currentTime >= state.currentLrc[i].time) {
      active = i;
    } else {
      break;
    }
  }

  if (active === state.currentLrcIndex) return;
  state.currentLrcIndex = active;

  const nodes = lyricsContentEl.querySelectorAll(".lrc-line");
  nodes.forEach((node, i) => {
    node.classList.toggle("active", i === active);
  });

  if (active >= 0 && nodes[active]) {
    nodes[active].scrollIntoView({ block: "center", behavior: "smooth" });
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

async function prefetchNext(index) {
  const nextIndex = index + 1;
  if (nextIndex >= state.catalog.tracks.length) return;

  const nextTrack = state.catalog.tracks[nextIndex];
  if (state.cache.has(nextTrack.stem)) return;

  try {
    await getTrackBundle(nextTrack.stem);
    const keep = new Set([state.catalog.tracks[index].stem, nextTrack.stem]);
    pruneCache(keep);
  } catch (err) {
    console.warn("预缓存下一首失败：", err);
  }
}

async function playTrackByIndex(index) {
  if (!state.unlocked || !state.payload) {
    setStatus("请先输入正确口令。");
    return;
  }

  const trackMeta = state.catalog.tracks[index];
  if (!trackMeta) return;

  try {
    setStatus(`正在解密：${trackMeta.title}`);
    const bundle = await getTrackBundle(trackMeta.stem);

    state.currentIndex = index;
    player.src = bundle.audioUrl;
    applyCover(bundle.coverUrl);
    applyLyrics(bundle);

    await player.play();

    nowPlayingEl.textContent = `正在播放：${trackMeta.title}`;
    markActiveTrack(index);
    setStatus(`播放中：${trackMeta.title}`);

    const keep = new Set([trackMeta.stem]);
    const nextTrack = state.catalog.tracks[index + 1];
    if (nextTrack) keep.add(nextTrack.stem);
    pruneCache(keep);

    void prefetchNext(index);
  } catch (err) {
    console.error(err);
    setStatus(`解密失败：${trackMeta.title}`);
  }
}

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
    setStatus("解锁成功。");
  } catch (err) {
    console.error(err);
    state.payload = null;
    state.unlocked = false;
    setStatus("口令错误或索引已损坏。");
  }
}

player.addEventListener("ended", async () => {
  const nextIndex = state.currentIndex + 1;
  if (nextIndex < state.catalog.tracks.length) {
    await playTrackByIndex(nextIndex);
  } else {
    setStatus("已播放到最后一首。");
  }
});

player.addEventListener("timeupdate", () => {
  updateLyricsByTime(player.currentTime);
});

unlockBtn.addEventListener("click", unlock);
passwordEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") unlock();
});

(async function init() {
  try {
    state.catalog = await loadJson("./catalog.json");
    state.manifestSec = await loadJson("./manifest.sec.json");
    renderTrackList();
    setStatus(`已加载 ${state.catalog.tracks.length} 首。请输入口令。`);
  } catch (err) {
    console.error(err);
    setStatus("加载歌单失败。");
  }
})();