import { CONTEUDO } from '../data/content.js';
import { emitir, iniciarAvaliacao, irParaTela, novaRun, TELAS } from './state.js';
import { aoIniciarAvaliacao } from './jokers.js';

// Fim de avaliacao: nota, conceito e creditos. Tudo aqui e funcao pura sobre
// numeros — nenhum peso, nenhuma faixa e nenhum multiplicador mora neste
// arquivo, todos vem de CONTEUDO.nota. O design §4 chama equilibrar pesoKill
// contra pesoHp de "a decisao de tunning mais importante do jogo": tunar isso
// nao pode exigir abrir um .js de logica.
//
// A fase 08 herda este arquivo para a run inteira (virar periodo, ir para o
// TCC, decidir o que um jubilamento faz com a run). Hoje ele so fecha UMA
// avaliacao.

export const MOTIVO_TEMPO = 'tempo'; // o cronometro zerou: aprovado
export const MOTIVO_JUBILADO = 'jubilado'; // o HP zerou

function numero(valor) {
  return Number.isFinite(valor) ? valor : 0;
}

// Uma casa decimal (CONTEUDO.nota.casasDecimais). O arredondamento nao e
// cosmetico: e a nota ARREDONDADA que escolhe a faixa, senao a tela mostraria
// 8,5 e pagaria os creditos de C.
export function arredondarNota(valor, pesos = CONTEUDO.nota) {
  const fator = 10 ** Math.max(0, Math.floor(numero(pesos.casasDecimais)));
  return Math.round(numero(valor) * fator) / fator;
}

// As tres parcelas da nota, separadas, porque a tela de resultado precisa
// mostrar de onde cada ponto veio — sem a decomposicao a nota e um numero
// arbitrario e o jogador nao tem como descobrir que cacar e preservar HP
// pagam os dois. `destino` e um objeto ja existente: fecharAvaliacao passa o
// de estado.run.resultado.parcelas e nada e alocado.
//
// Cada parcela sai JA arredondada, e calcularNota soma as parcelas
// arredondadas: arredondar so a soma bruta fazia a tela mostrar
// "+5,5 · +3,7" com nota 9,3. O grampo do teto tambem mora aqui, e cai na
// parcela de kills (a unica sem limite proprio): quem passou do teto ve os
// kills valendo so o que faltava para a nota maxima, e a conta ainda fecha.
export function parcelasDaNota(entrada, destino, pesos = CONTEUDO.nota) {
  const alvo = destino || { kills: 0, hp: 0, ileso: 0 };
  const kills = Math.max(0, numero(entrada.kills));
  const hpMax = numero(entrada.hpMax);
  const hpRestante = Math.max(0, numero(entrada.hpRestante));
  const fracaoHp = hpMax > 0 ? Math.min(1, hpRestante / hpMax) : 0;
  const maxima = Math.max(0, numero(pesos.maxima));

  alvo.hp = Math.min(maxima, arredondarNota(fracaoHp * numero(pesos.pesoHp), pesos));
  alvo.ileso = Math.min(
    arredondarNota(maxima - alvo.hp, pesos),
    entrada.ileso ? arredondarNota(numero(pesos.bonusIleso), pesos) : 0
  );
  const folga = arredondarNota(maxima - alvo.hp - alvo.ileso, pesos);
  alvo.kills = Math.min(folga, arredondarNota(kills * numero(pesos.pesoKill), pesos));
  return alvo;
}

// A funcao que a fase 13 vai tunar sem abrir este arquivo.
// calcularNota({ kills, hpRestante, hpMax, ileso }, pesos) -> numero
// E a soma das parcelas mostradas; o arredondamento final so apaga o ruido de
// ponto flutuante (5.5 + 3.7 = 9.2000000001).
export function calcularNota(entrada, pesos = CONTEUDO.nota) {
  const p = parcelasDaNota(entrada, null, pesos);
  const maxima = numero(pesos.maxima);
  return Math.max(0, Math.min(maxima, arredondarNota(p.kills + p.hp + p.ileso, pesos)));
}

// Primeira faixa (ordem decrescente de exigencia) cuja nota minima foi
// atingida. A ultima tem minimo 0 e o validador garante isso, entao esta
// funcao sempre devolve alguma coisa.
export function faixaDaNota(nota, faixas = CONTEUDO.nota.faixas) {
  const valor = numero(nota);
  for (const faixa of faixas) {
    if (valor >= faixa.minimo) return faixa;
  }
  return faixas[faixas.length - 1];
}

export function conceitoDaNota(nota, faixas = CONTEUDO.nota.faixas) {
  const faixa = faixaDaNota(nota, faixas);
  return faixa ? faixa.conceito : '';
}

// Creditos por conceito (design §4: D base, C +30%, B +60%, A +100%). Sai
// inteiro: meio credito nao compra nada e polui a tela.
export function creditosDaFaixa(faixa, pesos = CONTEUDO.nota) {
  if (!faixa) return 0;
  return Math.max(0, Math.round(numero(pesos.creditosBase) * numero(faixa.creditosFator)));
}

export function creditosDaNota(nota, pesos = CONTEUDO.nota) {
  return creditosDaFaixa(faixaDaNota(nota, pesos.faixas), pesos);
}

// Chamado por main.js quando a avaliacao termina, dos dois jeitos. Escreve em
// estado.run.resultado (objeto ja existente, criado em novaRun) e devolve a
// referencia — quem for desenhar le dali, nada aqui volta para a simulacao.
export function fecharAvaliacao(estado, motivo) {
  const av = estado.run.avaliacao;
  const player = estado.player;
  const r = estado.run.resultado;
  const aprovado = motivo === MOTIVO_TEMPO;

  r.id = av.id;
  r.nome = av.nome;
  r.periodo = av.periodo;
  r.motivo = motivo;
  r.aprovado = aprovado;
  r.kills = av.kills;
  r.danoTomado = av.danoTomado;
  r.nivel = player.nivel;
  r.hp = Math.max(0, player.hp);
  r.hpMax = player.hpMax;
  r.hpFracao = player.hpMax > 0 ? r.hp / player.hpMax : 0;
  r.duracao = av.duracao;
  r.tempo = Math.min(av.decorrido, av.duracao);
  // `ileso` sai de danoTomado, e nao de hp === hpMax, por causa do Lanche da
  // Cantina: quem levou uma paulada e curou depois nao terminou ileso. E e por
  // isso que o grampo de danoTomado (player.js limita o golpe fatal ao HP
  // restante) nao afeta a nota — ela le o campo como "tomou ou nao tomou", e a
  // magnitude do golpe que mata so existiria no caminho do jubilamento, onde
  // nao ha nota.
  r.ileso = aprovado && av.danoTomado <= 0;

  if (aprovado) {
    const p = parcelasDaNota({ kills: r.kills, hpRestante: r.hp, hpMax: r.hpMax, ileso: r.ileso }, r.parcelas);
    r.nota = Math.max(0, Math.min(CONTEUDO.nota.maxima, arredondarNota(p.kills + p.hp + p.ileso)));
    const faixa = faixaDaNota(r.nota);
    r.conceito = faixa.conceito;
    r.creditos = creditosDaFaixa(faixa);
  } else {
    // Jubilado nao tem nota: a run acabou, nao existe loja depois. A tela
    // mostra o que ele fez (mortos e tempo), nao quanto valeu.
    r.parcelas.kills = 0;
    r.parcelas.hp = 0;
    r.parcelas.ileso = 0;
    r.nota = 0;
    r.conceito = '';
    r.creditos = 0;
  }

  estado.run.nota = r.nota;
  estado.run.conceito = aprovado ? r.conceito : null;
  estado.run.jubilado = !aprovado;
  estado.run.creditos += r.creditos;
  r.creditosTotal = estado.run.creditos;

  // Fase 11: fanfarra de aprovacao e som grave de jubilacao saem daqui.
  emitir(estado, 'resultado', {
    aprovado,
    motivo,
    nota: r.nota,
    conceito: r.conceito,
    creditos: r.creditos,
  });
  return r;
}

// "Jogar" no menu comeca uma run NOVA: sem isto os creditos de uma partida
// jubilada vazariam para a seguinte. Fora do loop (clique de botao), entao
// alocar a run aqui nao fere a regra de pool. A fase 08 herda esta funcao.
export function iniciarRun(estado) {
  estado.run = novaRun();
  comecarAvaliacao(estado, 0, 0);
}

// Toda avaliacao de uma run comeca por aqui: o estado da avaliacao nasce
// (state.js) e os coringas agem sobre ele. E o UNICO chamador do hook
// aoIniciarAvaliacao — que tambem recalcula os atributos do jogador, entao
// uma avaliacao aberta por outro caminho roda sem os coringas.
export function comecarAvaliacao(estado, periodoIndex = 0, avaliacaoIndex = 0) {
  iniciarAvaliacao(estado, periodoIndex, avaliacaoIndex);
  aoIniciarAvaliacao(estado);
}

// A avaliacao que vem depois de (periodoIndex, avaliacaoIndex), ou null
// quando a run acabou. Pura.
export function proximaAvaliacao(periodoIndex, avaliacaoIndex, periodos = CONTEUDO.periodos) {
  const periodo = periodos[periodoIndex];
  if (periodo && avaliacaoIndex + 1 < periodo.avaliacoes.length) {
    return { periodoIndex, avaliacaoIndex: avaliacaoIndex + 1 };
  }
  if (periodoIndex + 1 < periodos.length) return { periodoIndex: periodoIndex + 1, avaliacaoIndex: 0 };
  return null;
}

// "Seguir" da loja. O MINIMO que a fase 07 precisava para a loja ter saida:
// a proxima avaliacao da lista, virando o periodo quando ele acaba, e o menu
// depois da ultima. A fase 08 e dona disto (anuncio de periodo, virada,
// TCC) e deve substituir esta funcao, nao remendar.
export function avancarRun(estado) {
  const prox = proximaAvaliacao(estado.run.periodoIndex, estado.run.avaliacaoIndex);
  if (!prox) {
    irParaTela(estado, TELAS.MENU);
    return false;
  }
  comecarAvaliacao(estado, prox.periodoIndex, prox.avaliacaoIndex);
  return true;
}
