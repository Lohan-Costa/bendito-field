// ===================== ffmpeg.js =====================
// Carrega e mantém uma única instância do ffmpeg.wasm.
//
// Estratégia de confiabilidade:
//  - Build ESM do ffmpeg + core ESM, AUTO-HOSPEDADOS em /vendor (mesmo domínio).
//    Isso casa o worker (module worker) com o core (export default) e elimina os
//    problemas de COEP/CORP e de descasamento UMD×module que travavam o load().
//  - Core SINGLE-THREAD → sem SharedArrayBuffer nem service worker. Multithread
//    fica como otimização opt-in para uma fase futura.

import { FFmpeg } from "../vendor/ffmpeg-esm/index.js";

// Dois cores auto-hospedados:
//  - MT (multithread): rápido e estável p/ decodificar 1080p; exige
//    crossOriginIsolated (ativado pelo coi-serviceworker) + SharedArrayBuffer.
//  - ST (single-thread): fallback universal. (O core ST 0.12.x tem um bug de
//    "index out of bounds" decodificando 1080p, então MT é o caminho preferido.)
const CORE = {
  mt: {
    js: "./vendor/core-mt-esm/ffmpeg-core.js",
    wasm: "./vendor/core-mt-esm/ffmpeg-core.wasm",
    worker: "./vendor/core-mt-esm/ffmpeg-core.worker.js",
  },
  st: {
    js: "./vendor/core-esm/ffmpeg-core.js",
    wasm: "./vendor/core-esm/ffmpeg-core.wasm",
  },
};

// Caminho relativo → URL absoluta (evita ambiguidade dentro do worker).
const abs = (p) => new URL(p, window.location.href).href;

let ffmpeg = null;
let loadPromise = null;
let usingMT = false;

/**
 * Carrega o motor (idempotente).
 * @param {(stage: string, ratio: number) => void} [onProgress]
 * @returns {Promise<FFmpeg>}
 */
export function loadEngine(onProgress = () => {}) {
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    ffmpeg = new FFmpeg();

    // Logs do core ajudam a diagnosticar (visíveis no console).
    ffmpeg.on("log", ({ message }) => console.debug("[ffmpeg]", message));

    // SINGLE-THREAD por decisão de arquitetura (Chrome-first):
    //  - Multithread (pthreads) não engata no Chrome com MXF grande e tem memória
    //    fixa (SharedArrayBuffer); single-thread tem memória que cresce.
    //  - Sem SharedArrayBuffer → sem service worker, sem cross-origin isolation,
    //    mesmo comportamento em Chrome/Firefox/GitHub Pages.
    usingMT = false;
    onProgress("Inicializando motor…", 0.2);

    await ffmpeg.load({
      coreURL: abs(CORE.st.js),
      wasmURL: abs(CORE.st.wasm),
    });

    onProgress("Pronto", 1);
    return ffmpeg;
  })();

  return loadPromise;
}

/** Instância já carregada (ou null). */
export function getFFmpeg() {
  return ffmpeg;
}

/** true se o core multithread está em uso. */
export function isMultithread() {
  return usingMT;
}

// ---------- Extração de frames ----------

/** Lê um File do navegador como Uint8Array (para o FS do ffmpeg). */
async function fileToUint8(file) {
  return new Uint8Array(await file.arrayBuffer());
}

/** Extrai metadados (resolução e fps) das mensagens de log do ffmpeg. */
function parseMeta(message, meta) {
  // Só lê da linha de stream "Video:" — as linhas de progresso ("frame=N fps=…")
  // contêm "N fps" e contaminavam o fps com a contagem de frames.
  // Só a PRIMEIRA linha "Video:" (o stream de ENTRADA) vale; a de saída já vem
  // escalada (ex.: 320x1080) e sobrescreveria a resolução de origem.
  if (!/Video:/.test(message)) return;
  if (meta.width == null) {
    const size = message.match(/(\d{2,5})x(\d{2,5})/);
    if (size) {
      meta.width = +size[1];
      meta.height = +size[2];
    }
  }
  if (meta.fps == null) {
    const fps = message.match(/([\d.]+)\s*fps/);
    if (fps) meta.fps = parseFloat(fps[1]);
  }
}

let inputWritten = null; // nome do arquivo de input já gravado no FS

/** Grava o arquivo de input no FS do ffmpeg uma única vez (reuso entre passes). */
async function ensureInput(file) {
  const ff = await loadEngine();
  if (inputWritten) return inputWritten;
  const ext = (file.name.split(".").pop() || "dat").toLowerCase();
  const input = `input.${ext}`;
  await ff.writeFile(input, await fileToUint8(file));
  inputWritten = input;
  return input;
}

/** Remove o input do FS (ao trocar de arquivo). */
export async function clearInput() {
  if (!inputWritten || !ffmpeg) return;
  try { await ffmpeg.deleteFile(inputWritten); } catch {}
  inputWritten = null;
}

/**
 * Encerra o worker do ffmpeg e suas threads (multithread). Importante chamar
 * quando não há mais trabalho de ffmpeg pendente: do contrário as threads
 * podem continuar consumindo CPU e atrapalhar a decodificação do vídeo no
 * player. O próximo uso recarrega o motor automaticamente.
 */
export function terminateEngine() {
  if (ffmpeg) {
    try { ffmpeg.terminate(); } catch {}
  }
  ffmpeg = null;
  loadPromise = null;
  inputWritten = null;
  usingMT = false;
}

/** Lê e remove os arquivos `prefix*.<ext>`, devolvendo object URLs em ordem. */
async function readImageSequence(prefix, ext = "png", mime = "image/png") {
  const ff = ffmpeg;
  const dir = await ff.listDir("/");
  const re = new RegExp(`^${prefix}\\d+\\.${ext}$`);
  const names = dir.filter((e) => !e.isDir && re.test(e.name)).map((e) => e.name).sort();
  const urls = [];
  for (const name of names) {
    const data = await ff.readFile(name);
    urls.push(URL.createObjectURL(new Blob([data], { type: mime })));
    await ff.deleteFile(name);
  }
  return urls;
}

/**
 * PASSE 1 — decodifica TODOS os frames em cinza, largura reduzida e ALTURA
 * NATIVA preservada (essencial para os fields), num ÚNICO arquivo rawvideo.
 *
 * Por que rawvideo e não JPEG: o encoder mjpeg do core ST TRAVA de forma
 * intermitente no Chrome ao codificar a imagem 320×altura-cheia (diagnosticado
 * em test-decode.html: -f null e rawvideo completam; mjpeg enforca). Saída crua
 * = sem encoder de imagem; o analyzer lê os bytes direto (gray = 1 byte/pixel),
 * o que ainda elimina os 354 createImageBitmap/getImageData do JS.
 *
 * @returns {Promise<{ data: Uint8Array, frameW: number, frameH: number,
 *   frameCount: number, fps: number, srcWidth: number, srcHeight: number }>}
 *   Os frames estão concatenados em `data`: frameW*frameH bytes cada, em ordem.
 *   srcWidth/srcHeight referem-se ao vídeo de ORIGEM (lidos do log).
 */
export async function extractGrayRaw(file, { width = 320, onProgress } = {}) {
  const ff = await loadEngine();
  const input = await ensureInput(file);

  const meta = { fps: null, width: null, height: null };
  const onLog = ({ message }) => parseMeta(message, meta);
  const onProg = onProgress
    ? ({ progress }) => onProgress(Math.max(0, Math.min(1, progress || 0)))
    : null;
  ff.on("log", onLog);
  if (onProg) ff.on("progress", onProg);

  try {
    await ff.exec([
      "-i", input,
      "-map", "0:v:0", "-an", // só o vídeo; ignora as 16 trilhas de áudio do MXF
      "-vf", `scale=${width}:ih,format=gray`, // largura fixa, altura intacta
      "-f", "rawvideo", "-pix_fmt", "gray", "g.raw", // 1 byte/pixel, sem encoder
    ]);
  } finally {
    ff.off("log", onLog);
    if (onProg) ff.off("progress", onProg);
  }

  const data = await ff.readFile("g.raw"); // Uint8Array (cinza, frames concatenados)
  await ff.deleteFile("g.raw");

  const frameW = width;
  const frameH = meta.height || 1080;
  const frameSize = frameW * frameH;
  const frameCount = frameSize ? Math.floor(data.length / frameSize) : 0;
  return {
    data,
    frameW,
    frameH,
    frameCount,
    fps: meta.fps || 29.97,
    srcWidth: meta.width || 0,
    srcHeight: meta.height || 0,
  };
}

/**
 * PASSE 2 — extrai em RESOLUÇÃO CHEIA (cor) apenas os frames pedidos.
 * @param {File} file
 * @param {number[]} frameIndices  índices 0-based, únicos e crescentes
 * @returns {Promise<Map<number, string>>}  frameIndex → object URL (PNG full-res)
 */
export async function extractWindows(file, frameIndices, { onProgress } = {}) {
  const ff = await loadEngine();
  const input = await ensureInput(file);
  if (!frameIndices.length) return new Map();

  const indices = [...new Set(frameIndices)].sort((a, b) => a - b);
  // Sem shell: nada de aspas; vírgulas escapadas com \, para não separar filtros.
  const sel = indices.map((n) => `eq(n\\,${n})`).join("+");

  const onProg = onProgress
    ? ({ progress }) => onProgress(Math.max(0, Math.min(1, progress || 0)))
    : null;
  if (onProg) ff.on("progress", onProg);

  try {
    await ff.exec([
      "-i", input,
      "-map", "0:v:0", "-an", // só o vídeo; ignora as 16 trilhas de áudio do MXF
      // Reduz p/ 960px (só visualização — os painéis exibem ~470px). Corta o
      // peso do PNG e acelera o carregamento das miniaturas.
      "-vf", `select=${sel},scale=960:-2`,
      "-vsync", "0",            // emite só os frames selecionados, sem repetir
      "-frames:v", String(indices.length), // PARA após o último frame pedido —
                                            // não decodifica a cauda do arquivo
      "-c:v", "png",            // PNG sem perdas — o encoder mjpeg trava no Chrome
      "w_%05d.png",
    ]);
  } finally {
    if (onProg) ff.off("progress", onProg);
  }

  // A ordem de saída segue a ordem crescente de n → casa com `indices`.
  const urls = await readImageSequence("w_", "png", "image/png");
  const map = new Map();
  indices.forEach((frameIndex, i) => {
    if (urls[i]) map.set(frameIndex, urls[i]);
  });
  return map;
}

/**
 * PASSE 2b — extrai os DOIS CAMPOS de cada frame de janela, LIMPOS, pelo próprio
 * ffmpeg (`separatefields`). Cada campo vira um PNG de meia-altura (1920×540)
 * contendo SÓ as linhas daquele campo — separação autoritativa, sem fatiar o
 * frame tecido no JS (que, no Chrome, deixava o Lower com aparência contaminada).
 * Para material TFF, a ordem de saída é top, bottom, top, bottom… (2 por frame).
 *
 * @param {File} file
 * @param {number[]} frameIndices  índices 0-based, únicos e crescentes
 * @returns {Promise<Map<number, {top:string, bottom:string}>>}
 */
export async function extractWindowFields(file, frameIndices, { onProgress } = {}) {
  const ff = await loadEngine();
  const input = await ensureInput(file);
  if (!frameIndices.length) return new Map();

  const indices = [...new Set(frameIndices)].sort((a, b) => a - b);
  const sel = indices.map((n) => `eq(n\\,${n})`).join("+");

  const onProg = onProgress
    ? ({ progress }) => onProgress(Math.max(0, Math.min(1, progress || 0)))
    : null;
  if (onProg) ff.on("progress", onProg);

  try {
    await ff.exec([
      "-i", input,
      "-map", "0:v:0", "-an",
      // separatefields PRIMEIRO (separa os campos), e só ENTÃO reduz a escala —
      // escalar antes misturaria os campos de volta. 960px basta p/ o painel.
      "-vf", `select=${sel},separatefields,scale=960:-2`,
      "-vsync", "0",
      "-frames:v", String(indices.length * 2), // 2 campos por frame selecionado
      "-c:v", "png",
      "s_%05d.png",
    ]);
  } finally {
    if (onProg) ff.off("progress", onProg);
  }

  // Saída em ordem: top0, bottom0, top1, bottom1, … → casa com `indices`.
  const urls = await readImageSequence("s_", "png", "image/png");
  const map = new Map();
  indices.forEach((frameIndex, i) => {
    const top = urls[2 * i];
    const bottom = urls[2 * i + 1];
    if (top && bottom) map.set(frameIndex, { top, bottom });
  });
  return map;
}

/**
 * Transcodifica o MXF inteiro para um MP4/H.264 (proxy) reproduzível no
 * navegador. NÃO desentrelaça — preserva o combing para que o split-field
 * "pisque" na reprodução. Áudio em AAC (primeira trilha).
 *
 * @param {File} file
 * @param {{ height?: number, onProgress?: (ratio:number)=>void }} [opts]
 * @returns {Promise<string>} object URL (video/mp4)
 */
export async function transcodeProxy(file, { height = 720, onProgress } = {}) {
  const ff = await loadEngine();
  const input = await ensureInput(file);
  const out = "proxy.mp4";

  const onProg = onProgress
    ? ({ progress }) => onProgress(Math.max(0, Math.min(1, progress || 0)))
    : null;
  if (onProg) ff.on("progress", onProg);

  try {
    await ff.exec([
      "-i", input,
      // Mapeia só 1 vídeo + 1 áudio → descarta a faixa de dados/timecode do MXF.
      "-map", "0:v:0", "-map", "0:a:0?",
      // Desentrelaça (bwdif): frames PROGRESSIVOS limpos → decodificação rápida
      // no navegador (o conteúdo combed travava o seek/decode). O flash do
      // split-field ainda aparece como anomalia de 1 frame; a inspeção exata dos
      // campos fica nos painéis Upper/Lower.
      "-vf", `bwdif=mode=0,scale=-2:${height},format=yuv420p`,
      "-c:v", "libx264", "-preset", "ultrafast", "-profile:v", "high", "-crf", "23",
      // -g 15 = keyframe a cada ~0.5s. SEM `-sc_threshold 0`: deixa o x264 inserir
      // keyframe NOS CORTES de cena — senão o frame do corte vira um P-frame
      // gigante (muda a imagem inteira) que trava a decodificação ao dar seek ali.
      "-g", "15",
      // Teto de bitrate baixo: alivia a decodificação (Firefox engasga em picos).
      "-maxrate", "3M", "-bufsize", "6M",
      "-c:a", "aac", "-b:a", "128k", "-ac", "2",
      // SEM +faststart: ele faz um 2º passe que ABORTA no wasm e é inútil para
      // blob (o navegador já tem o arquivo inteiro). Remover estabiliza o seek.
      out,
    ]);
  } finally {
    if (onProg) ff.off("progress", onProg);
  }

  const data = await ff.readFile(out);
  await ff.deleteFile(out);
  return URL.createObjectURL(new Blob([data], { type: "video/mp4" }));
}
