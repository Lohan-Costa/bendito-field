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
 * Desenha o frame tecido e os dois campos JÁ SEPARADOS pelo ffmpeg.
 * Os campos vêm como PNGs de meia-altura (1920×540) com SÓ as linhas do campo
 * — separação autoritativa, sem fatiar nada no JS.
 * @param {object} urls
 * @param {string} [urls.wovenUrl]   frame tecido (1920×1080, combing visível)
 * @param {string} [urls.topUrl]     campo superior (1920×540)
 * @param {string} [urls.bottomUrl]  campo inferior (1920×540)
 * @param {object} targets  { woven, upper, lower } canvases de destino
 */
export async function renderFields({ wovenUrl, topUrl, bottomUrl }, { woven, upper, lower }) {
  // O tecido é frame inteiro (vstretch 1). Os campos têm meia-altura, então
  // esticam 2× na vertical para recompor o aspecto 16:9 do frame.
  if (woven && wovenUrl) blitSharpImg(woven, await loadImage(wovenUrl), 1);
  if (upper && topUrl)   blitSharpImg(upper, await loadImage(topUrl), 2);
  if (lower && bottomUrl) blitSharpImg(lower, await loadImage(bottomUrl), 2);
}

/**
 * Desenha `img` no canvas de destino, no tamanho de EXIBIÇÃO × DPR (sem reescala
 * extra do navegador), com reamostragem de alta qualidade.
 * `vstretch` estica a altura (2 = campo de meia-altura → aspecto do frame cheio).
 */
function blitSharpImg(dest, img, vstretch) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = dest.clientWidth || 640;
  const bw = Math.max(1, Math.round(cssW * dpr));
  const bh = Math.max(1, Math.round((bw * img.naturalHeight * vstretch) / img.naturalWidth));
  dest.width = bw;
  dest.height = bh;
  const ctx = dest.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, bw, bh);
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
