/* Generates the Datalake Face Auth pitch deck (.pptx).
 * Dark control-room theme: near-black bg, signal-green accent, corner-bracket
 * motif, mono headers (Consolas) + Calibri body. Run: node build_deck.js */
const path = require('path');
const pptxgen = require('pptxgenjs');

const C = {
  bg: '07090B',
  bg2: '0D1216',
  surf: '111A21',
  surf2: '0A0F13',
  line: '25323B',
  text: 'DBE4E8',
  dim: '8B97A5',
  faint: '5A6770',
  green: '38E0A5',
  greenDk: '1E7D5C',
  amber: 'F2B347',
  red: 'FF6B6B',
};
const HEAD = 'Consolas';
const BODY = 'Calibri';
const W = 13.333;
const H = 7.5;
const APK_URL = 'https://github.com/perrysolid/NHAI/raw/main/docs/deliverables/DatalakeFaceAuth-android-universal-release.apk';

const pres = new pptxgen();
pres.defineLayout({name: 'WIDE', width: W, height: H});
pres.layout = 'WIDE';
pres.author = 'Team Datalake Face Auth';
pres.title = 'Datalake Face Auth';

let pageNo = 0;
const asset = (name) => path.join(__dirname, 'assets', name);

function slide() {
  const s = pres.addSlide();
  s.background = {color: C.bg};
  return s;
}

// thin L-shaped corner brackets (biometric-scanner motif)
function corners(s, color = C.green, op = 1) {
  const L = 0.42;
  const t = 0.045;
  const m = 0.32;
  const set = [
    [m, m, true, true],
    [W - m - L, m, false, true],
    [m, H - m - t, true, false],
    [W - m - L, H - m - t, false, false],
  ];
  for (const [x, y, left, top] of set) {
    s.addShape(pres.shapes.RECTANGLE, {
      x,
      y,
      w: L,
      h: t,
      fill: {color, transparency: (1 - op) * 100},
      line: {type: 'none'},
    });
    s.addShape(pres.shapes.RECTANGLE, {
      x: left ? x : x + L - t,
      y: top ? y : y - L + t,
      w: t,
      h: L,
      fill: {color, transparency: (1 - op) * 100},
      line: {type: 'none'},
    });
  }
}

function eyebrow(s, text, x, y) {
  s.addText(text.toUpperCase(), {
    x,
    y,
    w: 8,
    h: 0.3,
    fontFace: HEAD,
    fontSize: 12,
    color: C.green,
    charSpacing: 3,
    bold: true,
    margin: 0,
  });
}

function title(s, text, x, y, w) {
  s.addText(text, {
    x,
    y,
    w: w || 11.5,
    h: 1,
    fontFace: HEAD,
    fontSize: 32,
    color: C.text,
    bold: true,
    margin: 0,
  });
}

function footer(s) {
  pageNo += 1;
  s.addText('DATALAKE FACE AUTH', {
    x: 0.6,
    y: H - 0.45,
    w: 4,
    h: 0.3,
    fontFace: HEAD,
    fontSize: 9,
    color: C.faint,
    charSpacing: 2,
    margin: 0,
  });
  s.addText('NHAI DATALAKE 3.0', {
    x: W - 4.6,
    y: H - 0.45,
    w: 3.4,
    h: 0.3,
    fontFace: HEAD,
    fontSize: 9,
    color: C.faint,
    align: 'right',
    charSpacing: 2,
    margin: 0,
  });
  s.addText(String(pageNo).padStart(2, '0'), {
    x: W - 1.05,
    y: H - 0.45,
    w: 0.4,
    h: 0.3,
    fontFace: HEAD,
    fontSize: 9,
    color: C.green,
    align: 'right',
    margin: 0,
  });
}

function card(s, x, y, w, h, fill = C.surf) {
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x,
    y,
    w,
    h,
    rectRadius: 0.08,
    fill: {color: fill},
    line: {color: C.line, width: 1},
  });
}

function stat(s, x, y, w, num, label, color = C.green) {
  s.addText(num, {
    x,
    y,
    w,
    h: 0.9,
    fontFace: HEAD,
    fontSize: 40,
    color,
    bold: true,
    align: 'left',
    margin: 0,
  });
  s.addText(label.toUpperCase(), {
    x,
    y: y + 0.92,
    w,
    h: 0.5,
    fontFace: HEAD,
    fontSize: 11,
    color: C.dim,
    charSpacing: 1,
    align: 'left',
    margin: 0,
  });
}

function bodyList(s, items, x, y, w, h, size = 15) {
  s.addText(
    items.map((t, i) => ({
      text: t,
      options: {
        bullet: {indent: 18},
        color: C.text,
        breakLine: i !== items.length - 1,
        paraSpaceAfter: 8,
      },
    })),
    {x, y, w, h, fontFace: BODY, fontSize: size, color: C.text, valign: 'top'},
  );
}

function scannerPhone(s, x, y, w, h) {
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x,
    y,
    w,
    h,
    rectRadius: 0.18,
    fill: {color: C.surf2},
    line: {color: C.line, width: 1.2},
    shadow: {type: 'outer', color: '000000', blur: 3, offset: 1.5, angle: 45, opacity: 0.25},
  });
  s.addShape(pres.shapes.RECTANGLE, {
    x: x + 0.22,
    y: y + 0.28,
    w: w - 0.44,
    h: h - 0.56,
    fill: {color: C.bg},
    line: {color: C.line, width: 0.8},
  });
  s.addShape(pres.shapes.OVAL, {
    x: x + 0.74,
    y: y + 0.78,
    w: w - 1.48,
    h: h - 1.9,
    fill: {color: C.bg, transparency: 100},
    line: {color: C.green, width: 2},
  });
  s.addShape(pres.shapes.LINE, {
    x: x + 0.4,
    y: y + 2.4,
    w: w - 0.8,
    h: 0,
    line: {color: C.green, width: 1.2, transparency: 15},
  });
  s.addShape(pres.shapes.RECTANGLE, {x: x + 0.45, y: y + 0.52, w: 0.42, h: 0.05, fill: {color: C.green}, line: {type: 'none'}});
  s.addShape(pres.shapes.RECTANGLE, {x: x + 0.45, y: y + 0.52, w: 0.05, h: 0.42, fill: {color: C.green}, line: {type: 'none'}});
  s.addShape(pres.shapes.RECTANGLE, {x: x + w - 0.87, y: y + 0.52, w: 0.42, h: 0.05, fill: {color: C.green}, line: {type: 'none'}});
  s.addShape(pres.shapes.RECTANGLE, {x: x + w - 0.5, y: y + 0.52, w: 0.05, h: 0.42, fill: {color: C.green}, line: {type: 'none'}});
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: x + 0.52,
    y: y + h - 0.95,
    w: w - 1.04,
    h: 0.38,
    rectRadius: 0.08,
    fill: {color: C.surf},
    line: {color: C.greenDk, width: 0.8},
  });
  s.addText('AUTH READY', {
    x: x + 0.52,
    y: y + h - 0.88,
    w: w - 1.04,
    h: 0.22,
    fontFace: HEAD,
    fontSize: 9.5,
    color: C.green,
    bold: true,
    align: 'center',
    margin: 0,
  });
}

// ───────────────────────── 1. TITLE ─────────────────────────
(() => {
  const s = slide();
  corners(s, C.green, 1);
  // brand mark
  s.addShape(pres.shapes.RECTANGLE, {x: 0.95, y: 2.15, w: 0.5, h: 0.22, fill: {color: C.green}, line: {type: 'none'}});
  s.addShape(pres.shapes.RECTANGLE, {x: 0.95, y: 2.45, w: 0.22, h: 0.22, fill: {color: C.green}, line: {type: 'none'}});
  s.addShape(pres.shapes.RECTANGLE, {x: 1.23, y: 2.45, w: 0.22, h: 0.22, fill: {color: C.greenDk}, line: {type: 'none'}});
  eyebrow(s, 'NHAI Innovation Hackathon 7.0  ·  Datalake 3.0', 0.95, 1.5);
  s.addText('Datalake Face Auth', {
    x: 0.9,
    y: 2.95,
    w: 8.6,
    h: 1.2,
    fontFace: HEAD,
    fontSize: 54,
    color: C.text,
    bold: true,
    margin: 0,
  });
  s.addText(
    'Secure offline facial recognition + liveness detection for field personnel in zero-network zones',
    {x: 0.95, y: 4.1, w: 8.8, h: 1, fontFace: BODY, fontSize: 19, color: C.dim, margin: 0},
  );
  scannerPhone(s, 10.15, 1.55, 2.25, 4.65);
  // chips
  const chips = ['React Native / Android + iOS', '100% offline auth', '~10.7 MB models'];
  let cx = 0.95;
  for (const ch of chips) {
    const w = 0.22 + ch.length * 0.105;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {x: cx, y: 5.35, w, h: 0.42, rectRadius: 0.08, fill: {color: C.surf}, line: {color: C.line, width: 1}});
    s.addText(ch, {x: cx, y: 5.35, w, h: 0.42, fontFace: HEAD, fontSize: 11, color: C.green, align: 'center', valign: 'middle', margin: 0});
    cx += w + 0.18;
  }
  s.addText(
    [
      {text: 'Android APK  ', options: {color: C.faint, fontFace: HEAD, fontSize: 9.5}},
      {text: APK_URL, options: {color: C.green, fontFace: HEAD, fontSize: 8.3, hyperlink: {url: APK_URL}}},
    ],
    {x: 0.95, y: 6.15, w: 11.9, h: 0.28, margin: 0},
  );
  s.addText(
    [
      {text: 'Web demo  ', options: {color: C.faint, fontFace: HEAD, fontSize: 10.5}},
      {text: 'nhai-three.vercel.app', options: {color: C.green, fontFace: HEAD, fontSize: 10.5, hyperlink: {url: 'https://nhai-three.vercel.app'}}},
    ],
    {x: 0.95, y: 6.55, w: 7, h: 0.32, margin: 0},
  );
})();

// ───────────────────────── 2. PROBLEM ─────────────────────────
(() => {
  const s = slide();
  eyebrow(s, 'The problem', 0.6, 0.55);
  title(s, 'Authenticating field staff where there is no network', 0.6, 0.95, 12);
  card(s, 0.6, 2.15, 12.1, 1.95, C.surf);
  s.addShape(pres.shapes.RECTANGLE, {x: 0.6, y: 2.15, w: 0.08, h: 1.95, fill: {color: C.green}, line: {type: 'none'}});
  s.addText(
    'How can we accurately and securely authenticate field personnel using facial recognition and liveness detection on standard mid-range mobile devices without any active internet connection, while keeping the AI model lightweight and integrated into a React Native app on both Android and iOS?',
    {x: 0.95, y: 2.35, w: 11.5, h: 1.6, fontFace: BODY, fontSize: 17, italic: true, color: C.text, valign: 'middle', margin: 0},
  );
  const constraints = [
    ['OFFLINE', 'Zero network in the auth path'],
    ['LIGHTWEIGHT', '~20 MB model budget'],
    ['FAST', '< 1 second per verification'],
    ['INCLUSIVE', 'Indian faces, outdoor light'],
  ];
  let x = 0.6;
  const w = 2.92;
  for (const [k, v] of constraints) {
    card(s, x, 4.5, w, 1.7);
    s.addText(k, {x: x + 0.25, y: 4.7, w: w - 0.4, h: 0.4, fontFace: HEAD, fontSize: 15, color: C.green, bold: true, margin: 0});
    s.addText(v, {x: x + 0.25, y: 5.15, w: w - 0.4, h: 0.9, fontFace: BODY, fontSize: 13, color: C.dim, margin: 0, valign: 'top'});
    x += w + 0.13;
  }
  footer(s);
})();

// ───────────────────────── 3. SOLUTION ─────────────────────────
(() => {
  const s = slide();
  eyebrow(s, 'Our solution', 0.6, 0.55);
  title(s, 'A fully offline biometric pipeline, on the device', 0.6, 0.95, 12);
  const rows = [
    ['On-device inference', 'Detection, liveness and recognition all run locally with bundled TFLite models. No image ever leaves the device.'],
    ['Dual liveness', 'Passive anti-spoof (MiniFASNet) plus an active blink / smile / turn challenge that defeats photos and screens.'],
    ['Lightweight + fast', 'MobileFaceNet + MiniFASNet at ~10.7 MB, CPU-only, with a measured sub-second recognition budget.'],
    ['Sync, then purge', 'Verified records queue locally and sync to AWS/Render only when the network returns, then purge.'],
  ];
  let y = 2.2;
  for (let i = 0; i < rows.length; i++) {
    const [h, d] = rows[i];
    s.addShape(pres.shapes.OVAL, {x: 0.7, y: y + 0.05, w: 0.5, h: 0.5, fill: {color: C.surf}, line: {color: C.green, width: 1.5}});
    s.addText(String(i + 1), {x: 0.7, y: y + 0.05, w: 0.5, h: 0.5, fontFace: HEAD, fontSize: 16, color: C.green, bold: true, align: 'center', valign: 'middle', margin: 0});
    s.addText(h, {x: 1.45, y, w: 4, h: 0.6, fontFace: HEAD, fontSize: 17, color: C.text, bold: true, margin: 0, valign: 'middle'});
    s.addText(d, {x: 5.4, y, w: 7.3, h: 0.95, fontFace: BODY, fontSize: 14, color: C.dim, margin: 0, valign: 'middle'});
    y += 1.12;
  }
  footer(s);
})();

// ───────────────────────── 4. ARCHITECTURE ─────────────────────────
(() => {
  const s = slide();
  eyebrow(s, 'Architecture', 0.6, 0.55);
  title(s, 'Auth on-device; the cloud is only a sync target', 0.6, 0.95, 12);
  // device block
  card(s, 0.6, 2.2, 7.4, 3.7, C.surf);
  s.addText('DEVICE  —  fully offline, scored', {x: 0.85, y: 2.4, w: 7, h: 0.4, fontFace: HEAD, fontSize: 13, color: C.green, bold: true, charSpacing: 1, margin: 0});
  const steps = ['Camera', 'Face detect', 'Quality gates', 'Liveness', 'Recognition', 'Auth score', 'Encrypted queue'];
  let yy = 2.95;
  for (let i = 0; i < steps.length; i++) {
    card(s, 0.95, yy, 6.7, 0.36, C.surf2);
    s.addText(steps[i], {x: 1.15, y: yy, w: 6.3, h: 0.36, fontFace: BODY, fontSize: 13, color: C.text, valign: 'middle', margin: 0});
    yy += 0.405;
  }
  // arrow
  s.addShape(pres.shapes.RIGHT_ARROW, {x: 8.15, y: 3.7, w: 0.75, h: 0.6, fill: {color: C.greenDk}, line: {type: 'none'}});
  s.addText('on reconnect', {x: 7.95, y: 4.35, w: 1.2, h: 0.3, fontFace: HEAD, fontSize: 9, color: C.faint, align: 'center', margin: 0});
  // cloud block
  card(s, 9.1, 2.2, 3.6, 3.7, C.surf);
  s.addText('AWS / RENDER  —  not in auth path', {x: 9.3, y: 2.4, w: 3.4, h: 0.5, fontFace: HEAD, fontSize: 12, color: C.amber, bold: true, margin: 0, valign: 'top'});
  const cloud = ['POST /api/sync', 'Validate + store', 'Device purges queue', 'Ops dashboard + analytics'];
  let cy = 3.15;
  for (const c of cloud) {
    s.addText(c, {x: 9.35, y: cy, w: 3.2, h: 0.4, fontFace: BODY, fontSize: 13, color: C.dim, bullet: {indent: 14}, margin: 0});
    cy += 0.62;
  }
  s.addText('No recognition ever happens server-side. The device decides authentication entirely offline.', {x: 0.6, y: 6.05, w: 12, h: 0.5, fontFace: BODY, fontSize: 13, italic: true, color: C.faint, margin: 0});
  footer(s);
})();

// ───────────────────────── 5. PIPELINE ─────────────────────────
(() => {
  const s = slide();
  eyebrow(s, 'How a verification works', 0.6, 0.55);
  title(s, 'Detect → liveness → recognize → score → sync', 0.6, 0.95, 12);
  const flow = [
    ['Quality gates', 'One face, frontal pose, adequate light'],
    ['Active liveness', 'Randomized blink / smile / head-turn'],
    ['Recognition', '512-d embedding, multi-frame best match'],
    ['Composite score', 'Weighted 0-100 trust score'],
    ['Queue + sync', 'Record stored, then purged on sync'],
  ];
  const w = 2.34;
  let x = 0.6;
  for (let i = 0; i < flow.length; i++) {
    card(s, x, 2.5, w, 2.7);
    s.addShape(pres.shapes.OVAL, {x: x + w / 2 - 0.32, y: 2.75, w: 0.64, h: 0.64, fill: {color: C.surf2}, line: {color: C.green, width: 1.5}});
    s.addText(String(i + 1), {x: x + w / 2 - 0.32, y: 2.75, w: 0.64, h: 0.64, fontFace: HEAD, fontSize: 20, color: C.green, bold: true, align: 'center', valign: 'middle', margin: 0});
    s.addText(flow[i][0], {x: x + 0.15, y: 3.6, w: w - 0.3, h: 0.7, fontFace: HEAD, fontSize: 14, color: C.text, bold: true, align: 'center', margin: 0, valign: 'top'});
    s.addText(flow[i][1], {x: x + 0.15, y: 4.25, w: w - 0.3, h: 0.85, fontFace: BODY, fontSize: 12, color: C.dim, align: 'center', margin: 0, valign: 'top'});
    if (i < flow.length - 1) {
      s.addText('›', {x: x + w - 0.06, y: 3.5, w: 0.3, h: 0.6, fontFace: HEAD, fontSize: 26, color: C.greenDk, align: 'center', margin: 0});
    }
    x += w + 0.1;
  }
  s.addText('A static photo cannot complete the live challenge — so print and screen spoofs are rejected before recognition.', {x: 0.6, y: 5.6, w: 12, h: 0.5, fontFace: BODY, fontSize: 13, italic: true, color: C.faint, margin: 0});
  footer(s);
})();

// ───────────────────────── 6. LIVENESS ─────────────────────────
(() => {
  const s = slide();
  eyebrow(s, 'Anti-spoofing', 0.6, 0.55);
  title(s, 'Two layers of liveness defeat fraud', 0.6, 0.95, 12);
  card(s, 0.6, 2.2, 5.95, 3.9);
  s.addText('PASSIVE', {x: 0.9, y: 2.45, w: 5, h: 0.4, fontFace: HEAD, fontSize: 15, color: C.green, bold: true, margin: 0});
  s.addText('MiniFASNet anti-spoof', {x: 0.9, y: 2.9, w: 5.2, h: 0.4, fontFace: HEAD, fontSize: 13, color: C.text, margin: 0});
  bodyList(s, ['Silent RGB anti-spoof model (~5.7 MB)', 'Scores texture / depth cues per frame', 'Catches printed photos and replays', 'Runs on-device, no user effort'], 0.9, 3.45, 5.4, 2.4, 14);
  card(s, 6.75, 2.2, 5.95, 3.9);
  s.addText('ACTIVE', {x: 7.05, y: 2.45, w: 5, h: 0.4, fontFace: HEAD, fontSize: 15, color: C.green, bold: true, margin: 0});
  s.addText('Randomized challenge', {x: 7.05, y: 2.9, w: 5.2, h: 0.4, fontFace: HEAD, fontSize: 13, color: C.text, margin: 0});
  bodyList(s, ['Blink, smile or head-turn on demand', 'Randomized order within a 7s window', 'Verified from ML Kit eye/smile/pose', 'A photo or screen cannot respond live'], 7.05, 3.45, 5.4, 2.4, 14);
  s.addText('Blocked attempts are counted on-device and surfaced as a "presentation attacks blocked" KPI on the dashboard.', {x: 0.6, y: 6.25, w: 12, h: 0.5, fontFace: BODY, fontSize: 13, italic: true, color: C.faint, margin: 0});
  footer(s);
})();

// ───────────────────────── 7. DROWSINESS ─────────────────────────
(() => {
  const s = slide();
  eyebrow(s, 'Bonus  ·  on-device monitoring', 0.6, 0.55);
  title(s, 'Drowsiness & attention, from the same landmarks', 0.6, 0.95, 12);
  const metrics = [
    ['EAR', 'Eye openness per frame'],
    ['PERCLOS', '% eyes-closed over a window'],
    ['BLINK RATE', 'Fatigue indicator'],
    ['MICRO-SLEEP', 'Sustained eye closure'],
    ['LOOK-AWAY', 'Sustained head yaw'],
  ];
  let x = 0.6;
  const w = 2.34;
  for (const [k, v] of metrics) {
    card(s, x, 2.3, w, 1.95);
    s.addText(k, {x: x + 0.2, y: 2.55, w: w - 0.3, h: 0.5, fontFace: HEAD, fontSize: 15, color: C.green, bold: true, margin: 0});
    s.addText(v, {x: x + 0.2, y: 3.1, w: w - 0.35, h: 1, fontFace: BODY, fontSize: 13, color: C.dim, margin: 0, valign: 'top'});
    x += w + 0.1;
  }
  card(s, 0.6, 4.55, 12.1, 1.55, C.surf2);
  s.addText('No extra model, no network', {x: 0.9, y: 4.75, w: 11, h: 0.4, fontFace: HEAD, fontSize: 14, color: C.text, bold: true, margin: 0});
  s.addText('All metrics are derived on-device from the 68-point face landmarks already used for liveness. The snapshot is attached to each verified record and powers the dashboard’s fatigue analytics.', {x: 0.9, y: 5.2, w: 11.4, h: 0.8, fontFace: BODY, fontSize: 14, color: C.dim, margin: 0, valign: 'top'});
  footer(s);
})();

// ───────────────────────── 8. COMPOSITE SCORE ─────────────────────────
(() => {
  const s = slide();
  eyebrow(s, 'Innovation', 0.6, 0.55);
  title(s, 'A transparent, weighted Authentication Score', 0.6, 0.95, 12);
  s.addChart(
    pres.charts.PIE,
    [{name: 'Weights', labels: ['Recognition', 'Liveness', 'Alertness', 'Pose', 'Lighting'], values: [45, 25, 10, 10, 10]}],
    {
      x: 0.5,
      y: 2.1,
      w: 5.6,
      h: 4.4,
      chartColors: ['38E0A5', '1E7D5C', '2FA17A', '49B98F', '8FE9C8'],
      chartArea: {fill: {color: C.bg}},
      dataLabelColor: '07090B',
      dataLabelFontFace: HEAD,
      dataLabelFontSize: 11,
      showPercent: true,
      showValue: false,
      showLegend: true,
      legendPos: 'b',
      legendColor: C.dim,
      legendFontFace: HEAD,
      legendFontSize: 11,
    },
  );
  card(s, 6.5, 2.2, 6.2, 4.3);
  s.addText('Every signal becomes a 0-1 sub-score, multiplied by a weight, summed to a single score out of 100.', {x: 6.8, y: 2.45, w: 5.6, h: 0.9, fontFace: BODY, fontSize: 15, color: C.text, margin: 0, valign: 'top'});
  bodyList(
    s,
    [
      'Recognition (0.45) — match confidence from distance',
      'Liveness (0.25) — challenge passed',
      'Alertness (0.10) — not drowsy, eyes open',
      'Pose (0.10) — frontal head pose',
      'Lighting (0.10) — adequate illumination',
    ],
    6.8,
    3.4,
    5.7,
    2.1,
    13.5,
  );
  s.addText('Scores below 70 are flagged low-trust for review. Identical weighting on native and web.', {x: 6.8, y: 5.75, w: 5.7, h: 0.6, fontFace: BODY, fontSize: 12, italic: true, color: C.faint, margin: 0});
  footer(s);
})();

// ───────────────────────── 9. PERFORMANCE ─────────────────────────
(() => {
  const s = slide();
  eyebrow(s, 'Performance & footprint', 0.6, 0.55);
  title(s, 'Lightweight, sub-second, CPU-only', 0.6, 0.95, 12);
  card(s, 0.6, 2.2, 2.9, 2.0);
  stat(s, 0.85, 2.45, 2.5, '10.7', 'MB total models', C.green);
  card(s, 3.65, 2.2, 2.9, 2.0);
  stat(s, 3.9, 2.45, 2.5, '< 1s', 'recognize + match', C.green);
  card(s, 6.7, 2.2, 2.9, 2.0);
  stat(s, 6.95, 2.45, 2.5, '26', 'Android minSdk (8.0+)', C.green);
  card(s, 9.75, 2.2, 2.95, 2.0);
  stat(s, 10.0, 2.45, 2.5, '0', 'network calls in auth', C.green);
  s.addChart(
    pres.charts.BAR,
    [{name: 'MB', labels: ['Our models', '20 MB budget'], values: [10.7, 20]}],
    {
      x: 0.6,
      y: 4.5,
      w: 7.0,
      h: 2.3,
      barDir: 'bar',
      chartColors: ['38E0A5', '25323B'],
      chartColorsOpacity: [100, 100],
      chartArea: {fill: {color: C.bg}},
      catAxisLabelColor: C.dim,
      valAxisLabelColor: C.faint,
      catAxisLabelFontFace: HEAD,
      valAxisHidden: true,
      valGridLine: {style: 'none'},
      catGridLine: {style: 'none'},
      showValue: true,
      dataLabelColor: C.text,
      dataLabelFontFace: HEAD,
      dataLabelPosition: 'outEnd',
      showLegend: false,
      barGapWidthPct: 60,
    },
  );
  card(s, 8.0, 4.5, 4.7, 2.3, C.surf2);
  s.addText('Latency budget', {x: 8.3, y: 4.7, w: 4, h: 0.4, fontFace: HEAD, fontSize: 13, color: C.green, bold: true, margin: 0});
  bodyList(s, ['Detection + landmarks', 'Embedding extraction', 'Cosine match (~0 ms)', 'Measured live, shown per verify'], 8.3, 5.2, 4.1, 1.5, 13);
  footer(s);
})();

// ───────────────────────── 10. COMPLIANCE ─────────────────────────
(() => {
  const s = slide();
  eyebrow(s, 'Requirement compliance', 0.6, 0.55);
  title(s, 'Every constraint, mapped to the build', 0.6, 0.95, 12);
  const head = (t) => ({text: t, options: {fill: {color: C.surf2}, color: C.green, bold: true, fontFace: HEAD, fontSize: 12}});
  const cell = (t, c = C.text) => ({text: t, options: {color: c, fontFace: BODY, fontSize: 12.5, fill: {color: C.surf}}});
  const rows = [
    [head('Requirement'), head('Status'), head('Where')],
    [cell('React Native, Android + iOS'), cell('Met — Android APK builds; iOS project incl.', C.green), cell('app/')],
    [cell('Model ~20 MB'), cell('10.7 MB TFLite', C.green), cell('app/assets/models')],
    [cell('< 1s recognize + liveness'), cell('On-device latency budget', C.green), cell('benchmark / stat strip')],
    [cell('Android 8.0+, no GPU, 3 GB RAM'), cell('minSdk 26, CPU TFLite', C.green), cell('android/')],
    [cell('> 95% acc, Indian demographics'), cell('Baseline + documented validation', C.amber), cell('alignment doc')],
    [cell('Open-source only'), cell('MIT / Apache-2.0', C.green), cell('repo')],
    [cell('Offline liveness (blink/smile/turn)'), cell('Passive + active', C.green), cell('face/liveness')],
    [cell('Sync & purge (AWS)'), cell('Queue → POST → purge', C.green), cell('sync / backend')],
  ];
  s.addTable(rows, {
    x: 0.6,
    y: 2.15,
    w: 12.1,
    colW: [5.0, 4.6, 2.5],
    rowH: 0.46,
    border: {pt: 1, color: C.bg},
    align: 'left',
    valign: 'middle',
    autoPage: false,
  });
  footer(s);
})();

// ───────────────────────── 11. BONUS ─────────────────────────
(() => {
  const s = slide();
  eyebrow(s, 'Beyond the brief', 0.6, 0.55);
  title(s, 'Bonus capabilities that stand out', 0.6, 0.95, 12);
  const items = [
    ['Composite trust score', 'Weighted 0-100 score across all signals'],
    ['Drowsiness monitoring', 'PERCLOS, blink rate, micro-sleep, look-away'],
    ['Bilingual prompts + voice', 'Hindi or English, offline TTS, switchable'],
    ['Verifiable offline proof', '"0 network calls during auth" counter'],
    ['Latency budget', 'Per-verify ms breakdown, < 1s on-device'],
    ['Operations-ready records', 'Score, latency, fatigue and attack flags'],
  ];
  const w = 3.93;
  const hh = 1.72;
  let x = 0.6;
  let y = 2.25;
  items.forEach((it, i) => {
    card(s, x, y, w, hh);
    s.addShape(pres.shapes.OVAL, {x: x + 0.25, y: y + 0.28, w: 0.34, h: 0.34, fill: {color: C.green}, line: {type: 'none'}});
    s.addText(it[0], {x: x + 0.75, y: y + 0.22, w: w - 0.95, h: 0.5, fontFace: HEAD, fontSize: 14, color: C.text, bold: true, margin: 0, valign: 'middle'});
    s.addText(it[1], {x: x + 0.28, y: y + 0.78, w: w - 0.5, h: 0.8, fontFace: BODY, fontSize: 12.5, color: C.dim, margin: 0, valign: 'top'});
    x += w + 0.14;
    if ((i + 1) % 3 === 0) {
      x = 0.6;
      y += hh + 0.18;
    }
  });
  footer(s);
})();

// ───────────────────────── 12. STACK ─────────────────────────
(() => {
  const s = slide();
  eyebrow(s, 'Built with open-source', 0.6, 0.55);
  title(s, 'Tech stack', 0.6, 0.95, 12);
  const cols = [
    ['Native app (Android / iOS)', ['React Native 0.74', 'react-native-vision-camera', 'react-native-fast-tflite', 'ML Kit face detection', 'MMKV (encrypted store)', 'react-native-tts (offline voice)']],
    ['Browser demo (Vercel)', ['Vite + React + TypeScript', '@vladmandic/face-api', 'Web Speech API (offline TTS)', 'Playwright E2E']],
    ['Sync backend (AWS / Render)', ['Node + Express', 'PostgreSQL (optional) / in-memory', 'Docker + App Runner config', 'Server-rendered dashboard']],
  ];
  let x = 0.6;
  const w = 3.97;
  for (const [h, items] of cols) {
    card(s, x, 2.2, w, 4.1);
    s.addText(h, {x: x + 0.25, y: 2.4, w: w - 0.4, h: 0.7, fontFace: HEAD, fontSize: 14, color: C.green, bold: true, margin: 0, valign: 'top'});
    bodyList(s, items, x + 0.25, 3.15, w - 0.45, 3.0, 13.5);
    x += w + 0.13;
  }
  s.addText('All components are MIT or Apache-2.0 — no additional licensing required.', {x: 0.6, y: 6.5, w: 12, h: 0.4, fontFace: BODY, fontSize: 12, italic: true, color: C.faint, margin: 0});
  footer(s);
})();

// ───────────────────────── 13. DEMO / DEPLOY ─────────────────────────
(() => {
  const s = slide();
  eyebrow(s, 'Try it now', 0.6, 0.55);
  title(s, 'Android APK first, web demo optional', 0.6, 0.95, 12);
  const links = [
    ['ANDROID APK', APK_URL, APK_URL, 'Primary judge install. Fully offline native authentication with bundled models.', 'qr-github.png'],
    ['BROWSER DEMO', 'nhai-three.vercel.app', 'https://nhai-three.vercel.app', 'Open on a phone or laptop, allow the camera, enroll and verify.', 'qr-demo.png'],
    ['SOURCE CODE', 'github.com/perrysolid/NHAI', 'https://github.com/perrysolid/NHAI', 'Native app, web demo and backend, with full documentation.', 'qr-github.png'],
  ];
  let y = 2.2;
  for (const [k, label, url, desc, qr] of links) {
    card(s, 0.6, y, 12.1, 1.32);
    s.addText(k, {x: 0.9, y: y + 0.2, w: 3, h: 0.4, fontFace: HEAD, fontSize: 12, color: C.green, bold: true, charSpacing: 1, margin: 0});
    s.addText(
      [{text: label, options: {hyperlink: {url}, color: C.text, fontFace: HEAD, fontSize: k === 'ANDROID APK' ? 7.2 : 15, bold: true}}],
      {x: 0.9, y: y + 0.58, w: k === 'ANDROID APK' ? 10.25 : 5.15, h: 0.5, margin: 0},
    );
    s.addText(
      desc,
      k === 'ANDROID APK'
        ? {x: 0.9, y: y + 1.03, w: 10.1, h: 0.24, fontFace: BODY, fontSize: 9.5, color: C.dim, margin: 0}
        : {x: 5.75, y: y + 0.22, w: 5.45, h: 0.9, fontFace: BODY, fontSize: 12.5, color: C.dim, margin: 0, valign: 'middle'},
    );
    s.addShape(pres.shapes.RECTANGLE, {x: 11.42, y: y + 0.18, w: 0.94, h: 0.94, fill: {color: C.green}, line: {color: C.green, width: 0.5}});
    s.addImage({path: asset(qr), x: 11.48, y: y + 0.24, w: 0.82, h: 0.82});
    y += 1.5;
  }
  footer(s);
})();

// ───────────────────────── 14. JUDGE PACKAGE ─────────────────────────
(() => {
  const s = slide();
  eyebrow(s, 'Judge package', 0.6, 0.55);
  title(s, 'Installable mobile build is packaged with the repo', 0.6, 0.95, 12);

  card(s, 0.6, 2.05, 5.85, 3.95);
  s.addText('ANDROID APK', {x: 0.9, y: 2.3, w: 5, h: 0.4, fontFace: HEAD, fontSize: 15, color: C.green, bold: true, charSpacing: 1, margin: 0});
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {x: 0.9, y: 2.78, w: 3.35, h: 0.42, rectRadius: 0.08, fill: {color: C.green}, line: {type: 'none'}});
  s.addText(
    [{text: 'DOWNLOAD ANDROID APK', options: {hyperlink: {url: APK_URL}, color: C.bg, fontFace: HEAD, fontSize: 12.5, bold: true}}],
    {x: 0.9, y: 2.87, w: 3.35, h: 0.2, align: 'center', margin: 0},
  );
  bodyList(
    s,
    [
      'File: docs/deliverables/DatalakeFaceAuth-android-universal-release.apk',
      'One universal APK for judge phones: arm64-v8a + armeabi-v7a',
      'Release variant, version 1.0, package com.datalakefaceauth',
      'Bundled TFLite + ML Kit assets verified inside the APK',
    ],
    0.9,
    3.35,
    5.25,
    2.05,
    12.8,
  );
  s.addText('Gradle still emits smaller split APKs locally if architecture-specific installs are needed.', {x: 0.9, y: 5.55, w: 5.1, h: 0.32, fontFace: BODY, fontSize: 11.5, italic: true, color: C.faint, margin: 0});

  card(s, 6.75, 2.05, 5.95, 3.95);
  s.addText('iOS / IPA', {x: 7.05, y: 2.3, w: 5, h: 0.4, fontFace: HEAD, fontSize: 15, color: C.green, bold: true, charSpacing: 1, margin: 0});
  bodyList(
    s,
    [
      'iOS does not use APK files; judges need a signed IPA or TestFlight build',
      'React Native iOS project is included at app/ios/DatalakeFaceAuth.xcodeproj',
      'Build with Xcode after pod install, then archive with an Apple Team profile',
      'Offline auth code, storage flow and UI are shared from the same app source',
    ],
    7.05,
    2.9,
    5.3,
    2.45,
    12.8,
  );
  s.addText('We can archive iOS only when Apple signing credentials are available.', {x: 7.05, y: 5.55, w: 5.15, h: 0.32, fontFace: BODY, fontSize: 11.5, italic: true, color: C.faint, margin: 0});

  card(s, 0.6, 6.18, 12.1, 0.48, C.surf2);
  s.addText(
    [{text: `Direct APK: ${APK_URL}`, options: {hyperlink: {url: APK_URL}, color: C.green, fontFace: HEAD, fontSize: 7.8}}],
    {x: 0.9, y: 6.28, w: 11.5, h: 0.24, margin: 0},
  );
  footer(s);
})();

// ───────────────────────── 15. ROADMAP / CLOSE ─────────────────────────
(() => {
  const s = slide();
  corners(s, C.green, 1);
  eyebrow(s, 'Honest roadmap', 0.95, 1.35);
  s.addText('Production-ready core, a clear path to scale', {x: 0.9, y: 1.8, w: 11.5, h: 1, fontFace: HEAD, fontSize: 34, color: C.text, bold: true, margin: 0});
  bodyList(
    s,
    [
      'Swap MobileFaceNet for INT8 EdgeFace-S to shrink the recognition model further',
      'Fine-tune on IndicFairFace for diverse Indian-demographic robustness',
      'On-device benchmarking across mid-range hardware to certify > 95% and < 1s',
      'Drop the FaceEngine into the existing Datalake 3.0 React Native screens',
    ],
    0.95,
    3.0,
    11.4,
    2.0,
    15,
  );
  s.addText('Thank you', {x: 0.9, y: 5.55, w: 6, h: 0.7, fontFace: HEAD, fontSize: 24, color: C.green, bold: true, margin: 0});
  s.addText('nhai-three.vercel.app   ·   github.com/perrysolid/NHAI', {x: 0.95, y: 6.25, w: 11, h: 0.4, fontFace: HEAD, fontSize: 12, color: C.dim, margin: 0});
})();

pres.writeFile({fileName: 'Datalake_Face_Auth_Deck.pptx'}).then((f) => {
  // eslint-disable-next-line no-console
  console.log('wrote', f);
});
