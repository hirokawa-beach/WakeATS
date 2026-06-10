const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

let bellBuffer = null;
let chimeBuffer = null;
let bellSource = null;
let chimeSource = null;

let alarmTime = null;
let mathAnswer = null;
let alarmFired = false;
let wakeLock = null;
let failCount = 0;

let micStream = null;
let animFrameId = null;

function setIndicator(id, mode) {
  const el = document.getElementById(id);
  if (el) el.className = "light" + (mode ? " on-" + mode : "");
}

function resetIndicators() {
  ["lightArmed", "lightAlarm", "lightConf", "lightClear"].forEach((id) =>
    setIndicator(id, null),
  );
}

function setStatus(text, cls = "") {
  const el = document.getElementById("status");
  if (el) {
    el.textContent = text;
    el.className = "status-value" + (cls ? " " + cls : "");
  }
}

function saveState() {
  localStorage.setItem("ats_alarm_time", alarmTime || "");
  localStorage.setItem("ats_alarm_fired", alarmFired ? "1" : "0");
}

function loadState() {
  alarmTime = localStorage.getItem("ats_alarm_time") || null;
  alarmFired = localStorage.getItem("ats_alarm_fired") === "1";

  if (alarmTime) {
    document.getElementById("alarmTime").value = alarmTime;

    const armBtn = document.getElementById("armBtn");
    armBtn.textContent = "解除";
    armBtn.classList.add("cancel-mode");

    setStatus("待機 " + alarmTime, "status-ok");
    setIndicator("lightArmed", "amber");
    document.getElementById("footerSet").textContent = "設定 " + alarmTime;

    if (alarmFired) triggerAlarm();
    else acquireWakeLock();
  }
}

setInterval(() => {
  const now = new Date();
  document.getElementById("clock").textContent =
    String(now.getHours()).padStart(2, "0") +
    ":" +
    String(now.getMinutes()).padStart(2, "0") +
    ":" +
    String(now.getSeconds()).padStart(2, "0");

  document.getElementById("dateDisp").textContent = now
    .toLocaleDateString("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
    .replace(/\//g, ".");

  if (!alarmFired && alarmTime) {
    const cur =
      String(now.getHours()).padStart(2, "0") +
      ":" +
      String(now.getMinutes()).padStart(2, "0");
    if (alarmTime === cur && now.getSeconds() < 5) {
      alarmFired = true;
      saveState();
      triggerAlarm();
    }
  }
}, 500);

document.getElementById("armBtn").onclick = async () => {
  if (audioCtx.state === "suspended") audioCtx.resume();

  const armBtn = document.getElementById("armBtn");

  if (alarmTime) {
    alarmTime = null;
    alarmFired = false;
    failCount = 0;

    armBtn.textContent = "設定";
    armBtn.classList.remove("cancel-mode");
    setStatus("待機中");
    resetIndicators();
    document.getElementById("footerSet").textContent = "未設定";

    localStorage.removeItem("ats_alarm_time");
    localStorage.removeItem("ats_alarm_fired");
    releaseWakeLock();
    return;
  }

  const val = document.getElementById("alarmTime").value;
  if (!val) return;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch (e) {
    alert("指差歓呼（ボイス確認）にはマイクの許可が必要です。");
    return;
  }

  alarmTime = val;
  alarmFired = false;

  armBtn.textContent = "解除";
  armBtn.classList.add("cancel-mode");
  setStatus("待機 " + alarmTime, "status-ok");
  setIndicator("lightArmed", "amber");
  document.getElementById("footerSet").textContent = "設定 " + alarmTime;

  saveState();
  acquireWakeLock();
};

function triggerAlarm() {
  document.getElementById("clock").classList.add("alert");
  setStatus("ATS 警報発報中", "status-alert");
  setIndicator("lightArmed", null);
  setIndicator("lightAlarm", "red");
  document.getElementById("alarmSection").classList.add("visible");

  if (audioCtx.state !== "running") audioCtx.resume();

  if (bellSource) {
    bellSource.stop();
    bellSource = null;
  }
  if (chimeSource) {
    chimeSource.stop();
    chimeSource = null;
  }

  if (bellBuffer) bellSource = playLoop(bellBuffer);
  if (chimeBuffer) chimeSource = playLoop(chimeBuffer);

  if ("vibrate" in navigator) navigator.vibrate([500, 200, 500, 200, 500]);
  saveState();

  startVoiceUnlock();
}

async function startVoiceUnlock() {
  const voiceLock = document.getElementById("voiceLock");
  voiceLock.classList.add("visible");

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const source = audioCtx.createMediaStreamSource(micStream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    function checkVolume() {
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      let avg = sum / dataArray.length;

      const meterFill = document.getElementById("voiceLevel");
      meterFill.style.width = Math.min(100, (avg / 40) * 100) + "%";

      // 閾値を【25】に設定（普通の話し声レベルで即反応します）
      if (avg > 25) {
        unlockSwipe();
        return;
      }
      animFrameId = requestAnimationFrame(checkVolume);
    }
    checkVolume();
  } catch (err) {
    console.error("マイクアクセス失敗、安全のため自動解除", err);
    unlockSwipe();
  }
}

function unlockSwipe() {
  cancelAnimationFrame(animFrameId);
  if (micStream) micStream.getTracks().forEach((t) => t.stop());

  document.getElementById("voiceLock").classList.remove("visible");
  setStatus("歓呼確認済 — スワイプせよ", "status-amber");
}

const swipeBtn = document.getElementById("swipeBtn");
const swipeThumb = document.getElementById("swipeThumb");
let swipeStartX = 0;
let swiping = false;
const swipeFullWidth = () => swipeBtn.offsetWidth - swipeThumb.offsetWidth - 8;

function onSwipeStart(e) {
  if (!alarmFired) return;
  if (document.getElementById("voiceLock").classList.contains("visible"))
    return;

  swiping = true;
  swipeStartX = e.touches ? e.touches[0].clientX : e.clientX;
}

function onSwipeMove(e) {
  if (!swiping) return;
  const x = e.touches ? e.touches[0].clientX : e.clientX;
  const dx = Math.max(0, Math.min(x - swipeStartX, swipeFullWidth()));
  swipeThumb.style.left = 4 + dx + "px";
  if (dx >= swipeFullWidth() - 2) {
    swiping = false;
    confirmAlarm();
  }
  e.preventDefault();
}

function onSwipeEnd() {
  swiping = false;
  swipeThumb.style.transition = "left 0.25s";
  swipeThumb.style.left = "4px";
  setTimeout(() => {
    swipeThumb.style.transition = "";
  }, 250);
}

swipeBtn.addEventListener("touchstart", onSwipeStart, { passive: true });
swipeBtn.addEventListener("touchmove", onSwipeMove, { passive: false });
swipeBtn.addEventListener("touchend", onSwipeEnd);
swipeBtn.addEventListener("mousedown", onSwipeStart);
window.addEventListener("mousemove", onSwipeMove);
window.addEventListener("mouseup", onSwipeEnd);

function confirmAlarm() {
  if (bellSource) {
    bellSource.stop();
    bellSource = null;
  }
  document.getElementById("alarmSection").classList.remove("visible");
  setIndicator("lightAlarm", "red");
  setIndicator("lightConf", "amber");
  setStatus("確認済 — 解除コードを入力");

  const mode = Math.floor(Math.random() * 4);
  const questionEl = document.getElementById("question");
  let a, b, c;

  switch (mode) {
    case 0:
      a = Math.floor(Math.random() * 90) + 10;
      b = Math.floor(Math.random() * 90) + 10;
      mathAnswer = a + b;
      questionEl.textContent = `${a} + ${b} = ?`;
      break;
    case 1:
      a = Math.floor(Math.random() * 90) + 10;
      b = Math.floor(Math.random() * 40) + 10;
      mathAnswer = a - b;
      questionEl.textContent = `${a} - ${b} = ?`;
      break;
    case 2:
      a = Math.floor(Math.random() * 9) + 2;
      b = Math.floor(Math.random() * 9) + 2;
      mathAnswer = a * b;
      questionEl.textContent = `${a} × ${b} = ?`;
      break;
    case 3:
      a = Math.floor(Math.random() * 20) + 10;
      b = Math.floor(Math.random() * 20) + 10;
      c = Math.floor(Math.random() * 20) + 10;
      mathAnswer = a + b - c;
      questionEl.textContent = `(${a}+${b})-${c} = ?`;
      break;
  }
  document.getElementById("mathAnswer").value = "";
  document.getElementById("mathSection").classList.add("visible");
}

document.getElementById("solveBtn").onclick = solve;
document.getElementById("mathAnswer").addEventListener("keydown", (e) => {
  if (e.key === "Enter") solve();
});

function solve() {
  const inp = document.getElementById("mathAnswer");
  const val = Number(inp.value);

  if (val === mathAnswer) {
    if (chimeSource) {
      chimeSource.stop();
      chimeSource = null;
    }
    document.getElementById("mathSection").classList.remove("visible");
    document.getElementById("clock").classList.remove("alert");

    setIndicator("lightConf", null);
    setIndicator("lightClear", "green");
    setStatus("ATS 解除", "status-ok");

    document.getElementById("clearSection").classList.add("visible");
    document.getElementById("footerSet").textContent = "解除済";

    if ("vibrate" in navigator) navigator.vibrate(100);

    releaseWakeLock();
    localStorage.removeItem("ats_alarm_time");
    localStorage.removeItem("ats_alarm_fired");

    failCount = 0;
    alarmFired = false;
  } else {
    failCount++;
    setStatus(`解除失敗 ${failCount}回`, "status-alert");
    inp.classList.add("shake");
    setTimeout(() => inp.classList.remove("shake"), 300);

    if (failCount >= 5) {
      document.body.style.background = "#300";
      setStatus("ATS非常警報", "status-alert");
      if ("vibrate" in navigator)
        navigator.vibrate([300, 100, 300, 100, 300, 100, 1000]);
    }
  }
}

function playLoop(buffer) {
  if (!buffer) return null;
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.connect(audioCtx.destination);
  source.start();
  return source;
}

async function loadSound(url) {
  try {
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    return await audioCtx.decodeAudioData(arrayBuffer);
  } catch (err) {
    console.error("Audio load failed:", url);
    return null;
  }
}

async function acquireWakeLock() {
  if ("wakeLock" in navigator && !wakeLock) {
    try {
      wakeLock = await navigator.wakeLock.request("screen");
    } catch {}
  }
}

async function releaseWakeLock() {
  if (wakeLock) {
    try {
      await wakeLock.release();
    } catch {}
    wakeLock = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && alarmTime) acquireWakeLock();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js");
}

// アプリ起動時に保存された音源を読み込む、またはファイル選択時に保存する処理
async function initAudio() {
  // まずサーバー上にデフォルトで用意されている場合はそれを読み込む(なければnull)
  bellBuffer = await loadSound("atsbell.wav").catch(() => null);
  chimeBuffer = await loadSound("atschime.wav").catch(() => null);

  // ローカルストレージにユーザーが過去に設定したカスタム音源があれば上書き
  const savedBell = localStorage.getItem("custom_ats_bell");
  const savedChime = localStorage.getItem("custom_ats_chime");

  if (savedBell) bellBuffer = await decodeBase64Audio(savedBell);
  if (savedChime) chimeBuffer = await decodeBase64Audio(savedChime);

  // ファイル選択ボタンのイベント登録
  setupFileListener("bellFile", "custom_ats_bell", (buf) => { bellBuffer = buf; });
  setupFileListener("chimeFile", "custom_ats_chime", (buf) => { chimeBuffer = buf; });
}

// ファイルが選択されたらブラウザに保存する共通関数
function setupFileListener(inputId, storageKey, callback) {
  document.getElementById(inputId).onchange = function(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async function(event) {
      const arrayBuffer = event.target.result;
      
      // 再生用のデコード
      const buffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
      callback(buffer);

      // 次回起動時用に保存できるようにBase64文字列に変換してlocalStorageへ
      const base64String = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
      try {
        localStorage.setItem(storageKey, base64String);
        alert("音源を記憶しました！");
      } catch (err) {
        alert("ファイルサイズが大きすぎてブラウザに保存できませんでした。1MB以下の軽量なWAV/MP3を推奨します。");
      }
    };
    reader.readAsArrayBuffer(file);
  };
}

// 保存されたBase64から音声を復元する関数
async function decodeBase64Audio(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return await audioCtx.decodeAudioData(bytes.buffer);
}

initAudio();
loadState();
