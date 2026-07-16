// Lock globale del viewer durante un'analisi T2*: mentre un job e' in corso, un overlay a schermo
// intero intercetta tutti gli eventi puntatore -> blocca l'interazione con i VIEWPORT e con la
// LISTA SERIE (selezione di altre sequenze). Serve a garantire che la serie SORGENTE non cambi
// durante l'analisi. Vive fuori da React (agganciato al singleton analysisTracker), cosi' e'
// attivo qualunque pannello sia montato.

import { analysisTracker } from './analysisTracker';

let overlay: HTMLDivElement | null = null;

function ensureOverlay(): HTMLDivElement {
  if (overlay) return overlay;
  const el = document.createElement('div');
  el.id = 'cardiomap-analysis-lock';
  Object.assign(el.style, {
    position: 'fixed', inset: '0', zIndex: '2147483000',
    background: 'rgba(0,0,0,0.55)', display: 'none',
    alignItems: 'center', justifyContent: 'center', flexDirection: 'column',
    gap: '14px', color: '#e0e0e0', fontFamily: 'sans-serif', cursor: 'wait',
  } as Partial<CSSStyleDeclaration>);
  // blocca ogni evento puntatore/tastiera sotto l'overlay (viewport + lista serie + toolbar)
  const stop = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
  ['click', 'dblclick', 'mousedown', 'mouseup', 'wheel', 'contextmenu',
   'pointerdown', 'pointerup', 'dragstart', 'keydown'].forEach(
    ev => el.addEventListener(ev, stop, { capture: true, passive: false } as any));

  const style = document.createElement('style');
  style.textContent = '@keyframes cm-spin{to{transform:rotate(360deg)}}';
  const spinner = document.createElement('div');
  Object.assign(spinner.style, {
    width: '44px', height: '44px', border: '4px solid #1565c0',
    borderTopColor: 'transparent', borderRadius: '50%', animation: 'cm-spin 1s linear infinite',
  } as Partial<CSSStyleDeclaration>);
  const msg = document.createElement('div');
  msg.id = 'cardiomap-lock-msg';
  Object.assign(msg.style, { fontSize: '15px', fontWeight: '600' } as Partial<CSSStyleDeclaration>);
  const sub = document.createElement('div');
  sub.textContent = 'Non cambiare serie o viewport fino al termine.';
  Object.assign(sub.style, { fontSize: '12px', color: '#9e9e9e' } as Partial<CSSStyleDeclaration>);

  el.append(style, spinner, msg, sub);
  document.body.appendChild(el);
  overlay = el;
  return el;
}

function update(): void {
  const { running, stage } = analysisTracker.getState();
  const el = ensureOverlay();
  if (running) {
    el.style.display = 'flex';
    const msg = el.querySelector('#cardiomap-lock-msg');
    if (msg) msg.textContent = 'Analisi T2* in corso' + (stage ? ' — ' + stage : '') + '… viewer bloccato';
  } else {
    el.style.display = 'none';
  }
}

let installed = false;
export function installAnalysisLock(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  analysisTracker.subscribe(update);
  update();
}
