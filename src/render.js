import { CONTEUDO } from '../data/content.js';
import { TELAS } from './state.js';
import { criarPool } from './pool.js';
import { criarRng } from './rng.js';
import { dadosDaArma, nivelDaArma } from './weapons.js';
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
    fx.movimento = consultaDeMovimento(ctx);
    efeitosPorContexto.set(ctx, fx);
  }
  return fx;
}

// Fase 22: o `prefers-reduced-motion` do navegador tambem vale no canvas. A
// consulta e da janela do proprio canvas, aberta uma vez (ela acompanha a
// preferencia ao vivo); no node, e no contexto falso, nao existe e nada muda.
function consultaDeMovimento(ctx) {
  const janela = ctx && ctx.canvas && ctx.canvas.ownerDocument && ctx.canvas.ownerDocument.defaultView;
  return janela && typeof janela.matchMedia === 'function' ? janela.matchMedia('(prefers-reduced-motion: reduce)') : null;
}

function movimentoReduzido(fx) {
  return fx.movimento !== null && fx.movimento.matches === true;
}
// Lido uma vez por quadro (avancarEfeitos) em fx.parado: o `matches` da
// consulta e uma ida ao navegador, e o balanco o pediria por figurinha
// (centenas por quadro; o laco real mediu +0,5 ms).

export function criarEfeitos(cfg = CONTEUDO.juice, tema = CONTEUDO.tema, fig = CONTEUDO.visual.figurinhas) {
  return {
    cfg,
    tema,
    // Figurinhas (fase 16). O cache: `${emoji}|${tamanho}|${variante}|${degrau}`
    // (variante 'normal' ou 'espelhada'; degrau da inclinacao, -niveis..niveis)
    // -> { camada, sx, sy, largura, altura, cx, cy } — a celula dela na folha
    // (`camada`), e o centro do emoji na celula. O indice e o mesmo cache sem
    // montar string no caminho quente: emoji -> tamanho -> [variante x degrau].
    fig,
    figurinhas: new Map(),
    indiceFigurinhas: new Map(),
    // A folha de figurinhas e os dois rascunhos do cozimento (a silhueta e a
    // silhueta dilatada): tres canvas, criados no 1o quadro com figurinha e
    // nunca mais. `x`, `y`, `linha`: onde cabe a proxima (prateleiras).
    folha: { tentada: false, camada: null, silhueta: null, dilatada: null, x: 0, y: 0, linha: 0 },
    perfis: montarPerfis(fig, cfg),
    corRecorte: comAlfa(fig.recorte.cor, 1), // a sombra do recorte, opaca: o alfa e o globalAlpha
    // Para onde o jogador esta virado: so muda acima de limiarEspelho (parado,
    // ele continua olhando para onde andava). Estado do desenho, nao do jogo.
    jogadorEspelhado: false,
    bancaVx: 0, // a velocidade do corpo da Banca, lida no laco dos inimigos
    // A fase do balanco e o nasc RELATIVO ao primeiro visto na avaliacao: o
    // nasc absoluto conta todo nascimento da pool desde que a pagina abriu, e
    // a mesma run num navegador usado balancaria diferente de um novo.
    baseNascInimigo: Infinity,
    baseNascOrbe: Infinity,
    rng: criarRng(cfg.semente), // nunca o da simulacao
    // Fase 17: o das formas — o tremido do rastro, a forma, o angulo e o giro
    // das faiscas —, a parte para nao mudar a sequencia de `rng` (as faiscas e
    // o tremor saem como antes), e reiniciado a cada avaliacao (limparEfeitos):
    // a mesma avaliacao desenha igual em qualquer navegador.
    rngFormas: criarRng(cfg.sementeFormas),
    // O da pagina (pintarPagina): reiniciado em cfg.fundo.semente a cada
    // pintura, para o mesmo clima sair sempre a mesma pagina — e sem mexer na
    // sequencia de `rng`, que as faiscas e o tremor seguem usando.
    rngPagina: criarRng(cfg.fundo.semente),
    // A pool da fase 02, com o teto que ja estava reservado para particulas.
    particulas: criarPool(CONTEUDO.arena.limites.particles, novaParticula),
    numeros: criarPool(cfg.numeros.max, novoNumero),
    rajadas: new Map(), // id do tipo -> padrao + porTipo, combinado uma vez
    // Fase 17: as faiscas sao desenhadas por balde — (cor, forma, degrau de
    // alfa) —: a cor e o alfa mudam uma vez por balde. As cores de todas as
    // rajadas, numeradas uma vez; os baldes e a ordem, em arrays de tamanho
    // fixo (contagem).
    ...baldesDeParticulas(cfg.particulas, CONTEUDO.arena.limites.particles),
    // O rastro do jogador: o tremido de cada ponto (x, y), sorteado quando o
    // ponto nasce. `ref` e o rastro do jogador da vez (um por avaliacao) e
    // `indice`, onde ele estava no ultimo quadro.
    rastro: { ref: null, indice: 0, ruido: new Float32Array(2 * CONTEUDO.jogador.rastroTamanho) },
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
    // A preferencia de movimento reduzido (efeitosDe; null = sem navegador).
    // Com ela o tremor e o balanco ficam parados; o rng anda igual.
    movimento: null,
    parado: false, // movimentoReduzido(fx) deste quadro
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
    gradientes: { clima: null, vinheta: null, dano: null },
    // A pagina e as vinhetas pintadas uma vez por clima (desenharFundo).
    // `criarCamada` (w, h) -> canvas pode ser trocada (o smoke passa a dele).
    camadas: { clima: null, chao: null, vinheta: null, dano: null, criadas: 0 },
    criarCamada: null,
    // Para o smoke e para medir: o que o ultimo quadro fez (figurinhasCozidas,
    // figurinhasRecusadas: neste quadro; as recusadas sairam sem contorno,
    // com a folha cheia ou o teto atingido).
    diag: {
      fontes: 0, avisos: 0, numerosAgrupados: 0, numerosDescartados: 0, particulasDescartadas: 0,
      figurinhasCozidas: 0, figurinhasRecusadas: 0,
      flashesCozidos: 0, // silhuetas de golpe cozidas desde que o fx nasceu (fase 17)
    },
  };
}

// Fase 17: cada faisca e um confete (forma 0) ou um rabisco (forma 1), com
// angulo e giro (rad/s); `corIndice` e a cor no indice de fx.cores, o que o
// balde dela usa.
const CONFETE = 0;
const RABISCO = 1;

function novaParticula() {
  return { x: 0, y: 0, vx: 0, vy: 0, vida: 0, vidaMax: 0, tamanho: 0, atrito: 0, cor: '', corIndice: 0, forma: CONFETE, angulo: 0, giro: 0 };
}

// As cores de todas as rajadas (padrao, cada tipo, o jogador), numeradas, e os
// arrays de tamanho fixo da contagem por balde. Balde = (cor x forma) x
// niveisDeAlfa + degrau.
function baldesDeParticulas(p, capacidade) {
  const cores = [];
  const indiceCor = new Map();
  const anotar = (r) => {
    for (const c of (r && r.cores) || []) {
      if (!indiceCor.has(c)) {
        indiceCor.set(c, cores.length);
        cores.push(c);
      }
    }
  };
  anotar(p.padrao);
  anotar(p.jogador);
  for (const r of Object.values(p.porTipo)) anotar(r);
  const baldes = cores.length * 2 * p.niveisDeAlfa;
  return {
    cores,
    indiceCor,
    baldeDe: new Uint16Array(capacidade), // o balde de cada faisca ativa, no quadro
    ordem: new Uint16Array(capacidade), // as faiscas ativas, em ordem de balde
    inicioBalde: new Uint16Array(baldes + 1), // onde cada balde comeca em `ordem`
    cursorBalde: new Uint16Array(baldes),
  };
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
  fx.diag.figurinhasCozidas = 0;
  fx.diag.figurinhasRecusadas = 0;

  // O tremor e so isto: o mundo inteiro desenhado deslocado. Nenhuma posicao
  // de entidade muda.
  const ox = naArena ? fx.tremorX : 0;
  const oy = naArena ? fx.tremorY : 0;
  desenharFundo(ctx, fx, clima, largura, altura, ox, oy);

  if (naArena) {
    const av = estado.run.avaliacao;
    const banca = av.banca;
    desenharOrbes(ctx, fx, estado.xpOrbs, av.arena, v);
    desenharLanches(ctx, fx, estado.lanches, v);
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
  // Movimento reduzido: o sorteio acontece igual (as faiscas seguem a mesma
  // sequencia), so o deslocamento nao e aplicado.
  fx.parado = movimentoReduzido(fx);
  if (fx.parado) {
    fx.tremorX = 0;
    fx.tremorY = 0;
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
  fx.jogadorEspelhado = false;
  fx.baseNascInimigo = Infinity;
  fx.baseNascOrbe = Infinity;
  fx.rastro.ref = null; // o jogador da avaliacao nova tem rastro novo
  fx.rngFormas.s = fx.cfg.sementeFormas >>> 0;
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
    p.giro *= freio; // o confete gira menos conforme freia
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.angulo += p.giro * dt;
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
    r.indices = r.cores.map((c) => fx.indiceCor.get(c));
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
    const k = fx.rng.int(0, r.cores.length - 1);
    p.cor = r.cores[k];
    p.corIndice = r.indices[k];
    // Fase 17: a forma, o angulo e o giro, do rng das formas (a direcao, a
    // velocidade, a vida, o tamanho e a cor saem de `rng` como antes).
    p.forma = fx.rngFormas.chance(r.fracaoRabisco) ? RABISCO : CONFETE;
    p.angulo = fx.rngFormas.float() * VOLTA;
    p.giro = fx.rngFormas.range(-r.giroMax, r.giroMax);
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
  return memoriaDoInimigo(fx, e, agora).flash;
}

// O que o desenho lembra de cada inimigo entre quadros: o HP (o flash) e o
// lado para onde ele esta virado (fase 16: o espelho so muda acima de
// limiarEspelho, senao quem passa por cima do jogador piscaria de lado). Mora
// em fx.golpes, nunca no inimigo.
function memoriaDoInimigo(fx, e, agora) {
  const duracao = fx.cfg.flash.duracao;
  let g = fx.golpes.get(e);
  if (g === undefined) {
    g = { nasc: e.nasc, hp: e.hp, ate: 0, flash: 0, esquerda: false };
    fx.golpes.set(e, g);
  } else if (g.nasc !== e.nasc) {
    g.nasc = e.nasc;
    g.hp = e.hp;
    g.ate = 0;
    g.esquerda = false;
  } else {
    if (e.hp < g.hp) g.ate = agora + duracao;
    g.hp = e.hp;
  }
  const resta = g.ate - agora;
  g.flash = resta > 0 ? Math.min(1, resta / duracao) : 0;
  const limiar = fx.fig.limiarEspelho;
  if (e.vx < -limiar) g.esquerda = true;
  else if (e.vx > limiar) g.esquerda = false;
  return g;
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
// Desenhados por TAMANHO, do maior para o menor: o 📄 grande fica por baixo
// de quem anda em volta dele (era tambem uma troca de fonte por tamanho, e
// nao por inimigo — pendencia 16; com as figurinhas, a fonte so muda no
// cozimento). A 1a passada so le: guarda o flash e o lado de cada um
// (memoriaDoInimigo tem que ver todo inimigo, todo quadro) e junta os
// tamanhos.
const TAMANHOS = [];
const doMaiorParaOMenor = (a, b) => b - a;
let flashes = new Float32Array(0);
let esquerdas = new Uint8Array(0);

function desenharInimigos(ctx, fx, estado, v) {
  const inimigos = estado.enemies;
  const n = inimigos.length;
  const agora = estado.tempo;
  if (flashes.length < n) {
    flashes = new Float32Array(Math.max(n, CONTEUDO.arena.limites.enemies));
    esquerdas = new Uint8Array(flashes.length);
  }
  TAMANHOS.length = 0;
  fx.flashBanca = 0;
  fx.bancaVx = 0;
  const perfil = fx.perfis.inimigo;
  let bando = 0;
  for (let i = 0; i < n; i += 1) {
    const e = inimigos[i];
    const g = memoriaDoInimigo(fx, e, agora);
    flashes[i] = g.flash;
    esquerdas[i] = g.esquerda ? 1 : 0;
    // O chefe tem desenho proprio (desenharBanca), por cima do bando.
    if (e.chefe) {
      fx.flashBanca = g.flash;
      fx.bancaVx = e.vx;
      continue;
    }
    if (e.nasc < fx.baseNascInimigo) fx.baseNascInimigo = e.nasc;
    bando += 1;
    const tamanho = e.raio * v.emojiInimigoFator;
    if (!TAMANHOS.includes(tamanho)) TAMANHOS.push(tamanho);
  }
  if (bando === 0) return;
  TAMANHOS.sort(doMaiorParaOMenor);
  const o = OPCOES;
  o.perfil = perfil;
  o.vy = 0;
  for (let t = 0; t < TAMANHOS.length; t += 1) {
    const tamanho = TAMANHOS[t];
    for (let i = 0; i < n; i += 1) {
      const e = inimigos[i];
      if (e.chefe || e.raio * v.emojiInimigoFator !== tamanho) continue;
      o.vx = e.vx;
      o.nasc = e.nasc - fx.baseNascInimigo;
      o.espelhada = esquerdas[i] === 1;
      o.flash = flashes[i];
      desenharFigurinha(ctx, fx, e.emoji, e.x, e.y, tamanho, o);
    }
  }
}

// O aviso de spawn (fase 17): uma seta rabiscada a caneta vermelha na margem
// da pagina, no ponto da parede por onde o inimigo recem-nascido vai entrar,
// apontando para dentro — para onde ele anda (o jogador). Sem estado nenhum: e
// a idade do inimigo (av.decorrido - nascidoEm, escrito pela simulacao) e a
// posicao dele agora. A seta e desenhada com a origem no ponto de entrada e o
// eixo x na direcao da entrada (setTransform), e cresce da parede ate a ponta
// no comeco, como quem rabisca. Quem nasce dentro da arena (filhote do 📱,
// horda da Banca, que ja tem aviso proprio) nao acende nada.
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
      ctx.strokeStyle = a.cor;
      ctx.lineWidth = a.largura;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalCompositeOperation = a.composicao;
    }
    acesos += 1;
    // Acende e apaga: seno de meia volta ao longo da duracao.
    ctx.globalAlpha = a.alphaMax * Math.sin((Math.PI * idade) / a.duracao);
    const dx = p.x - e.x;
    const dy = p.y - e.y;
    const d = Math.hypot(dx, dy) || 1;
    ctx.setTransform(dx / d, dy / d, -dy / d, dx / d, ENTRADA.x + fx.tremorX, ENTRADA.y + fx.tremorY);
    // A haste, entortada para o lado no meio (feita a mao), e os dois riscos
    // da ponta.
    const k = Math.min(1, idade / (a.duracao * a.crescer));
    const comprimento = a.comprimento * k;
    const ponta = a.recuo + comprimento;
    const abertura = (a.abertura * Math.PI) / 180;
    const px = Math.cos(abertura) * a.ponta * k;
    const py = Math.sin(abertura) * a.ponta * k;
    ctx.beginPath();
    ctx.moveTo(a.recuo, 0);
    ctx.lineTo(a.recuo + comprimento / 2, a.bojo * k);
    ctx.lineTo(ponta, 0);
    ctx.moveTo(ponta - px, -py);
    ctx.lineTo(ponta, 0);
    ctx.lineTo(ponta - px, py);
    ctx.stroke();
  }
  if (acesos > 0) {
    ctx.setTransform(1, 0, 0, 1, fx.tremorX, fx.tremorY);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
  }
  fx.diag.avisos = acesos;
}

// As faiscas de morte (fase 17): confete de papel e rabiscos (um "v" curto a
// caneta), nas cores do tipo. Cada uma cai num balde — (cor, forma, degrau de
// alfa) — por contagem, em arrays de tamanho fixo: a cor e o alfa mudam uma
// vez por balde, e nao por faisca. O rabisco e UM caminho por balde, tracado
// de uma vez. O confete gira em 3D, de lado (a largura ou a altura encolhe com
// o cosseno do angulo, metade de cada jeito), e nao no plano: um retangulo
// alinhado e o caminho rapido do raster por CPU, e girado no plano 800 deles
// custavam ~2 ms a mais por quadro (fase 17, medido).
function desenharParticulas(ctx, fx) {
  const ps = fx.particulas.ativos;
  const n = ps.length;
  if (n === 0) return;
  const c = fx.cfg.particulas;
  const niveis = c.niveisDeAlfa;
  const total = fx.cursorBalde.length;
  const inicio = fx.inicioBalde;
  const cursor = fx.cursorBalde;
  inicio.fill(0);
  for (let i = 0; i < n; i += 1) {
    const p = ps[i];
    // O degrau de alfa: 1..niveis, nunca 0 enquanto a faisca vive.
    const a = p.vida / p.vidaMax;
    let degrau = Math.ceil(a * niveis) - 1;
    if (degrau < 0) degrau = 0;
    else if (degrau >= niveis) degrau = niveis - 1;
    const b = (p.corIndice * 2 + p.forma) * niveis + degrau;
    fx.baldeDe[i] = b;
    inicio[b + 1] += 1;
  }
  for (let b = 0; b < total; b += 1) {
    inicio[b + 1] += inicio[b];
    cursor[b] = inicio[b];
  }
  for (let i = 0; i < n; i += 1) {
    const b = fx.baldeDe[i];
    fx.ordem[cursor[b]] = i;
    cursor[b] += 1;
  }
  const conf = c.confete;
  const r = c.rabisco;
  ctx.globalCompositeOperation = c.composicao;
  ctx.lineWidth = r.largura;
  for (let b = 0; b < total; b += 1) {
    const de = inicio[b];
    const ate = inicio[b + 1];
    if (de === ate) continue;
    const degrau = b % niveis;
    const forma = Math.floor(b / niveis) % 2;
    const cor = fx.cores[Math.floor(b / (2 * niveis))];
    ctx.globalAlpha = (degrau + 1) / niveis;
    if (forma === CONFETE) {
      ctx.fillStyle = cor;
      for (let j = de; j < ate; j += 1) {
        const p = ps[fx.ordem[j]];
        // De lado: um eixo encolhe com o cosseno (ate `minimo`, nunca some).
        const lado = conf.minimo + (1 - conf.minimo) * Math.abs(Math.cos(p.angulo));
        const curto = p.tamanho * conf.razao;
        const w = p.giro >= 0 ? p.tamanho * lado : curto;
        const h = p.giro >= 0 ? curto : p.tamanho * lado;
        ctx.fillRect(p.x - w / 2, p.y - h / 2, w, h);
      }
      continue;
    }
    ctx.beginPath();
    for (let j = de; j < ate; j += 1) {
      const p = ps[fx.ordem[j]];
      const cos = Math.cos(p.angulo);
      const sen = Math.sin(p.angulo);
      const meio = (p.tamanho * r.comprimento) / 2;
      const dobra = 2 * meio * r.dobra;
      ctx.moveTo(p.x - cos * meio, p.y - sen * meio);
      ctx.lineTo(p.x - sen * dobra, p.y + cos * dobra);
      ctx.lineTo(p.x + cos * meio, p.y + sen * meio);
    }
    ctx.strokeStyle = cor;
    ctx.stroke();
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

// A Banca: a aura, um circulo de marca-texto ('multiply') na cor da fase (a
// "mudanca de cor" da transicao), e a figurinha maior que o corpo de colisao.
// Na transicao a aura pisca entre a cor da fase que acabou e a da que vem, no
// relogio da propria transicao — parado na pausa, como todo o resto.
function desenharBanca(ctx, fx, b, v) {
  if (b.estado === ESTADOS_BANCA.DERROTADA) return;
  const vb = v.banca;
  const perfil = fx.perfis.banca;
  let cor = vb.corAura[b.fase];
  if (b.estado === ESTADOS_BANCA.TRANSICAO) {
    const t = b.duracaoEstado - b.relogio;
    if (Math.sin(2 * Math.PI * vb.pulsoTransicao * t) > 0) cor = vb.corAura[b.fase + 1] || cor;
  }
  ctx.fillStyle = cor;
  ctx.globalAlpha = vb.alfaAura;
  ctx.globalCompositeOperation = vb.composicaoAura;
  ctx.beginPath();
  ctx.arc(b.x, b.y, vb.raioAura, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  const o = OPCOES;
  o.perfil = perfil;
  o.vx = fx.bancaVx;
  o.vy = 0;
  o.nasc = 0; // uma so: a fase nao importa
  o.espelhada = false;
  o.flash = fx.flashBanca;
  desenharFigurinha(ctx, fx, CONTEUDO.banca.emoji, b.x, b.y, vb.tamanhoEmoji, o);
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
  // Caneta vermelha tracejada (fase 17); o restore devolve o traco cheio.
  ctx.save();
  ctx.globalAlpha = vb.alphaTelegrafoMin + (vb.alphaTelegrafoMax - vb.alphaTelegrafoMin) * progresso;
  ctx.strokeStyle = vb.corTelegrafo;
  ctx.fillStyle = vb.corTelegrafo;
  ctx.lineCap = 'round';
  ctx.setLineDash(vb.tracejado);
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
  ctx.lineWidth = v.banca.larguraAviso;
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

function avisoDaHorda(ctx, b, params, progresso, v) {
  const raio = raioDoTipo(params.tipo) * (1 + progresso);
  ctx.lineWidth = v.banca.larguraAviso;
  for (let i = 0; i < b.quantosPontos; i += 1) {
    ctx.beginPath();
    ctx.arc(b.pontos[i].x, b.pontos[i].y, raio, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// As perguntas do leque: por cima dos inimigos, como os projeteis do jogador
// — e o que o jogador mais precisa enxergar.
function desenharPerguntas(ctx, fx, perguntas, v) {
  if (perguntas.length === 0) return;
  const cfg = CONTEUDO.banca.pergunta;
  const tamanho = cfg.raio * v.banca.emojiPerguntaFator;
  const o = OPCOES;
  o.perfil = fx.perfis.pergunta;
  o.espelhada = null;
  o.flash = 0;
  for (let i = 0; i < perguntas.length; i += 1) {
    const p = perguntas[i];
    o.vx = p.vx;
    o.vy = p.vy;
    o.nasc = p.nasc;
    desenharFigurinha(ctx, fx, cfg.emoji, p.x, p.y, tamanho, o);
  }
}

// O texto da virada de fase, durante a pausa da transicao inteira
// (banca.transicao.duracao), fora do tremor (fase 17): uma faixa de papel
// escurecido de lado a lado, com uma linha a lapis em cima e embaixo; "A Banca
// se reune" carimbado (a fonte e a tinta do carimbo, torto), e a fase nova
// escrita a mao embaixo.
function desenharTransicaoDaBanca(ctx, fx, b, largura, altura, v) {
  if (b.estado !== ESTADOS_BANCA.TRANSICAO) return;
  const proxima = CONTEUDO.banca.fases[b.fase + 1];
  if (!proxima) return;
  const vb = v.banca;
  const topo = altura * vb.faixaTextoY;
  const alto = altura * vb.faixaTextoAltura;
  ctx.globalAlpha = vb.alfaFaixa;
  ctx.fillStyle = vb.corFaixa;
  ctx.fillRect(0, topo, largura, alto);
  ctx.globalAlpha = 1;
  if (vb.bordaFaixa.largura > 0) {
    ctx.strokeStyle = vb.bordaFaixa.cor;
    ctx.lineWidth = vb.bordaFaixa.largura;
    ctx.beginPath();
    ctx.moveTo(0, topo);
    ctx.lineTo(largura, topo);
    ctx.moveTo(0, topo + alto);
    ctx.lineTo(largura, topo + alto);
    ctx.stroke();
  }
  const giro = (vb.giroTexto * Math.PI) / 180;
  ctx.setTransform(Math.cos(giro), Math.sin(giro), -Math.sin(giro), Math.cos(giro), largura / 2, topo + alto * 0.4);
  ctx.fillStyle = vb.corTexto;
  usarFonte(ctx, fx, vb.fonteTexto);
  ctx.fillText(CONTEUDO.textos.banca.transicao, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = vb.corSubtexto;
  usarFonte(ctx, fx, vb.fonteSubtexto);
  ctx.fillText(preencher(CONTEUDO.textos.banca.fase, { n: b.fase + 2, nome: proxima.nome }), largura / 2, topo + alto * 0.75);
}

// Desenhados depois dos inimigos e antes do jogador: o projetil precisa
// aparecer por cima de quem ele vai acertar para a leitura funcionar no meio
// do bando.
function desenharProjeteis(ctx, fx, projeteis, v) {
  if (projeteis.length === 0) return;
  // O borrao (fase 17): atras de cada um, na direcao oposta a velocidade, um
  // triangulo que afina ate a ponta — todos num caminho so, um preenchimento.
  const bo = fx.cfg.armas.projetil;
  if (bo.alfa > 0 && bo.tempo > 0) {
    ctx.beginPath();
    for (let i = 0; i < projeteis.length; i += 1) {
      const p = projeteis[i];
      const vel = Math.hypot(p.vx, p.vy);
      if (vel === 0) continue;
      const comprimento = Math.min(bo.maximo, vel * bo.tempo);
      const ux = p.vx / vel;
      const uy = p.vy / vel;
      const meia = (p.raio * v.emojiProjetilFator * bo.largura) / 2;
      ctx.moveTo(p.x - uy * meia, p.y + ux * meia);
      ctx.lineTo(p.x - ux * comprimento, p.y - uy * comprimento);
      ctx.lineTo(p.x + uy * meia, p.y - ux * meia);
    }
    ctx.globalAlpha = bo.alfa;
    ctx.fillStyle = bo.cor;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  const o = OPCOES;
  o.perfil = fx.perfis.projetil;
  o.espelhada = null;
  o.flash = 0;
  for (let i = 0; i < projeteis.length; i += 1) {
    const p = projeteis[i];
    o.vx = p.vx;
    o.vy = p.vy;
    o.nasc = p.nasc;
    desenharFigurinha(ctx, fx, p.emoji, p.x, p.y, p.raio * v.emojiProjetilFator, o);
  }
}

// Por baixo de todo mundo: orbe nenhum pode esconder um inimigo que vem
// chegando. Grampeado na arena SO no desenho (pendencia 29): o impulso do
// nascimento leva o orbe da borda ate ~36px para fora, e ele continua
// coletavel la — a simulacao nao muda, so o lugar onde ele aparece.
function desenharOrbes(ctx, fx, orbes, arena, v) {
  if (orbes.length === 0) return;
  // Todo orbe tem o mesmo raio (CONTEUDO.xpOrbe.raio), so o valor muda — o
  // tamanho sai da conta uma vez, fora do laco.
  const raio = CONTEUDO.xpOrbe.raio;
  const tamanho = raio * v.emojiOrbeFator;
  const xMin = arena.esquerda + raio;
  const xMax = arena.direita - raio;
  const yMin = arena.topo + raio;
  const yMax = arena.base - raio;
  for (let i = 0; i < orbes.length; i += 1) if (orbes[i].nasc < fx.baseNascOrbe) fx.baseNascOrbe = orbes[i].nasc;
  // O brilho por baixo de cada um (fase 17) e cozido na propria figurinha do
  // orbe (cozinhar, perfil.brilho): nenhuma copia a mais por orbe.
  const o = OPCOES;
  o.perfil = fx.perfis.orbe;
  o.espelhada = null;
  o.flash = 0;
  for (let i = 0; i < orbes.length; i += 1) {
    const orbe = orbes[i];
    const x = Math.min(xMax, Math.max(xMin, orbe.x));
    const y = Math.min(yMax, Math.max(yMin, orbe.y));
    o.vx = orbe.vx;
    o.vy = orbe.vy;
    o.nasc = orbe.nasc - fx.baseNascOrbe;
    desenharFigurinha(ctx, fx, CONTEUDO.xpOrbe.emoji, x, y, tamanho, o);
  }
}

// Os biscoitos da prova (pos-entrega, lanches.js): chao, como o orbe, e com o
// mesmo perfil dele (o brilho chama o olho para a cura). Nos ultimos
// `piscar` segundos piscam, para o jogador saber que vao sumir. O pisca sai da
// vida restante, que e estado: desenhar nao muda nada.
function desenharLanches(ctx, fx, lanches, v) {
  if (!lanches || lanches.length === 0) return;
  const cfg = CONTEUDO.lanches.arena;
  const tamanho = cfg.raio * v.emojiOrbeFator;
  const o = OPCOES;
  o.perfil = fx.perfis.orbe;
  o.espelhada = null;
  o.flash = 0;
  o.vx = 0;
  o.vy = 0;
  for (let i = 0; i < lanches.length; i += 1) {
    const lanche = lanches[i];
    if (lanche.vida < cfg.piscar && Math.floor(lanche.vida / cfg.piscaIntervalo) % 2 === 0) continue;
    // A fase do balanco nunca sai do nasc absoluto da pool (ele atravessa as
    // runs, e o reinicio limpo do dom.mjs compara o desenho): o indice basta.
    o.nasc = i;
    desenharFigurinha(ctx, fx, cfg.emoji, lanche.x, lanche.y, tamanho, o);
  }
}

function desenharJogador(ctx, fx, player, v) {
  // Jubilado: o jogador virou faisca (consumirEventos), nao tem o que desenhar.
  if (!player.vivo) return;
  desenharRastro(ctx, fx, player);

  // Para onde ele olha: so vira acima do limiar (parado, continua olhando
  // para onde andava).
  const limiar = fx.fig.limiarEspelho;
  if (player.vx < -limiar) fx.jogadorEspelhado = true;
  else if (player.vx > limiar) fx.jogadorEspelhado = false;

  // Pisca-pisca durante os i-frames: alterna com base no proprio contador de
  // invulnerabilidade (que so anda durante a avaliacao), nunca em estado.tempo.
  const piscando =
    player.invulneravel > 0 && Math.floor(player.invulneravel / v.piscaIntervalo) % 2 === 1;
  if (piscando) return;

  const o = OPCOES;
  o.perfil = fx.perfis.jogador;
  o.vx = player.vx;
  o.vy = player.vy;
  o.nasc = 0;
  o.espelhada = fx.jogadorEspelhado;
  o.flash = fx.flashJogador > 0 ? fx.flashJogador / fx.cfg.flash.jogadorDuracao : 0;
  desenharFigurinha(ctx, fx, CONTEUDO.jogador.emoji, player.x, player.y, v.tamanhoEmojiJogador, o);
}

// Rastro: um traco de lapis que afina e some para tras, pelos pontos do
// buffer circular, do mais antigo ao mais novo. r.indice aponta pro slot mais
// antigo (proximo a ser sobrescrito). Pendencia 11: com bolinhas de raio
// 7,7px a cada ~3px, o rastro antigo era um borrao; o traco afinando le como
// movimento. Fase 17: cada ponto treme um pouco (fx.rastro.ruido, sorteado
// por fx.rngFormas (e nao fx.rng: nao gasta a sequencia do juice) quando o ponto nasce — o traco nao ferve de um quadro
// para o outro), na proporcao da distancia ao ponto anterior: parado, nada
// treme.
function desenharRastro(ctx, fx, player) {
  const r = player.rastro;
  const n = r.pontos.length;
  const c = fx.cfg.rastro;
  sortearTremido(fx, r);
  const ruido = fx.rastro.ruido;
  ctx.strokeStyle = c.cor;
  ctx.lineCap = 'round';
  let anterior = null;
  let ax = 0;
  let ay = 0;
  for (let i = 0; i < n; i += 1) {
    const slot = (r.indice + i) % n;
    const ponto = r.pontos[slot];
    if (!ponto.ativo) {
      anterior = null;
      continue;
    }
    // O tremido do ponto, na proporcao do passo ate ele.
    const passo = anterior === null ? 0 : Math.hypot(ponto.x - anterior.x, ponto.y - anterior.y);
    const k = Math.min(1, passo / c.passoRuido);
    const x = ponto.x + ruido[2 * slot] * k;
    const y = ponto.y + ruido[2 * slot + 1] * k;
    if (anterior !== null && passo > 0) {
      const t = (i + 1) / n;
      ctx.globalAlpha = t * c.alfa;
      ctx.lineWidth = c.largura * t;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    anterior = ponto;
    ax = x;
    ay = y;
  }
  ctx.globalAlpha = 1;
  ctx.lineCap = 'butt';
}

// O tremido de cada ponto do rastro: sorteado (fx.rngFormas, nao fx.rng: nao gasta a sequencia do juice) quando o ponto nasce —
// os slots que a simulacao escreveu desde o ultimo quadro (r.indice andou) —,
// ou todos de uma vez num rastro novo (um por avaliacao). O mesmo rastro, com
// a mesma historia, treme igual em qualquer navegador.
function sortearTremido(fx, r) {
  const t = fx.rastro;
  const n = r.pontos.length;
  const amplitude = fx.cfg.rastro.ruido;
  let novos;
  let de;
  if (t.ref !== r) {
    t.ref = r;
    novos = n;
    de = 0;
  } else {
    novos = (r.indice - t.indice + n) % n;
    de = t.indice;
  }
  t.indice = r.indice;
  for (let i = 0; i < novos; i += 1) {
    const slot = (de + i) % n;
    t.ruido[2 * slot] = fx.rngFormas.range(-amplitude, amplitude);
    t.ruido[2 * slot + 1] = fx.rngFormas.range(-amplitude, amplitude);
  }
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
    else if (dados.comportamento === 'ondaArea') desenharOnda(ctx, fx, player, arma, nivel);
    else if (dados.comportamento === 'feixe') desenharFeixe(ctx, fx, player, arma, nivel);
  }
}

const SEM_TRACEJADO = [];

// ✏️ A caneta (fase 17): a orbita como um circulo tracejado a lapis; atras de
// cada satelite, um risco de tinta em arco, que esvai e afina em `segmentos`
// pedacos (do satelite para tras, contra o giro); e os satelites, figurinhas
// de projetil (sem balanco; sem velocidade guardada, nao inclinam nem
// espelham). O angulo de cada um sai de posicaoSatelite, a mesma conta da
// colisao.
// A mesma conta de posicaoSatelite (weapons.js), so o angulo: ela devolve um
// objeto novo, e aqui seriam duas por satelite por quadro.
function anguloSatelite(arma, nivel, i) {
  return (arma.angulo || 0) + ((Math.PI * 2) / nivel.quantidade) * i;
}

function desenharOrbital(ctx, fx, player, arma, dados, nivel, v) {
  const c = fx.cfg.armas.orbital;
  const orbita = c.orbita;
  ctx.strokeStyle = orbita.cor;
  ctx.globalAlpha = orbita.alfa;
  ctx.lineWidth = orbita.largura;
  ctx.setLineDash(orbita.tracejado);
  ctx.beginPath();
  ctx.arc(player.x, player.y, nivel.raioOrbita, 0, VOLTA);
  ctx.stroke();
  ctx.setLineDash(SEM_TRACEJADO);
  const risco = c.risco;
  const sentido = nivel.velocidadeAngular < 0 ? -1 : 1;
  const passo = (risco.graus * Math.PI) / 180 / risco.segmentos;
  ctx.strokeStyle = risco.cor;
  ctx.lineCap = 'round';
  for (let s = 0; s < nivel.quantidade; s += 1) {
    const a = anguloSatelite(arma, nivel, s);
    for (let k = 0; k < risco.segmentos; k += 1) {
      const resta = 1 - k / risco.segmentos;
      ctx.globalAlpha = risco.alfa * resta;
      ctx.lineWidth = risco.largura * (1 - risco.afina * (1 - resta));
      const perto = a - sentido * passo * k;
      const longe = a - sentido * passo * (k + 1);
      ctx.beginPath();
      if (sentido > 0) ctx.arc(player.x, player.y, nivel.raioOrbita, longe, perto);
      else ctx.arc(player.x, player.y, nivel.raioOrbita, perto, longe);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  ctx.lineCap = 'butt';
  const tamanho = nivel.raioColisao * v.emojiSateliteFator;
  const o = OPCOES;
  o.perfil = fx.perfis.projetil;
  o.vx = 0;
  o.vy = 0;
  o.nasc = 0;
  o.espelhada = false;
  o.flash = 0;
  for (let s = 0; s < nivel.quantidade; s += 1) {
    const a = anguloSatelite(arma, nivel, s);
    desenharFigurinha(ctx, fx, dados.emoji, player.x + Math.cos(a) * nivel.raioOrbita, player.y + Math.sin(a) * nivel.raioOrbita, tamanho, o);
  }
}

// 📝 O resumo: o telegrafo cresce de 0 ate nivel.raio ao longo de
// CONTEUDO.ondaArea.duracaoAnimacao e desaparece no mesmo ritmo — sem isso o
// dano da onda parece aleatorio (tarefa 2 do contrato da fase 05). Fase 17: um
// circulo desenhado a mao, a lapis — o raio com um ruido senoidal de baixa
// frequencia, passando um pouco do comeco, e um 2o traco deslocado —, com
// marca-texto por dentro ('multiply'), que esvai junto.
function desenharOnda(ctx, fx, player, arma, nivel) {
  const duracao = CONTEUDO.ondaArea.duracaoAnimacao;
  const progresso = Math.min(1, (arma.animacao || 0) / duracao);
  if (progresso >= 1) return; // pulso anterior ja terminou de sumir
  const c = fx.cfg.armas.onda;
  const raio = nivel.raio * progresso;
  const resta = 1 - progresso;
  const p = c.preenchimento;
  circuloAMao(ctx, c, player.x, player.y, raio, 0, 0, 0);
  ctx.globalAlpha = p.alfa * resta;
  ctx.globalCompositeOperation = p.composicao;
  ctx.fillStyle = p.cor;
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = c.alfa * resta;
  ctx.strokeStyle = c.cor;
  ctx.lineWidth = c.largura;
  ctx.lineJoin = 'round';
  ctx.stroke();
  // O 2o traco: deslocado, com o ruido em outra fase (a mao nao repete).
  circuloAMao(ctx, c, player.x, player.y, raio, c.deslocamento, -c.deslocamento, c.defasagem);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.lineJoin = 'miter';
}

// O caminho de um circulo a mao (beginPath incluido): `c.pontos` pontos por
// volta, raio com ruido senoidal, uma volta e `c.sobra` de volta.
function circuloAMao(ctx, c, x, y, raio, dx, dy, fase) {
  const total = Math.ceil(c.pontos * (1 + c.sobra));
  const passo = VOLTA / c.pontos;
  const ondulacao = raio * c.ondulacao;
  ctx.beginPath();
  for (let i = 0; i <= total; i += 1) {
    const a = i * passo;
    const r = raio + ondulacao * Math.sin(c.ondas * a + fase);
    const px = x + dx + Math.cos(a) * r;
    const py = y + dy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
}

// 🖍️ O marca-texto (fase 17): um risco de marca-texto do jogador ate o
// alcance, na direcao guardada em arma.angulo (a mesma que weapons.js usa
// para a colisao) — um retangulo de pontas arredondadas, dentro do retangulo
// do dano, em 'multiply' (realca a pauta por baixo), com a borda um tom mais
// escura.
function desenharFeixe(ctx, fx, player, arma, nivel) {
  const c = fx.cfg.armas.feixe;
  const angulo = arma.angulo || 0;
  const comprimento = nivel.alcance;
  const meia = nivel.largura / 2;
  const r = Math.min(meia * c.ponta, comprimento / 2);
  ctx.save();
  ctx.translate(player.x, player.y);
  ctx.rotate(angulo);
  ctx.beginPath();
  ctx.moveTo(0, meia - r);
  ctx.arc(r, -meia + r, r, Math.PI, Math.PI * 1.5);
  ctx.arc(comprimento - r, -meia + r, r, Math.PI * 1.5, VOLTA);
  ctx.arc(comprimento - r, meia - r, r, 0, Math.PI * 0.5);
  ctx.arc(r, meia - r, r, Math.PI * 0.5, Math.PI);
  ctx.globalCompositeOperation = c.composicao;
  ctx.globalAlpha = c.alfa;
  ctx.fillStyle = c.cor;
  ctx.fill();
  ctx.globalAlpha = c.borda.alfa;
  ctx.strokeStyle = c.borda.cor;
  ctx.lineWidth = c.borda.largura;
  ctx.stroke();
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
  const lista = [c.jogador.emoji, c.xpOrbe.emoji, c.banca.emoji, c.banca.pergunta.emoji, c.lanches.arena.emoji];
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

// ---------------------------------------------------------- figurinhas

// Cada entidade e um adesivo (fase 16): o emoji com contorno branco recortado
// e a sombra do recorte, e por baixo a sombra no chao, cozidos uma vez por
// (emoji, tamanho, variante, degrau) na folha de figurinhas e copiados com
// um drawImage so.
// A vida sai do que o estado ja tem: balanco (seno de estado.tempo, fase pelo
// nasc), inclinacao (pela velocidade), espelho (andando para a esquerda) — e
// o flash/pop da fase 12: o pop na escala e, por cima, a silhueta da figurinha
// numa cor so (fase 17, cozinharFlash).
//
// `opcoes` (desenharFigurinha):
//   perfil     fx.perfis.<entidade> (jogador, inimigo, banca, orbe, projetil, pergunta)
//   vx, vy     velocidade, px/s: a inclinacao e, sem `espelhada`, o lado
//   nasc       a fase do balanco (x balanco.fasePorNasc): o nasc relativo ao
//              1o da avaliacao (fx.baseNasc*), nunca o absoluto da pool
//   espelhada  true/false: o lado lembrado por quem chama; null: pela vx
//   flash      0..1: o pop e a silhueta do golpe por cima
// Os grupos reusam OPCOES: nenhum objeto por figurinha por quadro.
const OPCOES = { perfil: null, vx: 0, vy: 0, nasc: 0, espelhada: null, flash: 0 };
const VOLTA = Math.PI * 2;

// O perfil de cada entidade: os numeros de cima com o que ela sobrescreve,
// montados uma vez (criarEfeitos), com o que o quadro usa ja calculado. Fase
// 17: o orbe leva o brilho (juice.brilhoOrbe), cozido na figurinha dele.
function montarPerfis(fig, cfg) {
  const perfis = {};
  for (const [nome, o] of Object.entries(fig.porEntidade)) {
    const balanco = { ...fig.balanco, ...(o.balanco || {}) };
    const inclinacao = { ...fig.inclinacao, ...(o.inclinacao || {}) };
    const chao = { ...fig.chao, ...(o.chao || {}) };
    perfis[nome] = {
      nome,
      balanco,
      inclinacao,
      chao,
      espelhar: o.espelhar === undefined ? fig.espelhar : o.espelhar,
      omega: VOLTA * balanco.frequencia,
      inclinacaoMax: (inclinacao.graus * Math.PI) / 180,
      corChao: comAlfa(chao.cor, chao.alfa),
      brilho: nome === 'orbe' ? cfg.brilhoOrbe : null,
    };
  }
  return perfis;
}

// Uma figurinha no mundo. Quem chama esta no transform do mundo (com o
// tremor) e e nele que ela devolve o contexto, com alfa 1 e 'source-over'.
//
// O raster por CPU do Chrome (o caso pessimista que o --perf mede) copia uma
// celula da folha no caminho rapido so quando ela cai em pixel inteiro e sem
// giro nem escala: girar custa ~10x, posicao fracionaria ~2x (fase 16,
// medido). Por isso a inclinacao e cozida em degraus (`inclinacao.niveis`) e
// a figurinha e grudada no pixel inteiro; so o pop do flash escala. A
// sombra no chao e cozida na celula, por baixo da figurinha: desenhada a
// parte, num caminho de 400 elipses, custava mais que as 400 figurinhas.
export function desenharFigurinha(ctx, fx, emoji, x, y, tamanho, opcoes = OPCOES) {
  const p = opcoes.perfil;
  const espelhada = p.espelhar && (opcoes.espelhada === null ? opcoes.vx < -fx.fig.limiarEspelho : opcoes.espelhada);
  // Sobe e volta: 0 a `amplitude` px para cima (a sombra no chao, cozida na
  // celula, vai junto).
  const b = p.balanco;
  const sobe = b.amplitude > 0 && !fx.parado ? b.amplitude * 0.5 * (1 + Math.sin(p.omega * fx.relogio + opcoes.nasc * b.fasePorNasc)) : 0;
  // O degrau da inclinacao: -niveis..niveis, pela velocidade horizontal.
  let nivel = 0;
  if (p.inclinacaoMax > 0) {
    const k = opcoes.vx / p.inclinacao.velocidade;
    nivel = Math.round((k > 1 ? 1 : k < -1 ? -1 : k) * fx.fig.inclinacao.niveis);
  }
  const flash = opcoes.flash;
  const escala = flash > 0 ? 1 + fx.cfg.flash.escalaPop * flash : 1;
  const tx = fx.tremorX;
  const ty = fx.tremorY;
  const f = figurinha(ctx, fx, emoji, tamanho, espelhada, nivel, p);
  if (f !== null) {
    let dx;
    let dy;
    if (escala === 1) {
      // No pixel inteiro do canvas (o mundo ja esta deslocado pelo tremor).
      dx = Math.round(x + tx) - tx - f.cx;
      dy = Math.round(y - sobe + ty) - ty - f.cy;
    } else {
      ctx.setTransform(escala, 0, 0, escala, x + tx, y - sobe + ty);
      dx = -f.cx;
      dy = -f.cy;
    }
    ctx.drawImage(f.camada, f.sx, f.sy, f.largura, f.altura, dx, dy, f.largura, f.altura);
    if (flash > 0) {
      // O flash (fase 17, pendencia 107): a silhueta da propria figurinha numa
      // cor so, por cima, com o alfa do flash — cozida na 1a vez que ela
      // pisca. Sem lugar na folha para a silhueta, o golpe e so o pop.
      const silhueta = f.flash === null ? cozinharFlash(ctx, fx, f, emoji, tamanho, espelhada, nivel, p) : f.flash;
      if (silhueta) {
        const cf = fx.cfg.flash;
        ctx.globalCompositeOperation = cf.composicao;
        ctx.globalAlpha = cf.alpha * flash;
        ctx.drawImage(f.camada, silhueta.sx, silhueta.sy, f.largura, f.altura, dx, dy, f.largura, f.altura);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
    }
    if (escala !== 1) ctx.setTransform(1, 0, 0, 1, tx, ty);
    return;
  }
  // Sem folha (o node sem criarCamada) ou com ela cheia: o emoji direto,
  // sem contorno, com a mesma vida (o giro e o espelho sao do contexto). O
  // golpe e so o pop: sem folha nao ha silhueta para pintar.
  const angulo = (nivel / fx.fig.inclinacao.niveis) * p.inclinacaoMax;
  const cos = Math.cos(angulo) * escala;
  const sen = Math.sin(angulo) * escala;
  if (espelhada) ctx.setTransform(-cos, -sen, -sen, cos, x + tx, y - sobe + ty);
  else ctx.setTransform(cos, sen, -sen, cos, x + tx, y - sobe + ty);
  ctx.fillStyle = CONTEUDO.visual.corEmoji;
  desenharEmoji(ctx, fx, emoji, 0, 0, tamanho);
  ctx.setTransform(1, 0, 0, 1, tx, ty);
}

// A figurinha do cache, cozida na primeira vez que aparece. null: nao ha
// folha (node sem criarCamada) ou ela nao coube (a folha cheia, o teto).
// A recusa tambem fica guardada: nao se tenta de novo a cada quadro. O indice
// e emoji -> tamanho -> celulas [variante x degrau], sem string no caminho
// quente; o degrau e de um so jogo (inclinacao.niveis), e cada emoji e de
// uma entidade so (o perfil que cozinha e o primeiro que pede).
const RECUSADA = { recusada: true };

function figurinha(ctx, fx, emoji, tamanho, espelhada, nivel, perfil) {
  let porTamanho = fx.indiceFigurinhas.get(emoji);
  if (porTamanho === undefined) {
    porTamanho = new Map();
    fx.indiceFigurinhas.set(emoji, porTamanho);
  }
  const niveis = fx.fig.inclinacao.niveis;
  let celulas = porTamanho.get(tamanho);
  if (celulas === undefined) {
    celulas = new Array(2 * (2 * niveis + 1)).fill(null);
    porTamanho.set(tamanho, celulas);
  }
  const i = (espelhada ? 2 * niveis + 1 : 0) + nivel + niveis;
  let f = celulas[i];
  if (f === null) {
    f = cozinhar(ctx, fx, emoji, tamanho, espelhada, nivel, perfil);
    celulas[i] = f;
  }
  if (f === RECUSADA) {
    fx.diag.figurinhasRecusadas += 1;
    return null;
  }
  return f;
}

// A folha e os dois rascunhos, uma vez por fx. Sem como criar camada, nenhum.
function prepararFolha(ctx, fx) {
  const folha = fx.folha;
  if (folha.tentada) return folha.camada !== null;
  folha.tentada = true;
  const lado = fx.fig.atlas.lado;
  const camada = novaCamada(ctx, fx, lado, lado);
  if (!camada) return false;
  folha.silhueta = novaCamada(ctx, fx, 1, 1);
  folha.dilatada = novaCamada(ctx, fx, 1, 1);
  folha.camada = camada;
  return true;
}

// O cozimento (escopo §3.2, decisao 4), numa celula quadrada da folha:
//   0. a sombra no chao, a elipse do perfil, nivelada (nao gira com o degrau);
//   1. o emoji (ou a forma colorida do fallback, fase 14) na `silhueta`, com
//      visual.corEmoji — e aqui que o invariante da fase 12 vale agora;
//   2. 'source-in' na cor do adesivo: sobra so a silhueta, branca;
//   3. a silhueta desenhada em `passos` deslocamentos em volta, na `dilatada`;
//   4. a dilatada na cor da sombra, na folha, deslocada e com o alfa dela;
//   5. a dilatada branca, na folha: o contorno;
//   6. o emoji por cima.
// A variante espelhada e o emoji desenhado com escala (-1, 1), e o degrau da
// inclinacao, girado, nos passos 1 e 6; a sombra do recorte fica do mesmo
// lado em todas. O lado da celula e par: o centro cai em pixel inteiro. Tudo
// recortado na celula: nada vaza para a vizinha.
// Um lugar de `lado` x `lado` na folha (prateleiras: da esquerda para a
// direita, e a linha de baixo quando nao cabe). Escreve em CELULA; false se a
// folha acabou.
const CELULA = { sx: 0, sy: 0 };

function reservarCelula(fx, lado) {
  const folha = fx.folha;
  const ladoFolha = fx.fig.atlas.lado;
  const espaco = fx.fig.atlas.espaco;
  if (folha.x + lado > ladoFolha) {
    folha.x = 0;
    folha.y += folha.linha + espaco;
    folha.linha = 0;
  }
  if (folha.y + lado > ladoFolha) return false;
  CELULA.sx = folha.x;
  CELULA.sy = folha.y;
  folha.x += lado + espaco;
  if (lado > folha.linha) folha.linha = lado;
  return true;
}

function cozinhar(ctx, fx, emoji, tamanho, espelhada, nivel, perfil) {
  const fig = fx.fig;
  const angulo = (nivel / fig.inclinacao.niveis) * perfil.inclinacaoMax;
  if (!prepararFolha(ctx, fx) || fx.figurinhas.size >= fig.teto) return RECUSADA;
  const folha = fx.folha;
  const lado = 2 * Math.ceil((tamanho * fig.margem) / 2);
  if (!reservarCelula(fx, lado)) return RECUSADA;
  const sx = CELULA.sx;
  const sy = CELULA.sy;

  const meio = lado / 2;
  const silhueta = rascunho(folha.silhueta, lado);
  const dilatada = rascunho(folha.dilatada, lado);
  const c = folha.camada.getContext('2d');

  pintarFigura(silhueta, fx, emoji, tamanho, meio, meio, espelhada, angulo);
  silhueta.globalCompositeOperation = 'source-in';
  silhueta.fillStyle = fig.contorno.cor;
  silhueta.fillRect(0, 0, lado, lado);
  silhueta.globalCompositeOperation = 'source-over';

  const raio = fig.contorno.espessura * tamanho;
  dilatada.drawImage(folha.silhueta, 0, 0);
  for (let k = 0; k < fig.contorno.passos; k += 1) {
    const a = (VOLTA * k) / fig.contorno.passos;
    dilatada.drawImage(folha.silhueta, Math.cos(a) * raio, Math.sin(a) * raio);
  }
  dilatada.globalCompositeOperation = 'source-in';
  dilatada.fillStyle = fx.corRecorte;
  dilatada.fillRect(0, 0, lado, lado);

  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-over';
  c.beginPath();
  c.rect(sx, sy, lado, lado);
  c.clip();
  c.clearRect(sx, sy, lado, lado);
  const chao = perfil.chao;
  if (chao.alfa > 0 && chao.raio > 0) {
    const rx = chao.raio * tamanho;
    c.fillStyle = perfil.corChao;
    c.setTransform(rx, 0, 0, rx * chao.razao, sx + meio, sy + meio + chao.dy * tamanho);
    c.beginPath();
    c.arc(0, 0, 1, 0, VOLTA);
    c.fill();
    c.setTransform(1, 0, 0, 1, 0, 0);
  }
  if (perfil.brilho !== null) cozinharBrilho(c, perfil.brilho, tamanho, sx + meio, sy + meio, meio);
  c.globalAlpha = fig.recorte.alfa;
  c.drawImage(folha.dilatada, sx + fig.recorte.dx * tamanho, sy + fig.recorte.dy * tamanho);
  c.globalAlpha = 1;
  dilatada.fillStyle = fig.contorno.cor;
  dilatada.fillRect(0, 0, lado, lado);
  dilatada.globalCompositeOperation = 'source-over';
  c.drawImage(folha.dilatada, sx, sy);
  pintarFigura(c, fx, emoji, tamanho, sx + meio, sy + meio, espelhada, angulo);
  c.restore();

  // `flash`: a celula da silhueta do golpe (cozinharFlash), null ate o 1o.
  const f = { camada: folha.camada, sx, sy, largura: lado, altura: lado, cx: meio, cy: meio, flash: null };
  fx.figurinhas.set(`${emoji}|${tamanho}|${espelhada ? 'espelhada' : 'normal'}|${nivel}`, f);
  fx.diag.figurinhasCozidas += 1;
  return f;
}

// A silhueta do golpe de uma figurinha (fase 17, pendencia 107), na 1a vez
// que ela pisca: uma celula do mesmo tamanho, com o emoji (ou a forma do
// fallback) no mesmo lugar, o mesmo lado e o mesmo degrau, e por cima
// 'source-in' na cor do flash — sobra o desenho do emoji numa cor so. Copiada
// por cima da figurinha com o alfa do flash, a figurinha "acende" e volta. O
// contorno ja e branco: a silhueta so cobre o emoji. Fica em f.flash
// ({ sx, sy }, ou false se nao coube na folha); nao conta no teto (nao e
// figurinha nova, e a run inteira pisca so o bando, o jogador e A Banca).
function cozinharFlash(ctx, fx, f, emoji, tamanho, espelhada, nivel, perfil) {
  const lado = f.largura;
  if (!reservarCelula(fx, lado)) {
    f.flash = false;
    return false;
  }
  const sx = CELULA.sx;
  const sy = CELULA.sy;
  const c = fx.folha.camada.getContext('2d');
  const angulo = (nivel / fx.fig.inclinacao.niveis) * perfil.inclinacaoMax;
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-over';
  c.beginPath();
  c.rect(sx, sy, lado, lado);
  c.clip();
  c.clearRect(sx, sy, lado, lado);
  pintarFigura(c, fx, emoji, tamanho, sx + f.cx, sy + f.cy, espelhada, angulo);
  c.globalCompositeOperation = 'source-in';
  c.fillStyle = fx.cfg.flash.cor;
  c.fillRect(sx, sy, lado, lado);
  c.restore();
  f.flash = { sx, sy };
  fx.diag.flashesCozidos += 1;
  return f.flash;
}

// O brilho do orbe (fase 17), no passo 0 do cozimento, logo depois da sombra
// no chao: um gradiente radial da cor no alfa pedido ate ela mesma
// transparente, com a origem no meio da celula (o gradiente e do espaco do
// usuario). Um gradiente por celula cozida (o orbe nao inclina: duas, a normal
// e a espelhada), nunca por quadro; e copiado junto com a figurinha.
function cozinharBrilho(c, b, tamanho, x, y, meio) {
  const raio = Math.min(b.raio * tamanho, meio);
  c.setTransform(1, 0, 0, 1, x, y);
  const g = c.createRadialGradient(0, 0, 0, 0, 0, raio);
  g.addColorStop(0, comAlfa(b.cor, b.alfa));
  g.addColorStop(1, comAlfa(b.cor, 0));
  c.fillStyle = g;
  c.beginPath();
  c.arc(0, 0, raio, 0, VOLTA);
  c.fill();
  c.setTransform(1, 0, 0, 1, 0, 0);
}

// Um rascunho do tamanho da celula, limpo e com o contexto no padrao. Mudar o
// tamanho do canvas ja limpa (e zera o contexto); senao, clearRect.
function rascunho(camada, lado) {
  if (camada.width !== lado || camada.height !== lado) {
    camada.width = lado;
    camada.height = lado;
  }
  const c = camada.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-over';
  c.clearRect(0, 0, lado, lado);
  return c;
}

// O emoji (ou a forma do fallback) centrado em (x, y), espelhado (escala
// -1, 1) e girado se pedido, sempre com visual.corEmoji: o navegador aplica o
// alfa do fillStyle ao emoji colorido (fase 12).
function pintarFigura(c, fx, emoji, tamanho, x, y, espelhada, angulo) {
  let fonte = fx.fontes.get(tamanho);
  if (fonte === undefined) {
    fonte = `${tamanho}px ${CONTEUDO.visual.fonteEmoji}`;
    fx.fontes.set(tamanho, fonte);
  }
  const m = espelhada ? -1 : 1;
  const cos = Math.cos(angulo);
  const sen = Math.sin(angulo);
  c.setTransform(cos * m, sen * m, -sen, cos, x, y);
  c.font = fonte;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillStyle = CONTEUDO.visual.corEmoji;
  glifo(c, fx, emoji, 0, 0, tamanho);
  c.setTransform(1, 0, 0, 1, 0, 0);
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
