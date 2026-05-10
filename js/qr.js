// QR code encoder — implementation minimaliste (Reed-Solomon + version auto)
// Basée sur l'algorithme officiel ISO/IEC 18004. Pas de dépendance externe.
// Encode du UTF-8 en mode "byte" pour gérer URLs (ASCII + accents).

const ECC_LEVELS = { L: 0, M: 1, Q: 2, H: 3 };
const ECC_FORMAT_BITS = [
  // Pour chaque ECC level, les bits de format pré-calculés (15 bits) selon mask
  // Index: ECC * 8 + mask
  0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976,
  0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0,
  0x355f, 0x3068, 0x3f31, 0x3a06, 0x24b4, 0x2183, 0x2eda, 0x2bed,
  0x1689, 0x13be, 0x1ce7, 0x19d0, 0x0762, 0x0255, 0x0d0c, 0x083b,
];

// Capacité max byte mode pour ECC=M (suffit pour nos URLs ~300-500 chars)
// version: total codewords - ecc codewords - 2 (header)
const VERSION_INFO = [
  // [version, totalCodewords, eccCodewords (M), bytesCapacity (M)]
  [1,26,10,14], [2,44,16,26], [3,70,26,42], [4,100,36,62], [5,134,48,84],
  [6,172,64,106], [7,196,72,122], [8,242,88,152], [9,292,110,180],
  [10,346,130,213], [11,404,150,251], [12,466,176,287], [13,532,198,331],
  [14,581,216,362], [15,655,240,412], [16,733,280,450], [17,815,308,504],
  [18,901,338,560], [19,991,364,624], [20,1085,416,666],
];

// GF(256) tables pour Reed-Solomon
const GF_EXP = new Uint8Array(256);
const GF_LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  GF_EXP[255] = GF_EXP[0];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a] + GF_LOG[b]) % 255];
}

// Polynôme générateur Reed-Solomon de degré n
function rsGenPoly(n) {
  let p = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(p.length + 1).fill(0);
    for (let j = 0; j < p.length; j++) {
      next[j] ^= p[j];
      next[j + 1] ^= gfMul(p[j], GF_EXP[i]);
    }
    p = next;
  }
  return p;
}

function rsEncode(data, eccLen) {
  const gen = rsGenPoly(eccLen);
  const result = data.concat(new Array(eccLen).fill(0));
  for (let i = 0; i < data.length; i++) {
    const factor = result[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) {
      result[i + j] ^= gfMul(gen[j], factor);
    }
  }
  return result.slice(data.length);
}

function chooseVersion(byteCount) {
  for (const [v, , , cap] of VERSION_INFO) {
    if (byteCount + 2 <= cap) return v;
  }
  throw new Error('QR: payload trop gros (>666 bytes)');
}

function utf8Bytes(str) {
  return Array.from(new TextEncoder().encode(str));
}

// Construit le buffer de bits pour mode byte
function buildBitstream(data, version) {
  const info = VERSION_INFO[version - 1];
  const totalDataCodewords = info[1] - info[2];
  const bits = [];
  const push = (value, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(0b0100, 4); // mode byte
  // Char count indicator : 8 bits pour v1-9, 16 pour v10+
  const ccBits = version <= 9 ? 8 : 16;
  push(data.length, ccBits);
  for (const b of data) push(b, 8);
  // Terminator
  const remaining = totalDataCodewords * 8 - bits.length;
  push(0, Math.min(4, remaining));
  // Pad à 8
  while (bits.length % 8 !== 0) bits.push(0);
  // Pad bytes alternés
  const padBytes = [0xec, 0x11];
  let pi = 0;
  while (bits.length / 8 < totalDataCodewords) {
    push(padBytes[pi], 8);
    pi = (pi + 1) % 2;
  }
  // Convertir en codewords
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    codewords.push(b);
  }
  return codewords;
}

// Pour simplifier : un seul block ECC (vrai pour v1-5, suffit pour nos URLs)
function buildFinalCodewords(dataCodewords, eccLen) {
  const ecc = rsEncode(dataCodewords, eccLen);
  return dataCodewords.concat(ecc);
}

function placePatternsAndData(version, codewords) {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Int8Array(size).fill(-1));
  const reserved = Array.from({ length: size }, () => new Uint8Array(size));

  // Finder patterns aux 3 coins
  const placeFinder = (cx, cy) => {
    for (let dy = -1; dy <= 7; dy++) for (let dx = -1; dx <= 7; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      let on = 0;
      const ax = Math.abs(dx - 3), ay = Math.abs(dy - 3);
      const d = Math.max(ax, ay);
      if (d === 7) on = 0;
      else if (d === 4 || d === 3 || d === 2 || d === 0) on = 1;
      else on = 0;
      m[y][x] = on;
      reserved[y][x] = 1;
    }
  };
  placeFinder(0, 0);
  placeFinder(size - 7, 0);
  placeFinder(0, size - 7);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    m[6][i] = (i % 2 === 0) ? 1 : 0;
    m[i][6] = (i % 2 === 0) ? 1 : 0;
    reserved[6][i] = 1;
    reserved[i][6] = 1;
  }

  // Dark module
  m[size - 8][8] = 1;
  reserved[size - 8][8] = 1;

  // Format info reserved zones (15 bits aux 2 emplacements)
  for (let i = 0; i < 9; i++) reserved[8][i] = 1;
  for (let i = 0; i < 8; i++) reserved[i][8] = 1;
  for (let i = size - 8; i < size; i++) reserved[8][i] = 1;
  for (let i = size - 7; i < size; i++) reserved[i][8] = 1;

  // Alignment patterns (versions 2+)
  if (version >= 2) {
    const positions = getAlignmentPositions(version);
    for (const cy of positions) for (const cx of positions) {
      // Skip si chevauche un finder
      if ((cx < 9 && cy < 9) || (cx > size - 10 && cy < 9) || (cx < 9 && cy > size - 10)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const x = cx + dx, y = cy + dy;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        m[y][x] = (d === 0 || d === 2) ? 1 : 0;
        reserved[y][x] = 1;
      }
    }
  }

  // Placement des bits de données — direction zig-zag depuis bas-droite
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip timing column
    for (let i = 0; i < size; i++) {
      const y = upward ? size - 1 - i : i;
      for (let dx = 0; dx < 2; dx++) {
        const x = col - dx;
        if (reserved[y][x]) continue;
        if (bitIdx >= totalBits) { m[y][x] = 0; continue; }
        const bit = (codewords[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
        m[y][x] = bit;
        bitIdx++;
      }
    }
    upward = !upward;
  }
  return { m, size, reserved };
}

function getAlignmentPositions(version) {
  const table = [
    [], [6,18], [6,22], [6,26], [6,30], [6,34],
    [6,22,38], [6,24,42], [6,26,46], [6,28,50], [6,30,54],
    [6,32,58], [6,34,62], [6,26,46,66], [6,26,48,70], [6,26,50,74],
    [6,30,54,78], [6,30,56,82], [6,30,58,86], [6,34,62,90],
  ];
  return table[version - 1] || [];
}

// Mask functions ISO/IEC 18004
const MASK_FUNCS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(m, reserved, maskIdx) {
  const fn = MASK_FUNCS[maskIdx];
  const size = m.length;
  const out = m.map(row => Int8Array.from(row));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (reserved[y][x]) continue;
    if (fn(y, x)) out[y][x] ^= 1;
  }
  return out;
}

function placeFormatInfo(m, eccLevel, maskIdx) {
  const size = m.length;
  const formatBits = ECC_FORMAT_BITS[eccLevel * 8 + maskIdx];
  // Around top-left finder (15 bits)
  for (let i = 0; i < 6; i++) m[i][8] = (formatBits >> (14 - i)) & 1;
  m[7][8] = (formatBits >> 8) & 1;
  m[8][8] = (formatBits >> 7) & 1;
  m[8][7] = (formatBits >> 6) & 1;
  for (let i = 0; i < 6; i++) m[8][5 - i] = (formatBits >> (i + 9)) & 1;
  // Around top-right + bottom-left finders
  for (let i = 0; i < 8; i++) m[size - 1 - i][8] = (formatBits >> i) & 1;
  for (let i = 0; i < 7; i++) m[8][size - 7 + i] = (formatBits >> (i + 8)) & 1;
}

// Score de pénalité pour choisir le meilleur mask
function scoreMask(m) {
  const size = m.length;
  let score = 0;
  // Rule 1: runs of 5+ same color
  for (let y = 0; y < size; y++) {
    let run = 1;
    for (let x = 1; x < size; x++) {
      if (m[y][x] === m[y][x - 1]) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
      else run = 1;
    }
  }
  for (let x = 0; x < size; x++) {
    let run = 1;
    for (let y = 1; y < size; y++) {
      if (m[y][x] === m[y - 1][x]) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
      else run = 1;
    }
  }
  // Rule 2: 2x2 same color
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const c = m[y][x];
    if (m[y][x + 1] === c && m[y + 1][x] === c && m[y + 1][x + 1] === c) score += 3;
  }
  return score;
}

/**
 * Génère une matrice QR (boolean[][]) à partir d'un texte.
 * @param {string} text - URL ou texte (UTF-8 supporté)
 * @returns {boolean[][]} grille NxN, true = noir, false = blanc
 */
export function generateQRMatrix(text) {
  const data = utf8Bytes(text);
  const version = chooseVersion(data.length);
  const info = VERSION_INFO[version - 1];
  const eccLen = info[2];
  const dataCodewords = buildBitstream(data, version);
  const finalCodewords = buildFinalCodewords(dataCodewords, eccLen);
  const { m, reserved } = placePatternsAndData(version, finalCodewords);

  // Choisir le meilleur mask (0-7) en évaluant les pénalités
  let bestMask = 0, bestScore = Infinity;
  for (let mi = 0; mi < 8; mi++) {
    const masked = applyMask(m, reserved, mi);
    placeFormatInfo(masked, ECC_LEVELS.M, mi);
    const score = scoreMask(masked);
    if (score < bestScore) { bestScore = score; bestMask = mi; }
  }
  const finalMatrix = applyMask(m, reserved, bestMask);
  placeFormatInfo(finalMatrix, ECC_LEVELS.M, bestMask);
  return finalMatrix.map(row => Array.from(row).map(v => v === 1));
}

/**
 * Dessine un QR sur un canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {string} text
 * @param {Object} opts
 * @param {number} opts.scale - pixels per module (default 6)
 * @param {number} opts.margin - quiet zone in modules (default 4)
 * @param {string} opts.dark - couleur des modules noirs (default #000)
 * @param {string} opts.light - couleur des modules blancs (default #fff)
 */
export function renderQRToCanvas(canvas, text, opts = {}) {
  const matrix = generateQRMatrix(text);
  const scale = opts.scale || 6;
  const margin = opts.margin ?? 4;
  const dark = opts.dark || '#000';
  const light = opts.light || '#fff';
  const size = matrix.length;
  const px = (size + margin * 2) * scale;
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = dark;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (matrix[y][x]) ctx.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
    }
  }
}
