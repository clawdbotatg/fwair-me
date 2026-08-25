// fwairify — turn a Twitter pfp (or any image) into a fwair-style plush-in-a-glass-box.
//
// Usage:
//   node fwairify.mjs <@handle | image-path> [options]
//
// Options:
//   --out <file>       output png (default: out/<name>.png)
//   --quality <q>      low | medium | high (default high)
//   --n <count>        variants to generate (default 1; saved as name-1.png, name-2.png…)
//   --refs <count>     style reference images to send (default 3)
//   --keep-pfp         also save the fetched pfp next to the output
//
// Handle → pfp resolution: X API v2 if X_BEARER_TOKEN is set (loaded from
// clawd-twitter/.env when present), else unavatar.io. Style refs are sampled
// from example/*.avif (gitignored, decoded via sharp).

import OpenAI, { toFile } from "openai";
import sharp from "sharp";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
for (const env of [path.join(HERE, ".env"), "/Users/austingriffith/clawd/clawd-twitter/.env"]) {
  if (fs.existsSync(env)) {
    try { process.loadEnvFile(env); } catch {}
  }
}
if (!process.env.OPENAI_API_KEY) die("OPENAI_API_KEY missing (put it in .env)");

const args = process.argv.slice(2);
if (!args.length || args[0] === "--help") {
  console.log("usage: node fwairify.mjs <@handle | image-path> [--out f.png] [--quality high] [--n 1]");
  process.exit(args.length ? 0 : 1);
}
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const flag = (name) => args.includes(`--${name}`);

const input = args[0].replace(/^@/, "");
// Defaults tuned 2026-08-24: low quality + 1 ref (the bake-off winner) ≈
// $0.026/image and holds the style — high/3 refs (≈$0.24) looked no better at
// tweet size (see out/quality-compare.jpg, out/refs-compare.jpg, out/ref-pick-grid.jpg).
const quality = opt("quality", "low");
const nVariants = parseInt(opt("n", "1"), 10);
const nRefs = parseInt(opt("refs", "1"), 10);

function die(msg) { console.error(`fwairify: ${msg}`); process.exit(1); }

// ---------------------------------------------------------------- subject pfp
async function fetchPfp(handle) {
  const bearer = process.env.X_BEARER_TOKEN;
  if (bearer) {
    try {
      const r = await fetch(
        `https://api.x.com/2/users/by/username/${handle}?user.fields=profile_image_url`,
        { headers: { Authorization: `Bearer ${bearer}` } },
      );
      if (r.ok) {
        const j = await r.json();
        const raw = j?.data?.profile_image_url;
        if (raw?.includes("default_profile")) {
          const err = new Error(`@${handle} has no profile picture set — nothing to fwairify`);
          err.noPfp = true;
          throw err;
        }
        const url = raw?.replace("_normal", "_400x400");
        if (url) {
          const img = await fetch(url);
          if (img.ok) return Buffer.from(await img.arrayBuffer());
        }
      } else {
        console.warn(`  X API ${r.status} for @${handle}, falling back to unavatar`);
      }
    } catch (e) {
      if (e.noPfp) throw e;
      console.warn(`  X API failed (${e.message}), falling back to unavatar`);
    }
  }
  const r = await fetch(`https://unavatar.io/x/${handle}?fallback=false`);
  if (!r.ok) throw new Error(`could not resolve a pfp for @${handle} (unavatar ${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());
  // unavatar can serve Twitter's default silhouette instead of 404ing — compare
  // against a saved copy so we don't lovingly plushify the gray egg.
  try {
    const sig = async (b) => sharp(b).resize(16, 16, { fit: "fill" }).grayscale().raw().toBuffer();
    const [a, d] = await Promise.all([sig(buf), sig(await fsp.readFile(path.join(HERE, "assets", "default-avatar.png")))]);
    const diff = a.reduce((s, v, i) => s + Math.abs(v - d[i]), 0) / a.length;
    if (diff < 12) throw Object.assign(new Error(`@${handle} has no profile picture set — nothing to fwairify`), { noPfp: true });
  } catch (e) {
    if (e.noPfp) throw e; // sharp/read failures fall through — the guard is best-effort
  }
  return buf;
}

let subjectBuf, name;
if (fs.existsSync(input)) {
  subjectBuf = await fsp.readFile(input);
  name = path.basename(input).replace(/\.[^.]+$/, "");
} else {
  if (!/^[A-Za-z0-9_]{1,15}$/.test(input)) die(`"${input}" is neither a file nor a valid handle`);
  console.log(`fetching pfp for @${input} …`);
  try {
    subjectBuf = await fetchPfp(input);
  } catch (e) {
    die(e.message);
  }
  name = input.toLowerCase();
}
// normalize whatever we got (avif/webp/jpg, tiny sizes) to a clean square png
subjectBuf = await sharp(subjectBuf).resize(768, 768, { fit: "cover" }).png().toBuffer();

// Near-flat pfps (solid-color logos) give the model nothing to hold on to and
// it drifts into copying a style ref. Detect them and spell the subject out.
const stats = await sharp(subjectBuf).stats();
const maxStdev = Math.max(...stats.channels.slice(0, 3).map((c) => c.stdev));
let subjectHint = "";
if (maxStdev < 40) {
  const [r, g, b] = stats.channels.map((c) => Math.round(c.mean));
  subjectHint = `\nNOTE: the subject image is a minimal abstract logo (dominant color rgb(${r},${g},${b})). Do NOT render a person. The plush is that logo itself: a soft geometric plush of the same shape and exact color, with the signature black bead eyes, stuffed into the glass box.`;
}

const outFileBase = opt("out", path.join(HERE, "out", `${name}.png`));
await fsp.mkdir(path.dirname(outFileBase), { recursive: true });
if (flag("keep-pfp")) {
  const p = outFileBase.replace(/\.png$/, ".pfp.png");
  await fsp.writeFile(p, subjectBuf);
  console.log(`  saved source pfp → ${p}`);
}

// ---------------------------------------------------------------- style refs
// Curated spread: a clean simple one, a detailed human, and a non-human.
// Ranked by the 2026-08-24 single-ref bake-off (out/ref-pick-grid.jpg) plus
// Austin's call: pepe king is the best piece in the collection — lead ref.
const REF_POOL = [
  "eb72695a2e66542a7bd17a9cb001fbc9.avif", // pepe king — Austin's pick, non-human, accessories
  "343575df12a8a9beaff11fddc3ab3e96.avif", // grumpy guy — bake-off winner on squish/glass-press
  "5bb8312b9fef9f269466e1fd4ba7cfe2.avif", // man in suit — human detail, appliqué clothing
  "0d18fef85350986934e20510d922e0b0.avif", // beard + beanie + tattoos
  "1842265a88baafd960fbbaf45386fe2a.avif", // boy, teal shirt — generic, magnetic; keep last
];
// --ref <file.avif> pins a single specific reference from example/ (overrides --refs)
const pinnedRef = opt("ref", "");
const refList = pinnedRef
  ? [pinnedRef.endsWith(".avif") ? pinnedRef : pinnedRef + ".avif"]
  : REF_POOL.slice(0, nRefs);
const refFiles = [];
for (const f of refList) {
  const p = path.join(HERE, "example", f);
  if (!fs.existsSync(p)) continue;
  const png = await sharp(await fsp.readFile(p)).png().toBuffer();
  refFiles.push(await toFile(png, f.replace(/\.avif$/, ".png"), { type: "image/png" }));
}
if (!refFiles.length) die("no style refs found in example/ — restore the folder");

// ---------------------------------------------------------------- the prompt
const PROMPT = `The FIRST input image is the SUBJECT: someone's profile picture. Every other input image is a STYLE REFERENCE from the "fwair" collection — match their rendering style exactly.

Recreate the subject as a fwair plush: a chunky chibi stuffed toy squeezed snugly into a clear glass display cube that it completely fills, photographed straight-on.

Style rules (non-negotiable):
- The whole character is sewn from fuzzy bouclé terry fleece. EVERY detail — hair, eyebrows, facial hair, clothing, hats, glasses, jewelry, logos, tattoos — is built from soft fabric pieces, felt appliqué, or embroidery. Nothing is drawn, printed, or photographic.
- Proportions: an oversized head filling the upper two thirds of the box; a small squat seated body below; two big rounded feet pointing forward at the bottom corners; stubby arms squished flat against the side walls.
- The plush is comically overstuffed: the box is a size too small for it. Hair/head presses against the top pane, shoulders and arms squash flat against the side panes with visible bulging and creasing, feet press toward the front. Almost zero empty space inside the box — fabric touches all four inner walls.
- Eyes: glossy black plastic beads with two white specular highlights. This is the ONLY shiny non-fabric material.
- Likeness: keep the subject recognizable — hair style and color, skin/fur tone, facial hair, glasses, headwear, clothing type and colors, and any distinctive accessory, all translated into the plush fabric language. Simplify the face to the chibi idiom (small stitched mouth, felt brows) without losing who it is. If the subject is a logo, symbol, or abstract shape, the plush IS that shape sewn in fleece with its exact colors (e.g. a blue square logo becomes a squishy blue square plush with bead eyes stuffed in the box). If it is an animal or illustrated character, plushify that character.
- NEVER copy a person, character, or colors from the style references — they define rendering style only. The identity comes exclusively from the first image.
- Composition: perfectly square, frontal, the glass box's thin transparent frame visible along all four edges, soft even studio lighting, dark neutral background outside the glass, photorealistic product-photo rendering.
No text, no watermark.${subjectHint}`;

// ---------------------------------------------------------------- generate
const client = new OpenAI();
const subjectFile = await toFile(subjectBuf, "subject.png", { type: "image/png" });

console.log(`generating ${nVariants} image(s) with ${refFiles.length} style ref(s), quality=${quality} …`);
// note: gpt-image-2 rejects the input_fidelity param (gpt-image-1 only)
const result = await client.images.edit({
  model: "gpt-image-2",
  image: [subjectFile, ...refFiles],
  prompt: PROMPT,
  size: "1024x1024",
  quality,
  n: nVariants,
});

if (result.usage) {
  const u = result.usage;
  const cost = u.input_tokens * 8e-6 + u.output_tokens * 30e-6;
  console.log(`  usage: ${u.input_tokens} in + ${u.output_tokens} out ≈ $${cost.toFixed(3)}`);
}

const outs = [];
for (let i = 0; i < result.data.length; i++) {
  const b64 = result.data[i].b64_json;
  if (!b64) continue;
  const f = nVariants > 1 ? outFileBase.replace(/\.png$/, `-${i + 1}.png`) : outFileBase;
  await fsp.writeFile(f, Buffer.from(b64, "base64"));
  outs.push(f);
  console.log(`  ✓ ${f}`);
}
if (!outs.length) die("no image data in response");
