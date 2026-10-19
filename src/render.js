import { CONTEUDO } from '../data/content.js';
import { TELAS } from './state.js';
import { criarPool } from './pool.js';
import { criarRng } from './rng.js';
import { dadosDaArma, nivelDaArma, posicaoSatelite } from './weapons.js';
import { anguloDoLeque, ESTADOS_BANCA } from './boss.js';
import { preencher } from './ui.js';

// Le o estado e desenha. Nunca escreve no estado — se uma funcao daqui
// precisar mudar alguma coisa, ela esta no arquivo errado.
//
// Fase 12 (juice): os efeitos (tremor, particulas, numeros de dano, flashes)
// tem estado proprio, `fx`, que mora AQUI e nao em `estado`: nao e simulacao e
// nao entra no estado serializavel — o mesmo motivo de o mudo morar no audio.
// Eles leem a fila de eventos (desenhar roda uma vez por quadro, antes de
// main.js esvaziar a fila), andam no relogio estado.tempo e sorteiam com um
// rng proprio. A partida e identica com e sem desenho; o smoke prova.

// Onde a arena aparece: em jogo, e congelada por baixo das telas de fim — a
// explosao final (Banca, jubilado) termina durante o fade delas.
const TELAS_DE_JOGO = new Set([TELAS.AVALIACAO, TELAS.PAUSA, TELAS.CARTA]);
const TELAS_DE_FIM = new Set([TELAS.RESULTADO, TELAS.JUBILADO, TELAS.COLACAO]);

// Os efeitos de cada canvas. main.js chama desenhar(estado, ctx) e nunca ve o
// `fx`; o smoke passa o seu.
const efeitosPorContexto = new WeakMap();

export function efeitosDe(ctx) {
  let fx = efeitosPorContexto.get(ctx);
  if (!fx) {
    fx = criarEfeitos();
    efeitosPorContexto.set(ctx, fx);
  }
  return fx;
}

export function criarEfeitos(cfg = CONTEUDO.juice, tema = CONTEUDO.tema) {
  return {
    cfg,
    tema,
    rng: criarRng(cfg.semente), // nunca o da simulacao
    // O da pagina (pintarPagina): reiniciado em cfg.fundo.semente a cada
    // pintura, para o mesmo clima sair sempre a mesma pagina — e sem mexer na
    // sequencia de `rng`, que as faiscas e o tremor seguem usando.
    rngPagina: criarRng(cfg.fundo.semente),
    // A pool da fase 02, com o teto que ja estava reservado para particulas.
    particulas: criarPool(CONTEUDO.arena.limites.particles, novaParticula),
    numeros: criarPool(cfg.numeros.max, novoNumero),
    rajadas: new Map(), // id do tipo -> padrao + porTipo, combinado uma vez
    // Flash de golpe: inimigo (objeto da pool) -> { nasc, hp, ate }. O par
    // (objeto, nasc) e a identidade: o 1o filhote do 📱 e o MESMO objeto do pai
    // com nasc novo (pendencia 67), e herdar o HP do pai daria um flash falso.
    golpes: new WeakMap(),
    fontes: new Map(), // tamanho do emoji -> string de fonte
    // Os emoji que esta maquina nao tem (detectarEmojiFaltando), testados no
    // 1o quadro: Set, ou null quando nao falta nenhum (ou nao deu para testar).
    emojiConferido: false,
    emojiFaltando: null,
    fonteAtual: '',
    tamanhoFonte: -1,
    relogio: null, // estado.tempo do ultimo quadro desenhado
    dt: 0,
    avaliacao: null, // a avaliacao cujos efeitos estao na tela
    tremor: 0,
    tremorX: 0,
    tremorY: 0,
    flashJogador: 0, // s restantes
    vinhetaDano: 0, // s restantes
    flashBanca: 0, // 0..1, do quadro atual
    novasParticulas: 0, // neste quadro
    novosNumeros: 0,
    gradientes: { clima: null, vinheta: null, dano: null, aviso: null },
    // A pagina e as vinhetas pintadas uma vez por clima (desenharFundo).
    // `criarCamada` (w, h) -> canvas pode ser trocada (o smoke passa a dele).
    camadas: { clima: null, chao: null, vinheta: null, dano: null, criadas: 0 },
    criarCamada: null,
    // Para o smoke e para medir: o que o ultimo quadro fez.
    diag: { fontes: 0, avisos: 0, numerosAgrupados: 0, numerosDescartados: 0, particulasDescartadas: 0 },
  };
}

function novaParticula() {
  return { x: 0, y: 0, vx: 0, vy: 0, vida: 0, vidaMax: 0, tamanho: 0, atrito: 0, cor: '' };
}

function novoNumero() {
  return { x: 0, y: 0, x0: 0, y0: 0, valor: 0, mostrado: -1, texto: '', idade: 0, pop: 0, jogador: false };
}

export function desenhar(estado, ctx, fx = efeitosDe(ctx)) {
  const { largura, altura } = CONTEUDO.arena;
  const v = CONTEUDO.visual;
  const naArena = TELAS_DE_JOGO.has(estado.tela) || TELAS_DE_FIM.has(estado.tela);

  if (!fx.emojiConferido) {
    fx.emojiConferido = true;
    fx.emojiFaltando = detectarEmojiFaltando(ctx);
  }
  avancarEfeitos(estado, fx);
  const clima = climaDe(estado, fx.tema);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  // O rastro deixa as pontas redondas e os numeros de dano, as juntas: sem
  // repor, o quadro seguinte desenharia a parede e o leque com elas
  // (pendencia 88). Os padroes do canvas.
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  // Uma vez por quadro, e nao por emoji (pendencia 16). A fonte so e trocada
  // quando o tamanho muda (desenharEmoji).
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  fx.fonteAtual = '';
  fx.tamanhoFonte = -1;
  fx.diag.fontes = 0;
  fx.diag.avisos = 0;

  // O tremor e so isto: o mundo inteiro desenhado deslocado. Nenhuma posicao
  // de entidade muda.
  const ox = naArena ? fx.tremorX : 0;
  const oy = naArena ? fx.tremorY : 0;
  desenharFundo(ctx, fx, clima, largura, altura, ox, oy);

  if (naArena) {
    const av = estado.run.avaliacao;
    const banca = av.banca;
    desenharOrbes(ctx, fx, estado.xpOrbs, av.arena, v);
    // O aviso da Banca e marca no chao: por baixo de todo mundo, menos dos
    // orbes (que ja sao chao tambem).
    if (banca) desenharAvisosDaBanca(ctx, fx, banca, v);
    desenharInimigos(ctx, fx, estado, v);
    if (banca) desenharBanca(ctx, fx, banca, v);
    desenharParticulas(ctx, fx);
    desenharProjeteis(ctx, fx, estado.projectiles, v);
    desenharPerguntas(ctx, fx, estado.perguntas, v);
    desenharJogador(ctx, fx, estado.player, v);
    // Depois do jogador: caneta orbital, onda e feixe sao "efeitos da propria
    // arma", nao entidades da pool — fazem mais sentido desenhados por cima,
    // como um halo do jogador.
    desenharArmasEspeciais(ctx, fx, estado.player, v);
    // Por cima das entidades: quem esta fora da arena encolhida fica apagado
    // (pendencia 63), e a parede por cima de tudo.
    desenharForaDaArena(ctx, av.arena, clima, largura, altura, v, fx.cfg.tremor.maximo);
    desenharAvisosDeSpawn(ctx, fx, estado);
    desenharNumeros(ctx, fx);
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  desenharVinheta(ctx, fx, clima, largura, altura);
  if (naArena) {
    const banca = estado.run.avaliacao.banca;
    if (banca) desenharTransicaoDaBanca(ctx, fx, banca, largura, altura, v);
  }

  if (estado.tela === TELAS.PAUSA) {
    ctx.fillStyle = v.corSombraPausa;
    ctx.fillRect(0, 0, largura, altura);
  } else if (estado.tela === TELAS.CARTA) {
    ctx.fillStyle = v.corSombraCarta;
    ctx.fillRect(0, 0, largura, altura);
  }
}

// ------------------------------------------------------------ efeitos

// O relogio dos efeitos e estado.tempo: anda em passos de loop.passo, igual
// em qualquer monitor, e e o mesmo no node. Ele anda tambem na pausa e nas
// telas de fim (pendencia 1), e e de proposito: o tremor e as faiscas
// terminam em vez de ficar congelados atras do menu de pausa.
function avancarEfeitos(estado, fx) {
  const av = estado.run.avaliacao;
  if (fx.avaliacao !== av) {
    limparEfeitos(fx);
    fx.avaliacao = av;
  }
  const { passo, maxPassosPorFrame } = CONTEUDO.loop;
  const decorrido = fx.relogio === null ? 0 : estado.tempo - fx.relogio;
  const dt = Math.min(passo * maxPassosPorFrame, Math.max(0, decorrido));
  fx.relogio = estado.tempo;
  fx.dt = dt;
  fx.novasParticulas = 0;
  fx.novosNumeros = 0;
  envelhecer(fx, dt);
  consumirEventos(estado, fx);
  // Um deslocamento novo so quando o mundo andou: num monitor de 144 Hz os
  // quadros sem tick repetem o anterior, em vez de tremer mais rapido.
  if (fx.tremor <= 0) {
    fx.tremorX = 0;
    fx.tremorY = 0;
  } else if (dt > 0 || (fx.tremorX === 0 && fx.tremorY === 0)) {
    fx.tremorX = fx.rng.range(-1, 1) * fx.tremor;
    fx.tremorY = fx.rng.range(-1, 1) * fx.tremor;
  }
}

function limparEfeitos(fx) {
  fx.particulas.liberarTodos();
  fx.numeros.liberarTodos();
  fx.tremor = 0;
  fx.tremorX = 0;
  fx.tremorY = 0;
  fx.flashJogador = 0;
  fx.vinhetaDano = 0;
}

function envelhecer(fx, dt) {
  if (dt <= 0) return;
  const t = fx.cfg.tremor;
  fx.tremor *= Math.exp(-t.decaimento * dt);
  if (fx.tremor < t.minimo) fx.tremor = 0;
  fx.flashJogador = Math.max(0, fx.flashJogador - dt);
  fx.vinhetaDano = Math.max(0, fx.vinhetaDano - dt);

  // De tras para frente: liberar troca o ultimo para o buraco (pool.js).
  const ps = fx.particulas.ativos;
  for (let i = ps.length - 1; i >= 0; i -= 1) {
    const p = ps[i];
    p.vida -= dt;
    if (p.vida <= 0) {
      fx.particulas.liberar(p);
      continue;
    }
    const freio = Math.max(0, 1 - p.atrito * dt);
    p.vx *= freio;
    p.vy *= freio;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }

  const c = fx.cfg.numeros;
  const ns = fx.numeros.ativos;
  for (let i = ns.length - 1; i >= 0; i -= 1) {
    const n = ns[i];
    n.idade += dt;
    if (n.idade >= c.vida) {
      fx.numeros.liberar(n);
      continue;
    }
    n.pop = Math.max(0, n.pop - dt);
    n.y -= c.subida * dt;
  }
}

// A fila do quadro inteiro (ate maxPassosPorFrame ticks). Cada evento e visto
// uma vez: main.js esvazia a fila logo depois do desenho e do audio.
function consumirEventos(estado, fx) {
  const eventos = estado.eventos;
  const tremores = fx.cfg.tremor.eventos;
  const flash = fx.cfg.flash;
  for (let i = 0; i < eventos.length; i += 1) {
    const ev = eventos[i];
    const tremor = tremores[ev.tipo];
    if (tremor !== undefined) tremer(fx, tremor);
    const d = ev.dados;
    switch (ev.tipo) {
      case 'inimigo-morto':
        explodir(fx, d.x, d.y, rajadaDoTipo(fx, d.tipo));
        break;
      case 'arma-acerto':
        somarNumero(fx, d.x, d.y, d.dano, false);
        break;
      case 'jogador-dano':
        fx.flashJogador = flash.jogadorDuracao;
        fx.vinhetaDano = flash.vinhetaDanoDuracao;
        // Em cima do jogador, e nao no ponto do evento (que e o do inimigo).
        somarNumero(fx, estado.player.x, estado.player.y, d.dano, true);
        break;
      case 'jubilado':
        explodir(fx, estado.player.x, estado.player.y, rajadaDoTipo(fx, null));
        break;
      default:
        break;
    }
  }
}

// O maior ganha: tremores nao somam.
function tremer(fx, px) {
  fx.tremor = Math.min(fx.cfg.tremor.maximo, Math.max(fx.tremor, px));
}

// `padrao` + o que o tipo sobrescreve, montado na primeira vez. `null` e o
// jogador (o jubilado).
function rajadaDoTipo(fx, tipo) {
  const chave = tipo === null ? '' : tipo;
  let r = fx.rajadas.get(chave);
  if (!r) {
    const p = fx.cfg.particulas;
    const proprio = tipo === null ? p.jogador : p.porTipo[tipo];
    r = { ...p.padrao, ...(proprio || {}) };
    fx.rajadas.set(chave, r);
  }
  return r;
}

function explodir(fx, x, y, r) {
  const pool = fx.particulas;
  const teto = fx.cfg.particulas.maxPorQuadro;
  for (let i = 0; i < r.quantidade; i += 1) {
    // Pool cheia ou teto do quadro: a faisca nao nasce. Reciclar a mais antiga
    // (o que pool.obter faria) custa uma varredura da pool inteira por faisca.
    if (fx.novasParticulas >= teto || pool.reserva.length === 0) {
      fx.diag.particulasDescartadas += r.quantidade - i;
      return;
    }
    const p = pool.obter();
    const angulo = fx.rng.float() * Math.PI * 2;
    const velocidade = fx.rng.range(r.velocidadeMin, r.velocidadeMax);
    p.x = x;
    p.y = y;
    p.vx = Math.cos(angulo) * velocidade;
    p.vy = Math.sin(angulo) * velocidade;
    p.vida = fx.rng.range(r.vidaMin, r.vidaMax);
    p.vidaMax = p.vida;
    p.tamanho = fx.rng.range(r.tamanhoMin, r.tamanhoMax);
    p.atrito = r.atrito;
    p.cor = r.cores[fx.rng.int(0, r.cores.length - 1)];
    fx.novasParticulas += 1;
  }
}

// Agrupamento: o golpe perto de um numero ainda novo soma nele. Varredura
// linear: a pool de numeros e pequena (juice.numeros.max).
function somarNumero(fx, x, y, valor, doJogador) {
  if (!(valor > 0)) return;
  const c = fx.cfg.numeros;
  const ativos = fx.numeros.ativos;
  let alvo = null;
  let melhor = c.raioAgrupar * c.raioAgrupar;
  for (let i = 0; i < ativos.length; i += 1) {
    const n = ativos[i];
    if (n.jogador !== doJogador || n.idade >= c.janelaAgrupar) continue;
    const dx = n.x0 - x;
    const dy = n.y0 - y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= melhor) {
      melhor = d2;
      alvo = n;
    }
  }
  if (alvo) {
    alvo.valor += valor;
    alvo.pop = c.popDuracao;
    fx.diag.numerosAgrupados += 1;
    return;
  }
  if (fx.novosNumeros >= c.novosPorQuadro) {
    fx.diag.numerosDescartados += 1;
    return;
  }
  // Pool cheia: obter() recicla o mais velho, que e o que menos importa.
  const n = fx.numeros.obter();
  n.x0 = x;
  n.y0 = y;
  n.x = x;
  n.y = y - c.desvioNascimento;
  n.valor = valor;
  n.mostrado = -1;
  n.idade = 0;
  n.pop = c.popDuracao;
  n.jogador = doJogador;
  fx.novosNumeros += 1;
}

// Quanto do flash de golpe resta no inimigo (0..1). Chamado uma vez por
// quadro para cada inimigo vivo: e o HP caindo entre dois quadros que acende o
// flash, de qualquer arma ou fonte. O objeto da pool sozinho NAO identifica o
// inimigo — com nasc diferente, e outro inimigo e a memoria recomeca.
export function flashDoInimigo(fx, e, agora) {
  const duracao = fx.cfg.flash.duracao;
  let g = fx.golpes.get(e);
  if (g === undefined) {
    g = { nasc: e.nasc, hp: e.hp, ate: 0 };
    fx.golpes.set(e, g);
    return 0;
  }
  if (g.nasc !== e.nasc) {
    g.nasc = e.nasc;
    g.hp = e.hp;
    g.ate = 0;
    return 0;
  }
  if (e.hp < g.hp) g.ate = agora + duracao;
  g.hp = e.hp;
  const resta = g.ate - agora;
  return resta > 0 ? Math.min(1, resta / duracao) : 0;
}

// O ponto da parede da arena por onde quem esta em (ex, ey) entra andando
// para (px, py): o comeco do trecho do segmento que fica dentro do retangulo
// (Liang-Barsky). Escreve em `saida` e devolve false se o segmento nao entra
// (ou se ja comeca dentro).
const RECORTE = { t0: 0, t1: 1 };

function recortar(p, q) {
  if (p === 0) return q >= 0;
  const r = q / p;
  if (p < 0) {
    if (r > RECORTE.t1) return false;
    if (r > RECORTE.t0) RECORTE.t0 = r;
  } else {
    if (r < RECORTE.t0) return false;
    if (r < RECORTE.t1) RECORTE.t1 = r;
  }
  return true;
}

export function pontoDeEntrada(ex, ey, px, py, arena, saida) {
  if (ex >= arena.esquerda && ex <= arena.direita && ey >= arena.topo && ey <= arena.base) return false;
  const dx = px - ex;
  const dy = py - ey;
  RECORTE.t0 = 0;
  RECORTE.t1 = 1;
  if (!recortar(-dx, ex - arena.esquerda)) return false;
  if (!recortar(dx, arena.direita - ex)) return false;
  if (!recortar(-dy, ey - arena.topo)) return false;
  if (!recortar(dy, arena.base - ey)) return false;
  saida.x = ex + RECORTE.t0 * dx;
  saida.y = ey + RECORTE.t0 * dy;
  return true;
}

// ------------------------------------------------------------- fundo

// O clima do quadro: a pagina do caderno no estado daquele periodo (v2, fase
// 15; era a paleta da fase 12). Na arena e nas telas de fim, o da avaliacao
// que esta (ou estava) na tela; no anuncio, o do periodo que vai comecar; na
// tela do TCC, o da defesa; no menu, o do 1o periodo, onde toda run comeca.
// Pendencia 89: lendo sempre a ultima avaliacao, o menu depois da colacao saia
// com o clima do TCC, e o anuncio de um periodo novo com o do anterior. A loja
// fica com o do periodo que acabou de ser jogado.
export function climaDe(estado, tema = CONTEUDO.tema) {
  switch (estado.tela) {
    case TELAS.MENU:
      return climaDoPeriodo(tema, 0);
    case TELAS.ANUNCIO:
      return climaDoPeriodo(tema, estado.run.proxima.periodoIndex);
    case TELAS.TCC:
      return tema.climaTcc;
    default:
      return estado.run.avaliacao.banca ? tema.climaTcc : climaDoPeriodo(tema, estado.run.periodoIndex);
  }
}

function climaDoPeriodo(tema, periodoIndex) {
  return tema.climas[Math.max(0, Math.min(tema.climas.length - 1, periodoIndex))];
}

// A pagina (papel, pauta, margem, furos e os detalhes do clima) e as vinhetas
// nao mudam dentro de um periodo: sao pintadas UMA vez por clima numa camada
// fora da tela e copiadas a cada quadro com drawImage. Sem como criar camada
// (o node do smoke), pinta direto, com os mesmos numeros.
function novaCamada(ctx, fx, largura, altura) {
  if (fx.criarCamada) return fx.criarCamada(largura, altura);
  const doc = ctx.canvas && ctx.canvas.ownerDocument;
  if (doc && typeof doc.createElement === 'function') {
    const camada = doc.createElement('canvas');
    camada.width = largura;
    camada.height = altura;
    return camada;
  }
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(largura, altura);
  return null;
}

function prepararCamadas(ctx, fx, clima, largura, altura) {
  const cam = fx.camadas;
  if (cam.clima === clima) return;
  cam.clima = clima;
  // A camada da pagina passa da borda o quanto o tremor desloca o mundo.
  const m = Math.ceil(fx.cfg.tremor.maximo);
  cam.chao = novaCamada(ctx, fx, largura + 2 * m, altura + 2 * m);
  if (cam.chao) {
    const c = cam.chao.getContext('2d');
    c.translate(m, m);
    pintarPagina(c, fx, clima, largura, altura, m);
    cam.criadas += 1;
  }
  const vinheta = clima.vinheta;
  cam.vinheta = camadaDeBorda(ctx, fx, largura, altura, vinheta.cor, vinheta.raioInterno, vinheta.raioExterno);
  if (!cam.dano) {
    const f = fx.cfg.flash;
    cam.dano = camadaDeBorda(ctx, fx, largura, altura, f.corVinhetaDano, f.vinhetaDanoRaioInterno, f.vinhetaDanoRaioExterno);
  }
}

function camadaDeBorda(ctx, fx, largura, altura, cor, raioInterno, raioExterno) {
  const camada = novaCamada(ctx, fx, largura, altura);
  if (!camada) return null;
  const c = camada.getContext('2d');
  c.fillStyle = gradienteDeBorda(c, largura, altura, cor, raioInterno, raioExterno);
  c.fillRect(0, 0, largura, altura);
  fx.camadas.criadas += 1;
  return camada;
}

// O fundo do quadro, ja com o deslocamento do tremor (ox, oy).
function desenharFundo(ctx, fx, clima, largura, altura, ox, oy) {
  prepararCamadas(ctx, fx, clima, largura, altura);
  const m = Math.ceil(fx.cfg.tremor.maximo);
  ctx.setTransform(1, 0, 0, 1, ox, oy);
  const chao = fx.camadas.chao;
  if (chao) ctx.drawImage(chao, -m, -m);
  else pintarPagina(ctx, fx, clima, largura, altura, m);
}

// A pagina do caderno de um clima, de -m a largura + m (o tremor descobre a
// borda). Os sorteios saem de fx.rngPagina reiniciado em sementes fixas, uma
// por tipo de detalhe: a mesma pagina toda vez, e as 2 manchas da tarde sao
// as 2 primeiras das 4 da madrugada — o caderno e o mesmo, so mais gasto.
// O contexto volta como estava (save/restore): os rabiscos mudam lineCap.
function pintarPagina(ctx, fx, clima, largura, altura, m) {
  const f = fx.cfg.fundo;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = clima.papel;
  ctx.fillRect(-m, -m, largura + 2 * m, altura + 2 * m);

  if (clima.pauta !== null) {
    ctx.strokeStyle = clima.pauta;
    ctx.lineWidth = f.pauta.largura;
    ctx.beginPath();
    for (let y = f.pauta.topo; y < altura + m; y += f.pauta.passo) {
      ctx.moveTo(-m, y + 0.5);
      ctx.lineTo(largura + m, y + 0.5);
    }
    ctx.stroke();
  }
  if (clima.margem !== null) {
    ctx.strokeStyle = clima.margem;
    ctx.lineWidth = f.margem.largura;
    ctx.beginPath();
    ctx.moveTo(f.margem.x, -m);
    ctx.lineTo(f.margem.x, altura + m);
    ctx.stroke();
  }

  const rng = fx.rngPagina;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  rng.s = f.semente >>> 0;
  pintarManchas(ctx, rng, f.mancha, clima.manchas, f.margem.x, largura, altura);
  rng.s = (f.semente + 1) >>> 0;
  pintarVincos(ctx, rng, f.vinco, clima.vincos, largura, altura, m);
  rng.s = (f.semente + 2) >>> 0;
  pintarRabiscos(ctx, rng, f, clima.rabiscos, altura);

  if (clima.furos !== null) {
    const furos = f.furos;
    ctx.fillStyle = clima.furos.cor;
    ctx.strokeStyle = clima.furos.borda;
    ctx.lineWidth = furos.largura;
    for (let i = 0; i < furos.quantidade; i += 1) {
      ctx.beginPath();
      ctx.arc(furos.x, (altura * (i + 1)) / (furos.quantidade + 1), furos.raio, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  // A luz por cima do que esta escrito na pagina: tinge tudo.
  if (clima.luz !== null) {
    const luz = clima.luz;
    const x = luz.canto.endsWith('Direito') ? largura : 0;
    const y = luz.canto.startsWith('inferior') ? altura : 0;
    pintarLuz(ctx, x, y, luz.raio * Math.hypot(largura, altura), luz.cor, luz.alfa, largura, altura, m);
  }
  if (clima.luminaria !== null) {
    const l = clima.luminaria;
    pintarLuz(ctx, largura / 2, altura / 2, (l.raio * Math.hypot(largura, altura)) / 2, l.cor, l.alfa, largura, altura, m);
  }

  if (clima.timbrado !== null) {
    const t = clima.timbrado;
    ctx.strokeStyle = t.cor;
    ctx.lineWidth = t.larguraExterna;
    ctx.beginPath();
    ctx.rect(t.margem, t.margem, largura - 2 * t.margem, altura - 2 * t.margem);
    ctx.stroke();
    const dentro = t.margem + t.espaco;
    ctx.lineWidth = t.larguraInterna;
    ctx.beginPath();
    ctx.rect(dentro, dentro, largura - 2 * dentro, altura - 2 * dentro);
    ctx.stroke();
  }
  if (clima.marcaDagua !== null) {
    const md = clima.marcaDagua;
    // O emoji herda o alfa do fillStyle (fase 12): a cor e a opaca dos emoji,
    // e a transparencia e o globalAlpha.
    ctx.globalAlpha = md.alfa;
    ctx.fillStyle = CONTEUDO.visual.corEmoji;
    ctx.font = `${md.tamanho}px ${CONTEUDO.visual.fonteEmoji}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    glifo(ctx, fx, md.emoji, largura / 2, altura / 2, md.tamanho);
  }
  ctx.restore();
}

// Marca de xicara: um anel inteiro e, um pouco deslocado, um arco incompleto,
// em marrom translucido. Fora da faixa da margem.
function pintarManchas(ctx, rng, f, manchas, margemX, largura, altura) {
  if (manchas.quantidade <= 0) return;
  ctx.strokeStyle = manchas.cor;
  ctx.lineWidth = f.largura;
  for (let i = 0; i < manchas.quantidade; i += 1) {
    const r = rng.range(f.raioMin, f.raioMax);
    const x = rng.range(margemX + f.folga + r, largura - f.folga - r);
    const y = rng.range(f.folga + r, altura - f.folga - r);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    const inicio = rng.range(0, Math.PI * 2);
    ctx.beginPath();
    ctx.arc(x + rng.range(-f.desvio, f.desvio), y + rng.range(-f.desvio, f.desvio), r + rng.range(-f.desvio, f.desvio) / 2, inicio, inicio + f.arco * Math.PI * 2);
    ctx.stroke();
  }
}

// Vinco: uma dobra que atravessa a pagina de cima a baixo, na diagonal, em
// trechos com um pouco de tremor.
function pintarVincos(ctx, rng, f, vincos, largura, altura, m) {
  if (vincos.quantidade <= 0) return;
  ctx.strokeStyle = vincos.cor;
  ctx.lineWidth = f.largura;
  for (let i = 0; i < vincos.quantidade; i += 1) {
    const x0 = rng.range(0, largura);
    const sentido = rng.chance(0.5) ? 1 : -1;
    const x1 = x0 + sentido * rng.range(altura / 2, altura);
    ctx.beginPath();
    ctx.moveTo(x0, -m);
    for (let t = 1; t < f.trechos; t += 1) {
      const k = t / f.trechos;
      ctx.lineTo(x0 + (x1 - x0) * k + rng.range(-f.desvio, f.desvio), -m + (altura + 2 * m) * k);
    }
    ctx.lineTo(x1, altura + m);
    ctx.stroke();
  }
}

// Rabiscos a lapis na faixa da margem, entre os furos e a linha vermelha, do
// jeito que se rabisca esperando a prova: uma molinha descendo (voltas
// encadeadas) ou um caracol (espiral que abre), sorteados.
function pintarRabiscos(ctx, rng, f, rabiscos, altura) {
  if (rabiscos.quantidade <= 0) return;
  const r = f.rabisco;
  const esquerda = f.furos.x + f.furos.raio + r.tamanho / 2;
  const direita = Math.max(esquerda, f.margem.x - r.tamanho / 2);
  const passos = r.voltas * r.passosPorVolta;
  ctx.strokeStyle = rabiscos.cor;
  ctx.lineWidth = r.largura;
  for (let i = 0; i < rabiscos.quantidade; i += 1) {
    const x0 = rng.range(esquerda, direita);
    const y0 = rng.range(f.pauta.topo, altura - r.tamanho * r.voltas);
    const raio = rng.range(r.raioMin, r.raioMax);
    const molinha = rng.chance(r.molinhas);
    const giro = rng.range(0, Math.PI * 2);
    ctx.beginPath();
    for (let p = 0; p <= passos; p += 1) {
      const t = (p / r.passosPorVolta) * Math.PI * 2 + giro;
      const k = p / passos;
      // Molinha: voltas do mesmo tamanho descendo; caracol: o raio abre.
      const rr = molinha ? raio : (r.tamanho / 2) * k;
      const x = x0 + rr * Math.cos(t);
      const y = y0 + (molinha ? raio * r.voltas * k * r.descida : r.tamanho / 2) + rr * Math.sin(t);
      if (p === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

// Luz: gradiente radial da cor (no alfa pedido) ate ela mesma transparente.
function pintarLuz(ctx, x, y, raio, cor, alfa, largura, altura, m) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, raio);
  g.addColorStop(0, comAlfa(cor, alfa));
  g.addColorStop(1, comAlfa(cor, 0));
  ctx.fillStyle = g;
  ctx.fillRect(-m, -m, largura + 2 * m, altura + 2 * m);
}

// '#rgb', '#rrggbb' ou 'rgb(a)(r, g, b[, a])' -> 'rgba(r, g, b, alfa)'. O fim
// transparente de um gradiente tem que ser a MESMA cor com alfa 0: o canvas
// interpola sem pre-multiplicar, e 'transparent' (preto) sujaria o meio do
// caminho. Chamada so ao pintar uma camada (uma vez por clima), nunca por quadro.
export function comAlfa(cor, alfa) {
  let r;
  let g;
  let b;
  if (cor.startsWith('#')) {
    const hex = cor.length === 4 ? cor[1] + cor[1] + cor[2] + cor[2] + cor[3] + cor[3] : cor.slice(1, 7);
    const n = parseInt(hex, 16);
    r = (n >> 16) & 255;
    g = (n >> 8) & 255;
    b = n & 255;
  } else {
    const partes = cor.slice(cor.indexOf('(') + 1, cor.indexOf(')')).split(',');
    r = Number(partes[0]);
    g = Number(partes[1]);
    b = Number(partes[2]);
  }
  return `rgba(${r}, ${g}, ${b}, ${alfa})`;
}

// Vinheta nas bordas (a do clima) e, por cima, a vermelha do dano. Sem
// camada, os gradientes nascem uma vez por clima, nao por quadro.
function desenharVinheta(ctx, fx, clima, largura, altura) {
  const cam = fx.camadas;
  const forcaDano = fx.vinhetaDano > 0 ? fx.vinhetaDano / fx.cfg.flash.vinhetaDanoDuracao : 0;
  if (cam.vinheta) {
    ctx.drawImage(cam.vinheta, 0, 0);
    if (forcaDano > 0 && cam.dano) {
      ctx.globalAlpha = forcaDano;
      ctx.drawImage(cam.dano, 0, 0);
      ctx.globalAlpha = 1;
    }
    return;
  }
  const g = fx.gradientes;
  if (g.clima !== clima || !g.vinheta) {
    const v = clima.vinheta;
    const f = fx.cfg.flash;
    g.clima = clima;
    g.vinheta = gradienteDeBorda(ctx, largura, altura, v.cor, v.raioInterno, v.raioExterno);
    if (!g.dano) g.dano = gradienteDeBorda(ctx, largura, altura, f.corVinhetaDano, f.vinhetaDanoRaioInterno, f.vinhetaDanoRaioExterno);
  }
  ctx.fillStyle = g.vinheta;
  ctx.fillRect(0, 0, largura, altura);
  if (forcaDano > 0) {
    ctx.globalAlpha = forcaDano;
    ctx.fillStyle = g.dano;
    ctx.fillRect(0, 0, largura, altura);
    ctx.globalAlpha = 1;
  }
}

// Raios em fracao da meia-diagonal do canvas.
function gradienteDeBorda(ctx, largura, altura, cor, raioInterno, raioExterno) {
  const meiaDiagonal = Math.hypot(largura, altura) / 2;
  const g = ctx.createRadialGradient(
    largura / 2, altura / 2, raioInterno * meiaDiagonal,
    largura / 2, altura / 2, raioExterno * meiaDiagonal
  );
  g.addColorStop(0, comAlfa(cor, 0));
  g.addColorStop(1, cor);
  return g;
}

// A arena da avaliacao (av.arena). Com a Sala Lotada ela e menor que o
// canvas: o lado de fora vira margem hachurada a lapis — um veu do papel do
// clima e tracos a 45 graus — e a parede, uma linha grossa de caneta. Sem
// isso o jogador bateria numa parede invisivel. Desenhado DEPOIS das
// entidades: quem nasce na faixa de fora fica apagado ate cruzar a parede
// (pendencia 63). `folga` cobre o pedaco que o tremor descobre na borda. Com a
// arena inteira, a parede e a beira da pagina: fina e clara.
function desenharForaDaArena(ctx, arena, clima, largura, altura, v, folga) {
  const { esquerda, topo, direita, base } = arena;
  const encolhida = esquerda > 0 || topo > 0 || direita < largura || base < altura;
  if (encolhida) {
    const f = v.foraDaArena;
    const x0 = -folga;
    const y0 = -folga;
    const w = largura + 2 * folga;
    const h = altura + 2 * folga;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, w, h);
    ctx.rect(esquerda, topo, direita - esquerda, base - topo);
    ctx.clip('evenodd');
    ctx.globalAlpha = f.veu;
    ctx.fillStyle = clima.papel;
    ctx.fillRect(x0, y0, w, h);
    ctx.globalAlpha = f.alfa;
    ctx.strokeStyle = f.cor;
    ctx.lineWidth = f.largura;
    ctx.beginPath();
    for (let d = x0 - h; d < x0 + w; d += f.passo) {
      ctx.moveTo(d, y0);
      ctx.lineTo(d + h, y0 + h);
    }
    ctx.stroke();
    ctx.restore();
  }
  const p = v.parede;
  const l = encolhida ? p.largura : p.larguraInteira;
  ctx.strokeStyle = p.cor;
  ctx.lineWidth = l;
  ctx.globalAlpha = encolhida ? 1 : p.alfaInteira;
  ctx.strokeRect(esquerda + l / 2, topo + l / 2, direita - esquerda - l, base - topo - l);
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------- entidades

// estado.enemies guarda so os inimigos ativos da pool — o que nao esta em uso
// nao aparece aqui, entao nao precisa de teste de `ativo` no desenho.
//
// Desenhados por TAMANHO, do maior para o menor: uma troca de fonte por
// tamanho, e nao uma por inimigo numa horda misturada (pendencia 16) — e o
// 📄 grande fica por baixo de quem anda em volta dele. A 1a passada so le:
// guarda o flash de cada um (flashDoInimigo tem que ver todo inimigo, todo
// quadro) e junta os tamanhos.
const TAMANHOS = [];
const doMaiorParaOMenor = (a, b) => b - a;
let flashes = new Float32Array(0);

function desenharInimigos(ctx, fx, estado, v) {
  const inimigos = estado.enemies;
  const n = inimigos.length;
  const agora = estado.tempo;
  if (flashes.length < n) flashes = new Float32Array(Math.max(n, CONTEUDO.arena.limites.enemies));
  TAMANHOS.length = 0;
  fx.flashBanca = 0;
  for (let i = 0; i < n; i += 1) {
    const e = inimigos[i];
    flashes[i] = flashDoInimigo(fx, e, agora);
    // O chefe tem desenho proprio (desenharBanca), por cima do bando.
    if (e.chefe) {
      fx.flashBanca = flashes[i];
      continue;
    }
    const tamanho = e.raio * v.emojiInimigoFator;
    if (!TAMANHOS.includes(tamanho)) TAMANHOS.push(tamanho);
  }
  TAMANHOS.sort(doMaiorParaOMenor);
  ctx.fillStyle = v.corEmoji;
  for (let t = 0; t < TAMANHOS.length; t += 1) {
    const tamanho = TAMANHOS[t];
    for (let i = 0; i < n; i += 1) {
      const e = inimigos[i];
      if (e.chefe || e.raio * v.emojiInimigoFator !== tamanho) continue;
      if (flashes[i] > 0) desenharComFlash(ctx, fx, e.emoji, e.x, e.y, tamanho, flashes[i]);
      else desenharEmoji(ctx, fx, e.emoji, e.x, e.y, tamanho);
    }
  }
}

// O aviso de spawn: brilho na parede por onde o inimigo recem-nascido vai
// entrar. Sem estado nenhum: e a idade do inimigo (av.decorrido -
// nascidoEm, escrito pela simulacao) e a posicao dele agora. Quem nasce
// dentro da arena (filhote do 📱, horda da Banca, que ja tem aviso proprio)
// nao acende nada.
const ENTRADA = { x: 0, y: 0 };

function desenharAvisosDeSpawn(ctx, fx, estado) {
  const a = fx.cfg.avisoSpawn;
  const av = estado.run.avaliacao;
  const p = estado.player;
  const inimigos = estado.enemies;
  let acesos = 0;
  for (let i = 0; i < inimigos.length; i += 1) {
    const e = inimigos[i];
    if (e.chefe) continue;
    const idade = av.decorrido - e.nascidoEm;
    if (idade < 0 || idade >= a.duracao) continue;
    if (!pontoDeEntrada(e.x, e.y, p.x, p.y, av.arena, ENTRADA)) continue;
    if (acesos === 0) {
      if (!fx.gradientes.aviso) {
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, a.raio);
        g.addColorStop(0, a.corCentro);
        g.addColorStop(1, a.corBorda);
        fx.gradientes.aviso = g;
      }
      ctx.fillStyle = fx.gradientes.aviso;
      ctx.globalCompositeOperation = a.composicao;
    }
    acesos += 1;
    // Acende e apaga: seno de meia volta ao longo da duracao.
    ctx.globalAlpha = a.alphaMax * Math.sin((Math.PI * idade) / a.duracao);
    // O gradiente e do espaco do usuario: mover a origem leva o brilho junto.
    ctx.setTransform(1, 0, 0, 1, ENTRADA.x + fx.tremorX, ENTRADA.y + fx.tremorY);
    ctx.fillRect(-a.raio, -a.raio, 2 * a.raio, 2 * a.raio);
  }
  if (acesos > 0) {
    ctx.setTransform(1, 0, 0, 1, fx.tremorX, fx.tremorY);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
  fx.diag.avisos = acesos;
}

function desenharParticulas(ctx, fx) {
  const ps = fx.particulas.ativos;
  if (ps.length === 0) return;
  ctx.globalCompositeOperation = fx.cfg.particulas.composicao;
  let cor = '';
  for (let i = 0; i < ps.length; i += 1) {
    const p = ps[i];
    if (p.cor !== cor) {
      cor = p.cor;
      ctx.fillStyle = cor;
    }
    ctx.globalAlpha = p.vida / p.vidaMax;
    const meio = p.tamanho / 2;
    ctx.fillRect(p.x - meio, p.y - meio, p.tamanho, p.tamanho);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

// Os numeros de dano, por cima de tudo do mundo. Duas passadas (os do
// jogador tem fonte propria) para nao trocar de fonte a cada numero; o "pulo"
// e escala do contexto, nao tamanho de fonte.
function desenharNumeros(ctx, fx) {
  const ns = fx.numeros.ativos;
  if (ns.length === 0) return;
  const c = fx.cfg.numeros;
  ctx.lineJoin = 'round';
  ctx.lineWidth = c.larguraContorno;
  ctx.strokeStyle = c.corContorno;
  for (let passada = 0; passada < 2; passada += 1) {
    const doJogador = passada === 1;
    let preparado = false;
    for (let i = 0; i < ns.length; i += 1) {
      const n = ns[i];
      if (n.jogador !== doJogador) continue;
      const valor = Math.round(n.valor);
      // O Marca-texto acerta fracoes por tick: o numero so aparece quando a
      // soma chega a 1.
      if (valor < 1) continue;
      if (valor !== n.mostrado) {
        n.mostrado = valor;
        n.texto = String(valor);
      }
      if (!preparado) {
        preparado = true;
        usarFonte(ctx, fx, doJogador ? c.fonteJogador : c.fonte);
        ctx.fillStyle = doJogador ? c.corJogador : c.cor;
      }
      const vida = n.idade / c.vida;
      ctx.globalAlpha = vida < c.inicioFade ? 1 : Math.max(0, 1 - (vida - c.inicioFade) / (1 - c.inicioFade));
      const escala = 1 + c.pop * (n.pop / c.popDuracao);
      ctx.setTransform(escala, 0, 0, escala, n.x + fx.tremorX, n.y + fx.tremorY);
      ctx.strokeText(n.texto, 0, 0);
      ctx.fillText(n.texto, 0, 0);
    }
  }
  ctx.setTransform(1, 0, 0, 1, fx.tremorX, fx.tremorY);
  ctx.globalAlpha = 1;
}

// ------------------------------------------------------------- A Banca

// Tudo aqui le o espelho em estado.run.avaliacao.banca (boss.js), escrito
// depois das armas a cada tick: e a posicao e o HP do fim do tick.

// A Banca: aura na cor da fase (a "mudanca de cor" da transicao) e o emoji
// maior que o corpo de colisao. Na transicao a aura pisca entre a cor da
// fase que acabou e a da que vem, no relogio da propria transicao — parado
// na pausa, como todo o resto.
function desenharBanca(ctx, fx, b, v) {
  if (b.estado === ESTADOS_BANCA.DERROTADA) return;
  const vb = v.banca;
  let cor = vb.corAura[b.fase];
  if (b.estado === ESTADOS_BANCA.TRANSICAO) {
    const t = b.duracaoEstado - b.relogio;
    if (Math.sin(2 * Math.PI * vb.pulsoTransicao * t) > 0) cor = vb.corAura[b.fase + 1] || cor;
  }
  ctx.fillStyle = cor;
  ctx.beginPath();
  ctx.arc(b.x, b.y, vb.raioAura, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = v.corEmoji;
  if (fx.flashBanca > 0) desenharComFlash(ctx, fx, CONTEUDO.banca.emoji, b.x, b.y, vb.tamanhoEmoji, fx.flashBanca);
  else desenharEmoji(ctx, fx, CONTEUDO.banca.emoji, b.x, b.y, vb.tamanhoEmoji);
}

// O aviso de cada padrao (contrato da fase 10, tarefa 4): nasce fraco e
// fica forte ate o golpe sair. O desenho e o que o golpe vai fazer, com os
// mesmos numeros: as linhas do leque sao os angulos das perguntas
// (anguloDoLeque, de boss.js), a faixa da investida e o caminho cortado na
// parede (b.alcance), os circulos da horda sao onde cada inimigo nasce.
const AVISOS = {
  leque: avisoDoLeque,
  investida: avisoDaInvestida,
  horda: avisoDaHorda,
};

function desenharAvisosDaBanca(ctx, fx, b, v) {
  const avisando = b.estado === ESTADOS_BANCA.TELEGRAFO;
  // O leque com mais de uma salva continua mostrando as linhas ate a ultima.
  const salvas = b.estado === ESTADOS_BANCA.EXECUTANDO && b.salvas > 0;
  if (!avisando && !salvas) return;
  const params = CONTEUDO.banca.fases[b.fase].padroes[b.padrao];
  const aviso = AVISOS[b.padrao];
  if (!params || !aviso) return;
  const vb = v.banca;
  const progresso = avisando && b.duracaoEstado > 0 ? Math.min(1, Math.max(0, 1 - b.relogio / b.duracaoEstado)) : 1;
  ctx.save();
  ctx.globalAlpha = vb.alphaTelegrafoMin + (vb.alphaTelegrafoMax - vb.alphaTelegrafoMin) * progresso;
  ctx.strokeStyle = vb.corTelegrafo;
  ctx.fillStyle = vb.corTelegrafo;
  aviso(ctx, b, params, progresso, v, avisando);
  restaurar(ctx, fx);
}

function avisoDoLeque(ctx, b, params, progresso, v) {
  const vb = v.banca;
  const inicio = CONTEUDO.banca.raio;
  ctx.lineWidth = vb.larguraRaioLeque;
  ctx.beginPath();
  for (let i = 0; i < params.projeteis; i += 1) {
    const a = anguloDoLeque(b.mira, i, params.projeteis, params.abertura);
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    ctx.moveTo(b.x + dx * inicio, b.y + dy * inicio);
    ctx.lineTo(b.x + dx * vb.alcanceRaioLeque, b.y + dy * vb.alcanceRaioLeque);
  }
  ctx.stroke();
}

// O caminho inteiro (boss.js, tracarInvestida): o trecho reto, da Banca ate a
// quina, e o deslize ao longo da parede, se houver (pendencia 75). A faixa
// enche da Banca para a ponta, pelos dois trechos: quando chega la, ela corre.
function avisoDaInvestida(ctx, b, params, progresso, v, avisando) {
  if (!avisando) return;
  const r = CONTEUDO.banca.raio;
  const fracao = v.banca.preenchimentoInvestida;
  const cheio = (b.alcance + b.deslize + r) * progresso;
  ctx.lineWidth = 2;
  faixaDaInvestida(ctx, b.x, b.y, b.mira, b.alcance + r, Math.min(cheio, b.alcance + r), r, fracao);
  if (b.deslize > 0) {
    faixaDaInvestida(ctx, b.quinaX, b.quinaY, Math.atan2(b.deslizeY, b.deslizeX), b.deslize + r, Math.max(0, cheio - b.alcance), r, fracao);
  }
}

// Um trecho da faixa, de (x, y) na direcao `angulo`: o contorno inteiro e, por
// dentro, o quanto ja encheu. save/restore devolvem o transform do mundo (com
// o tremor) para o trecho seguinte.
function faixaDaInvestida(ctx, x, y, angulo, comprimento, cheio, r, fracao) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angulo);
  ctx.strokeRect(0, -r, comprimento, r * 2);
  ctx.globalAlpha *= fracao;
  if (cheio > 0) ctx.fillRect(0, -r, cheio, r * 2);
  ctx.restore();
}

// O raio de cada tipo, por id, montado uma vez: o aviso da horda nao procura
// em CONTEUDO.inimigos a cada quadro (pendencia 79).
let raioPorTipo = null;

function raioDoTipo(id) {
  if (!raioPorTipo) {
    raioPorTipo = new Map();
    for (const t of CONTEUDO.inimigos) raioPorTipo.set(t.id, t.raio);
  }
  const raio = raioPorTipo.get(id);
  return raio === undefined ? CONTEUDO.banca.raio : raio;
}

function avisoDaHorda(ctx, b, params, progresso) {
  const raio = raioDoTipo(params.tipo) * (1 + progresso);
  ctx.lineWidth = 2;
  for (let i = 0; i < b.quantosPontos; i += 1) {
    ctx.beginPath();
    ctx.arc(b.pontos[i].x, b.pontos[i].y, raio, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// As perguntas do leque: por cima dos inimigos, como os projeteis do jogador
// — e o que o jogador mais precisa enxergar.
function desenharPerguntas(ctx, fx, perguntas, v) {
  const cfg = CONTEUDO.banca.pergunta;
  const tamanho = cfg.raio * v.banca.emojiPerguntaFator;
  ctx.fillStyle = v.corEmoji;
  for (let i = 0; i < perguntas.length; i += 1) {
    desenharEmoji(ctx, fx, cfg.emoji, perguntas[i].x, perguntas[i].y, tamanho);
  }
}

// O texto da virada de fase, numa faixa escura no meio da tela, durante a
// pausa da transicao inteira (banca.transicao.duracao). Fora do tremor.
function desenharTransicaoDaBanca(ctx, fx, b, largura, altura, v) {
  if (b.estado !== ESTADOS_BANCA.TRANSICAO) return;
  const proxima = CONTEUDO.banca.fases[b.fase + 1];
  if (!proxima) return;
  const vb = v.banca;
  const topo = altura * vb.faixaTextoY;
  const alto = altura * vb.faixaTextoAltura;
  ctx.fillStyle = vb.corSombraTexto;
  ctx.fillRect(0, topo, largura, alto);
  ctx.fillStyle = vb.corTexto;
  usarFonte(ctx, fx, vb.fonteTexto);
  ctx.fillText(CONTEUDO.textos.banca.transicao, largura / 2, topo + alto * 0.4);
  usarFonte(ctx, fx, vb.fonteSubtexto);
  ctx.fillText(preencher(CONTEUDO.textos.banca.fase, { n: b.fase + 2, nome: proxima.nome }), largura / 2, topo + alto * 0.75);
}

// Desenhados depois dos inimigos e antes do jogador: o projetil precisa
// aparecer por cima de quem ele vai acertar para a leitura funcionar no meio
// do bando.
function desenharProjeteis(ctx, fx, projeteis, v) {
  ctx.fillStyle = v.corEmoji;
  for (let i = 0; i < projeteis.length; i += 1) {
    const p = projeteis[i];
    desenharEmoji(ctx, fx, p.emoji, p.x, p.y, p.raio * v.emojiProjetilFator);
  }
}

// Por baixo de todo mundo: orbe nenhum pode esconder um inimigo que vem
// chegando. Grampeado na arena SO no desenho (pendencia 29): o impulso do
// nascimento leva o orbe da borda ate ~36px para fora, e ele continua
// coletavel la — a simulacao nao muda, so o lugar onde ele aparece.
function desenharOrbes(ctx, fx, orbes, arena, v) {
  // Todo orbe tem o mesmo raio (CONTEUDO.xpOrbe.raio), so o valor muda — o
  // tamanho sai da conta uma vez, fora do laco.
  const raio = CONTEUDO.xpOrbe.raio;
  const tamanho = raio * v.emojiOrbeFator;
  const xMin = arena.esquerda + raio;
  const xMax = arena.direita - raio;
  const yMin = arena.topo + raio;
  const yMax = arena.base - raio;
  ctx.fillStyle = v.corEmoji;
  for (let i = 0; i < orbes.length; i += 1) {
    const x = Math.min(xMax, Math.max(xMin, orbes[i].x));
    const y = Math.min(yMax, Math.max(yMin, orbes[i].y));
    desenharEmoji(ctx, fx, CONTEUDO.xpOrbe.emoji, x, y, tamanho);
  }
}

function desenharJogador(ctx, fx, player, v) {
  // Jubilado: o jogador virou faisca (consumirEventos), nao tem o que desenhar.
  if (!player.vivo) return;
  desenharRastro(ctx, player, v);

  // Pisca-pisca durante os i-frames: alterna com base no proprio contador de
  // invulnerabilidade (que so anda durante a avaliacao), nunca em estado.tempo.
  const piscando =
    player.invulneravel > 0 && Math.floor(player.invulneravel / v.piscaIntervalo) % 2 === 1;
  if (piscando) return;

  ctx.fillStyle = v.corEmoji;
  const flash = fx.flashJogador > 0 ? fx.flashJogador / fx.cfg.flash.jogadorDuracao : 0;
  if (flash > 0) desenharComFlash(ctx, fx, CONTEUDO.jogador.emoji, player.x, player.y, v.tamanhoEmojiJogador, flash);
  else desenharEmoji(ctx, fx, CONTEUDO.jogador.emoji, player.x, player.y, v.tamanhoEmojiJogador);
}

// Rastro: um traco que afina para tras, pelos pontos do buffer circular, do
// mais antigo ao mais novo. r.indice aponta pro slot mais antigo (proximo a
// ser sobrescrito). Pendencia 11: com bolinhas de raio 7,7px a cada ~3px, o
// rastro antigo era um borrao; o traco afinando le como movimento.
function desenharRastro(ctx, player, v) {
  const r = player.rastro;
  const n = r.pontos.length;
  const espessura = CONTEUDO.jogador.raio * v.rastroRaioFator * 2;
  ctx.strokeStyle = v.corRastro;
  ctx.lineCap = 'round';
  let anterior = null;
  for (let i = 0; i < n; i += 1) {
    const ponto = r.pontos[(r.indice + i) % n];
    if (!ponto.ativo) {
      anterior = null;
      continue;
    }
    if (anterior !== null) {
      const t = (i + 1) / n;
      ctx.globalAlpha = t * v.rastroAlphaMax;
      ctx.lineWidth = espessura * t;
      ctx.beginPath();
      ctx.moveTo(anterior.x, anterior.y);
      ctx.lineTo(ponto.x, ponto.y);
      ctx.stroke();
    }
    anterior = ponto;
  }
  ctx.globalAlpha = 1;
}

// orbital, ondaArea e feixe nao passam pela pool de projeteis (a orbita e o
// feixe seguem o jogador continuamente; discretizar isso em objetos pooled
// so pra desenhar seria mais estado pra sincronizar por nenhum ganho). O
// desenho le a mesma instancia de arma (estado.player.armas) e os mesmos
// numeros de content.js que weapons.js usa para a colisao, entao o que
// aparece na tela e sempre exatamente onde o dano acontece.
function desenharArmasEspeciais(ctx, fx, player, v) {
  if (!player.vivo) return;
  for (let i = 0; i < player.armas.length; i += 1) {
    const arma = player.armas[i];
    const dados = dadosDaArma(arma.id);
    if (!dados) continue;
    const nivel = nivelDaArma(arma);
    if (!nivel) continue;

    if (dados.comportamento === 'orbital') desenharOrbital(ctx, fx, player, arma, dados, nivel, v);
    else if (dados.comportamento === 'ondaArea') desenharOnda(ctx, player, arma, nivel, v);
    else if (dados.comportamento === 'feixe') desenharFeixe(ctx, fx, player, arma, nivel, v);
  }
}

function desenharOrbital(ctx, fx, player, arma, dados, nivel, v) {
  const tamanho = nivel.raioColisao * v.emojiSateliteFator;
  ctx.fillStyle = v.corEmoji;
  for (let s = 0; s < nivel.quantidade; s += 1) {
    const pos = posicaoSatelite(player, arma, nivel, s);
    desenharEmoji(ctx, fx, dados.emoji, pos.x, pos.y, tamanho);
  }
}

// O telegrafo cresce de 0 ate nivel.raio ao longo de CONTEUDO.ondaArea.
// duracaoAnimacao e desaparece (alpha cai) no mesmo ritmo — sem isso o dano
// da onda parece aleatorio (tarefa 2 do contrato da fase 05).
function desenharOnda(ctx, player, arma, nivel, v) {
  const duracao = CONTEUDO.ondaArea.duracaoAnimacao;
  const progresso = Math.min(1, (arma.animacao || 0) / duracao);
  if (progresso >= 1) return; // pulso anterior ja terminou de sumir
  ctx.strokeStyle = v.corOndaTelegrafo;
  ctx.globalAlpha = 1 - progresso;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(player.x, player.y, nivel.raio * progresso, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// Desenhado como uma faixa translucida (a "marcacao" do highlighter) do
// jogador ate o alcance, na direcao guardada em arma.angulo — a mesma
// direcao que weapons.js usa para a colisao.
function desenharFeixe(ctx, fx, player, arma, nivel, v) {
  const angulo = arma.angulo || 0;
  ctx.save();
  ctx.translate(player.x, player.y);
  ctx.rotate(angulo);
  ctx.fillStyle = v.corFeixe;
  ctx.fillRect(0, -nivel.largura / 2, nivel.alcance, nivel.largura);
  restaurar(ctx, fx);
}

// ---------------------------------------------------------------- texto

// A fonte do canvas so muda quando o tamanho muda (pendencia 16): atribuir
// ctx.font e parsear uma string, e com 400 inimigos isso era feito 400 vezes
// por quadro. As strings ficam guardadas por tamanho.
function desenharEmoji(ctx, fx, emoji, x, y, tamanho) {
  if (fx.tamanhoFonte !== tamanho) {
    let fonte = fx.fontes.get(tamanho);
    if (fonte === undefined) {
      fonte = `${tamanho}px ${CONTEUDO.visual.fonteEmoji}`;
      fx.fontes.set(tamanho, fonte);
    }
    usarFonte(ctx, fx, fonte);
    fx.tamanhoFonte = tamanho;
  }
  glifo(ctx, fx, emoji, x, y, tamanho);
}

// O emoji, ou a forma no lugar dele numa maquina sem a fonte.
function glifo(ctx, fx, emoji, x, y, tamanho) {
  if (fx.emojiFaltando === null || !fx.emojiFaltando.has(emoji)) {
    ctx.fillText(emoji, x, y);
    return;
  }
  const fb = CONTEUDO.visual.emojiFallback;
  const cor = fb.cores[emoji];
  const antes = ctx.fillStyle;
  ctx.fillStyle = cor === undefined ? fb.corPadrao : cor;
  ctx.beginPath();
  ctx.arc(x, y, tamanho * fb.fatorRaio, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = antes;
}

// ------------------------------------------------------- emoji sem fonte

// Caracteres que nenhuma fonte desenha (o ultimo da area privada do plano 16
// e um nao-caractere do plano 1): o navegador poe no lugar deles o mesmo
// glifo de "nao tenho" (o tofu) que poria num emoji sem fonte.
export const REFERENCIAS_TOFU = ['\u{10FFFD}', '\u{1FFFE}'];
// Uma letra que toda fonte tem. Se ela sair em branco ou igual ao tofu, a
// leitura do canvas nao e confiavel (privacidade do navegador devolvendo
// pixels constantes) e nada e trocado: emoji de verdade virando circulo seria
// pior que o tofu.
export const CONTROLE_TOFU = 'A';

// Todo emoji que o canvas desenha. O resto (cartas, loja, HUD) e texto do DOM.
export function emojisDoCanvas(c = CONTEUDO) {
  const lista = [c.jogador.emoji, c.xpOrbe.emoji, c.banca.emoji, c.banca.pergunta.emoji];
  for (const a of c.armas) lista.push(a.emoji);
  for (const i of c.inimigos) lista.push(i.emoji);
  return lista;
}

// Desenha cada emoji num canvas pequeno, fora da tela, e compara os pixels
// com os do tofu: igual ao tofu, ou em branco, e emoji que esta maquina nao
// tem. Uma vez por canvas (o 1o quadro). Devolve o Set dos que faltam, ou
// null — nenhum falta, ou nao deu para testar (node, canvas sem leitura).
export function detectarEmojiFaltando(ctx, emojis = emojisDoCanvas(), v = CONTEUDO.visual) {
  const doc = ctx && ctx.canvas && ctx.canvas.ownerDocument;
  if (!doc || typeof doc.createElement !== 'function') return null;
  try {
    const fb = v.emojiFallback;
    const lado = fb.tamanhoTeste;
    const tela = doc.createElement('canvas');
    tela.width = lado;
    tela.height = lado;
    const c = tela.getContext('2d', { willReadFrequently: true });
    if (!c || typeof c.getImageData !== 'function') return null;
    c.font = `${fb.fonteTeste}px ${v.fonteEmoji}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = v.corEmoji;
    const ler = (texto) => {
      c.clearRect(0, 0, lado, lado);
      c.fillText(texto, lado / 2, lado / 2);
      return c.getImageData(0, 0, lado, lado).data;
    };
    const controle = ler(CONTROLE_TOFU);
    const tofus = REFERENCIAS_TOFU.map(ler);
    if (emBranco(controle) || tofus.some((t) => mesmosPixels(t, controle))) return null;
    let faltando = null;
    for (const emoji of emojis) {
      const p = ler(emoji);
      if (!emBranco(p) && !tofus.some((t) => mesmosPixels(t, p))) continue;
      if (!faltando) faltando = new Set();
      faltando.add(emoji);
    }
    return faltando;
  } catch {
    return null;
  }
}

function emBranco(dados) {
  for (let i = 0; i < dados.length; i += 1) if (dados[i] !== 0) return false;
  return true;
}

function mesmosPixels(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

// O flash: o emoji "incha" (escala do contexto, nao fonte nova) e e
// redesenhado em modo aditivo, que clareia so os pixels dele.
function desenharComFlash(ctx, fx, emoji, x, y, tamanho, forca) {
  const f = fx.cfg.flash;
  const escala = 1 + f.escalaPop * forca;
  ctx.setTransform(escala, 0, 0, escala, x + fx.tremorX, y + fx.tremorY);
  desenharEmoji(ctx, fx, emoji, 0, 0, tamanho);
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = f.alpha * forca;
  glifo(ctx, fx, emoji, 0, 0, tamanho);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.setTransform(1, 0, 0, 1, fx.tremorX, fx.tremorY);
}

function usarFonte(ctx, fx, fonte) {
  if (fx.fonteAtual === fonte) return;
  ctx.font = fonte;
  fx.fonteAtual = fonte;
  fx.tamanhoFonte = -1;
  fx.diag.fontes += 1;
}

// ctx.restore() devolve a fonte do save(): a lembranca da fonte atual deixa
// de valer.
function restaurar(ctx, fx) {
  ctx.restore();
  fx.fonteAtual = '';
  fx.tamanhoFonte = -1;
}
