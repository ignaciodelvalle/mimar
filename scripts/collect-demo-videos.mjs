// Collect Playwright demo recordings into tmp/demo-videos/ (gitignored) with stable names.
// The curated demo cut lives in the private companion repo (dim-interno:docs/demo/).
//
// Playwright writes each test's video to test-results/demo/<folder>/video.webm.
// One demo spec = one test = one segment, so we map each video to a segment file
// by the "NN-name" token in its folder (e.g. 01-publico) and copy it out.
//
// Usage: node scripts/collect-demo-videos.mjs
import fs from "node:fs";
import path from "node:path";

const SRC = "test-results/demo";
const OUT = "tmp/demo-videos";
fs.mkdirSync(OUT, { recursive: true });

function findVideos(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findVideos(full));
    else if (entry.name.endsWith(".webm")) out.push(full);
  }
  return out;
}

const videos = findVideos(SRC);
if (videos.length === 0) {
  console.log(
    `No .webm found under ${SRC}. Run: pnpm exec playwright test -c playwright.demo.config.ts`,
  );
  process.exit(0);
}

const manifest = [];
for (const v of videos) {
  const folder = path.basename(path.dirname(v));
  const m = folder.match(/(\d{2}-[a-z-]+?)(?:-segmento|-chromium|$)/i);
  const name = (m ? m[1] : folder).replace(/-+$/, "");
  const size = fs.statSync(v).size;
  const dest = path.join(OUT, `${name}.webm`);
  fs.copyFileSync(v, dest);
  manifest.push({ name, dest, sizeKB: Math.round(size / 1024) });
  console.log(`${name}.webm  <-  ${v}  (${Math.round(size / 1024)} KB)`);
}
console.log(`\nCollected ${manifest.length} segment(s) into ${OUT}/`);
