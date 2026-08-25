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
// normalize whatever we got (avif/webp/jpg, tiny sizes) to a clean square png.
// 256px is deliberate: input images bill ~(px/16)² tokens capped at 1024, so
// 256px costs 256 tokens vs 1024 at ≥512px — with no visible quality loss
// (out/cheap-*.png vs out/size-test-768.png, 2026-08-24).
const rawPfp = subjectBuf;
subjectBuf = await sharp(subjectBuf).resize(256, 256, { fit: "cover" }).png().toBuffer();

// There is deliberately NO flat-logo classifier here. Two generations of it
// misfired (stdev<40 flagged auryn's dark portrait, entropy<3 flagged
// econoar's CryptoPunk — both got "do NOT render a person" and came out as
// blobs), and the trimmed prompt's own "an abstract logo becomes that shape
// itself" line handles real logos (base, all-white) without any hint —
// verified 2026-08-24, out/nohint-*.png.
const subjectHint = "";

const outFileBase = opt("out", path.join(HERE, "out", `${name}.png`));
await fsp.mkdir(path.dirname(outFileBase), { recursive: true });
if (flag("keep-pfp")) {
  const p = outFileBase.replace(/\.png$/, ".pfp.png");
  await fsp.writeFile(p, rawPfp);
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
// --ref <file[,file…]> pins specific reference(s) from example/ (overrides --refs)
const pinnedRef = opt("ref", "");
const refList = pinnedRef
  ? pinnedRef.split(",").map((f) => (f.endsWith(".avif") ? f : f + ".avif"))
  : REF_POOL.slice(0, nRefs);
const refFiles = [];
for (const f of refList) {
  const p = path.join(HERE, "example", f);
  if (!fs.existsSync(p)) continue;
  const png = await sharp(await fsp.readFile(p)).resize(256, 256).png().toBuffer();
  refFiles.push(await toFile(png, f.replace(/\.avif$/, ".png"), { type: "image/png" }));
}
if (!refFiles.length) die("no style refs found in example/ — restore the folder");

// ---------------------------------------------------------------- the prompt
// Trimmed 2026-08-24 (490 → ~245 tokens, same results — see out/cheap-trimprompt.png).
const PROMPT = `Turn the subject of the FIRST image (person, character, or logo) into a plush from the fwair collection, matching the rendering style of the other input image(s) exactly: a chunky chibi stuffed toy sewn entirely from fuzzy boucle fleece, comically overstuffed into a clear glass display cube it barely fits - oversized head pressed against the top pane, stubby arms and shoulders squashed flat against the side walls with visible bulging, two big rounded feet at the bottom front, fabric touching all four inner walls. Every detail (hair, brows, facial hair, glasses, hats, clothing, jewelry, tattoos, logos) is soft fabric, felt applique, or embroidery - nothing drawn or printed. The only shiny material: glossy black plastic bead eyes with two white highlights. Keep the subject clearly recognizable - hair style and color, skin tone, accessories, outfit colors - translated into fabric; simplify the face to the chibi idiom. An abstract logo becomes that shape itself sewn in fleece with bead eyes. Never copy identity or colors from the style reference. Square frontal product photo, thin glass frame visible on all four edges, soft even studio light, dark neutral background. No text, no watermark.${subjectHint}`;

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
