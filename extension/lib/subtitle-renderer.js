// Pintado de subtítulos (compartido por el content script y la página de test).
//
// Dos estilos (ajuste `subtitleMode`):
//
//  - 'phrase' (por defecto, como en las plataformas de vídeo): cada frase
//    nueva SUSTITUYE a la anterior. Se mantiene en pantalla lo necesario para
//    leerla y, si no cabe en 2 líneas, se divide en "páginas" que se muestran
//    una tras otra. El texto provisional (gris) aparece solo cuando ya ha dado
//    tiempo a leer la frase, y nunca pegado a ella.
//
//  - 'rolling' (continuo): las frases se van acumulando y la más antigua sale
//    por arriba; el provisional va detrás, en gris.
//
// En ambos: español grande, inglés opcional debajo (bilingüe), máximo 2
// líneas por idioma y sin parpadeos (solo hay transición al aparecer y al
// desaparecer).

const MAX_LINES = 2;
const HIDE_AFTER_MS = 7000;
const KEEP_FINALS = 4;
// Un provisional vacío (fin de locución) llega justo antes de la frase
// confirmada: esperamos un poco antes de borrarlo para no parpadear.
const EMPTY_PARTIAL_GRACE_MS = 1500;

// Tiempo de lectura de un texto: ~20 caracteres por segundo, entre 1,2 y 5 s.
// (En directo no puede ser mucho más: una frase nueva siempre sustituye a la actual.)
export function readingMs(text) {
  return Math.min(5000, Math.max(1200, String(text || '').length * 50));
}

export class SubtitleRenderer {
  constructor(doc = document, { now } = {}) {
    this.doc = doc;
    this.now = now || (() => Date.now());
    this.finals = [];     // [{ id, es, en }] (modo continuo)
    this.current = null;  // frase en pantalla (modo frase): { es, en, pages, page, pageShownAt }
    this.partial = null;  // { es, en }
    this.settings = { bilingual: false, showPartial: true, subtitleMode: 'phrase' };

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
    this._repaginate();
    this.render();
  }

  unmount() {
    clearTimeout(this.tickTimer);
    this.root.remove();
  }

  get mounted() {
    return this.root.isConnected;
  }

  get phraseMode() {
    return this.settings.subtitleMode !== 'rolling';
  }

  applySettings(s) {
    this.settings = { ...this.settings, ...s };
    const st = this.root.style;
    if (s.fontSize) st.setProperty('--trtw-font-size', s.fontSize + 'px');
    if (s.textColor) st.setProperty('--trtw-text-color', s.textColor);
    if (s.bgOpacity != null) st.setProperty('--trtw-bg', `rgba(0, 0, 0, ${s.bgOpacity})`);
    this.root.classList.toggle('trtw-top', s.subtitlePosition === 'top');
    this._repaginate(); // el tamaño de letra cambia lo que cabe
    this.render();
  }

  // msg: { kind: 'partial' | 'final', id, en, es }
  update(msg) {
    if (msg.kind === 'final') {
      const f = { id: msg.id, es: msg.es || msg.en, en: msg.en };
      this.finals.push(f);
      if (this.finals.length > KEEP_FINALS) this.finals.shift();
      // La frase confirmada sustituye a lo que hubiera (incluido el provisional:
      // enseguida llegará el siguiente).
      this.current = { ...f, pages: null, page: 0, pageShownAt: this.now(), retired: false };
      this.partial = null;
      clearTimeout(this.partialClearTimer);
    } else if (msg.en) {
      clearTimeout(this.partialClearTimer);
      this.partial = { es: msg.es, en: msg.en };
    } else if (this.partial) {
      clearTimeout(this.partialClearTimer);
      this.partialClearTimer = setTimeout(() => {
        this.partial = null;
        this.render();
      }, EMPTY_PARTIAL_GRACE_MS);
      return;
    }
    this.render();
    this._armHide();
  }

  clear() {
    this.finals = [];
    this.current = null;
    this.partial = null;
    clearTimeout(this.hideTimer);
    clearTimeout(this.tickTimer);
    clearTimeout(this.partialClearTimer);
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

  _armHide(ms = HIDE_AFTER_MS) {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      this.finals = [];
      this.current = null;
      this.partial = null;
      this.render();
    }, ms);
  }

  _repaginate() {
    if (this.current) {
      this.current.pages = null;
      this.current.page = 0;
    }
  }

  // ── Pintado ────────────────────────────────────────────────

  render() {
    clearTimeout(this.tickTimer);
    const showPartial = this.settings.showPartial;
    const hasText = this.phraseMode
      ? (!!this.current && !this.current.retired) || (showPartial && !!this.partial)
      : this.finals.length > 0 || (showPartial && !!this.partial);
    this.box.classList.toggle('trtw-visible', hasText);
    const showEn = this.settings.bilingual && hasText;
    this.enLine.style.display = showEn ? '' : 'none';
    if (!this.mounted) return;
    if (!hasText) {
      this.esLine.textContent = '';
      this.enLine.textContent = '';
      return;
    }
    if (this.phraseMode) this._renderPhrase(showEn);
    else this._renderRolling(showEn);
  }

  // Modo frase: o la frase actual (página a página) o el provisional, nunca juntos.
  _renderPhrase(showEn) {
    const cur = this.current && !this.current.retired ? this.current : null;
    const partial = this.settings.showPartial ? this.partial : null;
    const now = this.now();

    if (cur) {
      if (!cur.pages) cur.pages = this._paginate(this.esLine, cur.es);
      // Avanza páginas según el tiempo de lectura de cada una.
      while (cur.page < cur.pages.length - 1 && now - cur.pageShownAt >= readingMs(cur.pages[cur.page])) {
        cur.pageShownAt += readingMs(cur.pages[cur.page]);
        cur.page++;
      }
      const pageText = cur.pages[cur.page];
      const readUntil = cur.pageShownAt + readingMs(pageText);
      const lastPage = cur.page === cur.pages.length - 1;

      if (!(lastPage && partial && now >= readUntil)) {
        const more = cur.pages.length > 1 && !lastPage ? ' …' : '';
        this._paint(this.esLine, [pageText + more], '');
        if (showEn) this._fitHead(this.enLine, cur.en);
        // Siguiente cambio: otra página o, si hay provisional, mostrarlo.
        if (!lastPage || partial) this._tick(readUntil - now);
        if (!lastPage) this._armHide(readUntil - now + HIDE_AFTER_MS);
        return;
      }
      // Ya leída y hay algo nuevo: la frase se retira y no vuelve a aparecer.
      cur.retired = true;
    }

    // Provisional solo (lo último que se está diciendo): se ve el final.
    this._paint(this.esLine, [], partial.es || partial.en);
    if (!this._fits(this.esLine)) this._trimFront(this.esLine, partial.es || partial.en, true);
    if (showEn) {
      this._paint(this.enLine, [], partial.en);
      if (!this._fits(this.enLine)) this._trimFront(this.enLine, partial.en, true);
    }
  }

  _tick(ms) {
    clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(() => this.render(), Math.max(50, ms));
  }

  // Divide un texto en trozos que caben en MAX_LINES (por palabras).
  _paginate(line, text) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const pages = [];
    let cur = [];
    for (const w of words) {
      this._paint(line, [[...cur, w].join(' ') + ' …'], '');
      if (cur.length && !this._fits(line)) {
        pages.push(cur.join(' '));
        cur = [w];
      } else {
        cur.push(w);
      }
    }
    if (cur.length) pages.push(cur.join(' '));
    return pages.length ? pages : [''];
  }

  // Modo continuo: frases acumuladas + provisional detrás.
  _renderRolling(showEn) {
    const partial = this.settings.showPartial ? this.partial : null;
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

  // Si no cabe, muestra el FINAL del texto con "…" delante (lo más reciente).
  _trimFront(line, text, isPartial) {
    const words = String(text || '').split(' ');
    while (words.length > 1) {
      words.shift();
      if (isPartial) this._paint(line, ['…'], words.join(' '));
      else this._paint(line, ['… ' + words.join(' ')], '');
      if (this._fits(line)) return;
    }
  }

  // Si no cabe, muestra el PRINCIPIO del texto con "…" detrás.
  _fitHead(line, text) {
    this._paint(line, [text], '');
    if (this._fits(line)) return;
    const words = String(text || '').split(' ');
    while (words.length > 1) {
      words.pop();
      this._paint(line, [words.join(' ') + ' …'], '');
      if (this._fits(line)) return;
    }
  }
}
