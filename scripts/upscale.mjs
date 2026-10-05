// Super-résolution ×4 d'une petite photo (ESRGAN « medium », modèle libre de
// UpscalerJS) en pur JavaScript — aucun binaire, aucun compte, tourne sur un
// runner GitHub. Utilisé par le robot photos : Instagram ne sert plus que des
// vignettes 100/150 px en anonyme ; agrandies par IA elles redeviennent
// présentables sur une fiche (sans inventer de détails : le modèle lisse et
// affine, il ne « redessine » pas un visage).
//
// Dépendances (npm, installées par le workflow) : @tensorflow/tfjs,
// @upscalerjs/esrgan-medium, sharp. Si elles manquent, upscaleIfSmall()
// renvoie l'image d'origine.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const SMALL_WIDTH = 400;   // en dessous : on agrandit
const MAX_B64 = 900_000;          // limite d'un document Firestore (marge)

let deps = null;
async function loadDeps() {
  if (deps) return deps;
  try {
    const tf = await import('@tensorflow/tfjs');
    const sharp = (await import('sharp')).default;
    const modelJson = findModel();
    if (!modelJson) throw new Error('modèle esrgan-medium introuvable');
    deps = { tf, sharp, modelJson };
  } catch (e) {
    deps = { error: e };
  }
  return deps;
}

// Le paquet restreint ses « exports » : on localise le dossier du modèle
// (node_modules/@upscalerjs/esrgan-medium/models/x4) sans passer par require.
function findModel() {
  const candidates = [join(process.cwd(), 'node_modules', '@upscalerjs', 'esrgan-medium')];
  try {
    let d = dirname(require.resolve('@upscalerjs/esrgan-medium'));
    for (let i = 0; i < 8; i++) { candidates.push(d); d = dirname(d); }
  } catch {}
  for (const c of candidates) {
    const p = join(c, 'models', 'x4', 'model.json');
    if (existsSync(p)) return p;
  }
  return null;
}

function localModelHandler(tf, modelJsonPath) {
  const dir = dirname(modelJsonPath);
  const json = JSON.parse(readFileSync(modelJsonPath, 'utf8'));
  const weightSpecs = json.weightsManifest.flatMap((g) => g.weights);
  const buffers = json.weightsManifest.flatMap((g) => g.paths.map((p) => readFileSync(join(dir, p))));
  const total = buffers.reduce((n, b) => n + b.length, 0);
  const weightData = new ArrayBuffer(total);
  let off = 0;
  for (const b of buffers) { new Uint8Array(weightData).set(new Uint8Array(b.buffer, b.byteOffset, b.length), off); off += b.length; }
  return tf.io.fromMemory({ modelTopology: json.modelTopology, weightSpecs, weightData, format: json.format });
}

let modelPromise = null;
function loadModel(tf, modelJson) {
  if (!modelPromise) modelPromise = tf.loadLayersModel(localModelHandler(tf, modelJson));
  return modelPromise;
}

/** Largeur/hauteur d'une image (Buffer). */
export async function imageSize(buf) {
  const d = await loadDeps();
  if (d.error) return null;
  const m = await d.sharp(buf).metadata();
  return { width: m.width || 0, height: m.height || 0 };
}

/**
 * Agrandit ×4 une image de moins de SMALL_WIDTH px de large.
 * @returns {{ buffer: Buffer, type: string, width: number, upscaled: boolean }}
 */
export async function upscaleIfSmall(buf, type = 'image/jpeg') {
  const d = await loadDeps();
  if (d.error) return { buffer: buf, type, width: 0, upscaled: false, reason: d.error.message };
  const { tf, sharp, modelJson } = d;
  const meta = await sharp(buf).metadata();
  const width = meta.width || 0;
  if (!width || width >= SMALL_WIDTH) return { buffer: buf, type, width, upscaled: false };

  let img = sharp(buf).removeAlpha();
  // Sources très dégradées (≤ 120 px) : un soupçon de flou avant l'IA évite
  // d'amplifier les blocs de compression JPEG.
  if (width <= 120) img = img.blur(0.6);
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const model = await loadModel(tf, modelJson);
  const out = tf.tidy(() => {
    const x = tf.tensor4d(new Float32Array(data), [1, info.height, info.width, 3]); // plage 0-255
    return tf.clipByValue(model.predict(x), 0, 255).round().squeeze();
  });
  const arr = await out.data();
  const [h, w] = out.shape;
  out.dispose();
  let quality = 88;
  let jpeg = await sharp(Buffer.from(Uint8Array.from(arr)), { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality, mozjpeg: true }).toBuffer();
  while (jpeg.length * 1.37 > MAX_B64 && quality > 50) {
    quality -= 10;
    jpeg = await sharp(jpeg).jpeg({ quality, mozjpeg: true }).toBuffer();
  }
  return { buffer: jpeg, type: 'image/jpeg', width: w, upscaled: true };
}

// Usage direct : node scripts/upscale.mjs entrée.jpg sortie.jpg
if (process.argv[1] && process.argv[1].endsWith('upscale.mjs') && process.argv[2]) {
  const { writeFileSync } = await import('node:fs');
  const t0 = Date.now();
  const r = await upscaleIfSmall(readFileSync(process.argv[2]));
  writeFileSync(process.argv[3] || process.argv[2].replace(/\.\w+$/, '') + '_x4.jpg', r.buffer);
  console.log(r.upscaled ? `agrandie → ${r.width} px en ${((Date.now() - t0) / 1000).toFixed(1)} s` : `inchangée (${r.width} px${r.reason ? ' — ' + r.reason : ''})`);
}
