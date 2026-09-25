// Pintado de subtítulos (compartido por el content script y la página de test).
//
// - Español grande; opcionalmente el inglés original debajo (modo bilingüe).
// - Máximo 2 líneas por idioma: si no cabe, se quitan las frases más antiguas
//   y, si una sola frase no cabe, se recorta por delante con "…".
// - Sin parpadeos: el texto se actualiza en el sitio; solo hay transición de
//   opacidad al aparecer y al desaparecer.
// - Texto provisional (hipótesis parcial) en gris, a continuación del definitivo.

const MAX_LINES = 2;
const HIDE_AFTER_MS = 7000;
const KEEP_FINALS = 4;

export class SubtitleRenderer {
  constructor(doc = document) {
    this.doc = doc;
    this.finals = [];     // [{ id, es, en }]
    this.partial = null;  // { es, en }
    this.settings = { bilingual: false, showPartial: true };

    const el = (tag, cls) => {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      return e;
    };
    this.root = el('div');
    this.root.id = 'trtw-subtitle-container';
    this.root.setAttribute('aria-live', 'polite');
    this.pill = el('div', 'trtw-pill');
    this.box = el('div', 'trtw-box');
    this.esLine = el('div', 'trtw-line trtw-es');
    this.enLine = el('div', 'trtw-line trtw-en');
    this.box.append(this.esLine, this.enLine);
    this.root.append(this.pill, this.box);
  }

  mount(parent) {
    if (this.root.parentElement !== parent) parent.appendChild(this.root);
    this.render();
  }

  unmount() {
    this.root.remove();
  }

  get mounted() {
    return this.root.isConnected;
  }

  applySettings(s) {
    this.settings = { ...this.settings, ...s };
    const st = this.root.style;
    if (s.fontSize) st.setProperty('--trtw-font-size', s.fontSize + 'px');
    if (s.textColor) st.setProperty('--trtw-text-color', s.textColor);
    if (s.bgOpacity != null) st.setProperty('--trtw-bg', `rgba(0, 0, 0, ${s.bgOpacity})`);
    this.root.classList.toggle('trtw-top', s.subtitlePosition === 'top');
    this.render();
  }

  // msg: { kind: 'partial' | 'final', id, en, es }
  update(msg) {
    if (msg.kind === 'final') {
      this.finals.push({ id: msg.id, es: msg.es || msg.en, en: msg.en });
      if (this.finals.length > KEEP_FINALS) this.finals.shift();
    } else {
      this.partial = msg.en ? { es: msg.es, en: msg.en } : null;
    }
    this.render();
    this._armHide();
  }

  clear() {
    this.finals = [];
    this.partial = null;
    clearTimeout(this.hideTimer);
    this.render();
  }

  // Aviso pequeño (cargando, errores…). null lo oculta.
  setStatus(text, { timeout = 0, error = false } = {}) {
    clearTimeout(this.pillTimer);
    this.pill.textContent = text || '';
    this.pill.classList.toggle('trtw-visible', !!text);
    this.pill.classList.toggle('trtw-error', !!error);
    if (text && timeout) this.pillTimer = setTimeout(() => this.setStatus(null), timeout);
  }

  _armHide() {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      this.finals = [];
      this.partial = null;
      this.render();
    }, HIDE_AFTER_MS);
  }

  render() {
    const partial = this.settings.showPartial ? this.partial : null;
    const hasText = this.finals.length > 0 || !!partial;
    this.box.classList.toggle('trtw-visible', hasText);
    const showEn = this.settings.bilingual && hasText;
    this.enLine.style.display = showEn ? '' : 'none';
    if (!this.mounted) return;
    if (!hasText) {
      this.esLine.textContent = '';
      this.enLine.textContent = '';
      return;
    }

    // Candidatos de más a menos contenido. Las dos líneas usan las MISMAS
    // frases para que el inglés corresponda siempre al español.
    const n = this.finals.length;
    const candidates = [];
    for (let start = 0; start < n; start++) candidates.push({ start, withPartial: true });
    if (n) candidates.push({ start: n - 1, withPartial: false }); // la última frase manda
    else candidates.push({ start: 0, withPartial: true });

    for (const c of candidates) {
      this._paintBoth(c.start, c.withPartial ? partial : null, showEn);
      if (this._fits(this.esLine) && (!showEn || this._fits(this.enLine))) return;
    }

    // Ni la última frase cabe sola: la recortamos por delante con "…".
    this._trimFront(this.esLine, n ? this.finals[n - 1].es : partial.es || partial.en, !n);
    if (showEn) this._trimFront(this.enLine, n ? this.finals[n - 1].en : partial.en, !n);
  }

  _paintBoth(start, partial, showEn) {
    const list = this.finals.slice(start);
    this._paint(this.esLine, list.map((f) => f.es), partial ? partial.es || partial.en : '');
    if (showEn) this._paint(this.enLine, list.map((f) => f.en), partial ? partial.en : '');
  }

  _paint(line, sentences, partial) {
    line.textContent = '';
    const fin = this.doc.createElement('span');
    fin.className = 'trtw-final';
    fin.textContent = sentences.join(' ');
    const par = this.doc.createElement('span');
    par.className = 'trtw-partial';
    par.textContent = partial ? (sentences.length ? ' ' : '') + partial : '';
    line.append(fin, par);
  }

  _fits(line) {
    const lineHeight = parseFloat(getComputedStyle(line).lineHeight) || 30;
    return line.getBoundingClientRect().height <= lineHeight * MAX_LINES + 2;
  }

  _trimFront(line, text, isPartial) {
    const words = String(text || '').split(' ');
    while (words.length > 1) {
      words.shift();
      if (isPartial) this._paint(line, ['…'], words.join(' '));
      else this._paint(line, ['… ' + words.join(' ')], '');
      if (this._fits(line)) return;
    }
  }
}
