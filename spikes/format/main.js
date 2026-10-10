import * as alphaTab from '@coderline/alphatab';
import abcjs from 'abcjs';

const load = (p) => fetch(p).then((r) => r.text());
const done = {};
window.__spikeDone = done;

function renderAlphaTex(el, tex, key) {
  const api = new alphaTab.AlphaTabApi(el, {
    core: { fontDirectory: '/node_modules/@coderline/alphatab/dist/font/', useWorkers: false, engine: 'svg' },
    display: { layoutMode: 'page', scale: 0.9 },
    notation: { elements: new Map([[alphaTab.NotationElement.EffectDynamics, false]]) },
    player: { enablePlayer: false },
  });
  api.error.on((e) => { el.insertAdjacentHTML('beforebegin', `<p class="error">${key}: ${e.message ?? e}</p>`); done[key] = 'error'; });
  api.renderFinished.on(() => { done[key] = 'ok'; });
  api.scoreLoaded.on((score) => {
    const diags = api.score?.diagnostics ?? [];
    if (diags.length) el.insertAdjacentHTML('beforebegin', `<pre class="error">${JSON.stringify(diags)}</pre>`);
  });
  try {
    api.tex(tex, [0, 1]);
  } catch (e) {
    el.insertAdjacentHTML('beforebegin', `<p class="error">${key}: ${e.message}</p>`);
    done[key] = 'error';
  }
}

// Minimal ChordPro -> {meta, sections, parts} for the spike only.
function parseContainer(text) {
  const meta = {};
  const chart = [];
  const parts = {};
  let part = null;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^\{start_of_part:\s*(.+)\}$/))) { part = m[1]; parts[part] = []; continue; }
    if (line === '{end_of_part}') { part = null; continue; }
    if (part) { parts[part].push(line); continue; }
    if ((m = line.match(/^\{(title|key|tempo|time):\s*(.+)\}$/))) { meta[m[1]] = m[2]; continue; }
    if ((m = line.match(/^\{start_of_\w+:\s*(.+)\}$/))) { chart.push({ section: m[1] }); continue; }
    if (line.startsWith('{') || line === '') continue;
    chart.push({ line });
  }
  return { meta, chart, parts };
}

function chordRow(line) {
  let chords = '';
  let lyrics = '';
  const re = /\[([^\]]*)\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(line))) {
    lyrics += line.slice(last, m.index);
    // East Asian chars are ~2 columns wide in monospace.
    const width = [...lyrics].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
    chords = chords.padEnd(width) + m[1] + ' ';
    last = re.lastIndex;
  }
  lyrics += line.slice(last);
  return { chords, lyrics };
}

function toAlphaTex({ meta, parts }) {
  const [num, den] = (meta.time ?? '4/4').split('/');
  const tracks = Object.entries(parts).map(([name, body]) => {
    const drums = /drum/i.test(name);
    const head = drums
      ? '\\instrument percussion\n\\articulation HH 42\n\\articulation SD 38\n\\articulation BD 36\n\\articulation CR 49\n\\clef neutral'
      : '\\staff {score}';
    return `\\track "${name}"\n${head}\n\\ts ${num} ${den}\n${body.join('\n')}`;
  });
  return `\\title "${meta.title}"\n\\tempo ${meta.tempo}\n.\n${tracks.join('\n\n')}`;
}

const [a, b, c] = await Promise.all([
  load('./samples/a-alphatex.atex'),
  load('./samples/b-abc.abc'),
  load('./samples/c-chordpro.cho'),
]);

document.querySelector('#a .src').textContent = a;
renderAlphaTex(document.querySelector('#a .out'), a, 'a');

document.querySelector('#b .src').textContent = b;
try {
  const [tune] = abcjs.renderAbc(document.querySelector('#b .out'), b, { staffwidth: 1000, add_classes: true });
  const warnings = tune?.warnings ?? [];
  if (warnings.length) document.querySelector('#b .out').insertAdjacentHTML('beforebegin', `<pre class="error">${warnings.join('\n')}</pre>`);
  done.b = 'ok';
} catch (e) {
  document.querySelector('#b .out').insertAdjacentHTML('beforebegin', `<p class="error">${e.message}</p>`);
  done.b = 'error';
}

document.querySelector('#c .src').textContent = c;
const parsed = parseContainer(c);
const chartEl = document.querySelector('#c .chart');
chartEl.insertAdjacentHTML('beforeend', `<h3>${parsed.meta.title} (Key: ${parsed.meta.key})</h3>`);
for (const item of parsed.chart) {
  if (item.section) { chartEl.insertAdjacentHTML('beforeend', `<h4>[${item.section}]</h4>`); continue; }
  const { chords, lyrics } = chordRow(item.line);
  chartEl.insertAdjacentHTML('beforeend', `<div class="line"><span class="chord">${chords}</span>\n${lyrics}</div>`);
}
renderAlphaTex(document.querySelector('#c .out'), toAlphaTex(parsed), 'c');
