import { CONTEUDO } from '../data/content.js';
import { emitir, irParaTela, TELAS } from './state.js';
import { obterScratch } from './pool.js';
import { dadosDaArma, equiparArma, subirNivelArma } from './weapons.js';
import { curar, xpParaSubir } from './player.js';
import { modificarAtributo } from './jokers.js';

// XP vira nivel, nivel vira carta. Este arquivo e simulacao pura: nao sabe o
// que e um botao nem um clique. A tela de carta congela o jogo escrevendo
// `estado.tela = TELAS.CARTA`; a escolha do jogador volta por
// `estado.cartas.escolha`, exatamente como o teclado chega por `estado.input`.
// Quem desenha e ui.js, que so le o estado.
//
// A coleta do XP fica em player.js (e o orbe encosta no jogador). A conversao
// XP -> nivel mora aqui porque ela emite evento, e player.js nao pode importar
// state.js sem fechar um ciclo (state.js importa criarRastro de player.js).

// Registro de efeitos de carta, na mesma ideia do registro de comportamentos
// de arma: o `tipo` vem de content.js e tem que existir aqui. Assinatura
// unica: (estado, carta) -> boolean (se o efeito mudou alguma coisa).
const EFEITOS = {
  'arma-nova': (estado, carta) => equiparArma(estado, carta.id) !== null,
  'arma-nivel': (estado, carta) => subirNivelArma(estado, carta.id),
  cura: (estado, carta) => curar(estado, carta.valor) > 0,
};

// Unico ponto de entrada, chamado por main.js todo tick: durante a avaliacao
// converte XP em nivel e abre a carta; com a carta aberta, espera a escolha.
export function atualizarCartas(estado) {
  if (estado.tela === TELAS.CARTA) {
    resolverEscolha(estado);
    return;
  }
  if (estado.tela !== TELAS.AVALIACAO) return;

  subirNiveis(estado);
  if (estado.cartas.fila > 0) abrirCarta(estado);
}

// `while`, nao `if`: uma horda que morre junto pode encher a barra duas vezes
// no mesmo quadro. Cada nivel entra na fila e vira uma carta propria, mostrada
// uma depois da outra — perder um nivel porque dois cairam juntos e o bug
// classico desta tela, e ele e invisivel quando acontece.
function subirNiveis(estado) {
  const player = estado.player;
  while (player.xp >= player.xpProximo) {
    if (!(player.xpProximo > 0)) break; // rede contra limiar zerado em content.js
    player.xp -= player.xpProximo;
    player.nivel += 1;
    player.xpProximo = xpParaSubir(player.nivel);
    estado.cartas.fila += 1;
    emitir(estado, 'nivel', player.nivel);
  }
}

function abrirCarta(estado) {
  sortearOpcoes(estado);
  estado.cartas.selecionada = 0;
  estado.cartas.escolha = null;
  // `versao` muda a cada sorteio: e como a UI percebe que a carta seguinte da
  // fila entrou, ja que a tela continua sendo a mesma.
  estado.cartas.versao += 1;
  estado.cartas.abertaEm = estado.tempo;
  irParaTela(estado, TELAS.CARTA);
  emitir(estado, 'carta-aberta', estado.player.nivel);
}

// O atraso de abertura da carta (cartas.atrasoEntrada), igual ao da loja:
// vale para cada carta da fila, porque a seguinte abre no lugar da anterior
// sem trocar de tela. Quem checa e main.js, antes de escolherCarta — o smoke
// escolhe direto, sem relogio.
export function cartaLiberada(estado) {
  return estado.tela === TELAS.CARTA && estado.tempo - estado.cartas.abertaEm >= CONTEUDO.cartas.atrasoEntrada;
}

function resolverEscolha(estado) {
  const cartas = estado.cartas;
  const indice = cartas.escolha;
  if (indice === null) return;
  cartas.escolha = null;

  const carta = cartas.opcoes[indice];
  if (!carta || carta.tipo === '') return;

  aplicarCarta(estado, carta);
  cartas.escolhidas += 1;
  cartas.fila = Math.max(0, cartas.fila - 1);
  emitir(estado, 'carta-escolhida', {
    tipo: carta.tipo,
    id: carta.id,
    nivel: carta.nivelProximo,
  });

  if (cartas.fila > 0) abrirCarta(estado);
  else irParaTela(estado, TELAS.AVALIACAO);
}

function aplicarCarta(estado, carta) {
  const efeito = EFEITOS[carta.tipo];
  if (!efeito) {
    throw new Error(
      `carta "${carta.id}": tipo "${carta.tipo}" nao existe em cards.js ` +
        `(registrados: ${Object.keys(EFEITOS).join(', ')})`
    );
  }
  return efeito(estado, carta);
}

// ------------------------------------------------------------ entrada do jogador

// A UI (mouse ou teclado) chama estas duas, nunca escreve no estado direto.
// Devolvem false quando o pedido nao faz sentido — clique atrasado depois de a
// carta fechar, indice fora da faixa.
export function escolherCarta(estado, indice) {
  if (!apontarCarta(estado, indice)) return false;
  estado.cartas.escolha = indice;
  return true;
}

// Move o cursor sem confirmar: e o que o mouse (mouseenter) e o foco do DOM
// chamam. Precisa passar pelo estado como qualquer outra entrada — destaque
// pintado direto na classe CSS seria desfeito no frame seguinte, e o jogador
// confirmaria a carta do cursor em vez da que esta apontando.
export function apontarCarta(estado, indice) {
  const cartas = estado.cartas;
  if (estado.tela !== TELAS.CARTA) return false;
  if (!Number.isInteger(indice) || indice < 0 || indice >= cartas.opcoes.length) return false;
  cartas.selecionada = indice;
  return true;
}

export function moverSelecaoCarta(estado, passo) {
  const cartas = estado.cartas;
  if (estado.tela !== TELAS.CARTA) return false;
  const total = cartas.opcoes.length;
  if (total === 0) return false;
  cartas.selecionada = (((cartas.selecionada + passo) % total) + total) % total;
  return true;
}

// ------------------------------------------------------------------ sorteio

// Regra: arma que o jogador nao tem, ou +1 nivel numa que ele tem e que ainda
// sobe. Nunca nivel acima do ultimo de content.js. Se nao houver opcao valida
// suficiente (tudo no maximo), a carta de consolo completa — sem isso o jogo
// travaria numa tela de escolha sem escolha, justamente no fim da avaliacao,
// que e quando isso acontece.
function sortearOpcoes(estado) {
  const candidatos = montarCandidatos(estado);
  const opcoes = estado.cartas.opcoes;
  // Um coringa pode mudar quantas opcoes esta carta mostra (jokers.js,
  // 'opcoesCarta'). Os slots de novasCartas() sao o teto, e ao menos uma
  // opcao sempre sai: tela de escolha sem escolha trava o jogo.
  const quantidade = Math.max(1, Math.min(opcoes.length, modificarAtributo(estado, 'opcoesCarta', CONTEUDO.cartas.quantidade)));

  for (let i = 0; i < opcoes.length; i += 1) {
    if (i >= quantidade) {
      esvaziarOpcao(opcoes[i]);
      continue;
    }
    const escolhido = sortearCandidato(estado, candidatos);
    if (escolhido < 0) {
      preencherConsolo(opcoes[i]);
      continue;
    }
    preencherArma(opcoes[i], estado, candidatos.tipos[escolhido], candidatos.ids[escolhido]);
    removerCandidato(candidatos, escolhido);
  }
}

// Listas paralelas em vez de um array de objetos: elas vivem no scratch e sao
// reaproveitadas a cada sorteio, entao nenhum objeto nasce dentro do update.
function scratchCandidatos(estado) {
  const scratch = obterScratch(estado);
  if (!scratch.cartas) scratch.cartas = { tipos: [], ids: [], pesos: [] };
  return scratch.cartas;
}

function montarCandidatos(estado) {
  const candidatos = scratchCandidatos(estado);
  candidatos.tipos.length = 0;
  candidatos.ids.length = 0;
  candidatos.pesos.length = 0;

  const cfg = CONTEUDO.cartas;
  for (const dados of CONTEUDO.armas) {
    const instancia = instanciaDaArma(estado, dados.id);
    if (!instancia) {
      empilhar(candidatos, 'arma-nova', dados.id, cfg.pesoArmaNova);
    } else if (instancia.nivel < dados.niveis.length) {
      empilhar(candidatos, 'arma-nivel', dados.id, cfg.pesoArmaNivel);
    }
  }
  return candidatos;
}

function empilhar(candidatos, tipo, id, peso) {
  if (!(peso > 0)) return;
  candidatos.tipos.push(tipo);
  candidatos.ids.push(id);
  candidatos.pesos.push(peso);
}

// Sorteio ponderado, sem reposicao (o chamador remove o escolhido). Devolve -1
// quando nao ha mais candidato: e o sinal de completar com a carta de consolo.
function sortearCandidato(estado, candidatos) {
  let total = 0;
  for (let i = 0; i < candidatos.pesos.length; i += 1) total += candidatos.pesos[i];
  if (!(total > 0)) return -1;

  let sorte = estado.rng.float() * total;
  for (let i = 0; i < candidatos.pesos.length; i += 1) {
    sorte -= candidatos.pesos[i];
    if (sorte <= 0) return i;
  }
  return candidatos.pesos.length - 1;
}

function removerCandidato(candidatos, i) {
  const ultimo = candidatos.pesos.length - 1;
  candidatos.tipos[i] = candidatos.tipos[ultimo];
  candidatos.ids[i] = candidatos.ids[ultimo];
  candidatos.pesos[i] = candidatos.pesos[ultimo];
  candidatos.tipos.length = ultimo;
  candidatos.ids.length = ultimo;
  candidatos.pesos.length = ultimo;
}

// Nome, descricao e emoji sao copiados de content.js — nenhuma string de UI
// nasce aqui. Os numeros do rotulo ("Nv. 2 → 3") vao crus; quem formata e
// ui.js, com os textos de CONTEUDO.textos.cartas.
function preencherArma(opcao, estado, tipo, id) {
  const dados = dadosDaArma(id);
  const instancia = instanciaDaArma(estado, id);
  opcao.tipo = tipo;
  opcao.id = id;
  opcao.nome = dados.nome;
  opcao.descricao = dados.descricao;
  opcao.emoji = dados.emoji;
  opcao.nivelAtual = instancia ? instancia.nivel : 0;
  opcao.nivelProximo = opcao.nivelAtual + 1;
  opcao.valor = 0;
}

function preencherConsolo(opcao) {
  const consolo = CONTEUDO.cartas.consolo;
  opcao.tipo = consolo.tipo;
  opcao.id = consolo.id;
  opcao.nome = consolo.nome;
  opcao.descricao = consolo.descricao;
  opcao.emoji = consolo.emoji;
  opcao.nivelAtual = 0;
  opcao.nivelProximo = 0;
  opcao.valor = consolo.valor;
}

// Slot fora da quantidade desta carta: tipo '' e o que ui.js esconde e o que
// resolverEscolha ignora.
function esvaziarOpcao(opcao) {
  opcao.tipo = '';
  opcao.id = '';
  opcao.nome = '';
  opcao.descricao = '';
  opcao.emoji = '';
  opcao.nivelAtual = 0;
  opcao.nivelProximo = 0;
  opcao.valor = 0;
}

function instanciaDaArma(estado, id) {
  const armas = estado.player.armas;
  for (let i = 0; i < armas.length; i += 1) if (armas[i].id === id) return armas[i];
  return null;
}

// Para o smoke, no mesmo espirito de verificarArmasDoConteudo(): content.js nao
// pode importar cards.js (ciclo), entao quem liga dado e codigo e o teste. Um
// `tipo` digitado errado na carta de consolo so apareceria no fim da avaliacao,
// quando tudo estivesse no nivel maximo — tarde demais.
export function verificarCartasDoConteudo() {
  const consolo = CONTEUDO.cartas.consolo;
  if (!EFEITOS[consolo.tipo]) {
    return (
      `cartas.consolo "${consolo.id}": tipo "${consolo.tipo}" nao registrado em cards.js ` +
      `(registrados: ${Object.keys(EFEITOS).join(', ')})`
    );
  }
  if (CONTEUDO.cartas.quantidade < 1) {
    return `cartas.quantidade: ${CONTEUDO.cartas.quantidade} — a tela abriria sem nenhuma opcao`;
  }
  return null;
}
