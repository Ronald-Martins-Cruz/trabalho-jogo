import { CONTEUDO, validarConteudo } from '../data/content.js';
import { novoEstado, novoRecorde, irParaTela, emitir, TELAS } from './state.js';
import { desenhar } from './render.js';
import { criarAudio } from './audio.js';
import { criarUi } from './ui.js';
import { atualizarPlayer, atualizarOrbes } from './player.js';
import { atualizarLanches } from './lanches.js';
import { atualizarInimigos } from './enemies.js';
import { atualizarArmas } from './weapons.js';
import { atualizarBanca, bancaVencida } from './boss.js';
import { apontarCarta, atualizarCartas, cartaLiberada, escolherCarta, moverSelecaoCarta } from './cards.js';
import {
  anuncioLiberado,
  atualizarRegras,
  colacaoLiberada,
  colarGrau,
  comecarDemo,
  comecarProxima,
  comecarTcc,
  fecharAvaliacao,
  iniciarRun,
  MOTIVO_JUBILADO,
  MOTIVO_TEMPO,
  sairDaColacao,
  tccLiberado,
} from './run.js';
import {
  abrirLoja,
  apontarLoja,
  comprarItem,
  comprarLanche,
  confirmarLoja,
  entradaLiberada,
  LINHA_CORINGAS,
  LINHA_VITRINE,
  moverSelecaoLoja,
  posicaoLanche,
  posicaoRerolar,
  posicaoSeguir,
  rerolar,
  seguirDaLoja,
  trocarLinhaLoja,
  venderCoringa,
} from './shop.js';
import { observarTick, registrarQuadro } from './telemetria.js';
import { gerarRelatorio } from './relatorio.js';
import { verificarArmasDoConteudo } from './weapons.js';
import { verificarInimigosDoConteudo } from './enemies.js';
import { verificarBancaDoConteudo } from './boss.js';
import { verificarCartasDoConteudo } from './cards.js';
import { verificarCoringasDoConteudo } from './jokers.js';

// Nada de document/window no topo deste modulo: e o que permite ao node
// importar `atualizar` e rodar a partida inteira sem navegador.

// ---------------------------------------------------------------- simulacao

export function atualizar(estado, dt) {
  estado.tempo += dt;

  switch (estado.tela) {
    case TELAS.AVALIACAO:
      atualizarAvaliacao(estado, dt);
      break;
    case TELAS.CARTA:
      // A simulacao inteira congela: so a escolha da carta anda. O cronometro
      // da avaliacao para junto, de proposito — a pausa e a recompensa.
      atualizarCartas(estado);
      break;
    case TELAS.MENU:
    case TELAS.PAUSA:
    case TELAS.RESULTADO:
    case TELAS.JUBILADO:
    case TELAS.LOJA:
    case TELAS.ANUNCIO:
    case TELAS.TCC:
    case TELAS.COLACAO:
      // Nada roda: a partida inteira fica congelada por tras do overlay. Toda
      // tela nova entra aqui — o `default` congela igual, mas listar deixa
      // explicito que foi decisao, nao esquecimento.
      break;
    default:
      break;
  }

  // Por ultimo e em qualquer tela: o relatorio de balanceamento so observa o
  // que este tick ja fez (debug.relatorio; desligado, retorna na hora).
  observarTick(estado, dt);
}

function atualizarAvaliacao(estado, dt) {
  const av = estado.run.avaliacao;
  // O guard vem ANTES de tudo, inclusive do jogador. Enquanto atualizarPlayer
  // ficou acima dele (fases 01 a 05) isso era inofensivo, porque o tick que
  // encerrava a avaliacao tambem saia da tela; com a tela de resultado no
  // lugar do menu, um caminho que voltasse aqui com a avaliacao concluida
  // deixaria o jogador andando atras do overlay. Pendencia 9 do ESTADO.md.
  if (av.concluida) return;
  atualizarPlayer(estado, dt);

  av.decorrido += dt;
  // O TCC (av.banca) nao tem cronometro: quem decide o fim e A Banca.
  if (!av.banca) av.restante = Math.max(0, av.duracao - av.decorrido);

  // As regras da avaliacao que agem com o tempo (perda de HP). Antes dos
  // inimigos: a morte por ela cai no mesmo observador de sempre, logo abaixo.
  atualizarRegras(estado, dt);
  atualizarInimigos(estado, dt);
  // A Banca depois dos inimigos (o corpo dela ja andou como um deles neste
  // tick) e antes das armas: ela decide o padrao, as perguntas voam e acertam.
  if (av.banca) atualizarBanca(estado, dt);
  // Depois dos inimigos: as armas miram e os projeteis colidem com as posicoes
  // ja integradas deste quadro, nao com as do quadro anterior.
  atualizarArmas(estado, dt);

  // Orbes por ultimo: os que nasceram das mortes deste quadro ja sao atraidos.
  // O evento sai daqui, e nao de dentro de player.js, porque player.js nao
  // pode importar state.js (state.js ja importa criarRastro de la).
  const xpAntes = estado.player.xp;
  atualizarOrbes(estado, dt);
  if (estado.player.xp > xpAntes) emitir(estado, 'xp-coletado', estado.player.xp - xpAntes);
  // Os biscoitos (pos-entrega): os que cairam das mortes deste quadro ja valem.
  atualizarLanches(estado, dt);

  // Depois das armas: a Banca caiu neste tick? Perguntado antes da morte do
  // jogador so para o espelho de HP dela estar em dia no boletim de quem
  // morreu junto.
  const bancaCaiu = av.banca !== null && bancaVencida(estado);

  // Unico observador da morte do jogador: qualquer fonte de dano (inimigo,
  // modificador, A Banca) so precisa zerar o hp via receberDano(). A morte
  // ganha da Banca caindo no mesmo tick, como ganha do cronometro.
  if (!estado.player.vivo) {
    av.concluida = true;
    emitir(estado, 'jubilado', av.id);
    fecharAvaliacao(estado, MOTIVO_JUBILADO);
    irParaTela(estado, TELAS.JUBILADO);
    return;
  }

  if (bancaCaiu) {
    av.concluida = true;
    colarGrau(estado);
    return;
  }

  if (!av.banca && av.restante <= 0) {
    av.concluida = true;
    emitir(estado, 'avaliacao-fim', av.id);
    fecharAvaliacao(estado, MOTIVO_TEMPO);
    irParaTela(estado, TELAS.RESULTADO);
    return;
  }

  // Por ultimo, e so com a avaliacao ainda de pe: morte e fim do cronometro
  // ganham do nivel que subiu no mesmo quadro. Uma carta aberta por cima de
  // uma avaliacao ja encerrada travaria a tela.
  atualizarCartas(estado);
}

// ------------------------------------------------------- relogio do quadro

// O acumulador de dt fixo, separado do navegador para poder ser testado. Um
// acumulador mal cuidado e o bug classico da pausa: a aba volta do background
// (ou o jogador fica 30s no ESC), o relogio de parede acumula tudo isso e o
// quadro seguinte roda 1800 passos de uma vez — o jogo "pula" e o jogador
// perde HP que nao viu chegar.
export function criarRelogio() {
  return { acumulador: 0, passos: 0, descartado: 0 };
}

// Converte tempo de parede em passos de dt fixo, no maximo
// loop.maxPassosPorFrame por quadro. O que passar disso e DESCARTADO em vez de
// ficar na divida: recuperar o atraso e o que espirala.
export function avancarRelogio(relogio, dtReal) {
  const { passo, maxPassosPorFrame } = CONTEUDO.loop;
  if (Number.isFinite(dtReal) && dtReal > 0) relogio.acumulador += dtReal;

  let passos = 0;
  while (relogio.acumulador >= passo && passos < maxPassosPorFrame) {
    relogio.acumulador -= passo;
    passos += 1;
  }
  if (passos >= maxPassosPorFrame && relogio.acumulador > 0) {
    relogio.descartado += relogio.acumulador;
    relogio.acumulador = 0;
  }

  relogio.passos = passos;
  return passos;
}

// Um quadro do navegador, sem o navegador: os passos de simulacao que o
// relogio rende, e depois as camadas que so leem o estado — desenho, UI,
// audio, o recorde no localStorage — e so entao a fila esvazia. `camadas` traz
// { desenhar(estado), sincronizar(estado), tocar(eventos), gravarRecorde(recorde),
// aoFalhar(nome, erro), falhas: {} }.
//
// Pendencia 85: uma excecao em qualquer camada (a sintese de som, um no do
// DOM que sumiu) saia de frame() antes do requestAnimationFrame, e o jogo
// congelava sem aviso. Agora cada camada roda isolada: cada falha diferente
// e relatada uma vez (aoFalhar; ver falhaDeCamada) e o quadro segue — a fila
// ainda esvazia e o recorde ainda e gravado. Uma falha da simulacao interrompe os passos DESTE
// quadro (repetir o mesmo passo quebrado 5x nao ajuda), e a pausa e o menu
// continuam funcionando para o jogador sair dela.
export function rodarQuadro(estado, relogio, dtReal, camadas) {
  const passos = avancarRelogio(relogio, dtReal);
  try {
    for (let i = 0; i < passos; i += 1) atualizar(estado, CONTEUDO.loop.passo);
  } catch (erro) {
    falhaDeCamada(camadas, 'simulacao', erro);
  }
  try {
    registrarQuadro(estado, dtReal, passos);
  } catch (erro) {
    falhaDeCamada(camadas, 'telemetria', erro);
  }
  try {
    camadas.desenhar(estado);
  } catch (erro) {
    falhaDeCamada(camadas, 'desenho', erro);
  }
  try {
    camadas.sincronizar(estado);
  } catch (erro) {
    falhaDeCamada(camadas, 'interface', erro);
  }
  // Consumidores da fila, antes de esvaziar: o audio toca o que o quadro
  // emitiu e o recorde e gravado aqui, e nao dentro da simulacao: run.js so o
  // escreve no estado e emite 'recorde'.
  try {
    camadas.tocar(estado.eventos);
  } catch (erro) {
    falhaDeCamada(camadas, 'audio', erro);
  }
  for (let i = 0; i < estado.eventos.length; i += 1) {
    if (estado.eventos[i].tipo !== 'recorde') continue;
    try {
      camadas.gravarRecorde(estado.recorde);
    } catch (erro) {
      falhaDeCamada(camadas, 'recorde', erro);
    }
  }
  estado.eventos.length = 0;
  return passos;
}

// Cada falha DIFERENTE de cada camada e relatada uma vez: a mesma excecao
// repetida a cada quadro inundaria o console, mas uma nova (outro bug, outra
// run) tem que aparecer — senao a arena congela em silencio. `falhas` conta
// todas.
function falhaDeCamada(camadas, nome, erro) {
  const falhas = camadas.falhas;
  falhas[nome] = (falhas[nome] || 0) + 1;
  if (!camadas.relatadas) camadas.relatadas = new Set(); // fora-do-loop: so na primeira falha do jogo
  const chave = `${nome}: ${erro && erro.message !== undefined ? erro.message : String(erro)}`;
  if (camadas.relatadas.has(chave)) return;
  camadas.relatadas.add(chave);
  if (camadas.aoFalhar) camadas.aoFalhar(nome, erro);
}

// Os verificadores de dado x codigo que o smoke roda antes de tudo, mais o
// validador de content.js (pendencias 22/34). No navegador ninguem os
// chamava: um typo de `comportamento` estourava dentro do
// requestAnimationFrame no primeiro disparo, sem mensagem util. iniciar() os
// roda uma vez, antes do loop. Devolve a lista de problemas (vazia = ok).
export function verificarConteudoDoJogo() {
  const problemas = [];
  for (const erro of validarConteudo().erros) problemas.push(`content.js: ${erro}`);
  const unicos = [verificarArmasDoConteudo(), verificarInimigosDoConteudo(), verificarBancaDoConteudo(), verificarCartasDoConteudo()];
  for (const problema of unicos) if (problema) problemas.push(problema);
  for (const problema of verificarCoringasDoConteudo()) problemas.push(problema);
  return problemas;
}

// ------------------------------------------------------------------ browser

export function iniciar() {
  // Problema de dado vai para o console com a lista inteira, e o jogo tenta
  // seguir: um aviso do validador (preco, texto) nao impede jogar, e o que
  // impediria ao menos ja tem nome quando quebrar.
  for (const problema of verificarConteudoDoJogo()) console.error(`semana-de-provas: ${problema}`);

  const canvas = document.getElementById('palco');
  const ctx = canvas.getContext('2d');
  canvas.width = CONTEUDO.arena.largura;
  canvas.height = CONTEUDO.arena.altura;

  const estado = novoEstado(Date.now() >>> 0);
  // O unico estado persistente do jogo (fase 10). Sem localStorage
  // (armazenamento bloqueado, navegador que o proiba), o jogo segue com o
  // recorde zerado e nada quebra.
  Object.assign(estado.recorde, lerRecorde());
  const ui = criarUi(document);
  // O audio vive fora do estado: a simulacao nunca o enxerga. O contexto so
  // nasce no primeiro gesto (ligarGestos), porque o navegador bloqueia antes.
  const audio = criarAudio({
    criarContexto: () => new (window.AudioContext || window.webkitAudioContext)(), // fora-do-loop: no primeiro gesto
    mudoInicial: lerMudo(),
    aoMudar: (mudo) => {
      gravarMudo(mudo);
      ui.mostrarMudo(mudo);
    },
  });
  ui.mostrarMudo(audio.estaMudo());
  ui.ligarMudo(() => audio.alternarMudo());
  ligarGestos(audio);

  ligarTeclado(estado, audio);
  ui.ligarBotoes({
    // O clique espera o atraso de abertura do menu, como o Enter.
    jogar: () => menuLiberado(estado) && jogarDoMenu(estado),
    continuar: () => continuarDaPausa(estado),
    menu: () => desistirDaPausa(estado),
    // Os dois botoes de fim de avaliacao chamam a MESMA funcao que o teclado:
    // quem decide para onde ir e a simulacao, nao o DOM. Fase 07: e aqui que
    // a loja entra no lugar do menu.
    resultado: () => sairDoResultado(estado),
    jubilado: () => sairDoResultado(estado),
    // Anuncio, TCC e colacao: o clique espera o atraso de abertura, como o Enter.
    comecar: () => anuncioLiberado(estado) && comecarProxima(estado),
    tcc: () => tccLiberado(estado) && comecarTcc(estado),
    colacao: () => colacaoLiberada(estado) && sairDaColacao(estado),
  });
  // Loja: como nas cartas, o mouse so aponta e confirma pelas funcoes de
  // shop.js, que escrevem no estado. Rerolar e seguir tambem apontam, para o
  // destaque do cursor acompanhar o mouse ate os botoes. O clique que gasta
  // espera o atraso de abertura, igual ao teclado (entradaLiberada).
  ui.ligarLoja({
    comprar: (i) => entradaLiberada(estado) && comprarItem(estado, i),
    vender: (i) => entradaLiberada(estado) && venderCoringa(estado, i),
    apontarItem: (i) => apontarLoja(estado, LINHA_VITRINE, i),
    apontarCoringa: (i) => apontarLoja(estado, LINHA_CORINGAS, i),
    rerolar: () => entradaLiberada(estado) && rerolar(estado),
    seguir: () => entradaLiberada(estado) && seguirDaLoja(estado),
    lanche: () => entradaLiberada(estado) && comprarLanche(estado),
    apontarLanche: () => apontarLoja(estado, LINHA_VITRINE, posicaoLanche(estado.loja)),
    apontarRerolar: () => apontarLoja(estado, LINHA_VITRINE, posicaoRerolar(estado.loja)),
    apontarSeguir: () => apontarLoja(estado, LINHA_VITRINE, posicaoSeguir(estado.loja)),
  });
  // Mouse na carta: a UI nao mexe no estado nem na classe CSS, so avisa qual
  // indice foi apontado ou escolhido. Mesmo caminho do teclado, e por isso
  // apontar com o mouse e confirmar com Enter leva a carta certa.
  // O clique espera o atraso de abertura da carta (cartaLiberada), como a
  // loja: o mouse parado onde a carta nasce nao escolhe as cegas.
  ui.ligarCartas(
    (indice) => cartaLiberada(estado) && escolherCarta(estado, indice),
    (indice) => apontarCarta(estado, indice)
  );
  // Botoes de relatorio (debug.relatorio): a UI pede um escopo, a montagem e
  // pura (relatorio.js) e baixar/copiar e com a UI.
  ui.ligarRelatorio((escopo) => arquivoDoRelatorio(estado, escopo));

  const relogio = criarRelogio();
  let anterior = performance.now();
  const camadas = {
    desenhar: (e) => desenhar(e, ctx),
    sincronizar: (e) => ui.sincronizar(e),
    tocar: (eventos) => audio.consumir(eventos),
    gravarRecorde: (recorde) => gravarRecorde(recorde),
    aoFalhar: (nome, erro) => console.error(`semana-de-provas: a camada "${nome}" falhou e o jogo segue sem ela neste quadro`, erro),
    falhas: {},
  };

  function frame(agora) {
    // Agendado antes de tudo: nada que aconteca neste quadro tira o seguinte.
    requestAnimationFrame(frame);
    const dtReal = (agora - anterior) / 1000;
    anterior = agora;
    rodarQuadro(estado, relogio, dtReal, camadas);
  }

  requestAnimationFrame(frame);
  return estado;
}

// O relatorio pedido por um botao: texto pronto e nome de arquivo com a hora
// local, que so o navegador sabe — a simulacao nunca le relogio de parede.
function arquivoDoRelatorio(estado, escopo) {
  const agora = new Date(); // fora-do-loop: so no clique do botao de relatorio
  const relatorio = gerarRelatorio(estado, escopo, ambienteDoNavegador(agora));
  if (!relatorio) return null;
  const dois = (n) => String(n).padStart(2, '0');
  const carimbo =
    `${agora.getFullYear()}-${dois(agora.getMonth() + 1)}-${dois(agora.getDate())}` +
    `_${dois(agora.getHours())}h${dois(agora.getMinutes())}m${dois(agora.getSeconds())}s`;
  return { nome: `relatorio_${relatorio.nomeBase}_${carimbo}.md`, texto: relatorio.texto };
}

// Onde a partida rodou. Fps baixo muda a dificuldade sentida (o relogio
// descarta tempo em vez de acelerar), entao isso entra no relatorio.
function ambienteDoNavegador(agora) {
  const tela = window.screen || {};
  let fuso = '';
  try {
    fuso = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    fuso = '';
  }
  return {
    geradoEm: agora.toISOString(),
    geradoEmLocal: agora.toLocaleString('pt-BR'),
    fusoHorario: fuso,
    navegador: navigator.userAgent,
    idioma: navigator.language,
    tela: `${tela.width || 0}x${tela.height || 0}`,
    janela: `${window.innerWidth}x${window.innerHeight}`,
    pixelRatio: window.devicePixelRatio || 1,
  };
}

// -------------------------------------------------------------------- mudo

// Mesmo padrao do recorde: o localStorage so e tocado aqui, e qualquer falha
// (ausente, bloqueado, cota) degrada em silencio. Padrao: som ligado.
export function lerMudo(armazenamento = armazenamentoDoNavegador()) {
  if (!armazenamento) return false;
  try {
    return armazenamento.getItem(CONTEUDO.audio.chaveMudo) === '1';
  } catch {
    return false;
  }
}

export function gravarMudo(mudo, armazenamento = armazenamentoDoNavegador()) {
  if (!armazenamento) return false;
  try {
    armazenamento.setItem(CONTEUDO.audio.chaveMudo, mudo ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}

// O primeiro gesto cria o AudioContext; os seguintes acordam um contexto que o
// navegador tenha suspendido (aba escondida, politica de autoplay).
function ligarGestos(audio) {
  const gesto = () => audio.destravar();
  window.addEventListener('pointerdown', gesto);
  window.addEventListener('keydown', gesto);
}

// ------------------------------------------------------------------ recorde

// O localStorage do navegador, ou null. Isolado aqui porque e a unica coisa
// do jogo que persiste (fase 10, tarefa 6) e porque ele falha de jeitos
// diferentes: nao existe no node, e no navegador ate LER `localStorage` pode
// lancar (armazenamento bloqueado pelo usuario). Quem chama recebe null e
// segue sem recorde.
export function armazenamentoDoNavegador() {
  try {
    return typeof localStorage !== 'undefined' && localStorage ? localStorage : null;
  } catch {
    return null;
  }
}

// O recorde guardado, ja conferido. Qualquer coisa fora do formato (nada
// guardado, JSON quebrado, numero torto, conceito que nao existe mais em
// content.js, getItem que lanca) vira o recorde zerado — nunca uma excecao.
export function lerRecorde(armazenamento = armazenamentoDoNavegador()) {
  const recorde = novoRecorde();
  if (!armazenamento) return recorde;
  try {
    const bruto = armazenamento.getItem(CONTEUDO.recorde.chave);
    if (typeof bruto !== 'string') return recorde;
    const dados = JSON.parse(bruto);
    const conceitos = CONTEUDO.nota.faixas.map((f) => f.conceito);
    if (
      dados &&
      Number.isInteger(dados.formaturas) &&
      dados.formaturas > 0 &&
      Number.isFinite(dados.melhorMedia) &&
      dados.melhorMedia >= 0 &&
      dados.melhorMedia <= CONTEUDO.nota.maxima &&
      conceitos.includes(dados.melhorConceito)
    ) {
      recorde.formaturas = dados.formaturas;
      recorde.melhorMedia = dados.melhorMedia;
      recorde.melhorConceito = dados.melhorConceito;
    }
  } catch {
    // Degrada em silencio: sem recorde e melhor que sem jogo.
  }
  return recorde;
}

// Devolve se gravou. Cota cheia, armazenamento bloqueado ou ausente: false, e
// o jogo segue.
export function gravarRecorde(recorde, armazenamento = armazenamentoDoNavegador()) {
  if (!armazenamento) return false;
  try {
    const dados = { formaturas: recorde.formaturas, melhorMedia: recorde.melhorMedia, melhorConceito: recorde.melhorConceito };
    armazenamento.setItem(CONTEUDO.recorde.chave, JSON.stringify(dados));
    return true;
  } catch {
    return false;
  }
}

const MAPA_TECLAS = {
  KeyW: 'cima',
  ArrowUp: 'cima',
  KeyS: 'baixo',
  ArrowDown: 'baixo',
  KeyA: 'esquerda',
  ArrowLeft: 'esquerda',
  KeyD: 'direita',
  ArrowRight: 'direita',
};

function ligarTeclado(estado, audio) {
  const aplicar = (code, apertada) => {
    const acao = MAPA_TECLAS[code];
    if (!acao) return false;
    estado.input.teclas[acao] = apertada;
    const t = estado.input.teclas;
    estado.input.eixoX = (t.direita ? 1 : 0) - (t.esquerda ? 1 : 0);
    estado.input.eixoY = (t.baixo ? 1 : 0) - (t.cima ? 1 : 0);
    return true;
  };

  window.addEventListener('keydown', (ev) => {
    // M muda o som em qualquer tela, antes de tudo: numa apresentacao de sala
    // e preciso poder calar o jogo na hora.
    if (ev.code === 'KeyM' && !ev.repeat) {
      audio.alternarMudo();
      ev.preventDefault();
      return;
    }
    // A carta come a tecla antes do movimento: as setas navegam entre as
    // opcoes em vez de empurrar um jogador que esta congelado de qualquer
    // jeito. O keyup segue chamando aplicar(), entao nenhuma tecla fica presa.
    if (estado.tela === TELAS.CARTA && !ev.repeat && teclaDaCarta(estado, ev.code)) {
      ev.preventDefault();
      return;
    }
    if (estado.tela === TELAS.LOJA && !ev.repeat && teclaDaLoja(estado, ev.code)) {
      ev.preventDefault();
      return;
    }
    // Tela de fim de avaliacao: Enter e Espaco seguem adiante. Sem isto
    // o jogador precisaria achar o botao com o mouse (ou com Tab) para sair.
    if (!ev.repeat && TECLAS_SEGUIR.has(ev.code) && sairDoResultado(estado)) {
      ev.preventDefault();
      return;
    }
    // Anuncio, TCC e colacao: as mesmas teclas. Cada uma espera o atraso de
    // abertura e engole a tecla enquanto isso (o Enter que saiu da loja nao
    // comeca a prova nem a defesa); fora delas, cai no resto.
    if (!ev.repeat && TECLAS_SEGUIR.has(ev.code) && estado.tela === TELAS.ANUNCIO) {
      if (anuncioLiberado(estado)) comecarProxima(estado);
      ev.preventDefault();
      return;
    }
    if (!ev.repeat && TECLAS_SEGUIR.has(ev.code) && estado.tela === TELAS.TCC) {
      if (tccLiberado(estado)) comecarTcc(estado);
      ev.preventDefault();
      return;
    }
    if (!ev.repeat && TECLAS_SEGUIR.has(ev.code) && estado.tela === TELAS.COLACAO) {
      if (colacaoLiberada(estado)) sairDaColacao(estado);
      ev.preventDefault();
      return;
    }
    if (CONTEUDO.debug.atalhoDemo === true && !ev.repeat && ev.shiftKey && ev.code === TECLA_DEMO && menuLiberado(estado)) {
      comecarDemo(estado);
      ev.preventDefault();
      return;
    }
    // Menu e pausa: Enter/Espaco fazem o botao principal ("Jogar",
    // "Continuar"), como nas outras telas — sem mouse, o jogo nao comecava.
    // Com um botao visivel em foco (Tab), quem age e ele: o Enter no
    // "Desistir" desiste. O menu espera o atraso de abertura e engole a tecla
    // enquanto isso: o 2o toque do Enter que saiu do jubilado ou da colacao
    // nao comeca uma run (o Enter segurado ja cai no ev.repeat).
    if (!ev.repeat && TECLAS_SEGUIR.has(ev.code) && !botaoEmFoco(ev) && estado.tela === TELAS.MENU) {
      if (menuLiberado(estado)) jogarDoMenu(estado);
      ev.preventDefault();
      return;
    }
    if (!ev.repeat && TECLAS_SEGUIR.has(ev.code) && !botaoEmFoco(ev) && continuarDaPausa(estado)) {
      ev.preventDefault();
      return;
    }
    if (aplicar(ev.code, true)) ev.preventDefault();
    // ev.repeat: segurar ESC repete o keydown ~30x/s e a pausa piscaria.
    if (ev.code === 'Escape' && !ev.repeat) alternarPausa(estado);
    // Espaco nunca rola a pagina nem "clica" um botao escondido que ficou com
    // o foco; so o botao visivel em foco recebe o clique dele.
    if (ev.code === 'Space' && !botaoEmFoco(ev)) ev.preventDefault();
  });

  window.addEventListener('keyup', (ev) => {
    if (aplicar(ev.code, false)) ev.preventDefault();
  });

  window.addEventListener('blur', () => perderFoco(estado));

  // Minimizar ou trocar de aba nem sempre dispara `blur` (depende do
  // navegador e de onde estava o foco). visibilitychange cobre o resto — e
  // tambem solta as teclas: sem isso, quem trocava de aba (Ctrl+Tab) com o
  // "D" apertado voltava andando sozinho para a parede.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) perderFoco(estado);
  });
}

// A janela perdeu o foco (blur) ou a aba sumiu: o keyup das teclas apertadas
// nunca vai chegar, entao todas soltam; e a prova pausa, como o ESC — o
// jogador nao morre olhando para outra janela no meio da apresentacao. As
// outras telas ja congelam o jogo e ficam como estao. Devolve se pausou.
export function perderFoco(estado) {
  estado.input.teclas = {};
  estado.input.eixoX = 0;
  estado.input.eixoY = 0;
  if (estado.tela !== TELAS.AVALIACAO) return false;
  irParaTela(estado, TELAS.PAUSA);
  return true;
}

// O alvo do teclado e um botao que o jogador enxerga (chegou nele com Tab)?
// Entao o Enter/Espaco e dele, e o navegador o clica. Um botao escondido que
// ficou com o foco depois de a tela sumir nao conta.
function botaoEmFoco(ev) {
  const alvo = ev.target;
  return Boolean(alvo && alvo.tagName === 'BUTTON' && typeof alvo.getClientRects === 'function' && alvo.getClientRects().length > 0);
}

// Enter/Espaco seguem adiante na tela de resultado e na de jubilado. ESC NAO:
// quem aperta ESC para pausar no instante em que o cronometro zera fecharia o
// boletim sem ler. Na tela de fim o ESC cai em alternarPausa, que nao faz nada.
const TECLAS_SEGUIR = new Set(['Enter', 'NumpadEnter', 'Space']);

// O atalho de demonstracao (debug.atalhoDemo, fase 23): Shift+T no menu pula
// para o TCC (run.js, comecarDemo). So com Shift e so no menu: ninguem o
// aperta jogando, e o menu nao tem outra tecla de letra.
const TECLA_DEMO = 'KeyT';

// A unica saida das duas telas de fim de avaliacao, usada pelo teclado e
// pelos dois botoes. Devolve false quando nao ha nada para fechar — e o que
// deixa o mesmo keydown cair para a pausa e para o movimento.
export function sairDoResultado(estado) {
  if (estado.tela !== TELAS.RESULTADO && estado.tela !== TELAS.JUBILADO) return false;
  // Aprovado vai para a loja; jubilado vai ao menu, porque a run acabou.
  if (estado.tela === TELAS.RESULTADO) abrirLoja(estado);
  else irParaTela(estado, TELAS.MENU);
  return true;
}

// Teclado da loja. Setas/WASD movem o cursor (cima/baixo troca entre a
// vitrine e os seus coringas), Enter/Espaco fazem o que o cursor aponta, 1-9 compram
// direto, L compra o lanche e R rerrola. As teclas que agem esperam o atraso
// de abertura (entradaLiberada): o Enter repetido do boletim nao compra nada.
function teclaDaLoja(estado, code) {
  if (code === 'ArrowLeft' || code === 'KeyA') return moverSelecaoLoja(estado, -1);
  if (code === 'ArrowRight' || code === 'KeyD') return moverSelecaoLoja(estado, 1);
  if (code === 'ArrowUp' || code === 'KeyW' || code === 'ArrowDown' || code === 'KeyS') {
    trocarLinhaLoja(estado);
    return true;
  }
  const confirma = code === 'Enter' || code === 'NumpadEnter' || code === 'Space';
  const gasta = confirma || code === 'KeyR' || code === 'KeyL' || /^(Digit|Numpad)[1-9]$/.test(code);
  if (!gasta) return false;
  if (!entradaLiberada(estado)) return true; // engole a tecla: nem compra, nem cai no resto
  if (code === 'KeyR') return rerolar(estado) || true;
  if (code === 'KeyL') return comprarLanche(estado) || true;
  if (confirma) return confirmarLoja(estado) || true;
  return comprarItem(estado, Number(code.slice(-1)) - 1) || true;
}

// Mouse pode falhar na apresentacao; teclado nao. 1/2/3 escolhe direto,
// setas movem o cursor e Enter confirma. O indice sai do proprio nome da tecla
// para acompanhar CONTEUDO.cartas.quantidade sem tabela para manter.
// As teclas que escolhem esperam o atraso de abertura (cartaLiberada) e sao
// engolidas enquanto isso; as setas nao, porque mover o cursor nao decide nada.
function teclaDaCarta(estado, code) {
  if (/^(Digit|Numpad)[1-9]$/.test(code)) {
    return !cartaLiberada(estado) || escolherCarta(estado, Number(code.slice(-1)) - 1);
  }
  if (code === 'ArrowLeft' || code === 'KeyA') return moverSelecaoCarta(estado, -1);
  if (code === 'ArrowRight' || code === 'KeyD') return moverSelecaoCarta(estado, 1);
  if (code === 'Enter' || code === 'Space' || code === 'NumpadEnter') {
    return !cartaLiberada(estado) || escolherCarta(estado, estado.cartas.selecionada);
  }
  return false;
}

// ESC: so a avaliacao rodando pausa, e so a pausa despausa. Na carta e na
// loja (e em toda tela que ja congela o jogo) e nada: nao existe "pausa por
// cima da carta", que voltaria para a avaliacao sem a carta ser escolhida.
export function alternarPausa(estado) {
  if (estado.tela === TELAS.AVALIACAO) irParaTela(estado, TELAS.PAUSA);
  else if (estado.tela === TELAS.PAUSA) irParaTela(estado, TELAS.AVALIACAO);
}

// Os botoes do menu e da pausa so valem na tela deles. Um clique atrasado, ou
// um Enter num botao que ficou com o foco depois de a tela sumir, nao pode
// recomecar a run no meio de uma prova, nem "continuar" de cima de uma carta
// ou da loja (o que pularia a escolha). Devolvem se agiram.
// O atraso de abertura do menu (menu.atrasoEntrada). Como o do anuncio, quem
// checa e quem chama (o teclado e o botao "Jogar"), e nao jogarDoMenu: o smoke
// e o fuzz a exercitam sem simular o relogio.
export function menuLiberado(estado) {
  return estado.tela === TELAS.MENU && estado.tempo - estado.telaAbertaEm >= CONTEUDO.menu.atrasoEntrada;
}

export function jogarDoMenu(estado) {
  if (estado.tela !== TELAS.MENU) return false;
  iniciarRun(estado);
  return true;
}

export function continuarDaPausa(estado) {
  if (estado.tela !== TELAS.PAUSA) return false;
  irParaTela(estado, TELAS.AVALIACAO);
  return true;
}

export function desistirDaPausa(estado) {
  if (estado.tela !== TELAS.PAUSA) return false;
  irParaTela(estado, TELAS.MENU);
  return true;
}
