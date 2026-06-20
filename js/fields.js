// ===================== fields.js =====================
// Separação de campos (fields) de um frame entrelaçado, no canvas.
//
// Um frame 1080i guarda dois campos intercalados por linha:
//   - Upper / Top field  → linhas pares  (0, 2, 4, …)
//   - Lower / Bottom field→ linhas ímpares (1, 3, 5, …)
//
// Para visualizar cada campo na proporção correta, duplicamos as linhas
// (line-doubling) de volta para a altura original.

const cache = new Map(); // url -> Promise<HTMLImageElement>

function loadImage(url) {
  if (cache.has(url)) return cache.get(url);
  const p = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
  cache.set(url, p);
  return p;
}

/**
 * Desenha um frame (tecido) e seus dois campos separados nos canvases dados.
 * @param {string} url            object URL do frame (PNG)
 * @param {object} targets
 * @param {HTMLCanvasElement} targets.woven  frame original (combing visível)
 * @param {HTMLCanvasElement} targets.upper  campo superior (line-doubled)
 * @param {HTMLCanvasElement} targets.lower  campo inferior (line-doubled)
 */
// Intensidade do realce (unsharp) aplicado aos painéis. 0 = desliga.
// ~0.4 dá uma nitidez perceptível sem virar "crocante"/ruidoso. Ajustável.
const SHARPEN = 0.4;

export async function renderFields(url, { woven, upper, lower }) {
  const img = await loadImage(url);
  const w = img.naturalWidth;
  const h = img.naturalHeight;

  // Lê os pixels do frame original uma única vez (offscreen, resolução cheia).
  const src = document.createElement("canvas");
  src.width = w;
  src.height = h;
  const sctx = src.getContext("2d", { willReadFrequently: true });
  sctx.drawImage(img, 0, 0);
  const data = sctx.getImageData(0, 0, w, h);

  if (woven) blitSharp(woven, src);                       // frame tecido
  if (upper) blitSharp(upper, fieldCanvas(data, w, h, 0)); // linhas pares  → Upper
  if (lower) blitSharp(lower, fieldCanvas(data, w, h, 1)); // linhas ímpares → Lower
}

/**
 * Monta um campo (offscreen, resolução cheia) a partir das linhas de paridade
 * `parity` (0 par / 1 ímpar), duplicando cada LINHA do campo para recompor a
 * altura. Mapeamento limpo (bob): as linhas de saída (2k, 2k+1) recebem a linha
 * k do campo, que na origem é a linha (2k + parity) → os dois campos ficam
 * alinhados e cada linha aparece exatamente 2×.
 */
function fieldCanvas(srcData, w, h, parity) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const out = ctx.createImageData(w, h);
  const sp = srcData.data;
  const dp = out.data;

  for (let y = 0; y < h; y++) {
    let sy = 2 * (y >> 1) + parity;
    if (sy >= h) sy = h - 1;
    const sRow = sy * w * 4;
    const dRow = y * w * 4;
    dp.set(sp.subarray(sRow, sRow + w * 4), dRow);
  }
  ctx.putImageData(out, 0, 0);
  return canvas;
}

/**
 * Reduz `srcCanvas` (res. cheia) para o tamanho de EXIBIÇÃO × DPR (sem reescala
 * extra do navegador) com reamostragem de alta qualidade e, em seguida, aplica
 * um REALCE (unsharp) — é o que dá a sensação de nitidez perdida no downscale.
 */
function blitSharp(dest, srcCanvas) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = dest.clientWidth || Math.min(srcCanvas.width, 640);
  const ratio = srcCanvas.height / srcCanvas.width;
  const bw = Math.max(1, Math.round(cssW * dpr));
  const bh = Math.max(1, Math.round(bw * ratio));
  dest.width = bw;
  dest.height = bh;
  const ctx = dest.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(srcCanvas, 0, 0, bw, bh);
  if (SHARPEN > 0) unsharp(ctx, bw, bh, SHARPEN);
}

/** Realce 3×3 (cruz) in-place sobre o contexto: center=1+4a, vizinhos=−a. */
function unsharp(ctx, w, h, amount) {
  if (w < 3 || h < 3) return;
  const img = ctx.getImageData(0, 0, w, h);
  const s = img.data;
  const out = new Uint8ClampedArray(s); // cópia (bordas ficam como estão)
  const stride = w * 4;
  const center = 1 + 4 * amount;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const p = i + c;
        out[p] = center * s[p] - amount * (s[p - 4] + s[p + 4] + s[p - stride] + s[p + stride]);
      }
    }
  }
  img.data.set(out);
  ctx.putImageData(img, 0, 0);
}

/**
 * Métrica simples de diferença média entre os dois campos de um frame (0–255).
 * Útil nas próximas fases (detecção de híbridos). Calculada em escala reduzida.
 */
export async function fieldDifference(url, sample = 240) {
  const img = await loadImage(url);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const sw = Math.min(sample, w);
  const sh = Math.round((sw / w) * h);

  const c = document.createElement("canvas");
  c.width = sw;
  c.height = sh;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, sw, sh);
  const d = ctx.getImageData(0, 0, sw, sh).data;

  let sum = 0;
  let count = 0;
  for (let y = 0; y + 1 < sh; y += 2) {
    for (let x = 0; x < sw; x++) {
      const a = (y * sw + x) * 4;
      const b = ((y + 1) * sw + x) * 4;
      // luminância aproximada
      const la = 0.299 * d[a] + 0.587 * d[a + 1] + 0.114 * d[a + 2];
      const lb = 0.299 * d[b] + 0.587 * d[b + 1] + 0.114 * d[b + 2];
      sum += Math.abs(la - lb);
      count++;
    }
  }
  return count ? sum / count : 0;
}
