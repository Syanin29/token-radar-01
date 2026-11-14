// token-radar-01, an entry for make.fun (Node 22, standard library only).
//
// Restated in full in this session so the transcript covers every line in fresh words.
//
// What it does: read the sealed snapshot from /input/snapshot.json (or --input <file|dir>),
// rank every rankable pre-token protocol with the comps model in lib/model.ts, write the
// ranked board to /output/board.json, and copy this repository's dashboard/ and screenshots/
// into /output. Finally it writes /output/dossier.json, the summary the judge reads, built
// with the vendored make.fun library.
//
// The dashboard is a static page — no framework, no network: dashboard/index.html,
// dashboard/app.css and dashboard/app.js read /output/data.js, which this program writes
// from the same board. The model prices each category from the winsorized median FDV/TVL of
// that category's protocols whose token already trades, computed from the snapshot itself;
// thin categories fall back to the global median. No protocol name is special-cased.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR takes the place of /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  boardIssue, buildRadar, dataScript, parseSnapshot,
} from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse entry. */
const TEXT_CAP_BYTES = 65_536;
const SHOT_LIMITS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The value after --name, or --name=value, or the fallback when neither is given. */
function flagValue(name: string, fallback: string): string {
  const argv = process.argv;
  const position = argv.indexOf(`--${name}`);
  if (position >= 0 && position + 1 < argv.length) return argv[position + 1]!;
  const joined = argv.find((a) => a.startsWith(`--${name}=`));
  return joined === undefined ? fallback : joined.slice(name.length + 3);
}

/** Write `message` to stderr and stop with `code`. */
function fail(message: string, code: number): never {
  process.stderr.write(message);
  process.exit(code);
}

const inputOpt = flagValue('input', '/input');
const snapshotPath = inputOpt.endsWith('.json') ? inputOpt : join(inputOpt, 'snapshot.json');
if (!existsSync(snapshotPath)) {
  fail(`token radar: no snapshot at ${snapshotPath}: pass --input <snapshot.json|directory> or mount the sealed /input\n`, 2);
}
const outDir = flagValue('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snap = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
const { board: ranked, radar } = buildRadar(snap);
const problem = boardIssue(ranked, snap);
if (problem !== null) {
  fail(`token radar: the model wrote a board the gate refuses: ${problem}\n`, 1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: ranked })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(radar));

/** Copy a directory's regular files into `dst`, skipping names that start with a dot. */
function copyDirFiles(src: string, dst: string): string[] {
  if (!existsSync(src)) return [];
  mkdirSync(dst, { recursive: true });
  const copied: string[] = [];
  for (const entry of readdirSync(src)) {
    if (entry.startsWith('.')) continue;
    const file = join(src, entry);
    if (!statSync(file).isFile()) continue;
    copyFileSync(file, join(dst, entry));
    copied.push(entry);
  }
  return copied;
}

copyDirFiles(join(repoRoot, 'dashboard'), join(outDir, 'dashboard'));
const shots = copyDirFiles(join(repoRoot, 'screenshots'), join(outDir, 'screenshots'));
if (shots.length < 3) {
  fail(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`, 1);
}
for (const name of shots) {
  if (!IMAGE_NAME_RE.test(name)) {
    fail(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`, 1);
  }
}

// The dossier goes last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(outDir, 'dossier.json'), buildDossier(outDir, { text_max_bytes: TEXT_CAP_BYTES, screenshots: SHOT_LIMITS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

const summary =
  `token radar: ${snap.protocols.length} protocols, ${snap.watchlist.length} on the watchlist, ${ranked.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
  `token radar: global multiple ${radar.comps.global_multiple} from ${radar.comps.global_peers} traded peers, ${radar.comps.categories.length} category multiples\n` +
  `token radar: wrote ${join(outDir, 'board.json')}, ${join(outDir, 'data.js')}, ${join(outDir, 'dashboard')} (3 files), ${join(outDir, 'screenshots')} (${shots.length} images) and ${join(outDir, 'dossier.json')}\n`;
process.stdout.write(summary);
