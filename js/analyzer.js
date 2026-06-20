// ===================== analyzer.js =====================
// Detecção de frames suspeitos de split-field (frame híbrido / "pulo" de campo).
//
// PROBLEMA central: a diferença entre campos |Upper − Lower| sozinha NÃO
// distingue um split-field de movimento normal. Em material entrelaçado os dois
// campos são captados com 1/60s de diferença, então QUALQUER movimento rápido
// (esportes, paneis) gera "combing" e um |Upper − Lower| alto — falso positivo.
//
// DISCRIMINADOR temporal (usa os frames ao redor):
//  - Split-field real: pelo menos UM campo é "bom" e flui no tempo (muitas vezes
//    o outro campo é congelado/duplicado de um vizinho). Logo o |Upper − Lower|
//    é MUITO MAIOR que a mudança temporal do MELHOR campo.
//  - Movimento normal: AMBOS os campos mudam no tempo tanto quanto diferem entre
//    si → |Upper − Lower| ≈ 0.5 × (mudança do campo entre frames). Não é "pulo".
//
// Assim, além do pico isolado de field-diff, exigimos que o field-diff NÃO seja
// explicado por movimento (motionRatio alto).

import { extractGrayRaw } from "./ffmpeg.js";

const WINDOW = 8;        // raio da janela para a mediana local
const MIN_SPIKE = 12;    // pico mínimo (diff - mediana local) para sinalizar
const RATIO = 2.2;       // ou diff >= RATIO × mediana local (com pico moderado)
const SOFT_SPIKE = 7;
// GATE de movimento: o field-diff precisa exceder a mudança temporal do MELHOR
// campo por este fator. Movimento puro dá ~0.5; split-field (campo congelado)
// dá um valor alto. Suba para ficar mais rígido (menos falsos positivos / pode
// perder casos sutis); baixe para o contrário.
const MIN_MOTION_RATIO = 1.2;

/**
 * @param {File} file
 * @param {{ onProgress?: (stage:string, ratio:number)=>void }} [opts]
 * @returns {Promise<{
 *   fps:number, width:number, height:number, frameCount:number,
 *   diffs:number[], suspects:Array<{frame:number,diff:number,spike:number,motionRatio:number,confidence:number,level:string}>
 * }>}
 */
export async function analyze(file, { onProgress = () => {} } = {}) {
  // ---- Passe 1: frames cinza crus (rawvideo, 1 arquivo, sem encoder) ----
  const { data, frameW, frameH, frameCount, fps, srcWidth, srcHeight } =
    await extractGrayRaw(file, {
      width: 320,
      onProgress: (r) => onProgress("Decodificando e analisando campos…", r * 0.85),
    });

  const frameSize = frameW * frameH;

  // ---- Métricas por frame ----
  //  diffs[i] = |Upper − Lower| no frame i (sinal de combing/split).
  //  tU[i] / tL[i] = mudança temporal de cada campo entre o frame i e i-1
  //    (mesma paridade) → quanto cada campo "anda" de um frame para o outro.
  const diffs = new Array(frameCount);
  const tU = new Array(frameCount).fill(NaN); // mudança temporal do campo par (Upper)
  const tL = new Array(frameCount).fill(NaN); // mudança temporal do campo ímpar (Lower)

  for (let i = 0; i < frameCount; i++) {
    const off = i * frameSize;
    diffs[i] = fieldDiffFromBytes(data, off, frameW, frameH);
    if (i > 0) {
      const prev = (i - 1) * frameSize;
      tU[i] = fieldTemporalDiff(data, off, prev, frameW, frameH, 0);
      tL[i] = fieldTemporalDiff(data, off, prev, frameW, frameH, 1);
    }
    if (i % 16 === 0) onProgress("Medindo campos e movimento…", 0.85 + 0.1 * (i / frameCount));
  }

  // ---- Detecção: pico isolado de field-diff + gate de movimento ----
  const suspects = detectSuspects(diffs, tU, tL);
  onProgress("Concluído", 1);

  return { fps, width: srcWidth, height: srcHeight, frameCount, diffs, suspects };
}

/**
 * Diferença média |linha par − linha ímpar| (0–255) de um frame cinza cru.
 * `buf` traz os frames concatenados; `off` é o byte inicial do frame; cada
 * pixel é 1 byte (luma).
 */
function fieldDiffFromBytes(buf, off, w, h) {
  let sum = 0;
  let count = 0;
  for (let y = 0; y + 1 < h; y += 2) {
    const rowA = off + y * w;
    const rowB = off + (y + 1) * w;
    for (let x = 0; x < w; x++) {
      sum += Math.abs(buf[rowA + x] - buf[rowB + x]);
      count++;
    }
  }
  return count ? sum / count : 0;
}

/**
 * Mudança temporal de UM campo (linhas de paridade `parity`) entre dois frames
 * (offsets `offA` e `offB`). Mede quanto aquele campo "anda" de um frame ao
 * outro — pequeno = campo estável/congelado; grande = campo em movimento.
 */
function fieldTemporalDiff(buf, offA, offB, w, h, parity) {
  let sum = 0;
  let count = 0;
  for (let y = parity; y < h; y += 2) {
    const ra = offA + y * w;
    const rb = offB + y * w;
    for (let x = 0; x < w; x++) {
      sum += Math.abs(buf[ra + x] - buf[rb + x]);
      count++;
    }
  }
  return count ? sum / count : 0;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Frames cujo field-diff é um pico isolado E não explicado por movimento.
 * @param {number[]} diffs  |Upper−Lower| por frame
 * @param {number[]} tU     mudança temporal do campo par (NaN no frame 0)
 * @param {number[]} tL     mudança temporal do campo ímpar (NaN no frame 0)
 */
export function detectSuspects(diffs, tU, tL) {
  const n = diffs.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    // Sem contexto temporal (1º frame) não dá para validar movimento → ignora.
    if (!Number.isFinite(tU[i]) || !Number.isFinite(tL[i])) continue;

    const a = Math.max(0, i - WINDOW);
    const b = Math.min(n, i + WINDOW + 1);
    const nb = [];
    for (let j = a; j < b; j++) if (j !== i) nb.push(diffs[j]);
    const med = median(nb);
    const spike = diffs[i] - med;
    const ratioHit = med > 0 && diffs[i] >= med * RATIO && spike >= SOFT_SPIKE;
    if (!(spike >= MIN_SPIKE || ratioHit)) continue; // não é pico de field-diff

    // GATE de movimento: o field-diff tem de superar a mudança do MELHOR campo.
    // Num split-field o campo "bom" flui (mudança baixa) → razão alta.
    // Em movimento normal os dois campos mudam → razão ~0.5 → descartado.
    const bestFieldMotion = Math.min(tU[i], tL[i]);
    const motionRatio = diffs[i] / (bestFieldMotion + 1e-3);
    if (motionRatio < MIN_MOTION_RATIO) continue; // explicado por movimento → não é "pulo"

    out.push({
      frame: i,
      diff: diffs[i],
      spike,
      motionRatio,
      confidence: confidenceFrom(spike, motionRatio),
      level: levelFrom(spike, motionRatio),
    });
  }
  // Mais confiantes primeiro.
  out.sort((p, q) => q.confidence - p.confidence || q.spike - p.spike);
  return out;
}

// Confiança = pico do field-diff + bônus por field-diff muito acima do movimento.
function confidenceFrom(spike, motionRatio) {
  const base = 50 + spike * 1.35;
  const motionBonus = Math.min(22, Math.max(0, (motionRatio - 1) * 10));
  return Math.max(50, Math.min(99, Math.round(base + motionBonus)));
}

function levelFrom(spike, motionRatio) {
  const c = confidenceFrom(spike, motionRatio);
  if (c >= 85) return "alta";
  if (c >= 68) return "media";
  return "baixa";
}
