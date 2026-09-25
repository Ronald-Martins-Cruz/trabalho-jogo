import { CONTEUDO } from '../data/content.js';
import { TELAS } from './state.js';
import { obterScratch } from './pool.js';

// Telemetria da partida: o que o relatorio de balanceamento (src/relatorio.js)
// le. Ligada por CONTEUDO.debug.relatorio.
//
// So OBSERVA. Tres regras mantem isso verdade:
//   1. nunca escreve em nada que a simulacao leia — so em estado.telemetria e
//      no scratch dela;
//   2. nunca sorteia (estado.rng) nem chama pool: obter/sincronizar mexem em
//      slot e reserva. estado.enemies e estado.xpOrbs sao lidos como arrays;
//   3. roda no FIM de atualizar(), depois de todo o resto.
// O smoke roda a mesma semente com a chave ligada e desligada e exige o mesmo
// resultado. E esse o trilho destas regras.
//
// De onde vem cada dado:
//   - da fila de eventos, lida com um cursor. Cada evento e processado uma
//     vez, no tick em que foi emitido: no navegador a fila so e esvaziada uma
//     vez por QUADRO, e um quadro pode ter ate loop.maxPassosPorFrame ticks;
//   - de uma leitura do estado a cada tick (posicao, inimigos por perto) e de
//     uma amostra a cada relatorio.amostraSegundos de avaliacao.
//
// Alocacao: o caminho de cada tick nao aloca. Objetos nascem so em marcos
// (avaliacao aberta, carta, golpe, amostra por segundo), e toda lista tem teto
// em relatorio.maxRegistros.

export const VERSAO_TELEMETRIA = 1;

export const SITUACAO = Object.freeze({
  EM_ANDAMENTO: 'em-andamento',
  APROVADO: 'aprovado', // avaliacao: o cronometro zerou
  JUBILADO: 'jubilado', // avaliacao e partida: o HP zerou
  DESISTIU: 'desistiu', // voltou ao menu com a avaliacao em curso (pausa -> Desistir)
  ENCERRADA: 'encerrada', // partida: voltou ao menu depois de uma avaliacao aprovada
  INTERROMPIDA: 'interrompida', // outra avaliacao/partida comecou por cima desta
});

// Golpe que tirou HP sem evento 'jogador-dano' dizendo de quem veio.
export const FONTE_DESCONHECIDA = 'desconhecida';

const EPS = 1e-6;
const TELAS_DE_JOGO = new Set([TELAS.AVALIACAO, TELAS.CARTA, TELAS.PAUSA]);

export function telemetriaLigada(debug = CONTEUDO.debug) {
  return Boolean(debug) && debug.relatorio === true;
}

// ------------------------------------------------------------ entrada

// Chamado por atualizar() (main.js) no fim de TODO tick, em qualquer tela: e
// a tela de menu que fecha uma avaliacao abandonada, e a de carta que mede o
// tempo de decisao.
export function observarTick(estado, dt) {
  if (!telemetriaLigada()) return;
  const tel = obterTelemetria(estado);
  const sc = scratchTelemetria(estado, tel);
  somarEm(tel.sessao.telas, estado.tela, dt);

  acompanharIdentidades(estado, tel, sc);

  const reg = registroAberto(sc);
  if (reg) {
    somarEm(reg.telas, estado.tela, dt);
    if (estado.tela === TELAS.CARTA && sc.cartaPendente) sc.cartaPendente.decisao += dt;
    const decorrido = estado.run.avaliacao.decorrido;
    // O minimo com dt protege contra cronometro adiantado por fora (o smoke
    // pula para o ultimo segundo): meio minuto de "tempo parado" num tick so
    // mentiria no relatorio.
    const avancou = Math.min(dt, decorrido - sc.decorrido);
    if (decorrido > sc.decorrido) sc.decorrido = decorrido;
    if (avancou > 0) acumularTick(estado, reg, sc, avancou);
  }

  processarEventos(estado, sc);

  if (reg && reg === registroAberto(sc)) {
    conferirHp(estado, reg, sc);
    if (estado.run.avaliacao.decorrido + EPS >= sc.proximaAmostra) amostrar(estado, reg, sc);
    if (sc.fechar !== null) fecharAvaliacao(estado, sc, sc.fechar, true);
    else if (estado.tela === TELAS.MENU) fecharAvaliacao(estado, sc, SITUACAO.DESISTIU, true);
  }

  if (estado.tela === TELAS.MENU && sc.partida && sc.partida.situacao === SITUACAO.EM_ANDAMENTO) {
    fecharPartida(estado, sc, situacaoAoVoltarAoMenu(sc.partida), true);
  }
}

// Chamado pelo quadro do navegador (main.js), uma vez por requestAnimationFrame.
// No node ninguem chama: o relatorio diz "nao medido" em vez de inventar fps.
// So conta quadro com a avaliacao rodando — o quadro gigante da volta de uma
// aba escondida cai na pausa e nao e lag.
export function registrarQuadro(estado, dtReal, passos) {
  if (!telemetriaLigada() || !estado.telemetria) return;
  if (estado.tela !== TELAS.AVALIACAO) return;
  if (!Number.isFinite(dtReal) || dtReal <= 0) return;
  acumularQuadro(estado.telemetria.sessao.quadros, dtReal, passos);
  const sc = estado.scratch && estado.scratch.telemetria;
  const reg = sc ? registroAberto(sc) : null;
  if (reg) acumularQuadro(reg.quadros, dtReal, passos);
}

// ------------------------------------------------------------ estruturas

function obterTelemetria(estado) {
  if (!estado.telemetria) {
    estado.telemetria = {
      versao: VERSAO_TELEMETRIA,
      semente: estado.rng.seed,
      sessao: {
        iniciadaEm: estado.tempo,
        telas: {}, // segundos em cada tela, na sessao inteira
        quadros: novosQuadros(),
        partidasIniciadas: 0,
        partidasDescartadas: 0, // sairam do historico pelo teto de relatorio.historicoPartidas
      },
      partidas: [],
    };
  }
  return estado.telemetria;
}

// Referencias vivas (run, avaliacao, player) e o que ainda nao virou registro.
// Mora no scratch, fora da serializacao do estado, como as pools.
function scratchTelemetria(estado, tel) {
  const scratch = obterScratch(estado);
  let sc = scratch.telemetria;
  if (!sc || sc.telemetria !== tel) {
    sc = {
      telemetria: tel,
      run: null, // identidade de estado.run: muda em iniciarRun()
      avaliacao: null, // identidade de estado.run.avaliacao: muda em iniciarAvaliacao()
      player: null,
      partida: null,
      registro: null,
      ultimoEvento: null, // cursor da fila
      decorrido: 0,
      danoTomado: 0,
      hp: 0,
      x: 0,
      y: 0,
      proximaAmostra: 0,
      ultimaAmostraEm: 0,
      janela: null,
      cartaPendente: null,
      fechar: null, // situacao pedida por evento neste tick ('resultado')
      morreuEm: null,
      ultimaFonte: '',
      somaGolpesTick: 0,
      ultimoPerto: 0,
      ultimoNaArena: 0,
      ultimaFolga: null,
    };
    scratch.telemetria = sc;
  }
  return sc;
}

function registroAberto(sc) {
  return sc.registro && sc.registro.situacao === SITUACAO.EM_ANDAMENTO ? sc.registro : null;
}

function novosQuadros() {
  return { quadros: 0, somaDt: 0, maxDt: 0, noTeto: 0, lentos: 0 };
}

function acumularQuadro(q, dt, passos) {
  q.quadros += 1;
  q.somaDt += dt;
  if (dt > q.maxDt) q.maxDt = dt;
  if (passos >= CONTEUDO.loop.maxPassosPorFrame) q.noTeto += 1;
  // Mais de dois passos de simulacao num quadro so: abaixo de ~30 fps.
  if (dt > 2 * CONTEUDO.loop.passo) q.lentos += 1;
}

function novaJanela(quantasArmas) {
  const danoPorArma = [];
  for (let i = 0; i < quantasArmas; i += 1) danoPorArma.push(0);
  return {
    mortos: 0,
    nascidos: 0,
    golpes: 0,
    danoTomado: 0,
    danoCausado: 0,
    danoPorArma,
    xpColetado: 0,
    distancia: 0,
  };
}

function zerarJanela(j) {
  j.mortos = 0;
  j.nascidos = 0;
  j.golpes = 0;
  j.danoTomado = 0;
  j.danoCausado = 0;
  for (let i = 0; i < j.danoPorArma.length; i += 1) j.danoPorArma[i] = 0;
  j.xpColetado = 0;
  j.distancia = 0;
}

function novoRegistroArma(dados, indice) {
  const porNivel = [];
  const niveis = Array.isArray(dados.niveis) && dados.niveis.length > 0 ? dados.niveis.length : CONTEUDO.arma.nivelMaximo;
  for (let i = 0; i < niveis; i += 1) {
    porNivel.push({ tempo: 0, disparos: 0, acertos: 0, mortes: 0, danoNominal: 0, danoEfetivo: 0 });
  }
  return {
    id: dados.id,
    indice, // coluna em amostras[].danoPorArma
    equipadaEm: null,
    niveis: [], // { nivel, t }: quando pegou cada nivel
    nivelFinal: 0,
    disparos: 0,
    acertos: 0,
    mortes: 0,
    danoNominal: 0,
    danoEfetivo: 0,
    porNivel,
  };
}

function novoRegistroInimigo(dados) {
  return {
    id: dados.id,
    nascidos: 0,
    mortos: 0,
    mortosForaDaArena: 0,
    somaVida: 0,
    somaDistanciaMorte: 0,
    vivosFim: 0,
  };
}

function registroDaArma(reg, id) {
  for (let i = 0; i < reg.armas.length; i += 1) if (reg.armas[i].id === id) return reg.armas[i];
  // Arma fora de CONTEUDO.armas: nao deveria existir, mas perder o dado e pior.
  const nova = novoRegistroArma({ id }, reg.armas.length);
  reg.armas.push(nova);
  return nova;
}

function registroDoInimigo(reg, id) {
  for (let i = 0; i < reg.inimigos.length; i += 1) if (reg.inimigos[i].id === id) return reg.inimigos[i];
  const novo = novoRegistroInimigo({ id });
  reg.inimigos.push(novo);
  return novo;
}

function registroDaFonte(reg, fonte) {
  for (let i = 0; i < reg.fontesDano.length; i += 1) if (reg.fontesDano[i].fonte === fonte) return reg.fontesDano[i];
  const nova = { fonte, golpes: 0, dano: 0 };
  reg.fontesDano.push(nova);
  return nova;
}

function indiceNivel(regArma, nivel) {
  const n = Number.isFinite(nivel) ? Math.floor(nivel) : 1;
  return Math.min(Math.max(n, 1), regArma.porNivel.length) - 1;
}

function nivelEquipado(estado, id) {
  const armas = estado.player.armas;
  for (let i = 0; i < armas.length; i += 1) if (armas[i].id === id) return armas[i].nivel;
  return 1;
}

// ------------------------------------------------------ partida e avaliacao

// Uma partida (a run) e uma avaliacao so passam a existir no relatorio quando
// entram numa tela de jogo: novoEstado() ja cria uma run e uma avaliacao para o
// menu ter o que mostrar, e nenhuma das duas foi jogada.
function acompanharIdentidades(estado, tel, sc) {
  if (!TELAS_DE_JOGO.has(estado.tela)) return;

  if (sc.run !== estado.run) {
    // O que estava aberto ficou para tras sem passar pelo menu. O estado ja e
    // o da partida NOVA, entao nao ha o que ler: so marcar.
    if (registroAberto(sc)) fecharAvaliacao(estado, sc, SITUACAO.INTERROMPIDA, false);
    if (sc.partida && sc.partida.situacao === SITUACAO.EM_ANDAMENTO) {
      fecharPartida(estado, sc, SITUACAO.INTERROMPIDA, false);
    }
    abrirPartida(estado, tel, sc);
    sc.run = estado.run;
    sc.avaliacao = null;
  }

  if (sc.avaliacao !== estado.run.avaliacao) {
    if (registroAberto(sc)) fecharAvaliacao(estado, sc, SITUACAO.INTERROMPIDA, false);
    // A mesma run seguiu depois de ter sido dada por encerrada (o smoke
    // recomeca avaliacoes na mesma run depois de um jubilamento): reabre.
    if (sc.partida.situacao !== SITUACAO.EM_ANDAMENTO) {
      sc.partida.situacao = SITUACAO.EM_ANDAMENTO;
      sc.partida.encerradaEm = null;
    }
    abrirAvaliacao(estado, sc);
    sc.avaliacao = estado.run.avaliacao;
  }
}

function abrirPartida(estado, tel, sc) {
  tel.sessao.partidasIniciadas += 1;
  const partida = {
    numero: tel.sessao.partidasIniciadas,
    situacao: SITUACAO.EM_ANDAMENTO,
    iniciadaEm: estado.tempo,
    encerradaEm: null,
    creditos: 0,
    coringas: [],
    avaliacoes: [],
  };
  tel.partidas.push(partida);
  while (tel.partidas.length > CONTEUDO.relatorio.historicoPartidas) {
    tel.partidas.shift();
    tel.sessao.partidasDescartadas += 1;
  }
  sc.partida = partida;
}

function abrirAvaliacao(estado, sc) {
  const cfg = CONTEUDO.relatorio;
  const av = estado.run.avaliacao;
  const p = estado.player;
  const grade = [];
  for (let i = 0; i < cfg.gradeColunas * cfg.gradeLinhas; i += 1) grade.push(0);

  const reg = {
    indice: sc.partida.avaliacoes.length + 1,
    id: av.id,
    nome: av.nome,
    periodo: av.periodo,
    tipo: av.tipo,
    duracao: av.duracao,
    periodoIndex: estado.run.periodoIndex,
    avaliacaoIndex: estado.run.avaliacaoIndex,
    situacao: SITUACAO.EM_ANDAMENTO,
    iniciadaEm: estado.tempo,
    encerradaEm: null,
    tempoJogado: 0, // cronometro da avaliacao no fechamento
    telas: {}, // segundos em cada tela enquanto esta avaliacao estava aberta
    pausas: 0,
    jogador: {
      hpInicial: p.hp,
      hpMax: p.hpMax,
      hpMin: p.hp,
      curado: 0,
      golpes: 0,
      danoTomado: 0,
      primeiroGolpeEm: null,
      distancia: 0,
      tempoParado: 0,
      tempoComInput: 0,
      tempoBorda: 0,
      tempoCanto: 0,
      grade, // segundos em cada celula, linha a linha (relatorio.gradeColunas x gradeLinhas)
    },
    // Somas ponderadas por dt: dividir por `tempo` da a media no tempo.
    pressao: {
      tempo: 0,
      somaVivos: 0,
      picoVivos: 0,
      somaNaArena: 0,
      somaPerto: 0,
      picoPerto: 0,
      tempoComPerto: 0,
      tempoNoTeto: 0,
      somaFolga: 0,
      tempoComInimigo: 0,
    },
    xp: { solto: 0, coletado: 0, noChaoFim: 0, orbesNoChaoFim: 0, orbesPico: 0 },
    niveis: [], // { nivel, t }: subidas de nivel do jogador
    armas: CONTEUDO.armas.map(novoRegistroArma),
    inimigos: CONTEUDO.inimigos.map(novoRegistroInimigo),
    fontesDano: [], // { fonte, golpes, dano }
    cartas: [], // { t, nivel, fila, opcoes: [{ tipo, id, de, para, valor }], escolhida, decisao }
    golpes: [], // { t, fonte, dano, hp, x, y, jogadorX, jogadorY, perto, vivos, nivel }
    amostras: [],
    morte: null,
    final: null,
    resultado: null, // copia de estado.run.resultado no fechamento
    quadros: novosQuadros(),
    descartados: { golpes: 0, cartas: 0, amostras: 0, niveis: 0 },
  };
  sc.partida.avaliacoes.push(reg);
  sc.registro = reg;

  sc.decorrido = av.decorrido;
  sc.danoTomado = av.danoTomado;
  sc.player = p;
  sc.hp = p.hp;
  sc.x = p.x;
  sc.y = p.y;
  sc.proximaAmostra = cfg.amostraSegundos * (Math.floor((av.decorrido + EPS) / cfg.amostraSegundos) + 1);
  sc.ultimaAmostraEm = av.decorrido;
  sc.janela = novaJanela(reg.armas.length);
  sc.cartaPendente = null;
  sc.fechar = null;
  sc.morreuEm = null;
  sc.ultimaFonte = '';
  sc.somaGolpesTick = 0;
  sc.ultimoPerto = 0;
  sc.ultimoNaArena = 0;
  sc.ultimaFolga = null;
}

// `lerEstado` falso quando quem fecha e a troca de identidade: o estado ja e o
// da avaliacao seguinte, e ler hp/armas dali poria no registro os numeros de
// outra partida.
function fecharAvaliacao(estado, sc, situacao, lerEstado) {
  const reg = registroAberto(sc);
  if (!reg) return;

  if (lerEstado) {
    const av = estado.run.avaliacao;
    const p = estado.player;
    if (av.decorrido > sc.ultimaAmostraEm + EPS) amostrar(estado, reg, sc);
    reg.tempoJogado = arred(Math.min(av.decorrido, av.duracao), 3);
    const armas = [];
    for (let i = 0; i < p.armas.length; i += 1) {
      armas.push({ id: p.armas[i].id, nivel: p.armas[i].nivel });
      registroDaArma(reg, p.armas[i].id).nivelFinal = p.armas[i].nivel;
    }
    reg.final = { hp: arred(p.hp, 2), hpMax: p.hpMax, nivel: p.nivel, xp: p.xp, xpProximo: p.xpProximo, armas };
    reg.xp.noChaoFim = xpNoChao(estado);
    reg.xp.orbesNoChaoFim = estado.xpOrbs.length;
    for (let i = 0; i < estado.enemies.length; i += 1) registroDoInimigo(reg, estado.enemies[i].tipo).vivosFim += 1;
    if (situacao === SITUACAO.APROVADO || situacao === SITUACAO.JUBILADO) {
      const r = estado.run.resultado;
      reg.resultado = { ...r, parcelas: { ...r.parcelas } };
    }
    if (situacao === SITUACAO.JUBILADO) {
      // Montada aqui, e nao no evento 'jubilado': conferirHp() roda depois dos
      // eventos e e ele quem atribui um golpe fatal que veio sem evento.
      reg.morte = {
        t: arred(sc.morreuEm !== null ? sc.morreuEm : av.decorrido, 2),
        fonte: sc.ultimaFonte || FONTE_DESCONHECIDA,
        x: Math.round(p.x),
        y: Math.round(p.y),
        vivos: estado.enemies.length,
        perto: sc.ultimoPerto,
        nivel: p.nivel,
      };
    }
    sc.partida.creditos = estado.run.creditos;
    sc.partida.coringas = copiarCoringas(estado.run.coringas);
  } else {
    reg.tempoJogado = arred(sc.decorrido, 3);
  }

  reg.situacao = situacao;
  reg.encerradaEm = estado.tempo;
  sc.cartaPendente = null;
  sc.fechar = null;
  sc.morreuEm = null;

  if (situacao === SITUACAO.JUBILADO || situacao === SITUACAO.DESISTIU) {
    fecharPartida(estado, sc, situacao, lerEstado);
  }
}

function fecharPartida(estado, sc, situacao, lerEstado) {
  const partida = sc.partida;
  if (!partida || partida.situacao !== SITUACAO.EM_ANDAMENTO) return;
  partida.situacao = situacao;
  partida.encerradaEm = estado.tempo;
  if (lerEstado && sc.run === estado.run) {
    partida.creditos = estado.run.creditos;
    partida.coringas = copiarCoringas(estado.run.coringas);
  }
}

function situacaoAoVoltarAoMenu(partida) {
  const ultima = partida.avaliacoes[partida.avaliacoes.length - 1];
  if (!ultima) return SITUACAO.INTERROMPIDA;
  if (ultima.situacao === SITUACAO.APROVADO) return SITUACAO.ENCERRADA;
  if (ultima.situacao === SITUACAO.JUBILADO || ultima.situacao === SITUACAO.DESISTIU) return ultima.situacao;
  return SITUACAO.INTERROMPIDA;
}

// A fase 07 decide a forma de um coringa na run. O relatorio guarda so o id,
// que e o que sobrevive a qualquer forma serializavel.
function copiarCoringas(lista) {
  if (!Array.isArray(lista)) return [];
  return lista.map((c) => (typeof c === 'string' ? c : c && typeof c.id === 'string' ? c.id : String(c)));
}

// ------------------------------------------------------------- cada tick

function acumularTick(estado, reg, sc, dt) {
  const cfg = CONTEUDO.relatorio;
  const { largura, altura } = CONTEUDO.arena;
  const p = estado.player;
  const j = reg.jogador;

  if (sc.player === p) {
    const d = Math.hypot(p.x - sc.x, p.y - sc.y);
    j.distancia += d;
    sc.janela.distancia += d;
  }
  sc.player = p;
  sc.x = p.x;
  sc.y = p.y;

  if (Math.hypot(p.vx, p.vy) < cfg.velocidadeParado) j.tempoParado += dt;
  if ((estado.input.eixoX || 0) !== 0 || (estado.input.eixoY || 0) !== 0) j.tempoComInput += dt;

  const paredeX = Math.min(p.x, largura - p.x);
  const paredeY = Math.min(p.y, altura - p.y);
  if (Math.min(paredeX, paredeY) - p.raio <= cfg.margemBorda) j.tempoBorda += dt;
  if (paredeX <= cfg.margemCanto && paredeY <= cfg.margemCanto) j.tempoCanto += dt;
  const coluna = Math.min(cfg.gradeColunas - 1, Math.max(0, Math.floor((p.x / largura) * cfg.gradeColunas)));
  const linha = Math.min(cfg.gradeLinhas - 1, Math.max(0, Math.floor((p.y / altura) * cfg.gradeLinhas)));
  j.grade[linha * cfg.gradeColunas + coluna] += dt;
  if (p.hp < j.hpMin) j.hpMin = p.hp;

  const inimigos = estado.enemies;
  const raioPerto2 = cfg.raioPerto * cfg.raioPerto;
  let perto = 0;
  let naArena = 0;
  let folga = Infinity;
  for (let i = 0; i < inimigos.length; i += 1) {
    const e = inimigos[i];
    const dx = e.x - p.x;
    const dy = e.y - p.y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= raioPerto2) perto += 1;
    if (e.x >= 0 && e.x <= largura && e.y >= 0 && e.y <= altura) naArena += 1;
    const f = Math.sqrt(d2) - e.raio - p.raio;
    if (f < folga) folga = f;
  }

  const vivos = inimigos.length;
  const pr = reg.pressao;
  pr.tempo += dt;
  pr.somaVivos += vivos * dt;
  if (vivos > pr.picoVivos) pr.picoVivos = vivos;
  pr.somaNaArena += naArena * dt;
  pr.somaPerto += perto * dt;
  if (perto > pr.picoPerto) pr.picoPerto = perto;
  if (perto > 0) pr.tempoComPerto += dt;
  if (vivos >= CONTEUDO.spawn.maxSimultaneos) pr.tempoNoTeto += dt;
  if (vivos > 0) {
    pr.somaFolga += Math.max(0, folga) * dt;
    pr.tempoComInimigo += dt;
  }
  sc.ultimoPerto = perto;
  sc.ultimoNaArena = naArena;
  sc.ultimaFolga = vivos > 0 ? folga : null;

  if (estado.xpOrbs.length > reg.xp.orbesPico) reg.xp.orbesPico = estado.xpOrbs.length;

  // Tempo de cada arma em cada nivel: o denominador do dps por nivel.
  for (let i = 0; i < p.armas.length; i += 1) {
    const arma = p.armas[i];
    const r = registroDaArma(reg, arma.id);
    r.porNivel[indiceNivel(r, arma.nivel)].tempo += dt;
  }
}

// danoTomado da avaliacao e a verdade; os eventos dizem de onde veio. O que
// sobrar sem evento (fonte nova que esqueceu de emitir, teste que chama
// receberDano direto) entra como fonte desconhecida em vez de sumir.
function conferirHp(estado, reg, sc) {
  const av = estado.run.avaliacao;
  const p = estado.player;
  const resto = av.danoTomado - sc.danoTomado - sc.somaGolpesTick;
  if (resto > EPS) registrarGolpe(estado, reg, sc, FONTE_DESCONHECIDA, resto, p.hp, p.x, p.y, av.decorrido);
  sc.danoTomado = av.danoTomado;
  sc.somaGolpesTick = 0;
  if (sc.player === p && p.hp > sc.hp + EPS) reg.jogador.curado += p.hp - sc.hp;
  if (p.hp < reg.jogador.hpMin) reg.jogador.hpMin = p.hp;
  sc.hp = p.hp;
}

function amostrar(estado, reg, sc) {
  const cfg = CONTEUDO.relatorio;
  const av = estado.run.avaliacao;
  const p = estado.player;
  const j = sc.janela;

  if (reg.amostras.length >= cfg.maxRegistros) {
    reg.descartados.amostras += 1;
  } else {
    const danoPorArma = [];
    for (let i = 0; i < j.danoPorArma.length; i += 1) danoPorArma.push(arred(j.danoPorArma[i], 1));
    reg.amostras.push({
      t: arred(av.decorrido, 2),
      hp: arred(p.hp, 1),
      nivel: p.nivel,
      xp: p.xp,
      xpProximo: p.xpProximo,
      vivos: estado.enemies.length,
      naArena: sc.ultimoNaArena,
      perto: sc.ultimoPerto,
      folga: sc.ultimaFolga === null ? null : arred(Math.max(0, sc.ultimaFolga), 1),
      orbes: estado.xpOrbs.length,
      xpNoChao: xpNoChao(estado),
      projeteis: estado.projectiles.length,
      x: Math.round(p.x),
      y: Math.round(p.y),
      // Da amostra anterior ate esta:
      mortos: j.mortos,
      nascidos: j.nascidos,
      golpes: j.golpes,
      danoTomado: arred(j.danoTomado, 1),
      danoCausado: arred(j.danoCausado, 1),
      danoPorArma,
      xpColetado: j.xpColetado,
      distancia: Math.round(j.distancia),
    });
  }
  zerarJanela(j);
  sc.ultimaAmostraEm = av.decorrido;
  const passo = cfg.amostraSegundos;
  sc.proximaAmostra = passo * (Math.floor((av.decorrido + EPS) / passo) + 1);
}

function xpNoChao(estado) {
  let total = 0;
  for (let i = 0; i < estado.xpOrbs.length; i += 1) total += estado.xpOrbs[i].valor;
  return total;
}

// ------------------------------------------------------------- eventos

// Cursor: lembra o ultimo evento visto e processa so o que veio depois dele.
// Se ele nao esta mais na fila (esvaziada pelo quadro, ou empurrada para fora
// pelo teto de emitir()), tudo o que sobrou e mais novo e entra.
function processarEventos(estado, sc) {
  const fila = estado.eventos;
  let inicio = 0;
  if (sc.ultimoEvento !== null) {
    for (let i = fila.length - 1; i >= 0; i -= 1) {
      if (fila[i] === sc.ultimoEvento) {
        inicio = i + 1;
        break;
      }
    }
  }
  for (let i = inicio; i < fila.length; i += 1) processarEvento(estado, sc, fila[i]);
  sc.ultimoEvento = fila.length > 0 ? fila[fila.length - 1] : null;
}

function processarEvento(estado, sc, ev) {
  const reg = registroAberto(sc);
  if (!reg) return;
  const d = ev.dados;
  const t = estado.run.avaliacao.decorrido;

  switch (ev.tipo) {
    case 'tela':
      if (d === TELAS.PAUSA) reg.pausas += 1;
      break;

    case 'inimigo-nasceu':
      registroDoInimigo(reg, d.tipo).nascidos += 1;
      sc.janela.nascidos += 1;
      break;

    case 'inimigo-morto': {
      const { largura, altura } = CONTEUDO.arena;
      const r = registroDoInimigo(reg, d.tipo);
      const p = estado.player;
      r.mortos += 1;
      if (Number.isFinite(d.vida)) r.somaVida += d.vida;
      r.somaDistanciaMorte += Math.hypot(d.x - p.x, d.y - p.y);
      if (d.x < 0 || d.x > largura || d.y < 0 || d.y > altura) r.mortosForaDaArena += 1;
      if (Number.isFinite(d.xp)) reg.xp.solto += d.xp;
      sc.janela.mortos += 1;
      break;
    }

    case 'arma-acerto': {
      const a = registroDaArma(reg, d.arma);
      const n = a.porNivel[indiceNivel(a, nivelEquipado(estado, d.arma))];
      const nominal = Number.isFinite(d.dano) ? d.dano : 0;
      const efetivo = Number.isFinite(d.efetivo) ? d.efetivo : nominal;
      a.acertos += 1;
      n.acertos += 1;
      a.danoNominal += nominal;
      n.danoNominal += nominal;
      a.danoEfetivo += efetivo;
      n.danoEfetivo += efetivo;
      if (d.matou) {
        a.mortes += 1;
        n.mortes += 1;
      }
      sc.janela.danoCausado += efetivo;
      if (a.indice < sc.janela.danoPorArma.length) sc.janela.danoPorArma[a.indice] += efetivo;
      break;
    }

    case 'arma-disparo': {
      const a = registroDaArma(reg, d.arma);
      a.disparos += 1;
      a.porNivel[indiceNivel(a, nivelEquipado(estado, d.arma))].disparos += 1;
      break;
    }

    case 'arma-equipada':
    case 'arma-nivel': {
      const a = registroDaArma(reg, d.arma);
      if (a.equipadaEm === null) a.equipadaEm = arred(t, 2);
      if (a.niveis.length < CONTEUDO.relatorio.maxRegistros) a.niveis.push({ nivel: d.nivel, t: arred(t, 2) });
      break;
    }

    case 'nivel':
      if (reg.niveis.length < CONTEUDO.relatorio.maxRegistros) reg.niveis.push({ nivel: d, t: arred(t, 2) });
      else reg.descartados.niveis += 1;
      break;

    case 'xp-coletado':
      if (Number.isFinite(d)) {
        reg.xp.coletado += d;
        sc.janela.xpColetado += d;
      }
      break;

    case 'carta-aberta':
      abrirCarta(estado, reg, sc, d, t);
      break;

    case 'carta-escolhida':
      fecharCarta(sc, d);
      break;

    case 'jogador-dano':
      registrarGolpe(estado, reg, sc, d.fonte, d.dano, d.hp, d.x, d.y, t);
      sc.somaGolpesTick += d.dano;
      break;

    case 'jubilado':
      sc.morreuEm = t;
      break;

    case 'resultado':
      sc.fechar = d && d.aprovado ? SITUACAO.APROVADO : SITUACAO.JUBILADO;
      break;

    default:
      break;
  }
}

// As opcoes sao copiadas na ABERTURA: quando a escolha chega, a proxima carta
// da fila pode ja ter sorteado por cima de estado.cartas.opcoes no mesmo tick.
function abrirCarta(estado, reg, sc, nivel, t) {
  sc.cartaPendente = null;
  if (reg.cartas.length >= CONTEUDO.relatorio.maxRegistros) {
    reg.descartados.cartas += 1;
    return;
  }
  const opcoes = [];
  const lista = estado.cartas.opcoes;
  for (let i = 0; i < lista.length; i += 1) {
    const o = lista[i];
    if (o.tipo === '') continue;
    opcoes.push({ tipo: o.tipo, id: o.id, de: o.nivelAtual, para: o.nivelProximo, valor: o.valor });
  }
  const carta = { t: arred(t, 2), nivel, fila: estado.cartas.fila, opcoes, escolhida: -1, decisao: 0 };
  reg.cartas.push(carta);
  sc.cartaPendente = carta;
}

// O evento nao traz o indice, e estado.cartas.selecionada ja pode ter voltado
// a 0 com a carta seguinte. Tipo + id identificam a opcao: o sorteio e sem
// reposicao, e so a carta de consolo repete — e ai qualquer uma e a mesma.
function fecharCarta(sc, d) {
  const carta = sc.cartaPendente;
  if (!carta || !d) return;
  for (let i = 0; i < carta.opcoes.length; i += 1) {
    if (carta.opcoes[i].tipo === d.tipo && carta.opcoes[i].id === d.id) {
      carta.escolhida = i;
      break;
    }
  }
  carta.decisao = arred(carta.decisao, 3);
  sc.cartaPendente = null;
}

function registrarGolpe(estado, reg, sc, fonte, dano, hp, x, y, t) {
  const valor = Number.isFinite(dano) ? dano : 0;
  const j = reg.jogador;
  const nome = typeof fonte === 'string' && fonte !== '' ? fonte : FONTE_DESCONHECIDA;
  j.golpes += 1;
  j.danoTomado += valor;
  if (j.primeiroGolpeEm === null) j.primeiroGolpeEm = arred(t, 2);
  sc.janela.golpes += 1;
  sc.janela.danoTomado += valor;
  const f = registroDaFonte(reg, nome);
  f.golpes += 1;
  f.dano += valor;
  sc.ultimaFonte = nome;

  if (reg.golpes.length >= CONTEUDO.relatorio.maxRegistros) {
    reg.descartados.golpes += 1;
    return;
  }
  const p = estado.player;
  reg.golpes.push({
    t: arred(t, 2),
    fonte: nome,
    dano: arred(valor, 2),
    hp: arred(hp, 2),
    x: Math.round(x),
    y: Math.round(y),
    jogadorX: Math.round(p.x),
    jogadorY: Math.round(p.y),
    perto: sc.ultimoPerto,
    vivos: estado.enemies.length,
    nivel: p.nivel,
  });
}

// ------------------------------------------------------------- utilitarios

function somarEm(alvo, chave, valor) {
  alvo[chave] = (alvo[chave] || 0) + valor;
}

function arred(valor, casas) {
  if (!Number.isFinite(valor)) return 0;
  const fator = 10 ** casas;
  return Math.round(valor * fator) / fator;
}
