import { CONTEUDO } from '../data/content.js';
import { emitir, irParaTela, TELAS } from './state.js';
import { curaDeLanche, dadosDoCoringa, hpDaRun, maximoDaRun, modificarAtributo, novaInstancia } from './jokers.js';
import { avancarRun } from './run.js';

// A loja entre avaliacoes (design §5). Simulacao pura, como cards.js: a UI
// (mouse ou teclado) chama as funcoes exportadas aqui e le estado.loja para
// desenhar. Nenhuma funcao daqui toca no DOM, e nenhuma e chamada de dentro
// do update: a loja e uma tela congelada, entao as acoes acontecem direto no
// clique/tecla, como sairDoResultado.
//
// O cursor e (linha, selecionada):
//   linha 0, a vitrine: 0..quantidade-1 sao os itens, `quantidade` e o lanche
//            da cantina, `quantidade + 1` o botao de rerolar e
//            `quantidade + 2` o de seguir;
//   linha 1, os coringas do jogador (para vender).
//
// Pos-entrega: a cantina. A loja SEMPRE tem um lanche (CONTEUDO.lanches.loja),
// sorteado na abertura e a cada rerrolagem, que cura o HP que a run perdeu
// (run.vida): a vida nao enche mais sozinha entre avaliacoes.
// Mouse e teclado escrevem no MESMO cursor (apontarLoja): destaque pintado
// direto na classe CSS seria desfeito pelo sincronizar do quadro seguinte, e
// o Enter compraria o item do cursor, nao o apontado (pendencia 26).

export const LINHA_VITRINE = 0;
export const LINHA_CORINGAS = 1;

// Chaves de CONTEUDO.textos.loja.avisos.
export const AVISOS = {
  SEM_CREDITOS: 'semCreditos',
  CHEIO: 'cheio',
  VENDIDO: 'vendido',
  SEM_NOVIDADE: 'semNovidade',
  HP_CHEIO: 'hpCheio',
};

// ------------------------------------------------------------------ numeros

// A faixa de conceito que manda na loja. Conceito desconhecido (ou nenhum)
// cai na ultima faixa, a mais baixa.
function faixaDoConceito(conceito, faixas) {
  for (const faixa of faixas) if (faixa.conceito === conceito) return faixa;
  return faixas[faixas.length - 1];
}

// Quantos itens a loja mostra depois deste conceito (design §5: 3, ou 4 com
// B ou A).
export function itensDaLoja(conceito, faixas = CONTEUDO.nota.faixas) {
  return faixaDoConceito(conceito, faixas).itensLoja;
}

// Quantos rerolls da visita saem de graca (design §4: 1 com A).
export function rerollsGratisDaLoja(conceito, faixas = CONTEUDO.nota.faixas) {
  return faixaDoConceito(conceito, faixas).rerollsGratis;
}

// O proximo reroll: 0 enquanto houver reroll gratis, depois base + incremento
// por reroll PAGO ja feito nesta visita. Os gratis nao encarecem o seguinte.
export function precoReroll(loja, cfg = CONTEUDO.loja) {
  if (loja.gratis > 0) return 0;
  return cfg.rerollBase + cfg.rerollIncremento * loja.rerolls;
}

// A venda devolve uma fracao do preco CHEIO (sem o desconto da Carteirinha):
// comprar com desconto e vender nao vira lucro, porque a fracao e menor que o
// desconto deixa sobrar.
export function valorDeVenda(id, cfg = CONTEUDO.loja) {
  const dados = dadosDoCoringa(id);
  return dados ? Math.floor(dados.preco * cfg.fracaoVenda) : 0;
}

// O preco de vitrine de um item ou lanche: o de content.js vezes o fator
// 'precoLoja' (base 1; a 🎟️ Carteirinha baixa). Inteiro, nunca menos de 1.
export function precoNaLoja(estado, base) {
  return Math.max(1, Math.round(base * modificarAtributo(estado, 'precoLoja', 1)));
}

export function dadosDoLanche(id, lista = CONTEUDO.lanches.loja) {
  for (let i = 0; i < lista.length; i += 1) if (lista[i].id === id) return lista[i];
  return null;
}

export function posicaoLanche(loja) {
  return loja.quantidade;
}

export function posicaoRerolar(loja) {
  return loja.quantidade + 1;
}

export function posicaoSeguir(loja) {
  return loja.quantidade + 2;
}

function tamanhoDaLinha(estado, linha) {
  return linha === LINHA_VITRINE ? estado.loja.quantidade + 3 : estado.run.coringas.length;
}

// ------------------------------------------------------------------ abrir

// Chamado por sairDoResultado (main.js) no caminho do aprovado.
export function abrirLoja(estado) {
  const loja = estado.loja;
  // Um coringa pode mudar quantos itens aparecem (jokers.js, 'itensLoja'); os
  // slots alocados em novaLoja() sao o teto.
  const itens = modificarAtributo(estado, 'itensLoja', itensDaLoja(estado.run.conceito));
  loja.quantidade = Math.max(0, Math.min(loja.itens.length, itens));
  loja.rerolls = 0;
  // O 🗳️ Amigo no C.A. soma aqui, ao que o conceito ja da.
  loja.gratis = Math.max(0, modificarAtributo(estado, 'rerollsGratis', rerollsGratisDaLoja(estado.run.conceito)));
  loja.linha = LINHA_VITRINE;
  loja.selecionada = 0;
  loja.aviso = '';
  loja.abertaEm = estado.tempo;
  sortearItens(estado);
  loja.lanche.compras = 0;
  sortearLanche(estado);
  irParaTela(estado, TELAS.LOJA);
  emitir(estado, 'loja-aberta', { quantidade: loja.quantidade, creditos: estado.run.creditos });
}

// Sorteio sem reposicao entre os coringas que o jogador pode comprar: nao
// tem, e nao e um "1x por run" ja gasto. Slot sem candidato fica vazio
// (id '') — com 6 coringas no MVP e 5 de teto, isso acontece de verdade.
function disponivel(estado, id) {
  return !possui(estado, id) && !estado.run.coringasGastos.includes(id);
}

function sortearItens(estado) {
  const loja = estado.loja;
  const candidatos = [];
  for (const dados of CONTEUDO.coringas) {
    if (disponivel(estado, dados.id)) candidatos.push(dados);
  }
  for (let i = 0; i < loja.itens.length; i += 1) {
    const item = loja.itens[i];
    item.vendido = false;
    if (i >= loja.quantidade || candidatos.length === 0) {
      item.id = '';
      item.preco = 0;
      continue;
    }
    const k = estado.rng.int(0, candidatos.length - 1);
    const dados = candidatos[k];
    candidatos[k] = candidatos[candidatos.length - 1];
    candidatos.length -= 1;
    item.id = dados.id;
    item.preco = precoNaLoja(estado, dados.preco);
  }
}

// A cantina: um lanche sorteado entre todos, sempre (o validador garante que
// a lista nao e vazia). Novo a cada abertura e a cada rerrolagem. As compras
// da visita (lanche.compras) NAO zeram no reroll, so na abertura: senao um
// reroll de ◉ 10 (ou gratis) sairia mais barato que o encarecimento.
function sortearLanche(estado) {
  const lista = CONTEUDO.lanches.loja;
  const dados = lista[estado.rng.int(0, lista.length - 1)];
  const lanche = estado.loja.lanche;
  lanche.id = dados.id;
  lanche.preco = precoDoLanche(estado, dados, lanche.compras);
}

// O preco da proxima compra: cada compra na mesma visita encarece o lanche em
// lanches.encarecePorCompra do preco de tabela, e o desconto vale por cima.
function precoDoLanche(estado, dados, compras) {
  return precoNaLoja(estado, dados.preco * (1 + CONTEUDO.lanches.encarecePorCompra * compras));
}

// Comprar ou vender a 🎟️ Carteirinha muda o preco do que ainda esta a venda.
function reprecificar(estado) {
  const loja = estado.loja;
  for (let i = 0; i < loja.quantidade; i += 1) {
    const item = loja.itens[i];
    const dados = item.id ? dadosDoCoringa(item.id) : null;
    if (dados && !item.vendido) item.preco = precoNaLoja(estado, dados.preco);
  }
  const lanche = dadosDoLanche(loja.lanche.id);
  if (lanche) loja.lanche.preco = precoDoLanche(estado, lanche, loja.lanche.compras);
}

// O HP que o jogador tem agora, na loja, e o maximo (com os itens da mochila).
// A UI pergunta todo quadro: passa o proprio objeto em `saida`.
export function vidaNaLoja(estado, saida = { hp: 0, hpMax: 0 }) {
  saida.hpMax = maximoDaRun(estado);
  saida.hp = hpDaRun(estado, saida.hpMax);
  return saida;
}

// Comprar ou vender um item de HP maximo (🥤 Garrafa d'Agua) mexe na vida de
// agora: o maximo que sobe chega cheio (o HP sobe junto), o que desce so corta
// o que passar do novo teto. Chamado com o maximo de ANTES da troca. A run
// que nunca perdeu nada (-1) continua cheia.
function acertarVida(estado, hpMaxAntes) {
  const run = estado.run;
  if (!(run.vida >= 0)) return;
  const hpMax = maximoDaRun(estado);
  run.vida = Math.min(hpMax, Math.max(0, run.vida) + Math.max(0, hpMax - hpMaxAntes));
}

// Quanto o lanche da cantina cura (com a 🍱 Lancheira), para a etiqueta.
export function curaDoLancheDaLoja(estado) {
  const dados = dadosDoLanche(estado.loja.lanche.id);
  return dados ? curaDeLanche(estado, dados.cura) : 0;
}

function possui(estado, id) {
  const lista = estado.run.coringas;
  for (let i = 0; i < lista.length; i += 1) if (lista[i].id === id) return true;
  return false;
}

function naVitrine(loja, id) {
  for (let i = 0; i < loja.quantidade; i += 1) {
    const item = loja.itens[i];
    if (item.id === id && !item.vendido) return true;
  }
  return false;
}

// Um reroll so vale se puder trazer alguma coisa que nao esta a venda agora.
// Com 6 coringas no MVP e 4 itens na vitrine, quem tem 2 ja ve tudo o que
// sobra: cobrar por um sorteio que so embaralha a ordem seria roubo.
export function rerolarTrazNovidade(estado) {
  const loja = estado.loja;
  for (const dados of CONTEUDO.coringas) {
    if (disponivel(estado, dados.id) && !naVitrine(loja, dados.id)) return true;
  }
  return false;
}

function recusar(estado, aviso) {
  estado.loja.aviso = aviso;
  emitir(estado, 'loja-recusa', aviso);
  return false;
}

// ------------------------------------------------------------------ acoes
// Todas devolvem false quando o pedido nao vale (fora da loja, indice ruim,
// sem credito). Recusa por regra do jogo deixa um aviso para a tela.

export function comprarItem(estado, indice) {
  if (estado.tela !== TELAS.LOJA) return false;
  const loja = estado.loja;
  if (!Number.isInteger(indice) || indice < 0 || indice >= loja.quantidade) return false;
  const item = loja.itens[indice];
  if (item.id === '') return false;
  if (item.vendido) return recusar(estado, AVISOS.VENDIDO);
  if (estado.run.coringas.length >= CONTEUDO.loja.teto) return recusar(estado, AVISOS.CHEIO);
  if (estado.run.creditos < item.preco) return recusar(estado, AVISOS.SEM_CREDITOS);

  const hpMaxAntes = maximoDaRun(estado);
  estado.run.creditos -= item.preco;
  estado.run.coringas.push(novaInstancia(item.id));
  item.vendido = true;
  loja.aviso = '';
  acertarVida(estado, hpMaxAntes);
  reprecificar(estado);
  emitir(estado, 'coringa-comprado', { id: item.id, preco: item.preco });
  return true;
}

// O lanche da cantina: cura o HP da run (run.vida), o mesmo que a loja
// mostra. Compra-se de novo enquanto houver o que curar, cada vez mais caro.
// Com a vida cheia a loja recusa — pagar por nada seria roubo, como o reroll
// sem novidade.
export function comprarLanche(estado) {
  if (estado.tela !== TELAS.LOJA) return false;
  const loja = estado.loja;
  const lanche = loja.lanche;
  const dados = dadosDoLanche(lanche.id);
  if (!dados) return false;
  const hpMax = maximoDaRun(estado);
  const antes = hpDaRun(estado, hpMax);
  if (antes >= hpMax) return recusar(estado, AVISOS.HP_CHEIO);
  if (estado.run.creditos < lanche.preco) return recusar(estado, AVISOS.SEM_CREDITOS);

  const preco = lanche.preco;
  estado.run.creditos -= preco;
  estado.run.vida = Math.min(hpMax, antes + curaDeLanche(estado, dados.cura));
  lanche.compras += 1;
  lanche.preco = precoDoLanche(estado, dados, lanche.compras);
  loja.aviso = '';
  emitir(estado, 'lanche-comprado', { id: lanche.id, preco, cura: estado.run.vida - antes });
  return true;
}

export function venderCoringa(estado, indice) {
  if (estado.tela !== TELAS.LOJA) return false;
  const lista = estado.run.coringas;
  if (!Number.isInteger(indice) || indice < 0 || indice >= lista.length) return false;
  const inst = lista[indice];
  const valor = valorDeVenda(inst.id);
  const hpMaxAntes = maximoDaRun(estado);
  lista.splice(indice, 1);
  estado.run.creditos += valor;
  const loja = estado.loja;
  loja.aviso = '';
  acertarVida(estado, hpMaxAntes);
  reprecificar(estado);
  // O cursor nao pode ficar apontando para um slot que deixou de existir.
  if (loja.linha === LINHA_CORINGAS) {
    if (lista.length === 0) {
      loja.linha = LINHA_VITRINE;
      loja.selecionada = 0;
    } else if (loja.selecionada >= lista.length) {
      loja.selecionada = lista.length - 1;
    }
  }
  emitir(estado, 'coringa-vendido', { id: inst.id, valor });
  return true;
}

export function rerolar(estado) {
  if (estado.tela !== TELAS.LOJA) return false;
  const loja = estado.loja;
  if (!rerolarTrazNovidade(estado)) return recusar(estado, AVISOS.SEM_NOVIDADE);
  const preco = precoReroll(loja);
  if (estado.run.creditos < preco) return recusar(estado, AVISOS.SEM_CREDITOS);
  estado.run.creditos -= preco;
  if (loja.gratis > 0) loja.gratis -= 1;
  else loja.rerolls += 1;
  loja.aviso = '';
  sortearItens(estado);
  sortearLanche(estado);
  emitir(estado, 'loja-reroll', { preco });
  return true;
}

export function seguirDaLoja(estado) {
  if (estado.tela !== TELAS.LOJA) return false;
  estado.loja.aviso = '';
  avancarRun(estado);
  return true;
}

// ----------------------------------------------------------------- cursor

// Mouse (mouseenter), foco (Tab) e teclado passam por aqui.
export function apontarLoja(estado, linha, indice) {
  if (estado.tela !== TELAS.LOJA) return false;
  if (linha !== LINHA_VITRINE && linha !== LINHA_CORINGAS) return false;
  if (!Number.isInteger(indice) || indice < 0 || indice >= tamanhoDaLinha(estado, linha)) return false;
  estado.loja.linha = linha;
  estado.loja.selecionada = indice;
  return true;
}

export function moverSelecaoLoja(estado, passo) {
  if (estado.tela !== TELAS.LOJA) return false;
  const loja = estado.loja;
  const total = tamanhoDaLinha(estado, loja.linha);
  if (total === 0) return false;
  loja.selecionada = (((loja.selecionada + passo) % total) + total) % total;
  loja.aviso = '';
  return true;
}

// Cima/baixo: troca entre a vitrine e os coringas do jogador. Sem coringa
// nenhum, a linha de baixo nao existe e o cursor fica onde esta.
export function trocarLinhaLoja(estado) {
  if (estado.tela !== TELAS.LOJA) return false;
  const loja = estado.loja;
  const destino = loja.linha === LINHA_VITRINE ? LINHA_CORINGAS : LINHA_VITRINE;
  const total = tamanhoDaLinha(estado, destino);
  if (total === 0) return false;
  loja.linha = destino;
  loja.selecionada = Math.min(loja.selecionada, total - 1);
  loja.aviso = '';
  return true;
}

// Enter: faz o que o cursor aponta.
export function confirmarLoja(estado) {
  if (estado.tela !== TELAS.LOJA) return false;
  const loja = estado.loja;
  if (loja.linha === LINHA_CORINGAS) return venderCoringa(estado, loja.selecionada);
  if (loja.selecionada === posicaoLanche(loja)) return comprarLanche(estado);
  if (loja.selecionada === posicaoRerolar(loja)) return rerolar(estado);
  if (loja.selecionada === posicaoSeguir(loja)) return seguirDaLoja(estado);
  return comprarItem(estado, loja.selecionada);
}

// As acoes que gastam ou saem (comprar, vender, rerolar, seguir), por teclado
// OU mouse, esperam loja.atrasoEntrada depois da abertura: quem apertou Enter
// duas vezes, ou deu clique duplo no "Continuar" do boletim, nao gasta
// credito sem ter visto a vitrine. Apontar (mover o cursor) nao espera.
// main.js e quem consulta, antes de chamar a acao; as acoes em si nao, para o
// smoke poder exercita-las sem simular o relogio. estado.tempo anda em
// qualquer tela.
export function entradaLiberada(estado) {
  return estado.tela === TELAS.LOJA && estado.tempo - estado.loja.abertaEm >= CONTEUDO.loja.atrasoEntrada;
}
