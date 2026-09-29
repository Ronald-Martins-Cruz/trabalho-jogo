import { CONTEUDO } from '../data/content.js';
import { emitir } from './state.js';
import { xpParaSubir } from './player.js';

// Coringas. A regra que este arquivo existe para estabelecer: NENHUM
// `if (temCoringa('x'))` fora daqui. O resto do jogo so conhece a lista
// fechada de HOOKS abaixo, cada um chamado de UM lugar so:
//
//   aoIniciarAvaliacao(estado)                   run.js     comecarAvaliacao()
//   aoCalcularDano(estado, dano, alvo) -> dano   weapons.js golpear()
//   aoMatarInimigo(estado, inimigo)              enemies.js aplicarDano()
//   aoGanharXp(estado, valor) -> valor           player.js  atualizarOrbes()
//   aoReceberDanoFatal(estado, dano) -> hp       player.js  receberDano()
//   modificarAtributo(estado, nome, v) -> v      um lugar POR ATRIBUTO:
//     velocidade, raioColeta, hpMax              jokers.js  aplicarAtributos()
//     itensLoja                                  shop.js    abrirLoja()
//     opcoesCarta                                cards.js   sortearOpcoes()
//
// Um coringa em content.js nao e codigo: e um `efeito` (nome de uma entrada
// de EFEITOS) mais `params` (os numeros). Um efeito implementa um ou mais
// hooks. Coringa novo com efeito existente entra so em content.js.
//
// Todo hook passa por coringasEmJogo(): e ali, e so ali, que a regra
// `coringas` da avaliacao (🚫 Prova sem Consulta) desliga a mao inteira.
//
// A instancia de um coringa comprado mora em estado.run.coringas como
// { id, contador, gasto }: tudo numero/booleano/string, o estado continua
// serializavel. `contador` e memoria por avaliacao (Grupo de WhatsApp),
// `gasto` e memoria por run (Atestado).

export const HOOKS = [
  'aoIniciarAvaliacao',
  'aoCalcularDano',
  'aoMatarInimigo',
  'aoGanharXp',
  'aoReceberDanoFatal',
  'modificarAtributo',
];

// Atributos do jogador que modificarAtributo pode mexer. Cada um e copiado de
// CONTEUDO.jogador para estado.player no inicio da avaliacao, ja modificado,
// e o jogo le do player.
export const ATRIBUTOS = ['velocidade', 'raioColeta', 'hpMax'];

// Atributos que nao moram no player: quem usa o numero pergunta
// modificarAtributo(estado, nome, base) na hora de usar, com o estado daquele
// instante (a Xerox, por exemplo, so vale enquanto cartas.escolhidas === 0).
// O ponto de uso limita o resultado aos slots que existem.
export const ATRIBUTOS_NO_USO = ['itensLoja', 'opcoesCarta'];

// Contagens e HP saem arredondados: HP x1,15 daria 114,99999999999999 no HUD,
// e "3,75 itens na loja" nao existe.
const ATRIBUTOS_INTEIROS = ['hpMax', 'itensLoja', 'opcoesCarta'];

// Cada efeito: { parametros: [...], validar?, <hook>(estado, inst, params, ...) }.
// `parametros` e o que o check exige em `params` de todo coringa que use o
// efeito, e `validar(params) -> erro|null` confere o que nao e so presenca —
// typo em content.js falha no `npm run check`, nao no meio da run.
const EFEITOS = {
  // 🔋 Energetico, 📶 Wi-Fi.
  atributo: {
    parametros: ['atributo', 'fator'],
    validar: (params) =>
      ATRIBUTOS.includes(params.atributo) || ATRIBUTOS_NO_USO.includes(params.atributo)
        ? null
        : `atributo "${params.atributo}" nao e um de ${ATRIBUTOS.concat(ATRIBUTOS_NO_USO).join(', ')}`,
    modificarAtributo(estado, inst, params, nome, valor) {
      return nome === params.atributo ? valor * params.fator : valor;
    },
  },

  // 📚 Caderno Emprestado. Da o XP exato dos proximos `niveis` niveis: no
  // primeiro tick a carta de nivel abre pelo caminho normal (cards.js), e o
  // jogador escolhe a carta do nivel 2 antes do primeiro inimigo chegar.
  // A subida so acontece no tick, entao um segundo coringa deste efeito acha
  // a barra ja cheia: ele primeiro desconta o XP que ja esta pendente (o mesmo
  // laco de cards.js subirNiveis) e so entao soma os niveis dele.
  nivelInicial: {
    parametros: ['niveis'],
    aoIniciarAvaliacao(estado, inst, params) {
      const player = estado.player;
      let nivel = player.nivel;
      let sobra = player.xp;
      let limiar = player.xpProximo;
      while (limiar > 0 && sobra >= limiar) {
        sobra -= limiar;
        nivel += 1;
        limiar = xpParaSubir(nivel);
      }
      let xp = limiar - sobra;
      for (let i = 1; i < params.niveis; i += 1) {
        nivel += 1;
        xp += xpParaSubir(nivel);
      }
      if (xp > 0) player.xp += xp;
    },
  },

  // 🌙 Vespera da Prova.
  danoNoFim: {
    parametros: ['segundos', 'fator'],
    aoCalcularDano(estado, inst, params, dano) {
      return estado.run.avaliacao.restante <= params.segundos ? dano * params.fator : dano;
    },
  },

  // 📱 Grupo de WhatsApp. O contador zera a cada avaliacao ("cumulativo
  // dentro da avaliacao") e conta so as mortes feitas COM o coringa.
  danoPorMorte: {
    parametros: ['porMorte'],
    aoIniciarAvaliacao(estado, inst) {
      inst.contador = 0;
    },
    aoMatarInimigo(estado, inst) {
      inst.contador += 1;
    },
    aoCalcularDano(estado, inst, params, dano) {
      return dano * (1 + params.porMorte * inst.contador);
    },
  },

  // 🏥 Atestado Medico. `gasto` vive na instancia (que dura a run) e o id vai
  // para run.coringasGastos, para a loja nao vende-lo de novo.
  sobreviverFatal: {
    parametros: ['hp'],
    // hp < 1 nao salva ninguem: o hook devolve 0 = "nenhum coringa segurou".
    validar: (params) => (params.hp >= 1 ? null : `params.hp = ${params.hp}, precisa ser >= 1`),
    aoReceberDanoFatal(estado, inst, params) {
      if (inst.gasto) return 0;
      inst.gasto = true;
      const gastos = estado.run.coringasGastos;
      if (!gastos.includes(inst.id)) gastos.push(inst.id);
      emitir(estado, 'coringa-ativado', { id: inst.id });
      return params.hp;
    },
  },

  // Sem coringa no MVP. Existe para o hook aoGanharXp ter efeito — e e o que
  // o smoke usa para provar que um coringa novo entra so por content.js.
  multiplicarXp: {
    parametros: ['fator'],
    aoGanharXp(estado, inst, params, valor) {
      return valor * params.fator;
    },
  },
};

// ------------------------------------------------------------------- dados

export function dadosDoCoringa(id, lista = CONTEUDO.coringas) {
  for (let i = 0; i < lista.length; i += 1) if (lista[i].id === id) return lista[i];
  return null;
}

function efeitoDe(dados) {
  return dados ? EFEITOS[dados.efeito] || null : null;
}

// A instancia que a loja empurra em run.coringas. Nasce fora do loop (clique).
export function novaInstancia(id) {
  return { id, contador: 0, gasto: false };
}

// ------------------------------------------------------------------- hooks
// Todos percorrem coringasEmJogo() (no maximo loja.teto) e saem na hora
// quando ela esta vazia: sem coringa, o custo e uma comparacao.

const NENHUM = [];

// O UNICO lugar que le a regra `coringas` da avaliacao (0 = Prova sem
// Consulta). Enquanto uma avaliacao com a regra desligada esta de pe, todo
// hook ve a mao vazia; os coringas continuam na run e voltam na loja
// seguinte (av.concluida), onde itensLoja ainda pergunta por eles.
function coringasEmJogo(estado) {
  const av = estado.run.avaliacao;
  return av.regras.coringas > 0 || av.concluida ? estado.run.coringas : NENHUM;
}

// Para o HUD esmaecer a mao: a UI pergunta aqui em vez de ler a regra, e a
// semantica (inclusive "voltam quando a avaliacao conclui") mora num lugar so.
export function coringasDesligados(estado) {
  return coringasEmJogo(estado) !== estado.run.coringas;
}

export function aoIniciarAvaliacao(estado) {
  aplicarAtributos(estado);
  const lista = coringasEmJogo(estado);
  for (let i = 0; i < lista.length; i += 1) {
    const inst = lista[i];
    const dados = dadosDoCoringa(inst.id);
    const efeito = efeitoDe(dados);
    if (efeito && efeito.aoIniciarAvaliacao) efeito.aoIniciarAvaliacao(estado, inst, dados.params);
  }
}

// Unico lugar em que um atributo do JOGADOR e calculado (os de ATRIBUTOS_NO_USO
// sao perguntados por quem os usa). O player acabou de nascer (novoPlayer),
// entao HP cheio aqui e o HP cheio modificado.
function aplicarAtributos(estado) {
  const player = estado.player;
  for (let i = 0; i < ATRIBUTOS.length; i += 1) {
    const nome = ATRIBUTOS[i];
    player[nome] = modificarAtributo(estado, nome, CONTEUDO.jogador[nome]);
  }
  player.hp = player.hpMax;
}

export function modificarAtributo(estado, nome, valor) {
  const lista = coringasEmJogo(estado);
  let v = valor;
  for (let i = 0; i < lista.length; i += 1) {
    const inst = lista[i];
    const dados = dadosDoCoringa(inst.id);
    const efeito = efeitoDe(dados);
    if (efeito && efeito.modificarAtributo) v = efeito.modificarAtributo(estado, inst, dados.params, nome, v);
  }
  return ATRIBUTOS_INTEIROS.includes(nome) ? Math.round(v) : v;
}

// `alvo` e o inimigo que vai levar o golpe, ainda com o HP de antes dele. Um
// efeito que precise matar na hora (a Cola na Regua da expansao) devolve
// Math.max(dano, alvo.hp) — o HP exato que falta, e nao um numero enorme que
// sairia no evento arma-acerto e no relatorio como dano.
export function aoCalcularDano(estado, dano, alvo) {
  const lista = coringasEmJogo(estado);
  let d = dano;
  for (let i = 0; i < lista.length; i += 1) {
    const inst = lista[i];
    const dados = dadosDoCoringa(inst.id);
    const efeito = efeitoDe(dados);
    if (efeito && efeito.aoCalcularDano) d = efeito.aoCalcularDano(estado, inst, dados.params, d, alvo);
  }
  return d;
}

export function aoMatarInimigo(estado, inimigo) {
  const lista = coringasEmJogo(estado);
  for (let i = 0; i < lista.length; i += 1) {
    const inst = lista[i];
    const dados = dadosDoCoringa(inst.id);
    const efeito = efeitoDe(dados);
    if (efeito && efeito.aoMatarInimigo) efeito.aoMatarInimigo(estado, inst, dados.params, inimigo);
  }
}

export function aoGanharXp(estado, valor) {
  const lista = coringasEmJogo(estado);
  let v = valor;
  for (let i = 0; i < lista.length; i += 1) {
    const inst = lista[i];
    const dados = dadosDoCoringa(inst.id);
    const efeito = efeitoDe(dados);
    if (efeito && efeito.aoGanharXp) v = efeito.aoGanharXp(estado, inst, dados.params, v);
  }
  return v;
}

// Devolve o HP com que o jogador sobrevive ao golpe fatal, ou 0 se nenhum
// coringa o salvou. O primeiro que salvar encerra: dois Atestados nao gastam
// juntos no mesmo golpe.
export function aoReceberDanoFatal(estado, dano) {
  const lista = coringasEmJogo(estado);
  for (let i = 0; i < lista.length; i += 1) {
    const inst = lista[i];
    const dados = dadosDoCoringa(inst.id);
    const efeito = efeitoDe(dados);
    if (!efeito || !efeito.aoReceberDanoFatal) continue;
    const hp = efeito.aoReceberDanoFatal(estado, inst, dados.params, dano);
    if (hp > 0) return hp;
  }
  return 0;
}

// ------------------------------------------------------------ verificacao

// Para check.mjs e smoke.mjs, no mesmo espirito de verificarArmasDoConteudo():
// content.js nao pode importar este arquivo, entao quem liga dado a codigo e
// o teste. Devolve a lista de problemas (vazia = ok).
export function verificarCoringasDoConteudo(conteudo = CONTEUDO) {
  const problemas = [];
  const vistos = new Set();
  for (const nomeEfeito of Object.keys(EFEITOS)) {
    for (const chave of Object.keys(EFEITOS[nomeEfeito])) {
      if (chave !== 'parametros' && chave !== 'validar' && !HOOKS.includes(chave)) {
        problemas.push(`efeito "${nomeEfeito}" em jokers.js implementa "${chave}", que nao e hook (${HOOKS.join(', ')})`);
      }
    }
  }
  for (const coringa of conteudo.coringas) {
    if (vistos.has(coringa.id)) problemas.push(`coringa "${coringa.id}": id repetido`);
    vistos.add(coringa.id);
    const efeito = EFEITOS[coringa.efeito];
    if (!efeito) {
      problemas.push(
        `coringa "${coringa.id}": efeito "${coringa.efeito}" nao existe em jokers.js ` +
          `(registrados: ${Object.keys(EFEITOS).join(', ')})`
      );
      continue;
    }
    const params = coringa.params || {};
    for (const p of efeito.parametros) {
      if (params[p] === undefined) problemas.push(`coringa "${coringa.id}": efeito "${coringa.efeito}" pede params.${p}`);
    }
    const erro = efeito.validar ? efeito.validar(params) : null;
    if (erro) problemas.push(`coringa "${coringa.id}": ${erro}`);
    for (const [chave, valor] of Object.entries(params)) {
      if (typeof valor === 'number' && !Number.isFinite(valor)) {
        problemas.push(`coringa "${coringa.id}": params.${chave} nao e finito`);
      }
    }
  }
  return problemas;
}
