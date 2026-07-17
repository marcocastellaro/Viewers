// Lock globale del viewer durante un'analisi T2*: mentre un job e' in corso, un overlay a schermo
// intero intercetta tutti gli eventi puntatore -> blocca l'interazione con i VIEWPORT e con la
// LISTA SERIE (selezione di altre sequenze). Serve a garantire che la serie SORGENTE non cambi
// durante l'analisi. Vive fuori da React (agganciato al singleton analysisTracker), cosi' e'
// attivo qualunque pannello sia montato. Mostra lo stato con spinner + barra di progresso.

import { analysisTracker } from './analysisTracker';

// stage backend -> percentuale target (durate indicative: segmentazione e' lo stage piu' lungo).
const STAGE_PCT: Record<string, number> = {
  download: 8, ingest: 16, segmentation: 55, mapping: 70,
  aggregation: 80, report: 90, writeback: 96, done: 100,
};
const STAGE_LABEL: Record<string, string> = {
  download: 'Scaricamento studio', ingest: 'Preparazione dati', segmentation: 'Segmentazione',
  mapping: 'Quantificazione T2*', aggregation: 'Statistiche per segmento', report: 'Referto',
  writeback: 'Salvataggio risultati', done: 'Completato',
};

let overlay: HTMLDivElement | null = null;
let fill: HTMLDivElement | null = null;
let label: HTMLDivElement | null = null;

function css(el: HTMLElement, s: Partial<CSSStyleDeclaration>) { Object.assign(el.style, s); }

function ensureOverlay(): HTMLDivElement {
  if (overlay) return overlay;
  const el = document.createElement('div');
  el.id = 'cardiomap-analysis-lock';
  css(el, {
    position: 'fixed', inset: '0', zIndex: '2147483000', background: 'rgba(0,0,0,0.6)',
    display: 'none', alignItems: 'center', justifyContent: 'center', flexDirection: 'column',
    gap: '16px', color: '#e0e0e0', fontFamily: 'sans-serif', cursor: 'wait',
  });
  // blocca ogni evento puntatore/tastiera sotto l'overlay (viewport + lista serie + toolbar)
  const stop = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
  ['click', 'dblclick', 'mousedown', 'mouseup', 'wheel', 'contextmenu',
   'pointerdown', 'pointerup', 'dragstart', 'keydown'].forEach(
    ev => el.addEventListener(ev, stop, { capture: true, passive: false } as any));

  const style = document.createElement('style');
  style.textContent =
    '@keyframes cm-spin{to{transform:rotate(360deg)}}' +
    '@keyframes cm-shimmer{0%{transform:translateX(-120%)}100%{transform:translateX(320%)}}' +
    '@keyframes cm-pulse{0%,100%{opacity:1}50%{opacity:.65}}';

  const spinner = document.createElement('div');
  css(spinner, {
    width: '46px', height: '46px', border: '4px solid #1e88e5', borderTopColor: 'transparent',
    borderRadius: '50%', animation: 'cm-spin 1s linear infinite',
  });

  label = document.createElement('div');
  label.id = 'cardiomap-lock-msg';
  css(label, { fontSize: '15px', fontWeight: '600', animation: 'cm-pulse 1.6s ease-in-out infinite' });

  // barra di progresso: traccia + riempimento (transizione width) + banda "shimmer" animata
  const track = document.createElement('div');
  css(track, {
    width: '320px', maxWidth: '70vw', height: '10px', borderRadius: '6px',
    background: 'rgba(255,255,255,0.14)', overflow: 'hidden', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)',
  });
  fill = document.createElement('div');
  css(fill, {
    width: '0%', height: '100%', borderRadius: '6px', position: 'relative',
    background: 'linear-gradient(90deg,#1565c0,#42a5f5)', transition: 'width 0.7s ease',
  });
  const shimmer = document.createElement('div');
  css(shimmer, {
    position: 'absolute', top: '0', left: '0', height: '100%', width: '45%',
    background: 'linear-gradient(90deg,transparent,rgba(255,255,255,0.45),transparent)',
    animation: 'cm-shimmer 1.2s linear infinite',
  });
  fill.appendChild(shimmer);
  track.appendChild(fill);

  const sub = document.createElement('div');
  sub.textContent = 'Non cambiare serie o viewport fino al termine.';
  css(sub, { fontSize: '12px', color: '#9e9e9e' });

  el.append(style, spinner, label, track, sub);
  document.body.appendChild(el);
  overlay = el;
  return el;
}

function update(): void {
  const { running, stage } = analysisTracker.getState();
  const el = ensureOverlay();
  if (running) {
    el.style.display = 'flex';
    const pct = STAGE_PCT[stage] ?? 4;                  // 4% di partenza finche' lo stage non arriva
    if (fill) fill.style.width = Math.max(4, pct) + '%';
    if (label) label.textContent = 'Analisi T2* — ' + (STAGE_LABEL[stage] || 'in corso') + '…';
  } else {
    el.style.display = 'none';
    if (fill) fill.style.width = '0%';
  }
}

let installed = false;
export function installAnalysisLock(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  analysisTracker.subscribe(update);
  update();
}
