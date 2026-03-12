const statusEl = document.getElementById("status");
const trackListEl = document.getElementById("trackList");
const passwordEl = document.getElementById("password");
const unlockBtn = document.getElementById("unlockBtn");
const player = document.getElementById("player");
const nowPlayingEl = document.getElementById("nowPlaying");

const state = {
  manifest: null,
  masterKey: null,
  unlocked: false,
  currentIndex: -1,
  cache: new Map(), // trackId -> { blobUrl, title }
};

function setStatus(text) {
  statusEl.textContent = text;
}

function hexToUint8(hex) {
  if (!hex || hex.length % 2 !== 0) {
    throw new Error("十六进制字段格式错误");
  }
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return arr;
}

async function loadManifest() {
  const resp = await fetch("./manifest.json", { cache: "no-store" });
  if (!resp.ok) {
    throw new Error("无法读取 manifest.json");
  }
  return await resp.json();
}

async function deriveMasterKey(password, kdfInfo) {
  if (kdfInfo.name !== "PBKDF2") {
    throw new Error("不支持的 KDF");
  }

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
      salt: hexToUint8(kdfInfo.salt),
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

async function unwrapDEK(track) {
  const wrappedDEK = hexToUint8(track.wrapped_dek);
  const wrapNonce = hexToUint8(track.wrap_nonce);

  const rawDEK = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: wrapNonce,
    },
    state.masterKey,
    wrappedDEK
  );

  return await crypto.subtle.importKey(
    "raw",
    rawDEK,
    {
      name: "AES-GCM",
    },
    false,
    ["decrypt"]
  );
}

async function decryptTrack(track) {
  const resp = await fetch(track.file, { cache: "no-store" });
  if (!resp.ok) {
    throw new Error(`无法读取文件：${track.file}`);
  }

  const cipherBuffer = await resp.arrayBuffer();
  const dek = await unwrapDEK(track);

  const plainBuffer = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: hexToUint8(track.data_nonce),
    },
    dek,
    cipherBuffer
  );

  return new Blob([plainBuffer], {
    type: track.mime || "application/octet-stream",
  });
}

function formatSize(size) {
  if (size >= 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + " MB";
  if (size >= 1024) return (size / 1024).toFixed(1) + " KB";
  return size + " B";
}

function renderTrackList() {
  trackListEl.innerHTML = "";

  state.manifest.tracks.forEach((track, index) => {
    const li = document.createElement("li");
    li.className = "track";
    li.dataset.index = String(index);
    li.dataset.trackId = track.id;

    const num = document.createElement("div");
    num.className = "small";
    num.textContent = String(index + 1).padStart(2, "0");

    const info = document.createElement("div");
    info.innerHTML = `
      <div class="track-title">${escapeHtml(track.title)}</div>
      <div class="small">${formatSize(track.size || 0)}</div>
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

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function markActiveTrack(index) {
  [...trackListEl.querySelectorAll(".track")].forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.index) === index);
  });
}

function revokeCacheEntry(trackId) {
  const cached = state.cache.get(trackId);
  if (!cached) return;
  if (cached.blobUrl) {
    URL.revokeObjectURL(cached.blobUrl);
  }
  state.cache.delete(trackId);
}

function pruneCache(keepIds) {
  for (const trackId of state.cache.keys()) {
    if (!keepIds.has(trackId)) {
      revokeCacheEntry(trackId);
    }
  }
}

async function getTrackBlobUrl(track) {
  const cached = state.cache.get(track.id);
  if (cached) return cached.blobUrl;

  const blob = await decryptTrack(track);
  const blobUrl = URL.createObjectURL(blob);

  state.cache.set(track.id, {
    blobUrl,
    title: track.title,
  });

  return blobUrl;
}

async function prefetchNext(index) {
  const nextIndex = index + 1;
  if (nextIndex >= state.manifest.tracks.length) return;

  const track = state.manifest.tracks[nextIndex];
  if (state.cache.has(track.id)) return;

  try {
    await getTrackBlobUrl(track);
    const keep = new Set([state.manifest.tracks[index].id, track.id]);
    pruneCache(keep);
  } catch (err) {
    console.warn("预缓存下一首失败：", err);
  }
}

async function playTrackByIndex(index) {
  if (!state.unlocked || !state.masterKey) {
    setStatus("请先输入正确口令。");
    return;
  }

  const track = state.manifest.tracks[index];
  if (!track) return;

  try {
    setStatus(`正在解密：${track.title}`);
    const blobUrl = await getTrackBlobUrl(track);

    state.currentIndex = index;
    player.src = blobUrl;
    await player.play();

    nowPlayingEl.textContent = `正在播放：${track.title}`;
    markActiveTrack(index);
    setStatus(`播放中：${track.title}`);

    const keep = new Set([track.id]);
    const nextTrack = state.manifest.tracks[index + 1];
    if (nextTrack) keep.add(nextTrack.id);
    pruneCache(keep);

    void prefetchNext(index);
  } catch (err) {
    console.error(err);
    setStatus(`解密失败：${track.title}`);
  }
}

async function unlock() {
  const password = passwordEl.value;
  if (!password) {
    setStatus("请输入口令。");
    return;
  }

  try {
    setStatus("正在验证口令…");
    const key = await deriveMasterKey(password, state.manifest.kdf);

    // 用第一首歌做试解密校验
    if (state.manifest.tracks.length > 0) {
      const first = state.manifest.tracks[0];
      const wrappedDEK = hexToUint8(first.wrapped_dek);

      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: hexToUint8(first.wrap_nonce),
        },
        key,
        wrappedDEK
      );
    }

    state.masterKey = key;
    state.unlocked = true;
    setStatus("口令验证成功。");
  } catch (err) {
    console.error(err);
    state.masterKey = null;
    state.unlocked = false;
    setStatus("口令错误。");
  }
}

player.addEventListener("ended", async () => {
  const nextIndex = state.currentIndex + 1;
  if (nextIndex < state.manifest.tracks.length) {
    await playTrackByIndex(nextIndex);
  } else {
    setStatus("已播放到最后一首。");
  }
});

unlockBtn.addEventListener("click", unlock);
passwordEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") unlock();
});

(async function init() {
  try {
    state.manifest = await loadManifest();
    renderTrackList();
    setStatus(`已加载 ${state.manifest.tracks.length} 首。请输入口令。`);
  } catch (err) {
    console.error(err);
    setStatus("加载歌单失败。");
  }
})();