// Um navegador de mentira para o node, sem dependencia nenhuma: DOM montado a
// partir do index.html de verdade, window/document com contagem de
// escutadores, canvas 2D que registra o que foi desenhado, AudioContext que
// so conta vozes e um localStorage em memoria. E o que deixa test/dom.mjs
// rodar iniciar(), ui.js e render.js inteiros — a fiacao que o smoke nao
// alcanca (pendencia 4).
//
// Fiel no que o jogo usa e estrito no resto: um metodo de DOM ou de canvas
// que o jogo passe a chamar e nao exista aqui estoura o teste, e e assim que
// se descobre. O que este arquivo NAO imita: layout e CSS. "Visivel" e so
// "nenhum ancestral com a classe `oculto`" (o display:none !important do
// style.css); geometria, sobreposicao de botoes e rolagem real sao conferidas
// no Chrome (handoff 14).

const VAZIOS = new Set(['meta', 'link', 'br', 'hr', 'img', 'input', 'source', 'area', 'base', 'col', 'wbr']);
const TEXTO_CRU = new Set(['script', 'style']);

// ------------------------------------------------------------------ eventos

// Um alvo de evento que conta quantos escutadores tem. A contagem e o que o
// teste de vazamento le: trocar de tela sem remover escutador e o vazamento
// mais provavel deste codigo (contrato da fase 14, tarefa 3).
class Alvo {
  constructor() {
    this._ouvintes = new Map();
  }
  addEventListener(tipo, fn) {
    if (typeof fn !== 'function') throw new Error(`addEventListener("${tipo}") sem funcao`);
    const lista = this._ouvintes.get(tipo) || [];
    if (lista.includes(fn)) return; // o navegador ignora a mesma funcao repetida
    lista.push(fn);
    this._ouvintes.set(tipo, lista);
  }
  removeEventListener(tipo, fn) {
    const lista = this._ouvintes.get(tipo);
    if (!lista) return;
    const i = lista.indexOf(fn);
    if (i >= 0) lista.splice(i, 1);
  }
  contarOuvintes() {
    let n = 0;
    for (const lista of this._ouvintes.values()) n += lista.length;
    return n;
  }
  disparar(tipo, ev = {}) {
    const lista = this._ouvintes.get(tipo);
    if (!lista) return ev;
    for (const fn of lista.slice()) fn.call(this, ev);
    return ev;
  }
}

function novoEvento(tipo, extra = {}) {
  const ev = {
    type: tipo,
    defaultPrevented: false,
    preventDefault() {
      ev.defaultPrevented = true;
    },
    stopPropagation() {},
    ...extra,
  };
  return ev;
}

// ------------------------------------------------------------------ elementos

class ListaDeClasses {
  constructor() {
    this._s = new Set();
  }
  add(...nomes) {
    for (const n of nomes) this._s.add(n);
  }
  remove(...nomes) {
    for (const n of nomes) this._s.delete(n);
  }
  contains(n) {
    return this._s.has(n);
  }
  toggle(n, forcar) {
    const ligar = forcar === undefined ? !this._s.has(n) : Boolean(forcar);
    if (ligar) this._s.add(n);
    else this._s.delete(n);
    return ligar;
  }
  get value() {
    return [...this._s].join(' ');
  }
}

class Estilo {
  setProperty(nome, valor) {
    this[nome] = String(valor);
  }
  removeProperty(nome) {
    delete this[nome];
  }
}

class Texto {
  constructor(dado) {
    this.nodeType = 3;
    this.data = dado;
    this.parentNode = null;
  }
  get textContent() {
    return this.data;
  }
}

class Elemento extends Alvo {
  constructor(doc, tag) {
    super();
    this.ownerDocument = doc;
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.localName = tag.toLowerCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.classList = new ListaDeClasses();
    this.style = new Estilo();
    this.title = '';
    this.href = '';
    this.download = '';
    this.type = '';
    if (this.localName === 'canvas') {
      this.width = 300;
      this.height = 150;
      this._ctx = null;
    }
  }

  get id() {
    return this.attributes.get('id') || '';
  }
  set id(v) {
    this.attributes.set('id', String(v));
  }
  get className() {
    return this.classList.value;
  }
  set className(v) {
    this.classList = new ListaDeClasses();
    for (const c of String(v).split(/\s+/)) if (c) this.classList.add(c);
  }
  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }
  get childElementCount() {
    return this.children.length;
  }
  get textContent() {
    let t = '';
    for (const n of this.childNodes) t += n.textContent;
    return t;
  }
  set textContent(v) {
    for (const n of this.childNodes) n.parentNode = null;
    this.childNodes = [];
    const t = String(v);
    if (t !== '') this._anexar(new Texto(t));
  }

  getAttribute(nome) {
    if (nome === 'class') return this.className;
    return this.attributes.has(nome) ? this.attributes.get(nome) : null;
  }
  setAttribute(nome, valor) {
    if (nome === 'class') this.className = valor;
    else this.attributes.set(nome, String(valor));
  }
  hasAttribute(nome) {
    return nome === 'class' ? this.classList.value !== '' : this.attributes.has(nome);
  }
  removeAttribute(nome) {
    this.attributes.delete(nome);
  }

  _anexar(no) {
    if (no.parentNode) no.parentNode._tirar(no);
    no.parentNode = this;
    this.childNodes.push(no);
  }
  _tirar(no) {
    const i = this.childNodes.indexOf(no);
    if (i >= 0) this.childNodes.splice(i, 1);
    no.parentNode = null;
  }
  appendChild(no) {
    this._anexar(no);
    return no;
  }
  append(...nos) {
    for (const no of nos) this._anexar(typeof no === 'string' ? new Texto(no) : no);
  }
  remove() {
    if (this.parentNode) this.parentNode._tirar(this);
  }

  // Visivel = ligado ao documento e sem `oculto` em si nem em nenhum
  // ancestral (o display:none !important de style.css).
  get conectado() {
    let no = this;
    while (no.parentNode) no = no.parentNode;
    return no === this.ownerDocument.documentElement;
  }
  get visivel() {
    if (!this.conectado) return false;
    for (let no = this; no && no.nodeType === 1; no = no.parentNode) {
      if (no.classList.contains('oculto')) return false;
    }
    return true;
  }
  getClientRects() {
    return this.visivel ? [{ width: 1, height: 1 }] : [];
  }
  get offsetWidth() {
    return this.visivel ? 1 : 0;
  }
  get offsetParent() {
    return this.visivel ? this.parentNode : null;
  }

  focus() {
    const doc = this.ownerDocument;
    if (doc.activeElement === this) return;
    const anterior = doc.activeElement;
    doc.activeElement = this;
    if (anterior && anterior !== doc.body) anterior.disparar('blur', novoEvento('blur', { target: anterior }));
    this.disparar('focus', novoEvento('focus', { target: this }));
  }
  blur() {
    const doc = this.ownerDocument;
    if (doc.activeElement !== this) return;
    doc.activeElement = doc.body;
    this.disparar('blur', novoEvento('blur', { target: this }));
  }
  // `elemento.click()` do DOM (baixarArquivo usa no <a download>).
  click() {
    const ev = novoEvento('click', { target: this, detail: 0 });
    this.disparar('click', ev);
    if (this.localName === 'a' && this.download) this.ownerDocument._baixados.push({ nome: this.download, href: this.href });
    return ev;
  }

  matches(seletor) {
    return casa(this, seletor);
  }
  closest(seletor) {
    for (let no = this; no && no.nodeType === 1; no = no.parentNode) if (casa(no, seletor)) return no;
    return null;
  }
  querySelectorAll(seletor) {
    const achados = [];
    percorrer(this, (no) => {
      if (no !== this && casa(no, seletor)) achados.push(no);
    });
    return achados;
  }
  querySelector(seletor) {
    return this.querySelectorAll(seletor)[0] || null;
  }

  getContext(tipo, opcoes) {
    if (this.localName !== 'canvas' || tipo !== '2d') return null;
    if (!this._ctx) this._ctx = criarContexto2d(this, opcoes);
    return this._ctx;
  }
}

function percorrer(raiz, visita) {
  visita(raiz);
  for (const filho of raiz.childNodes) if (filho.nodeType === 1) percorrer(filho, visita);
}

// Seletor simples, sem combinador: `tag`, `#id`, `.classe`, `[attr]`,
// `[attr="v"]`, e a soma deles (`button.botao[data-x]`). E tudo o que ui.js
// usa; um seletor fora disso lanca, para nao casar errado em silencio.
function casa(no, seletor) {
  const s = seletor.trim();
  if (/[\s>+~,:]/.test(s.replace(/\[[^\]]*\]/g, ''))) throw new Error(`dom-falso: seletor "${seletor}" nao suportado`);
  const partes = s.match(/(^[a-zA-Z][\w-]*)|(#[\w-]+)|(\.[\w-]+)|(\[[^\]]+\])/g) || [];
  if (partes.join('') !== s) throw new Error(`dom-falso: seletor "${seletor}" nao suportado`);
  for (const p of partes) {
    if (p[0] === '#') {
      if (no.id !== p.slice(1)) return false;
    } else if (p[0] === '.') {
      if (!no.classList.contains(p.slice(1))) return false;
    } else if (p[0] === '[') {
      const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(p);
      if (!m) throw new Error(`dom-falso: seletor "${seletor}" nao suportado`);
      if (!no.hasAttribute(m[1])) return false;
      if (m[2] !== undefined && no.getAttribute(m[1]) !== m[2]) return false;
    } else if (no.localName !== p.toLowerCase()) {
      return false;
    }
  }
  return true;
}

// ------------------------------------------------------------------ html

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodificar(t) {
  return t.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (inteiro, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTIDADES[e] !== undefined ? ENTIDADES[e] : inteiro;
  });
}

// O index.html do jogo, sem tolerancia a html torto: tag que fecha sem ter
// aberto lanca. Devolve o <html>.
function montarHtml(doc, html) {
  let raiz = null;
  const pilha = [];
  let i = 0;
  const topo = () => pilha[pilha.length - 1];
  while (i < html.length) {
    if (html.startsWith('<!--', i)) {
      const fim = html.indexOf('-->', i);
      i = fim < 0 ? html.length : fim + 3;
      continue;
    }
    if (html.startsWith('<!', i)) {
      i = html.indexOf('>', i) + 1;
      continue;
    }
    if (html.startsWith('</', i)) {
      const fim = html.indexOf('>', i);
      const tag = html.slice(i + 2, fim).trim().toLowerCase();
      const aberto = pilha.pop();
      if (!aberto || aberto.localName !== tag) throw new Error(`dom-falso: </${tag}> fecha <${aberto ? aberto.localName : 'nada'}>`);
      i = fim + 1;
      continue;
    }
    if (html[i] === '<') {
      const m = /^<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/.exec(html.slice(i));
      if (!m) throw new Error(`dom-falso: tag ilegivel perto de ${JSON.stringify(html.slice(i, i + 40))}`);
      const tag = m[1].toLowerCase();
      const el = new Elemento(doc, tag);
      for (const a of m[2].matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        const valor = a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4] !== undefined ? a[4] : '';
        el.setAttribute(a[1].toLowerCase(), decodificar(valor));
      }
      if (el.attributes.has('type')) el.type = el.attributes.get('type');
      if (el.attributes.has('title')) el.title = el.attributes.get('title');
      if (tag === 'canvas') {
        if (el.attributes.has('width')) el.width = Number(el.attributes.get('width'));
        if (el.attributes.has('height')) el.height = Number(el.attributes.get('height'));
      }
      if (topo()) topo().appendChild(el);
      else if (tag === 'html') raiz = el;
      else throw new Error(`dom-falso: <${tag}> fora do <html>`);
      i += m[0].length;
      if (TEXTO_CRU.has(tag)) {
        const fim = html.toLowerCase().indexOf(`</${tag}>`, i);
        el._cru = html.slice(i, fim);
        i = fim + tag.length + 3;
        continue;
      }
      if (!VAZIOS.has(tag) && m[3] !== '/') pilha.push(el);
      continue;
    }
    const fim = html.indexOf('<', i);
    const t = html.slice(i, fim < 0 ? html.length : fim);
    if (topo() && t.trim() !== '') topo().appendChild(new Texto(decodificar(t)));
    i = fim < 0 ? html.length : fim;
  }
  if (pilha.length > 0) throw new Error(`dom-falso: <${topo().localName}> nunca fechou`);
  return raiz;
}

class Documento extends Alvo {
  constructor(html) {
    super();
    this.nodeType = 9;
    this.hidden = false;
    this._baixados = [];
    this._criados = 0;
    // Todo elemento que o jogo criou, por referencia fraca: depois de um gc,
    // o que ainda deref() e o que alguem segura. Fora da arvore e vivo, com
    // escutador, e o vazamento que contar() (so a arvore) nao ve.
    this._criadosRefs = [];
    this.documentElement = montarHtml(this, html);
    this.head = this.documentElement.querySelector('head');
    this.body = this.documentElement.querySelector('body');
    this.activeElement = this.body;
  }
  get visibilityState() {
    return this.hidden ? 'hidden' : 'visible';
  }
  createElement(tag) {
    this._criados += 1;
    const el = new Elemento(this, tag);
    this._criadosRefs.push(new WeakRef(el));
    return el;
  }
  getElementById(id) {
    let achado = null;
    percorrer(this.documentElement, (no) => {
      if (!achado && no.id === id) achado = no;
    });
    return achado;
  }
  querySelectorAll(seletor) {
    const achados = [];
    percorrer(this.documentElement, (no) => {
      if (casa(no, seletor)) achados.push(no);
    });
    return achados;
  }
  querySelector(seletor) {
    return this.querySelectorAll(seletor)[0] || null;
  }
}

// --------------------------------------------------------------- canvas 2d

// Um "pixel" de mentira por texto: o teste de emoji de render.js le
// getImageData depois de um fillText. `glifos(texto)` devolve o que a fonte
// teria desenhado — por padrao, um padrao proprio de cada texto; o teste
// troca para simular o tofu de uma maquina sem fonte de emoji.
function padraoDoTexto(texto) {
  let h = 2166136261;
  for (let i = 0; i < texto.length; i += 1) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

const PROPRIEDADES_2D = [
  'fillStyle', 'strokeStyle', 'lineWidth', 'lineCap', 'lineJoin', 'globalAlpha',
  'globalCompositeOperation', 'textAlign', 'textBaseline', 'font',
];

// O contexto 2D: so os metodos que o jogo usa. Cada chamada de desenho no
// contexto principal entra num resumo (hash) do quadro, com os numeros
// arredondados, e o teste de reinicio compara o resumo de dois navegadores.
// save/restore tem pilha de verdade: `pilha()` diz se o quadro fechou.
function criarContexto2d(canvas, opcoes = {}) {
  let resumo = 2166136261;
  const somar = (texto) => {
    for (let i = 0; i < texto.length; i += 1) {
      resumo ^= texto.charCodeAt(i);
      resumo = Math.imul(resumo, 16777619) >>> 0;
    }
  };
  const n = (v) => (typeof v === 'number' ? (Math.round(v * 100) / 100).toString() : typeof v === 'string' ? v : typeof v);
  const pilha = [];
  const reg = { ops: 0, textos: [], formas: [], leituras: 0, ultimoTexto: null, opcoes };
  const ctx = {
    canvas,
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    font: '10px sans-serif',
    reg,
    // Ligado, cada chamada entra no resumo e nas listas (caro: so no trecho
    // que o teste compara). Desligado, so conta.
    gravar: false,
    // Hash do que foi desenhado desde o ultimo `zerarResumo`.
    get resumo() {
      return resumo;
    },
    zerarResumo() {
      resumo = 2166136261;
      reg.ops = 0;
      reg.textos.length = 0;
      reg.formas.length = 0;
    },
    pilha: () => pilha.length,
  };
  const op = (nome, args, extra = '') => {
    reg.ops += 1;
    if (!ctx.gravar) return;
    somar(`${nome}(${Array.prototype.map.call(args, n).join(',')})${extra};`);
  };
  // So o estado que muda o resultado de cada chamada: o fillStyle que sobrou
  // do quadro anterior nao muda um drawImage.
  const comum = () => `${n(ctx.globalAlpha)}|${ctx.globalCompositeOperation}`;
  const preenche = () => `${n(ctx.fillStyle)}|${comum()}`;
  const traca = () => `${n(ctx.strokeStyle)}|${n(ctx.lineWidth)}|${ctx.lineCap}|${ctx.lineJoin}|${comum()}`;
  const escreve = () => `${ctx.font}|${ctx.textAlign}|${ctx.textBaseline}|${preenche()}`;
  const t = [1, 0, 0, 1, 0, 0];
  Object.assign(ctx, {
    setTransform(a, b, c, d, e, f) {
      t.splice(0, 6, a, b, c, d, e, f);
      op('setTransform', arguments);
    },
    translate(x, y) {
      t[4] += t[0] * x + t[2] * y;
      t[5] += t[1] * x + t[3] * y;
      op('translate', arguments);
    },
    rotate(a) {
      const c = Math.cos(a);
      const s = Math.sin(a);
      const [a0, b0, c0, d0] = t;
      t[0] = a0 * c + c0 * s;
      t[1] = b0 * c + d0 * s;
      t[2] = c0 * c - a0 * s;
      t[3] = d0 * c - b0 * s;
      op('rotate', arguments);
    },
    save() {
      pilha.push([...PROPRIEDADES_2D.map((p) => ctx[p]), [...t]]);
      op('save', arguments);
    },
    restore() {
      const topo = pilha.pop();
      if (!topo) throw new Error('canvas falso: restore() sem save()');
      PROPRIEDADES_2D.forEach((p, i) => {
        ctx[p] = topo[i];
      });
      t.splice(0, 6, ...topo[PROPRIEDADES_2D.length]);
      op('restore', arguments);
    },
    beginPath() { op('beginPath', arguments); },
    closePath() { op('closePath', arguments); },
    moveTo() { op('moveTo', arguments); },
    lineTo() { op('lineTo', arguments); },
    rect() { op('rect', arguments); },
    // Fase 15: o lado de fora da arena encolhida e recortado ('evenodd').
    clip() { op('clip', arguments); },
    arc(x, y, r) {
      if (!(r >= 0)) throw new Error(`canvas falso: arc com raio ${r}`); // o navegador lanca IndexSizeError
      op('arc', arguments);
    },
    fill() {
      if (ctx.gravar) reg.formas.push({ cor: ctx.fillStyle, alpha: ctx.globalAlpha, x: t[4], y: t[5] });
      op('fill', arguments, ctx.gravar ? preenche() : '');
    },
    stroke() { op('stroke', arguments, ctx.gravar ? traca() : ''); },
    fillRect() { op('fillRect', arguments, ctx.gravar ? preenche() : ''); },
    strokeRect() { op('strokeRect', arguments, ctx.gravar ? traca() : ''); },
    clearRect() {
      reg.ultimoTexto = null;
      op('clearRect', arguments);
    },
    fillText(texto, x, y) {
      reg.ultimoTexto = texto;
      if (ctx.gravar) reg.textos.push({ texto, x: t[0] * x + t[2] * y + t[4], y: t[1] * x + t[3] * y + t[5], fonte: ctx.font, cor: ctx.fillStyle });
      op('fillText', arguments, ctx.gravar ? escreve() : '');
    },
    strokeText() { op('strokeText', arguments, ctx.gravar ? `${escreve()}|${traca()}` : ''); },
    // A imagem entra no resumo pelo tamanho: as camadas de fundo sao objetos
    // diferentes em cada navegador, com o mesmo conteudo.
    drawImage(img, x, y) {
      op('drawImage', [img && img.width, img && img.height, x, y], ctx.gravar ? comum() : '');
    },
    // Fora do resumo: e o render enchendo o cache dele, nao desenho.
    createRadialGradient() {
      return { addColorStop() {} };
    },
    getImageData(x, y, w, h) {
      reg.leituras += 1;
      const dados = new Uint8ClampedArray(w * h * 4);
      const ultimo = reg.ultimoTexto;
      if (!ultimo) return { data: dados, width: w, height: h };
      const glifo = canvas.ownerDocument._glifo(ultimo);
      if (glifo === null) return { data: dados, width: w, height: h }; // nada desenhado
      for (let i = 0; i < dados.length; i += 1) dados[i] = (glifo >>> (8 * (i % 4))) & 0xff;
      return { data: dados, width: w, height: h };
    },
  });
  return ctx;
}

// ------------------------------------------------------------------ audio

function parametro(valor = 0) {
  const p = { value: valor };
  for (const m of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime', 'cancelScheduledValues']) {
    p[m] = (...args) => {
      if (args.some((a) => typeof a === 'number' && !Number.isFinite(a))) throw new Error(`audio falso: ${m}(${args.join(', ')}) com numero nao finito`);
      return p;
    };
  }
  return p;
}

// Conta vozes e checa numero torto; o som em si nao existe.
export function criarAudioContextFalso(registro) {
  return class AudioContextFalso {
    constructor() {
      registro.contextos += 1;
      registro.instancias.push(this);
      this.currentTime = 0;
      this.sampleRate = 8000;
      this.state = 'running';
      this.destination = { connect() {} };
    }
    resume() {
      this.state = 'running';
      return Promise.resolve();
    }
    no(extra) {
      registro.nos += 1;
      return { connect() {}, disconnect() {}, ...extra };
    }
    createGain() {
      return this.no({ gain: parametro(1) });
    }
    createDynamicsCompressor() {
      return this.no({ threshold: parametro(), knee: parametro(), ratio: parametro(), attack: parametro(), release: parametro() });
    }
    createBiquadFilter() {
      return this.no({ type: 'lowpass', frequency: parametro() });
    }
    createBuffer(canais, n) {
      const dados = new Float32Array(n);
      return { getChannelData: () => dados, length: n, numberOfChannels: canais };
    }
    fonte(extra) {
      return this.no({
        start(t) {
          if (!Number.isFinite(t)) throw new Error(`audio falso: start(${t})`);
          registro.vozes += 1;
        },
        stop() {},
        ...extra,
      });
    }
    createBufferSource() {
      return this.fonte({ buffer: null, loop: false });
    }
    createOscillator() {
      return this.fonte({ type: 'sine', frequency: parametro() });
    }
  };
}

// ---------------------------------------------------------------- navegador

class Armazenamento {
  constructor(inicial = {}) {
    this._m = new Map(Object.entries(inicial));
  }
  getItem(k) {
    return this._m.has(k) ? this._m.get(k) : null;
  }
  setItem(k, v) {
    this._m.set(k, String(v));
  }
  removeItem(k) {
    this._m.delete(k);
  }
  get length() {
    return this._m.size;
  }
  copia() {
    return Object.fromEntries(this._m);
  }
}

// Um navegador inteiro: `com(fn)` roda fn com document/window/rAF/
// performance/localStorage deste navegador no global (o jogo os le de la, na
// hora; todo metodo abaixo que entra no jogo passa por ele), `quadro(ms)` roda o proximo
// requestAnimationFrame, e tecla/clicar imitam a entrada do jogador com a
// acao padrao do navegador (Enter e Espaco clicam o botao com foco).
export function criarNavegador({ html, armazenamento = {}, semente = 1, glifo = padraoDoTexto } = {}) {
  const doc = new Documento(html);
  doc._glifo = glifo;
  const audio = { contextos: 0, nos: 0, vozes: 0, instancias: [] };
  const win = new Alvo();
  Object.assign(win, {
    innerWidth: 1280,
    innerHeight: 720,
    devicePixelRatio: 1,
    screen: { width: 1920, height: 1080 },
    AudioContext: criarAudioContextFalso(audio),
    document: doc,
  });
  const storage = new Armazenamento(armazenamento);
  const nav = {
    document: doc,
    window: win,
    localStorage: storage,
    audio,
    erros: [],
    agora: 0, // ms do relogio de parede falso (performance.now e o rAF)
    proximo: null, // o requestAnimationFrame pendente
    rolagens: [], // teclas que rolariam a pagina (sem preventDefault, sem botao)
    estado: null,
  };

  const globais = {
    document: doc,
    window: win,
    localStorage: storage,
    requestAnimationFrame: (fn) => {
      if (nav.proximo) throw new Error('dom-falso: dois requestAnimationFrame no mesmo quadro');
      nav.proximo = fn;
      return 1;
    },
    performance: { now: () => nav.agora },
  };

  // O jogo le os globais na hora: cada chamada para dentro dele roda com os
  // deste navegador no lugar (dois navegadores convivem no mesmo node).
  nav.com = (fn) => {
    const antes = {};
    for (const k of Object.keys(globais)) {
      antes[k] = Object.getOwnPropertyDescriptor(globalThis, k);
      Object.defineProperty(globalThis, k, { value: globais[k], configurable: true, writable: true, enumerable: true });
    }
    const consoleErro = console.error;
    console.error = (...a) => nav.erros.push(a.map((x) => (x && x.stack ? x.stack.split('\n').slice(0, 3).join(' / ') : String(x))).join(' '));
    try {
      return fn();
    } finally {
      console.error = consoleErro;
      for (const k of Object.keys(globais)) {
        if (antes[k]) Object.defineProperty(globalThis, k, antes[k]);
        else delete globalThis[k];
      }
    }
  };

  // iniciar() com a semente fixa: Date.now e o relogio do navegador sao os
  // deste teste.
  nav.iniciar = (iniciar) =>
    nav.com(() => {
      const agoraReal = Date.now;
      Date.now = () => semente;
      try {
        nav.estado = iniciar();
      } finally {
        Date.now = agoraReal;
      }
      return nav.estado;
    });

  // Um quadro do navegador: o relogio de parede anda `ms` e o rAF roda.
  nav.quadro = (ms) => {
    const fn = nav.proximo;
    if (!fn) throw new Error('dom-falso: nenhum requestAnimationFrame pendente (o loop morreu)');
    nav.proximo = null;
    nav.agora += ms;
    // O relogio do audio anda com o de parede (o limitador de sons o le).
    for (const c of audio.instancias) c.currentTime = nav.agora / 1000;
    nav.com(() => fn(nav.agora));
    if (!nav.proximo) throw new Error('dom-falso: o quadro nao agendou o seguinte');
  };

  const ehBotaoComFoco = () => {
    const a = doc.activeElement;
    return a && a !== doc.body && a.localName === 'button' && a.visivel;
  };

  // Tecla apertada e solta, como o navegador manda: keydown/keyup na window
  // com o alvo no elemento com foco; Enter clica o botao com foco no keydown
  // e Espaco no keyup, se ninguem chamou preventDefault.
  nav.tecla = (code, { repeat = false, so = null } = {}) =>
    nav.com(() => {
      const alvo = doc.activeElement || doc.body;
      let baixo = null;
      if (so !== 'up') {
        baixo = win.disparar('keydown', novoEvento('keydown', { code, key: code, repeat, target: alvo }));
        if (!baixo.defaultPrevented && (code === 'Enter' || code === 'NumpadEnter') && ehBotaoComFoco()) doc.activeElement.click();
        const rola = ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'];
        if (!baixo.defaultPrevented && rola.includes(code) && !ehBotaoComFoco()) nav.rolagens.push(code);
      }
      if (so !== 'down') {
        const cima = win.disparar('keyup', novoEvento('keyup', { code, key: code, repeat: false, target: alvo }));
        if (code === 'Space' && !(baixo && baixo.defaultPrevented) && !cima.defaultPrevented && ehBotaoComFoco()) doc.activeElement.click();
      }
      return baixo;
    });

  // Um clique de mouse de verdade num elemento: so num elemento visivel (o
  // jogador nao clica no que esta escondido), com mouseenter, foco (o
  // navegador da foco ao botao clicado) e o `detail` do clique (2 = segundo
  // clique de um clique duplo).
  nav.clicar = (el, { detail = 1, forcar = false } = {}) =>
    nav.com(() => {
      if (!el) throw new Error('dom-falso: clique num elemento que nao existe');
      if (!forcar && !el.visivel) throw new Error(`dom-falso: clique em #${el.id || el.className} escondido`);
      win.disparar('pointerdown', novoEvento('pointerdown', { target: el }));
      el.disparar('mouseenter', novoEvento('mouseenter', { target: el }));
      if (el.localName === 'button') el.focus();
      return el.disparar('click', novoEvento('click', { target: el, detail }));
    });

  nav.apontar = (el) => nav.com(() => el.disparar('mouseenter', novoEvento('mouseenter', { target: el })));

  nav.perderFoco = () => nav.com(() => win.disparar('blur', novoEvento('blur', { target: win })));
  nav.esconderAba = (oculta = true) =>
    nav.com(() => {
      doc.hidden = oculta;
      doc.disparar('visibilitychange', novoEvento('visibilitychange', { target: doc }));
    });

  // Contadores do teste de vazamento.
  nav.contar = () => {
    let nos = 0;
    let ouvintesElementos = 0;
    percorrer(doc.documentElement, (no) => {
      nos += 1;
      ouvintesElementos += no.contarOuvintes();
    });
    return {
      nos,
      ouvintesWindow: win.contarOuvintes(),
      ouvintesDocument: doc.contarOuvintes(),
      ouvintesElementos,
    };
  };

  // Os elementos criados pelo jogo que estao FORA da arvore e ainda vivos
  // (rode depois de um gc e de devolver o controle ao loop de eventos: o
  // WeakRef segura o alvo ate o fim da tarefa em que foi criado ou lido).
  nav.foraDaArvore = () => {
    let vivos = 0;
    let comEscutador = 0;
    let escutadores = 0;
    const tags = {};
    doc._criadosRefs = doc._criadosRefs.filter((ref) => ref.deref() !== undefined);
    for (const ref of doc._criadosRefs) {
      const el = ref.deref();
      if (!el || el.conectado) continue;
      vivos += 1;
      tags[el.localName] = (tags[el.localName] || 0) + 1;
      const n = el.contarOuvintes();
      if (n > 0) comEscutador += 1;
      escutadores += n;
    }
    return { vivos, comEscutador, escutadores, tags: JSON.stringify(tags) };
  };

  // O que esta na tela: id/classe, texto e largura de cada elemento visivel.
  // E o que o teste de reinicio compara entre dois navegadores.
  nav.retrato = ({ ignorar = () => false } = {}) => {
    const partes = [];
    const visitar = (no, caminho) => {
      if (no.classList.contains('oculto') || ignorar(no)) return;
      const nome = `${caminho}/${no.localName}${no.id ? '#' + no.id : ''}`;
      const classes = [...no.classList._s].filter((c) => c !== 'entrando').sort().join('.');
      let texto = '';
      for (const filho of no.childNodes) if (filho.nodeType === 3) texto += filho.data;
      const largura = no.style.width || '';
      partes.push(`${nome}[${classes}]${texto ? ' "' + texto + '"' : ''}${largura ? ' w=' + largura : ''}`);
      no.children.forEach((filho, i) => visitar(filho, `${nome}:${i}`));
    };
    visitar(doc.body, '');
    return partes;
  };

  return nav;
}
