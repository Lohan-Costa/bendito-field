// ===================== main.js =====================
// Orquestra: upload → análise (detecção de suspeitos de split-field) →
// ocorrências → filmstrip de contexto → painel de fields.

import { loadEngine, isMultithread, extractWindows, clearInput, terminateEngine } from "./ffmpeg.js";
import { analyze } from "./analyzer.js";
import { Filmstrip } from "./filmstrip.js";
import { Occurrences } from "./occurrences.js";
import { renderFields } from "./fields.js";

const WINDOW_RADIUS = 4; // -4 … SUSPEITO … +4

// ---------- Referências de DOM ----------
const el = {
  engineStatus:      document.getElementById("engineStatus"),
  engineStatusLabel: document.getElementById("engineStatusLabel"),

  dropzone:  document.getElementById("dropzone"),
  fileInput: document.getElementById("fileInput"),

  fileName: document.getElementById("fileName"),
  fileMeta: document.getElementById("fileMeta"),
  btnReset: document.getElementById("btnReset"),

  loadingOverlay: document.getElementById("loadingOverlay"),
  loadingText:    document.getElementById("loadingText"),
  loadingBar:     document.getElementById("loadingBar"),

  occList:        document.getElementById("occList"),
  occCount:       document.getElementById("occCount"),

  // Painel Frame (estados: dropzone / loading / canvas / approved)
  playerLoading:  document.getElementById("playerLoading"),
  proxyText:      document.getElementById("proxyText"),
  proxyBar:       document.getElementById("proxyBar"),
  approvedMsg:    document.getElementById("approvedMsg"),
  approvedTitle:  document.getElementById("approvedTitle"),
  approvedSub:    document.getElementById("approvedSub"),

  filmstrip:      document.getElementById("filmstrip"),
  frameInfo:      document.getElementById("frameInfo"),
  canvasWoven:    document.getElementById("canvasWoven"),
  canvasUpper:    document.getElementById("canvasUpper"),
  canvasLower:    document.getElementById("canvasLower"),
};

// ---------- Estado ----------
const state = {
  engine: "idle", // idle | loading | ready | error
  file: null,
  fps: 29.97,
  frameCount: 0,
  suspects: [],
  windowUrls: new Map(), // frameIndex → object URL (full-res) das janelas
};

let filmstrip = null;
let occurrences = null;

const ACCEPTED_EXT = [".mxf"];

// ---------- Motor (ffmpeg.wasm) ----------
function setEngineState(s, label) {
  state.engine = s;
  el.engineStatus.dataset.state = s;
  el.engineStatusLabel.textContent = label;
}

async function startEngine() {
  if (state.engine === "loading" || state.engine === "ready") return;
  setEngineState("loading", "Motor: carregando…");
  try {
    // Watchdog: se o load não resolver em 45s, falha com mensagem em vez de travar.
    const watchdog = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Tempo esgotado ao carregar o motor (45s).")), 45000)
    );
    await Promise.race([
      loadEngine((stage, ratio) => {
        el.loadingText.textContent = stage;
        el.loadingBar.style.width = `${Math.round(ratio * 100)}%`;
      }),
      watchdog,
    ]);
    const mode = isMultithread() ? "multithread" : "single-thread";
    setEngineState("ready", `Motor: pronto (${mode})`);
  } catch (err) {
    console.error("Falha ao carregar o motor:", err);
    setEngineState("error", "Motor: falha ao carregar");
    if (state.file) {
      const detail = (err && err.message) || String(err) || "erro desconhecido";
      alert("Não foi possível carregar o motor de análise.\n\n" + detail +
            "\n\nVeja o console (F12) para detalhes.");
    }
  } finally {
    hideOverlay();
  }
}

// ---------- Overlay ----------
function showOverlay(text = "Carregando motor de análise…") {
  el.loadingText.textContent = text;
  el.loadingOverlay.hidden = false;
}
function hideOverlay() {
  el.loadingOverlay.hidden = true;
}

// ---------- Estado do painel Frame (dropzone / loading / canvas) ----------
function setFrameMode(mode) {
  // mode: "drop" | "loading" | "frame" | "approved"
  el.dropzone.hidden = mode !== "drop";
  el.playerLoading.hidden = mode !== "loading";
  el.approvedMsg.hidden = mode !== "approved";
  el.canvasWoven.style.visibility = mode === "frame" ? "visible" : "hidden";
}

// Mensagem de sucesso: "clean" = nenhum suspeito; "ignored" = o usuário
// descartou todas as ocorrências (eram falsos positivos).
function showApproved(kind) {
  el.approvedTitle.textContent = kind === "ignored" ? "Tudo revisado" : "Vídeo aprovado";
  el.approvedSub.textContent = kind === "ignored"
    ? "Os falsos positivos foram descartados — nada a revisar."
    : "Nenhum split-field suspeito encontrado.";
  clearFieldPanels();
  if (filmstrip) filmstrip.clear();
  setFrameMode("approved");
}

// A lista de ocorrências chama isto quando a contagem muda (inclui descartes).
function onOccChange(count, dismissedAll) {
  el.occCount.textContent = count === 0
    ? (dismissedAll ? "0 — revisado" : "0 suspeitas")
    : (count === 1 ? "1 suspeita" : `${count} suspeitas`);
  if (count === 0) showApproved(dismissedAll ? "ignored" : "clean");
}

// ---------- Manipulação de arquivo ----------
function hasAcceptedExt(name) {
  const lower = name.toLowerCase();
  return ACCEPTED_EXT.some((ext) => lower.endsWith(ext));
}

function formatBytes(bytes) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

async function handleFile(file) {
  if (!file) return;
  if (!hasAcceptedExt(file.name)) {
    alert("Formato não suportado. Use um arquivo MXF (XDCAM HD422).");
    return;
  }

  state.file = file;
  el.fileName.textContent = file.name;
  el.fileMeta.textContent = formatBytes(file.size);
  el.btnReset.hidden = false;
  setFrameMode("loading");
  el.proxyText.textContent = "Aguardando motor…";

  // Garante que o motor esteja pronto antes de extrair.
  if (state.engine !== "ready") {
    showOverlay(
      state.engine === "loading"
        ? "Aguardando o motor terminar de carregar…"
        : "Carregando motor de análise…"
    );
    await startEngine();
  }
  if (state.engine !== "ready") return; // falhou ao carregar

  await runAnalysis(file);
}

// ---------- Análise ----------
async function runAnalysis(file) {
  releaseWindows();
  setFrameMode("loading");
  el.proxyText.textContent = "Decodificando e analisando campos…";
  el.proxyBar.style.width = "0%";

  try {
    const res = await analyze(file, {
      onProgress: (stage, ratio) => {
        const pct = Math.round(ratio * 100);
        el.proxyText.textContent = `${stage} ${pct}%`;
        el.proxyBar.style.width = `${pct}%`;
        console.log(`[análise] ${stage} ${pct}%`);
      },
    });

    state.fps = res.fps;
    state.frameCount = res.frameCount;
    state.suspects = res.suspects;

    el.fileMeta.textContent =
      `${formatBytes(file.size)} · ${res.width}×${res.height} · ` +
      `${res.fps.toFixed(2)} fps · ${res.frameCount} frames`;

    // As OCORRÊNCIAS (timecodes) aparecem JÁ — info mais importante p/ o
    // usuário — antes de extrair as imagens. onOccChange cuida da contagem e,
    // se não houver suspeitos, mostra a mensagem de "vídeo aprovado".
    occurrences.setSuspects(res.suspects);
    if (!res.suspects.length) return; // vídeo limpo: nada a extrair

    // Motor NOVO para a passada 2: remove qualquer instabilidade de reuso do
    // core ST entre execs (a passada 1 já terminou de usar o motor).
    terminateEngine();

    // Extrai, em resolução cheia, só as janelas ao redor de cada suspeito.
    el.proxyText.textContent = "Extraindo imagens dos suspeitos…";
    el.proxyBar.style.width = "0%";
    const indices = unionWindowIndices(res.suspects, res.frameCount);
    state.windowUrls = await extractWindows(file, indices, {
      onProgress: (r) => { el.proxyBar.style.width = `${Math.round(r * 100)}%`; },
    });

    setFrameMode("frame"); // mostra o canvas do frame
    occurrences.reselect(); // renderiza campos/filmstrip da ocorrência atual
  } catch (err) {
    console.error("Falha na análise:", err);
    el.proxyText.textContent = "Falha na análise — veja o console (F12).";
    el.proxyBar.style.width = "0%";
  }
}

// Conjunto (ordenado, sem repetição) de todos os frames das janelas dos suspeitos.
function unionWindowIndices(suspects, frameCount) {
  const set = new Set();
  for (const s of suspects) {
    for (let f = s.frame - WINDOW_RADIUS; f <= s.frame + WINDOW_RADIUS; f++) {
      if (f >= 0 && f < frameCount) set.add(f);
    }
  }
  return [...set].sort((a, b) => a - b);
}

// ---------- Seleção de ocorrência → filmstrip ----------
function onOccurrenceSelected(suspect) {
  const win = [];
  for (let f = suspect.frame - WINDOW_RADIUS; f <= suspect.frame + WINDOW_RADIUS; f++) {
    if (f < 0 || f >= state.frameCount) continue;
    const url = state.windowUrls.get(f);
    if (url) win.push({ frame: f, url, suspect: f === suspect.frame });
  }
  filmstrip.setWindow(win, suspect.frame); // dispara onFrameSelected(suspect.frame)
}

// ---------- Seleção de frame → painéis de campos ----------
async function onFrameSelected(frame) {
  const s = state.suspects.find((x) => x.frame === frame);
  const tag = s ? `  ·  ⚠ suspeito (${s.confidence}%)` : "";
  el.frameInfo.textContent = `#${frame + 1}  ·  ${timecode(frame, state.fps)}${tag}`;

  const url = state.windowUrls.get(frame);
  if (!url) return;
  try {
    await renderFields(url, {
      woven: el.canvasWoven,
      upper: el.canvasUpper,
      lower: el.canvasLower,
    });
  } catch (err) {
    console.error("Falha ao renderizar fields:", err);
  }
}

function clearFieldPanels() {
  for (const c of [el.canvasWoven, el.canvasUpper, el.canvasLower]) {
    c.getContext("2d").clearRect(0, 0, c.width, c.height);
  }
  el.frameInfo.textContent = "";
}

function releaseWindows() {
  for (const url of state.windowUrls.values()) URL.revokeObjectURL(url);
  state.windowUrls = new Map();
}

// Timecode SMPTE simples (HH:MM:SS:FF) a partir do índice do frame.
function timecode(index, fps) {
  const r = Math.max(1, Math.round(fps));
  const ff = index % r;
  const totalSec = Math.floor(index / r);
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
}

function resetFile() {
  state.file = null;
  el.fileInput.value = "";
  releaseWindows();
  state.suspects = [];
  state.frameCount = 0;
  if (filmstrip) filmstrip.clear();
  if (occurrences) occurrences.clear();
  clearInput();
  clearFieldPanels();
  el.fileName.textContent = "";
  el.fileMeta.textContent = "";
  el.occCount.textContent = "";
  el.btnReset.hidden = true;
  setFrameMode("drop"); // volta a mostrar a dropzone no painel Frame
}

// ---------- Eventos de upload ----------
function wireUpload() {
  // dropzone é um <button> → Enter/Espaço já disparam o clique nativamente.
  el.dropzone.addEventListener("click", () => el.fileInput.click());
  // input está dentro do button: impede que o clique dele borbulhe e re-abra o diálogo.
  el.fileInput.addEventListener("click", (e) => e.stopPropagation());

  el.fileInput.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    handleFile(file);
  });

  // Drag & drop
  ["dragenter", "dragover"].forEach((evt) =>
    el.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      el.dropzone.classList.add("is-dragover");
    })
  );
  ["dragleave", "dragend"].forEach((evt) =>
    el.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      el.dropzone.classList.remove("is-dragover");
    })
  );
  el.dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    el.dropzone.classList.remove("is-dragover");
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    handleFile(file);
  });

  // Evita que soltar fora da dropzone abra o arquivo no navegador.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  el.btnReset.addEventListener("click", resetFile);
}

// ---------- Navegação por teclado ----------
function wireKeyboard() {
  window.addEventListener("keydown", (e) => {
    if (!state.file || !state.suspects.length) return;
    if (e.target.tagName === "INPUT") return;
    if (e.key === "ArrowRight") { e.preventDefault(); filmstrip.next(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); filmstrip.prev(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); occurrences.select(occurrences.selected + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); occurrences.select(occurrences.selected - 1); }
  });
}

// ---------- Init ----------
function init() {
  filmstrip = new Filmstrip(el.filmstrip, onFrameSelected);
  occurrences = new Occurrences(
    el.occList,
    onOccurrenceSelected,
    (frame) => timecode(frame, state.fps),
    onOccChange
  );

  setFrameMode("drop");
  wireUpload();
  wireKeyboard();
  // Pré-carrega o motor em segundo plano para reduzir a espera no primeiro arquivo.
  startEngine();
}

init();
