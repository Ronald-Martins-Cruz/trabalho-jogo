// npm run smoke — roda a partida headless com semente fixa e falha se o jogo
// quebrar. Nenhum navegador envolvido: a simulacao e feita so de objetos.
//
// Como estender quando sua fase acrescentar sistema novo:
//   1. adicione uma entrada em VERIFICACOES com { nome, rodar(estado, tick) }
//      devolvendo uma string de erro ou null;
//   2. se sua fase criar uma pool nova, registre o teto em
//      CONTEUDO.arena.limites — a verificacao de pool le de la sozinha;
//   3. some seus contadores em resumo() para eles aparecerem na linha final.

import { CONTEUDO } from '../data/content.js';
import { novoEstado, iniciarAvaliacao, irParaTela, TELAS } from '../src/state.js';
import { alternarPausa, atualizar, avancarRelogio, criarRelogio, sairDoResultado } from '../src/main.js';
import {
  avancarRun,
  calcularNota,
  comecarAvaliacao,
  creditosDaFaixa,
  faixaDaNota,
  iniciarRun,
  MOTIVO_JUBILADO,
  MOTIVO_TEMPO,
  proximaAvaliacao,
} from '../src/run.js';
import {
  aoCalcularDano,
  ATRIBUTOS,
  HOOKS,
  novaInstancia,
  verificarCoringasDoConteudo,
} from '../src/jokers.js';
import {
  abrirLoja,
  apontarLoja,
  AVISOS,
  comprarItem,
  confirmarLoja,
  itensDaLoja,
  LINHA_CORINGAS,
  LINHA_VITRINE,
  moverSelecaoLoja,
  posicaoRerolar,
  posicaoSeguir,
  precoReroll,
  rerolar,
  rerolarTrazNovidade,
  rerollsGratisDaLoja,
  seguirDaLoja,
  entradaLiberada,
  trocarLinhaLoja,
  valorDeVenda,
  venderCoringa,
} from '../src/shop.js';
// ui.js nao toca no DOM no topo do modulo (criarUi recebe o `document`), entao
// os formatadores puros da tela de resultado podem ser testados aqui — e a
// primeira cobertura automatica que ui.js tem.
import { armasDoBoletim, decomposicaoDaNota, formatarNota, resumoDoJubilado, rotuloDoReroll } from '../src/ui.js';
import { aplicarDano, spawnInimigo, poolInimigos, limparInimigos } from '../src/enemies.js';
import {
  atualizarArmas,
  dadosDaArma,
  equiparArma,
  nivelDaArma,
  poolProjeteis,
  posicaoSatelite,
  subirNivelArma,
  verificarArmasDoConteudo,
} from '../src/weapons.js';
import { apontarCarta, escolherCarta, moverSelecaoCarta, verificarCartasDoConteudo } from '../src/cards.js';
import { atualizarOrbes, atualizarPlayer, poolOrbes, receberDano, soltarOrbeXp, xpParaSubir } from '../src/player.js';
import { criarPool } from '../src/pool.js';
import { FONTE_DESCONHECIDA, registrarQuadro, SITUACAO } from '../src/telemetria.js';
import { analisarAvaliacao, ESCOPOS, gerarRelatorio } from '../src/relatorio.js';

const SEMENTE = 20261110;
const TICKS = 3600; // 60s simulados a 1/60
const PASSO = CONTEUDO.loop.passo;
const INTERVALO_VARREDURA = 60; // varredura profunda de NaN/Infinity a cada 1s
const VOLTA_TICKS = 600; // bot: ticks para uma volta completa (10s a 60 ticks/s)
const TICKS_AQUECIMENTO = 600; // 10s: depois disso nenhuma alocacao nova e aceita
const MINIMO_INIMIGOS = 20; // pico abaixo disso significa spawn quebrado
const TICKS_ARMA = 1800; // 30s da corrida do bot parado (checarArmaSozinha)
const MINIMO_MORTOS_ARMA = 20; // abaixo disso a arma nao esta matando de verdade

// Progressao. O alvo do design §3 e nivel 5-6 em 60s; a faixa aceita e mais
// larga que o alvo de proposito — ela existe para pegar o sistema QUEBRADO
// (orbe que ninguem coleta trava no nivel 1; curva zerada dispara para 20),
// nao para congelar o balanceamento, que e da fase 13.
const TICKS_PROGRESSAO = 3600; // 60s: a janela de que o design fala
const NIVEL_MINIMO_60S = 4;
const NIVEL_MAXIMO_60S = 9;
const TICKS_CONGELADO = 30; // ticks com a carta aberta sem ninguem escolher

// Fim de avaliacao. A corrida dedicada roda uma avaliacao inteira sem segurar
// o HP do jogador — e a unica que produz uma nota honesta para imprimir.
const TICKS_AVALIACAO_COMPLETA = TICKS + 240;
const TEMPO_FORA = 30; // segundos de aba escondida/pausa longa no teste do relogio
const DANO_DO_CENARIO = 30; // arranhao no cenario de resultado: hp != hpMax e ileso = false
const CREDITOS_ANTERIORES = 7; // creditos ja na run antes do boletim: soma tem que somar
const KILLS_DO_CENARIO = 120; // mortos plantados no boletim do cenario de resultado
const EPSILON = 1e-9;

// As duas telas em que uma avaliacao termina. Antes desta fase as duas eram o
// menu, e todo o smoke procurava por TELAS.MENU.
function telaDeFim(estado) {
  return estado.tela === TELAS.RESULTADO || estado.tela === TELAS.JUBILADO;
}

// Para onde sairDoResultado leva: a loja (aprovado) ou o menu (jubilado).
// Antes da fase 07 as duas saidas eram o menu.
function foraDaAvaliacao(estado) {
  return estado.tela === TELAS.MENU || estado.tela === TELAS.LOJA;
}

// Teste de carga: `npm run smoke -- --carga` enche a arena ate o teto da pool
// e mantem o jogador de pe, para medir o custo de IA + separacao + colisao no
// pior caso. Fora desse modo a corrida e a de sempre.
const CARGA = process.argv.includes('--carga');
const ALVO_CARGA = CONTEUDO.arena.limites.enemies;
if (CARGA) CONTEUDO.spawn.maxSimultaneos = ALVO_CARGA;

const POOLS = Object.keys(CONTEUDO.arena.limites).filter((p) => p !== 'eventos');

const picos = {};
for (const pool of POOLS) picos[pool] = 0;
const contadores = { avaliacoesConcluidas: 0, eventos: 0, cartas: 0, porTipo: {}, notas: [], conceitos: [] };

// Pools: alocacao so na abertura. `criados` e o numero de vezes que a fabrica
// rodou — se crescer depois do aquecimento, alguem esta alocando dentro do
// update, que e a restricao 5 do CLAUDE.md e a causa n1 de travamento.
const criadosNoAquecimento = {};
let danoTotal = 0;
let danoAnterior = 0;

// Rastreio de movimento do jogador: a asserção de arena so prova que ele nao
// SAI dos limites, o que passa igual se ele nunca sair do lugar. Isto pega o
// caso em que atualizarPlayer() para de ser chamado (ex.: alguem reorganiza
// atualizarAvaliacao() numa fase futura e perde a linha no meio do caminho).
let distanciaPercorrida = 0;
let posAnteriorX = null;
let posAnteriorY = null;
let minX = Infinity;
let maxX = -Infinity;
let minY = Infinity;
let maxY = -Infinity;

// avaliacao.danoTomado zera a cada avaliacao nova; acumular so as diferencas
// positivas da o total da corrida inteira, atravessando os reinicios.
function registrarDano(estado) {
  const atual = estado.run.avaliacao.danoTomado;
  if (atual > danoAnterior) danoTotal += atual - danoAnterior;
  danoAnterior = atual;
}

function registrarMovimento(estado) {
  const p = estado.player;
  if (posAnteriorX !== null) {
    distanciaPercorrida += Math.hypot(p.x - posAnteriorX, p.y - posAnteriorY);
  }
  posAnteriorX = p.x;
  posAnteriorY = p.y;
  if (p.x < minX) minX = p.x;
  if (p.x > maxX) maxX = p.x;
  if (p.y < minY) minY = p.y;
  if (p.y > maxY) maxY = p.y;
}

const VERIFICACOES = [
  {
    nome: 'escalares finitos',
    rodar(estado) {
      const av = estado.run.avaliacao;
      const suspeitos = [
        ['tempo', estado.tempo],
        ['player.x', estado.player.x],
        ['player.y', estado.player.y],
        ['player.hp', estado.player.hp],
        ['player.xp', estado.player.xp],
        ['avaliacao.restante', av.restante],
        ['avaliacao.decorrido', av.decorrido],
      ];
      for (const [nome, valor] of suspeitos) {
        if (!Number.isFinite(valor)) return `${nome} virou ${valor}`;
      }
      return null;
    },
  },
  {
    nome: 'pools dentro do teto',
    rodar(estado) {
      for (const pool of POOLS) {
        const tamanho = estado[pool].length;
        if (tamanho > picos[pool]) picos[pool] = tamanho;
        if (tamanho > CONTEUDO.arena.limites[pool]) {
          return `pool ${pool} com ${tamanho} itens, teto e ${CONTEUDO.arena.limites[pool]}`;
        }
      }
      if (estado.eventos.length > CONTEUDO.arena.limites.eventos) {
        return `fila de eventos com ${estado.eventos.length}, teto e ${CONTEUDO.arena.limites.eventos}`;
      }
      return null;
    },
  },
  {
    nome: 'tela valida',
    rodar(estado) {
      const validas = Object.values(TELAS);
      return validas.includes(estado.tela) ? null : `tela desconhecida "${estado.tela}"`;
    },
  },
  {
    nome: 'varredura profunda',
    rodar(estado, tick) {
      if (tick % INTERVALO_VARREDURA !== 0) return null;
      return procurarNumeroInvalido(estado, 'estado', new Set(), 0);
    },
  },
  {
    nome: 'inimigos sadios',
    rodar(estado) {
      const inimigos = estado.enemies;
      for (let i = 0; i < inimigos.length; i += 1) {
        const e = inimigos[i];
        if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) {
          return `inimigo ${i} (${e.tipo}) em posicao invalida (${e.x}, ${e.y})`;
        }
        if (!Number.isFinite(e.vx) || !Number.isFinite(e.vy)) {
          return `inimigo ${i} (${e.tipo}) com velocidade invalida (${e.vx}, ${e.vy})`;
        }
        if (!Number.isFinite(e.hp) || e.raio <= 0) {
          return `inimigo ${i} (${e.tipo}) com hp=${e.hp} raio=${e.raio}`;
        }
      }
      return null;
    },
  },
  {
    nome: 'projeteis sadios',
    rodar(estado) {
      const projeteis = estado.projectiles;
      for (let i = 0; i < projeteis.length; i += 1) {
        const p = projeteis[i];
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
          return `projetil ${i} (${p.arma}) em posicao invalida (${p.x}, ${p.y})`;
        }
        if (!Number.isFinite(p.vx) || !Number.isFinite(p.vy)) {
          return `projetil ${i} (${p.arma}) com velocidade invalida (${p.vx}, ${p.vy})`;
        }
        if (!Number.isFinite(p.vida) || p.raio <= 0 || !Number.isFinite(p.dano)) {
          return `projetil ${i} (${p.arma}) com vida=${p.vida} raio=${p.raio} dano=${p.dano}`;
        }
        // Projetil parado e projetil que nunca sai da frente do jogador: ou a
        // mira devolveu (0,0) ou a velocidade do nivel nao chegou ate aqui.
        if (p.vx === 0 && p.vy === 0) return `projetil ${i} (${p.arma}) parado no lugar`;
      }
      return null;
    },
  },
  {
    nome: 'pools sem alocar no loop',
    rodar(estado, tick) {
      const pools = estado.scratch && estado.scratch.pools;
      if (!pools) return null;
      for (const [chave, pool] of Object.entries(pools)) {
        if (tick <= TICKS_AQUECIMENTO) {
          criadosNoAquecimento[chave] = pool.criados;
        } else if (pool.criados > criadosNoAquecimento[chave]) {
          return (
            `pool ${chave} fabricou ${pool.criados - criadosNoAquecimento[chave]} objetos depois do ` +
            `aquecimento (${criadosNoAquecimento[chave]} -> ${pool.criados}) — alguem esta alocando dentro do update`
          );
        }
        if (tick % INTERVALO_VARREDURA === 0) {
          const problema = pool.verificar();
          if (problema) return `pool ${chave} inconsistente: ${problema}`;
        }
      }
      return null;
    },
  },
  {
    // Nao depende de semente, de balanceamento nem de o jogador morrer nesta
    // corrida: so proibe o estado impossivel. Continua valendo na fase 03,
    // quando as armas fizerem o jogador parar de morrer.
    nome: 'morte encerra a avaliacao',
    rodar(estado) {
      if (!estado.player.vivo && estado.tela === TELAS.AVALIACAO) {
        return 'jogador morto e a avaliacao continua: ninguem observa player.vivo';
      }
      return null;
    },
  },
  {
    nome: 'jogador dentro da arena',
    rodar(estado) {
      const { largura, altura } = CONTEUDO.arena;
      const p = estado.player;
      const r = p.raio;
      const FOLGA = 0.5; // acumulo de ponto flutuante no clamp da borda
      if (p.x < r - FOLGA || p.x > largura - r + FOLGA || p.y < r - FOLGA || p.y > altura - r + FOLGA) {
        return `jogador saiu da arena: (${p.x.toFixed(2)}, ${p.y.toFixed(2)}), raio=${r}, arena=${largura}x${altura}`;
      }
      return null;
    },
  },
];

// Bot minimo que move o jogador em circulo, escrevendo em estado.input como o
// teclado faria (eixoX/eixoY em [-1, 1]). player.js nunca le teclado direto —
// e exatamente essa porta que permite este bot substituir o navegador.
function botCircular(estado, tick) {
  const angulo = (tick / VOLTA_TICKS) * 2 * Math.PI;
  estado.input.eixoX = Math.cos(angulo);
  estado.input.eixoY = Math.sin(angulo);
}

// No modo carga a arena fica cheia ate o teto da pool e o jogador nao morre —
// o que se quer medir e o custo por quadro de IA, separacao e colisao com a
// pool inteira viva, nao a sobrevivencia dele.
function manterCarga(estado) {
  if (!CARGA || estado.tela !== TELAS.AVALIACAO) return;
  estado.player.hp = estado.player.hpMax; // toma dano (e conta), mas nao cai
  while (estado.enemies.length < ALVO_CARGA && spawnInimigo(estado)) {
    /* enche ate o teto */
  }
}

function procurarNumeroInvalido(valor, caminho, vistos, profundidade) {
  if (profundidade > 8) return null;
  if (typeof valor === 'number') {
    return Number.isFinite(valor) ? null : `${caminho} = ${valor}`;
  }
  if (typeof valor !== 'object' || valor === null) return null;
  if (vistos.has(valor)) return null;
  vistos.add(valor);
  if (Array.isArray(valor)) {
    for (let i = 0; i < valor.length; i += 1) {
      const achado = procurarNumeroInvalido(valor[i], `${caminho}[${i}]`, vistos, profundidade + 1);
      if (achado) return achado;
    }
    return null;
  }
  for (const [chave, item] of Object.entries(valor)) {
    if (typeof item === 'function') continue;
    const achado = procurarNumeroInvalido(item, `${caminho}.${chave}`, vistos, profundidade + 1);
    if (achado) return achado;
  }
  return null;
}

function falhar(tick, mensagem) {
  console.error(`\nsmoke FALHOU no tick ${tick} (t=${(tick * PASSO).toFixed(2)}s):`);
  console.error(`  x ${mensagem}\n`);
  process.exit(1);
}

// A partida nunca enche a pool ate o teto (spawn.maxSimultaneos para antes),
// entao o caminho de "pool cheia: recicle o mais antigo" ficaria sem cobertura
// nenhuma — e e justamente ele que decide se o jogo aloca ou trava quando a
// arena lota. Pool de brinquedo, tres objetos, antes da corrida.
function checarReciclagemDaPool() {
  const pool = criarPool(3, () => ({ marca: 0 }));
  const primeiro = pool.obter();
  primeiro.marca = 1;
  pool.obter().marca = 2;
  pool.obter().marca = 3;
  const quarto = pool.obter(); // pool cheia: precisa reaproveitar o de marca 1

  if (pool.ativos.length !== 3) falhar(0, `pool cheia cresceu para ${pool.ativos.length} ativos (teto 3)`);
  if (pool.criados !== 3) falhar(0, `pool cheia fabricou objeto novo (criados=${pool.criados})`);
  if (quarto !== primeiro) falhar(0, 'pool cheia nao reciclou o objeto mais antigo');
  if (pool.reciclados !== 1) falhar(0, `esperava 1 reciclagem, veio ${pool.reciclados}`);
  const problema = pool.verificar();
  if (problema) falhar(0, `pool de brinquedo inconsistente: ${problema}`);

  pool.liberarTodos();
  if (pool.ativos.length !== 0 || pool.reserva.length !== 3) {
    falhar(0, `liberarTodos deixou ativos=${pool.ativos.length} reserva=${pool.reserva.length}`);
  }
}

// Arma e dado: a entrada de content.js so vira tiro se `comportamento` apontar
// para uma funcao registrada em weapons.js. Sem esta checagem, uma arma nova
// (fase 05) so explodiria no instante do primeiro disparo, dentro do update.
function checarArmasDoConteudo() {
  const problema = verificarArmasDoConteudo();
  if (problema) falhar(0, problema);
}

// Os numeros de cada nivel precisam sair de content.js e o nivel precisa ficar
// grampeado na faixa: nivel fora do array viraria `undefined` dentro do update
// e o projetil sairia com NaN em tudo.
function checarNiveisDaArma() {
  const estado = novoEstado(SEMENTE + 2);
  const id = CONTEUDO.arma.inicial;
  const dados = dadosDaArma(id);
  const arma = equiparArma(estado, id);

  if (!arma) falhar(0, `equiparArma("${id}") devolveu null: a arma inicial nao existe em content.js`);
  if (arma.nivel !== 1 || arma.cooldown !== 0) {
    falhar(0, `arma equipada veio com nivel=${arma.nivel} cooldown=${arma.cooldown}, esperava 1 e 0`);
  }
  if (estado.player.armas.length !== 1) falhar(0, 'equiparArma nao pos a instancia em player.armas');
  if (equiparArma(estado, id) !== arma) falhar(0, 'equiparArma duplicou uma arma que o jogador ja tinha');
  if (nivelDaArma(arma) !== dados.niveis[0]) falhar(0, 'nivel 1 nao esta lendo niveis[0] de content.js');

  let subidas = 0;
  while (subirNivelArma(estado, id)) {
    subidas += 1;
    if (subidas > 50) falhar(0, 'subirNivelArma nunca devolve false: o nivel maximo nao segura');
  }
  if (arma.nivel !== dados.niveis.length) {
    falhar(0, `arma parou no nivel ${arma.nivel}, content.js tem ${dados.niveis.length} niveis`);
  }
  if (nivelDaArma(arma) !== dados.niveis[dados.niveis.length - 1]) {
    falhar(0, 'nivel maximo nao esta lendo o ultimo objeto de niveis');
  }

  arma.nivel = dados.niveis.length + 99; // nivel impossivel, vindo de um bug futuro
  if (nivelDaArma(arma) !== dados.niveis[dados.niveis.length - 1]) {
    falhar(0, 'nivel fora da faixa nao foi grampeado: o update leria undefined');
  }
}

// Bot PARADO no centro, spawn ligado: e a corrida que prova que a arma mata
// sozinha. Na corrida principal o bot anda em circulo e foge, o que embaralha
// "a arma funciona" com "o jogador escapou".
//
// Teto de projeteis vivos calculado a partir dos proprios dados da arma
// (quantos cabem dentro de um tempo de voo): se algum projetil deixar de voltar
// a pool, o pico estoura este teto em poucos segundos. Sai de content.js de
// proposito — a fase 05 muda os numeros e a assercao se ajusta sozinha.
function tetoDeProjeteisVivos(nivel) {
  const voo = Math.min(CONTEUDO.projetil.vidaMaxima, nivel.alcance / nivel.velocidade);
  return (Math.ceil(voo / nivel.cadencia) + 1) * nivel.projeteis;
}

function checarArmaSozinha() {
  const estado = novoEstado(SEMENTE + 1);
  iniciarAvaliacao(estado);

  let pico = 0;
  let mortos = 0;
  let disparos = 0;
  let acertos = 0;

  for (let tick = 1; tick <= TICKS_ARMA; tick += 1) {
    estado.input.eixoX = 0;
    estado.input.eixoY = 0;
    // O que se mede aqui e a arma, nao a sobrevivencia: o jogador toma dano
    // mas nao cai, senao a corrida terminaria no meio.
    estado.player.hp = estado.player.hpMax;
    try {
      atualizar(estado, PASSO);
    } catch (e) {
      falhar(tick, `excecao com o bot parado: ${e && e.stack ? e.stack : e}`);
    }
    // Parado no centro ele coleta muito XP e sobe de nivel rapido: sem
    // escolher a carta, esta corrida congelaria e mediria a arma por 3s.
    escolherCarta(estado, 0);

    if (estado.projectiles.length > pico) pico = estado.projectiles.length;
    // Filtrado pela arma inicial (Café): com 4 armas em content.js o bot
    // parado tambem sobe de nivel rapido e pode pegar outra arma na carta
    // (sempre aceita a opcao 0). 'arma-disparo'/'arma-acerto' carregam o id de
    // quem disparou/acertou — sem o filtro, um pulso do Resumo (que tambem
    // emite 'arma-disparo') infla `disparos` sem nascer projetil nenhum na
    // pool, e a conta contra pool.nascimentos abaixo quebra por um motivo que
    // nao tem nada a ver com o Café.
    for (const evento of estado.eventos) {
      if (evento.tipo === 'arma-disparo' && evento.dados.arma === CONTEUDO.arma.inicial) disparos += 1;
      if (evento.tipo === 'arma-acerto' && evento.dados.arma === CONTEUDO.arma.inicial) {
        acertos += 1;
        if (evento.dados.matou) mortos += 1;
      }
    }
    estado.eventos.length = 0;
  }

  const pool = poolProjeteis(estado);

  if (estado.player.armas.length === 0) {
    falhar(TICKS_ARMA, 'o jogador terminou a avaliacao sem arma nenhuma: atualizarArmas() roda no update?');
  }
  if (disparos === 0) falhar(TICKS_ARMA, 'a arma nao disparou nenhuma vez com o bot parado no centro');
  const teto = tetoDeProjeteisVivos(nivelDaArma(estado.player.armas[0]));

  if (acertos === 0) falhar(TICKS_ARMA, `${disparos} disparos e nenhum acerto: a colisao do projetil roda?`);
  if (mortos < MINIMO_MORTOS_ARMA) {
    falhar(TICKS_ARMA, `a arma matou ${mortos} inimigos em ${TICKS_ARMA} ticks (minimo ${MINIMO_MORTOS_ARMA})`);
  }
  if (pico > teto) {
    falhar(TICKS_ARMA, `pico de ${pico} projeteis vivos, teto calculado e ${teto}: algum projetil nao volta a pool`);
  }
  if (pool.nascimentos < disparos) {
    falhar(TICKS_ARMA, `${disparos} disparos mas so ${pool.nascimentos} projeteis nasceram da pool`);
  }
  if (pool.criados !== pool.capacidade) {
    falhar(TICKS_ARMA, `pool de projeteis fabricou ${pool.criados} objetos para capacidade ${pool.capacidade}`);
  }
  const problema = pool.verificar();
  if (problema) falhar(TICKS_ARMA, `pool de projeteis inconsistente: ${problema}`);

  // Drenagem: sem inimigo nenhum a arma nao tem alvo, entao so os projeteis em
  // voo continuam andando. Depois do tempo maximo de voo a pool tem que estar
  // vazia — se sobrar um, ele e imortal. Aqui se chama atualizarArmas direto,
  // sem atualizar(), justamente para que ninguem nasca durante a drenagem.
  limparInimigos(estado);
  const ticksDrenagem = Math.ceil(CONTEUDO.projetil.vidaMaxima / PASSO) + 60;
  for (let i = 0; i < ticksDrenagem; i += 1) atualizarArmas(estado, PASSO);
  if (estado.projectiles.length !== 0) {
    falhar(
      TICKS_ARMA + ticksDrenagem,
      `${estado.projectiles.length} projeteis continuam vivos ${ticksDrenagem} ticks depois do ultimo alvo`
    );
  }

  return { pico, mortos, disparos, acertos, teto };
}

// A armadilha desta fase. Um inimigo morto volta para a reserva da pool e o
// proximo spawn pode reaproveitar O MESMO objeto — outra vida no mesmo slot.
// Um projetil perfurante lembra quem ja atingiu para nao bater duas vezes no
// mesmo inimigo; se essa lembranca guardar so a referencia, o inimigo novo
// herda a imunidade do morto e fica intocavel para aquele projetil. O par
// (ref, nasc) e o que separa as duas vidas.
//
// O cenario e montado a mao porque so acontece na ordem exata: alvo morre,
// pool recicla o objeto, o mesmo projetil (ainda com perfuracao) alcanca o
// inimigo novo.
const DIST_ALVO = 60; // px do jogador ate o primeiro alvo
const DIST_RECICLADO = 200; // px do jogador ate o inimigo que reusa o objeto

function checarGuardaDeGeracao() {
  const estado = novoEstado(SEMENTE + 3);
  iniciarAvaliacao(estado);
  limparInimigos(estado);

  const player = estado.player;
  player.x = CONTEUDO.arena.largura / 2;
  player.y = CONTEUDO.arena.altura / 2;

  const arma = equiparArma(estado, CONTEUDO.arma.inicial);
  const dados = dadosDaArma(arma.id);
  // Precisa de um nivel de UM projetil so (senao o vizinho do leque acerta o
  // reciclado e o teste passa sem provar nada) e com perfuracao (senao o
  // projetil morre no primeiro alvo e nunca chega ao segundo).
  const indice = dados.niveis.findIndex((n) => n.projeteis === 1 && n.perfuracao >= 1);
  if (indice < 0) {
    falhar(0, 'nenhum nivel da arma inicial tem 1 projetil com perfuracao: aponte este teste para outra arma');
  }
  arma.nivel = indice + 1;
  const nivel = nivelDaArma(arma);
  if (nivel.alcance < DIST_RECICLADO + 40) {
    falhar(0, `alcance ${nivel.alcance} curto demais para o cenario (precisa de ${DIST_RECICLADO + 40})`);
  }

  const alvo = spawnInimigo(estado);
  if (!alvo) falhar(0, 'spawnInimigo devolveu null montando o cenario da guarda de geracao');
  alvo.x = player.x + DIST_ALVO;
  alvo.y = player.y;

  // So a primeira salva interessa: uma segunda acertaria o inimigo reciclado
  // sem memoria nenhuma e esconderia o bug.
  const passo = () => {
    atualizarArmas(estado, PASSO);
    arma.cooldown = 999;
  };

  let passos = 0;
  while (alvo.ativo && passos < 120) {
    passo();
    passos += 1;
  }
  if (alvo.ativo) falhar(0, `o projetil nao matou o alvo a ${DIST_ALVO}px em 120 ticks`);

  const reciclado = spawnInimigo(estado);
  if (reciclado !== alvo) {
    falhar(0, 'a pool nao reaproveitou o objeto do inimigo morto: este teste depende disso para ter sentido');
  }
  reciclado.x = player.x + DIST_RECICLADO;
  reciclado.y = player.y;
  const hpAntes = reciclado.hp;

  passos = 0;
  while (reciclado.ativo && reciclado.hp === hpAntes && passos < 120) {
    passo();
    passos += 1;
  }
  if (reciclado.ativo && reciclado.hp === hpAntes) {
    falhar(
      0,
      'o inimigo que reusou o objeto do morto nao levou dano nenhum: a memoria do projetil ' +
        'esta comparando so a referencia, sem o `nasc` — guarda de geracao quebrada'
    );
  }
}

// A outra metade da memoria de perfuracao. `checarGuardaDeGeracao()` prova que
// o `nasc` separa duas vidas no mesmo objeto, mas passa igual com a memoria
// inteira desligada — um projetil sem memoria nenhuma tambem acerta o inimigo
// reciclado. Aqui se prova que a memoria EXISTE, nas duas pontas:
//
//   1a salva  um projetil perfurante fica ~5 quadros dentro do raio de colisao
//             de um alvo parado. Sem `jaAtingiu`, ele rebate no mesmo inimigo a
//             cada quadro ate gastar a perfuracao: 2 acertos em vez de 1.
//   2a salva  o mesmo objeto da pool e reaproveitado. Sem `esquecerAtingidos`,
//             ele ainda lembra do alvo da salva anterior — que continua vivo,
//             com o mesmo `nasc` — e atravessa sem dano: 0 acertos em vez de 1.
//
// O alvo e imortal de proposito: o que se conta aqui e acerto, nao morte.
const DIST_IMORTAL = 120; // px do jogador ate o alvo parado
const HP_IMORTAL = 1e6; // hp alto o bastante para o alvo nunca sair da arena
const TICKS_SALVA = 240; // teto de ticks que uma salva tem para ir e voltar

function salvaUnica(estado, arma) {
  arma.cooldown = 0;
  let acertos = 0;
  let objeto = null;
  let passos = 0;
  do {
    atualizarArmas(estado, PASSO);
    arma.cooldown = 999; // trava a arma: uma salva por vez, sem reforco
    if (!objeto && estado.projectiles.length > 0) objeto = estado.projectiles[0];
    for (const evento of estado.eventos) if (evento.tipo === 'arma-acerto') acertos += 1;
    estado.eventos.length = 0;
    passos += 1;
  } while (estado.projectiles.length > 0 && passos < TICKS_SALVA);
  return { acertos, objeto };
}

function checarMemoriaDePerfuracao() {
  const estado = novoEstado(SEMENTE + 4);
  iniciarAvaliacao(estado);
  limparInimigos(estado);

  const player = estado.player;
  player.x = CONTEUDO.arena.largura / 2;
  player.y = CONTEUDO.arena.altura / 2;

  const arma = equiparArma(estado, CONTEUDO.arma.inicial);
  const dados = dadosDaArma(arma.id);
  const indice = dados.niveis.findIndex((n) => n.projeteis === 1 && n.perfuracao >= 1);
  if (indice < 0) {
    falhar(0, 'nenhum nivel da arma inicial tem 1 projetil com perfuracao: aponte este teste para outra arma');
  }
  arma.nivel = indice + 1;
  if (nivelDaArma(arma).alcance < DIST_IMORTAL + 40) {
    falhar(0, `alcance ${nivelDaArma(arma).alcance} curto demais para o alvo a ${DIST_IMORTAL}px`);
  }

  const alvo = spawnInimigo(estado);
  if (!alvo) falhar(0, 'spawnInimigo devolveu null montando o alvo imortal');
  alvo.x = player.x + DIST_IMORTAL;
  alvo.y = player.y;
  alvo.hpMax = HP_IMORTAL;
  alvo.hp = HP_IMORTAL;

  const primeira = salvaUnica(estado, arma);
  const segunda = salvaUnica(estado, arma);

  if (!primeira.objeto || !segunda.objeto) falhar(0, 'a arma nao disparou contra o alvo parado');
  if (primeira.objeto !== segunda.objeto) {
    falhar(0, 'a pool nao reaproveitou o mesmo projetil nas duas salvas: este teste depende disso');
  }
  if (primeira.acertos !== 1) {
    falhar(
      0,
      `a primeira salva acertou ${primeira.acertos}x o mesmo inimigo parado (esperava 1): ` +
        'o projetil perfurante esta rebatendo quadro a quadro — jaAtingiu() nao esta filtrando'
    );
  }
  if (segunda.acertos !== 1) {
    falhar(
      0,
      `a segunda salva acertou ${segunda.acertos}x o mesmo inimigo (esperava 1): ` +
        'o projetil reciclado ainda carrega a memoria da salva anterior — falta esquecerAtingidos() no disparo'
    );
  }
}

// ------------------------------------------------------- orbital (Caneta Bic)
//
// orbital guarda estado entre quadros (arma.golpes com o par ref+nasc, e
// arma.angulo) do mesmo jeito que o projetil perfurante guarda `atingidos` —
// a mesma armadilha da fase 03, so que aqui o "ja atingiu" tem que EXPIRAR
// sozinho (intervaloDano) em vez de durar o voo inteiro. As duas funcoes
// abaixo cobrem as duas pontas, no mesmo espirito de checarGuardaDeGeracao()
// e checarMemoriaDePerfuracao() para o projetil.
//
// Chama-se atualizarArmas() direto (sem atualizar()) para isolar a arma —
// mas isso pula atualizarAvaliacao(), que e quem avanca
// run.avaliacao.decorrido. orbital usa decorrido para o cooldown por inimigo,
// entao o teste precisa avancar esse relogio manualmente, senao o cooldown
// nunca expira (decorrido ficaria travado em 0 para sempre).
function passoOrbital(estado, dt) {
  estado.run.avaliacao.decorrido += dt;
  atualizarArmas(estado, dt);
}

function prepararCenarioOrbital(seedOffset) {
  const estado = novoEstado(seedOffset);
  iniciarAvaliacao(estado);
  limparInimigos(estado);

  const player = estado.player;
  player.x = CONTEUDO.arena.largura / 2;
  player.y = CONTEUDO.arena.altura / 2;

  const arma = equiparArma(estado, 'caneta');
  if (!arma) falhar(0, 'equiparArma("caneta") falhou montando o cenario orbital: a arma ainda existe em content.js?');
  const dados = dadosDaArma('caneta');
  // Precisa de 1 caneta so (senao a segunda passa em outro angulo e acerta o
  // alvo num instante diferente, embaralhando a contagem esperada) — mesmo
  // espirito do `findIndex` de checarGuardaDeGeracao() para o leque de
  // projeteis: procura o nivel certo em vez de supor que e sempre o 1.
  const indice = dados.niveis.findIndex((n) => n.quantidade === 1);
  if (indice < 0) {
    falhar(0, 'nenhum nivel da Caneta Bic tem 1 caneta orbitando: ajuste este teste para outro nivel/arma');
  }
  arma.nivel = indice + 1;
  const nivel = nivelDaArma(arma);
  return { estado, player, arma, dados, nivel };
}

// A mesma guarda de geracao dos projeteis (ref+nasc), aqui para o cooldown por
// inimigo do orbital: mata o alvo no primeiro passe (a caneta gira e da uma
// tacada rapida nele), deixa a pool reciclar o MESMO objeto para o proximo
// inimigo (LIFO) e reposiciona-o exatamente onde a caneta esta agora. Sem o
// `nasc`, o inimigo novo herdaria o cooldown do morto e sairia ileso.
function checarGuardaDeGeracaoOrbital() {
  const { estado, player, arma, nivel } = prepararCenarioOrbital(SEMENTE + 10);

  const alvo = spawnInimigo(estado);
  if (!alvo) falhar(0, 'spawnInimigo devolveu null montando o cenario orbital');
  alvo.x = player.x + nivel.raioOrbita;
  alvo.y = player.y;
  alvo.hpMax = 1;
  alvo.hp = 1; // um toque da caneta (dano bem maior que 1) mata na hora

  let passos = 0;
  while (alvo.ativo && passos < 60) {
    passoOrbital(estado, PASSO);
    passos += 1;
  }
  if (alvo.ativo) falhar(0, 'a caneta orbital nao matou o alvo no primeiro passe em 60 ticks (1s)');

  const reciclado = spawnInimigo(estado);
  if (reciclado !== alvo) {
    falhar(0, 'a pool nao reaproveitou o objeto do inimigo morto: este teste depende disso para ter sentido');
  }
  // A caneta nao para de girar so porque matou alguem: reposiciona no ponto
  // EXATO onde ela esta agora para o contato ser imediato no proximo quadro.
  const pos = posicaoSatelite(player, arma, nivel, 0);
  reciclado.x = pos.x;
  reciclado.y = pos.y;
  reciclado.hpMax = 1;
  reciclado.hp = 1;

  passos = 0;
  while (reciclado.ativo && passos < 10) {
    passoOrbital(estado, PASSO);
    passos += 1;
  }
  if (reciclado.ativo) {
    falhar(
      0,
      'o inimigo que reusou o objeto do morto nao levou dano nenhum da caneta orbital: a memoria de cooldown ' +
        'esta comparando so a referencia, sem o `nasc` — guarda de geracao quebrada'
    );
  }
}

// O cooldown por inimigo em si: um alvo IMORTAL e parado no ponto de contato
// nunca pode ser atingido duas vezes com MENOS de nivel.intervaloDano de
// intervalo (a caneta fica varios quadros dentro do raio de colisao a cada
// passagem — sem o cooldown seria um acerto por quadro de contato), mas TEM
// que voltar a ser atingivel depois que o cooldown expira.
//
// Mede-se os TIMESTAMPS de cada acerto (em vez de contar "acertos por passe")
// de proposito: quanto o contato dura por passagem depende de
// raioColisao/velocidadeAngular/raioOrbita, e um numero fixo de "1 por passe"
// quebra sempre que a fase 13 (ou esta mesma fase, durante o balanceamento)
// mexer nesses numeros e o contato passar a durar mais que uma unica janela
// de cooldown — o que aconteceu de verdade ao tunar a Caneta Bic nesta fase.
// O invariante que realmente importa nao muda: nenhum par de acertos
// consecutivos pode ficar mais perto no tempo que intervaloDano.
function checarCooldownPorInimigoOrbital() {
  const { estado, player, dados, nivel } = prepararCenarioOrbital(SEMENTE + 11);

  const alvo = spawnInimigo(estado);
  if (!alvo) falhar(0, 'spawnInimigo devolveu null montando o alvo imortal do cenario orbital');
  alvo.x = player.x + nivel.raioOrbita;
  alvo.y = player.y;
  alvo.hpMax = 1e6;
  alvo.hp = 1e6;

  // Duas voltas completas de folga: tempo de sobra para o alvo ser atingido
  // de novo pelo menos uma vez depois do cooldown expirar.
  const periodoTicks = Math.ceil((Math.PI * 2) / nivel.velocidadeAngular / PASSO);
  const totalTicks = periodoTicks * 2 + 30;
  const timestamps = [];

  for (let i = 0; i < totalTicks; i += 1) {
    passoOrbital(estado, PASSO);
    for (const evento of estado.eventos) {
      if (evento.tipo === 'arma-acerto' && evento.dados.arma === dados.id) {
        timestamps.push(estado.run.avaliacao.decorrido);
      }
    }
    estado.eventos.length = 0;
  }

  if (timestamps.length < 2) {
    falhar(
      0,
      `a caneta acertou o alvo parado so ${timestamps.length}x em duas voltas completas (esperava 2+): ` +
        'o cooldown por inimigo nao esta liberando o alvo de novo depois de expirar'
    );
  }
  // Pequena folga de ponto flutuante: dt acumulado em soma nao bate exato com
  // o expiraEm calculado por multiplicacao.
  const FOLGA = 1e-9;
  for (let i = 1; i < timestamps.length; i += 1) {
    const intervalo = timestamps[i] - timestamps[i - 1];
    if (intervalo < nivel.intervaloDano - FOLGA) {
      falhar(
        0,
        `dois acertos na mesma caneta ficaram a ${intervalo.toFixed(4)}s um do outro, menos que ` +
          `nivel.intervaloDano (${nivel.intervaloDano}s): o cooldown por inimigo nao esta bloqueando — ` +
          'e o mesmo bug de "so lembra o slot mais antigo" que ja foi visto aqui'
      );
    }
  }
}

// checarCooldownPorInimigoOrbital() usa UM alvo so e nunca estoura o anel de
// memoria (CONTEUDO.orbital.memoriaAlvos) — o bug que ela cobre e de LOGICA
// (comparar so a referencia). Existe uma segunda forma do mesmo sintoma que
// so aparece com um ENXAME: se mais inimigos DISTINTOS forem atingidos
// dentro de uma janela de intervaloDano do que memoriaAlvos consegue
// lembrar ao mesmo tempo, o round-robin de lembrarGolpe() pode sobrescrever
// o slot de um inimigo cujo cooldown AINDA esta vivo — esse inimigo perde a
// protecao sem ter vencido o proprio intervaloDano. Usa o nivel MAXIMO da
// Caneta Bic (mais canetas girando, cooldown mais curto — o pior caso pra
// capacidade) e um numero de inimigos parados na propria orbita,
// deliberadamente maior que memoriaAlvos, pra tentar estourar o anel de
// verdade. Os eventos `arma-acerto` nao carregam qual inimigo foi atingido,
// mas os alvos sao IMORTAIS e PARADOS: casar pela posicao (x, y) exata do
// evento identifica o alvo sem ambiguidade.
function checarCooldownComEnxameOrbital() {
  const estado = novoEstado(SEMENTE + 13);
  iniciarAvaliacao(estado);
  limparInimigos(estado);

  const player = estado.player;
  player.x = CONTEUDO.arena.largura / 2;
  player.y = CONTEUDO.arena.altura / 2;

  const arma = equiparArma(estado, 'caneta');
  if (!arma) falhar(0, 'equiparArma("caneta") falhou montando o cenario de enxame orbital');
  const dados = dadosDaArma('caneta');
  arma.nivel = dados.niveis.length; // nivel maximo: mais canetas, intervaloDano mais curto
  const nivel = nivelDaArma(arma);

  // Acima de memoriaAlvos por uma MARGEM FIXA, nao um multiplo dela — um
  // multiplo (ex.: 3x) faria este teste nunca passar, nao importa quanto a
  // memoria cresca, porque o enxame cresceria junto. +8 basta pra forcar o
  // anel a reciclar slot (com N <= memoriaAlvos, todo inimigo acha sua
  // propria entrada de primeira e o codigo de reciclagem nunca roda — o
  // teste passaria sem testar nada). Visto falhando com o round-robin puro
  // (sem preferir slot vencido) e passando com o conserto — ver handoff.
  const N = CONTEUDO.orbital.memoriaAlvos + 8;
  const ultimoPorAlvo = new Map();
  for (let i = 0; i < N; i += 1) {
    const e = spawnInimigo(estado);
    if (!e) falhar(0, 'spawnInimigo devolveu null montando o enxame do cenario orbital');
    const angulo = (Math.PI * 2 * i) / N;
    e.x = player.x + Math.cos(angulo) * nivel.raioOrbita;
    e.y = player.y + Math.sin(angulo) * nivel.raioOrbita;
    e.hpMax = 1e6;
    e.hp = 1e6;
    ultimoPorAlvo.set(`${e.x.toFixed(3)},${e.y.toFixed(3)}`, null);
  }

  const DURACAO_TICKS = 600; // 10s, o mesmo tamanho de janela usado na medicao da revisao
  const FOLGA = 1e-9;
  let acertos = 0;
  for (let i = 0; i < DURACAO_TICKS; i += 1) {
    passoOrbital(estado, PASSO);
    const agora = estado.run.avaliacao.decorrido;
    for (const evento of estado.eventos) {
      if (evento.tipo !== 'arma-acerto' || evento.dados.arma !== dados.id) continue;
      acertos += 1;
      const chave = `${evento.dados.x.toFixed(3)},${evento.dados.y.toFixed(3)}`;
      const anterior = ultimoPorAlvo.get(chave);
      if (anterior !== null && anterior !== undefined && agora - anterior < nivel.intervaloDano - FOLGA) {
        falhar(
          0,
          `com ${N} inimigos na orbita (memoriaAlvos=${CONTEUDO.orbital.memoriaAlvos}), dois acertos no MESMO ` +
            `inimigo do enxame ficaram a ${(agora - anterior).toFixed(4)}s um do outro, menos que intervaloDano ` +
            `(${nivel.intervaloDano}s): o anel de cooldown estourou — outro inimigo tomou o slot antes de vencer`
        );
      }
      ultimoPorAlvo.set(chave, agora);
    }
    estado.eventos.length = 0;
  }
  if (acertos === 0) falhar(0, 'a caneta orbital nao acertou ninguem no cenario de enxame — o cenario nao vale nada');
}

// ------------------------------------------------------------- feixe (Marca-texto)
//
// feixe NAO guarda memoria de inimigo entre quadros — e uma forma geometrica
// recalculada do zero a cada quadro, sem projetil nem perfuracao — entao nao
// ha guarda de geracao para testar aqui (nada para confundir entre vidas
// diferentes do mesmo objeto reciclado). O que precisa de prova e o outro
// jeito de errar: dano por SEGUNDO escalado errado por dt viraria dano por
// QUADRO (60x mais forte a 60fps) ou dano fixo por acerto (dano NAO escalando
// com o tempo de contato).
function checarFeixeContinuo() {
  const estado = novoEstado(SEMENTE + 12);
  iniciarAvaliacao(estado);
  limparInimigos(estado);

  const player = estado.player;
  player.x = CONTEUDO.arena.largura / 2;
  player.y = CONTEUDO.arena.altura / 2;

  const arma = equiparArma(estado, 'marcatexto');
  if (!arma) falhar(0, 'equiparArma("marcatexto") falhou montando o cenario do feixe');
  const dados = dadosDaArma('marcatexto');
  const nivel = nivelDaArma(arma);

  // "Parado mantem a ultima direcao" so tem dente se a direcao guardada NAO
  // for a mesma que o valor padrao (0): usa-se movimento para BAIXO
  // (angulo = PI/2), nao para a direita, de proposito.
  player.vx = 0;
  player.vy = 100;
  atualizarArmas(estado, PASSO);
  if (Math.abs(arma.angulo - Math.PI / 2) > 1e-9) {
    falhar(0, `o feixe nao girou para a direcao do movimento: angulo=${arma.angulo}, esperava ${Math.PI / 2}`);
  }
  player.vx = 0;
  player.vy = 0; // "parado": velocidade exatamente zero, como aplicarAtrito() deixa

  const alvo = spawnInimigo(estado);
  if (!alvo) falhar(0, 'spawnInimigo devolveu null montando o alvo do feixe');
  alvo.x = player.x;
  alvo.y = player.y + nivel.alcance / 2; // no meio do feixe, na direcao guardada
  alvo.hpMax = 1e6;
  alvo.hp = 1e6;

  const TICKS_FEIXE = 120; // 2s
  let danoTotal = 0;
  for (let i = 0; i < TICKS_FEIXE; i += 1) {
    atualizarArmas(estado, PASSO);
    if (Math.abs(arma.angulo - Math.PI / 2) > 1e-9) {
      falhar(i, `o feixe mudou de direcao (angulo=${arma.angulo}) com o jogador parado: nao deveria`);
    }
    for (const evento of estado.eventos) {
      if (evento.tipo === 'arma-acerto' && evento.dados.arma === dados.id) danoTotal += evento.dados.dano;
    }
    estado.eventos.length = 0;
  }

  const esperado = nivel.dano * TICKS_FEIXE * PASSO;
  const erroRelativo = Math.abs(danoTotal - esperado) / esperado;
  if (erroRelativo > 1e-6) {
    falhar(
      TICKS_FEIXE,
      `o feixe aplicou ${danoTotal.toFixed(4)} de dano em ${(TICKS_FEIXE * PASSO).toFixed(2)}s, esperava ` +
        `${esperado.toFixed(4)} (nivel.dano x tempo): o dano por segundo nao esta escalado por dt corretamente`
    );
  }
}

// O ima dos orbes, que e a tarefa 1 do contrato e a metade do laco de
// dopamina. Sem esta checagem ele passa despercebido: com o ima desligado o
// jogador ainda coleta o que pisa em cima, e a corrida de 60s continua
// chegando num nivel plausivel — foi exatamente o que aconteceu quando a
// mutacao "ima desligado" deixou o smoke inteiro verde.
//
// Roda atualizarOrbes() direto, sem atualizar(), para que nenhum inimigo
// nasca, morra ou solte orbe no meio da medida.
function checarImaDeOrbes() {
  const estado = novoEstado(SEMENTE + 9);
  iniciarAvaliacao(estado);
  limparInimigos(estado);

  const player = estado.player;
  player.x = CONTEUDO.arena.largura / 2;
  player.y = CONTEUDO.arena.altura / 2;
  const raioIma = CONTEUDO.jogador.raioColeta;
  const pool = poolOrbes(estado);

  // 1. A rampa: dois orbes parados, um na beirada do ima e outro colado no
  // jogador. Um tick. O de perto tem que ganhar MAIS velocidade — e isso que
  // "aceleracao crescente conforme se aproximam" quer dizer. Aceleracao
  // constante deixaria os dois iguais.
  const parado = (distancia) => {
    const orbe = soltarOrbeXp(estado, player.x + distancia, player.y, 1);
    orbe.vx = 0;
    orbe.vy = 0;
    return orbe;
  };
  const longe = parado(raioIma * 0.95);
  const perto = parado(raioIma * 0.15);
  atualizarOrbes(estado, PASSO);
  const velLonge = Math.hypot(longe.vx, longe.vy);
  const velPerto = Math.hypot(perto.vx, perto.vy);
  if (!(velLonge > 0)) {
    falhar(0, `orbe dentro do ima (${(raioIma * 0.95).toFixed(0)}px) nao ganhou velocidade nenhuma: o ima nao puxa`);
  }
  if (!(velPerto > velLonge)) {
    falhar(
      0,
      `o orbe perto do jogador acelerou ${velPerto.toFixed(1)} px/s e o da beirada ${velLonge.toFixed(1)}: ` +
        'a aceleracao nao cresce com a proximidade, o orbe e rebocado em vez de aspirado'
    );
  }
  pool.liberarTodos();

  // 2. O raio significa alguma coisa: fora dele o orbe parado fica parado.
  // A conta e de deslocamento em qualquer direcao, nao so de aproximacao —
  // tirar o teste de distancia da uma `proximidade` negativa, que EMPURRA o
  // orbe para longe, e uma assercao de "nao se aproximou" passaria feliz.
  const fora = soltarOrbeXp(estado, player.x + raioIma * 1.35, player.y, 1);
  fora.vx = 0;
  fora.vy = 0;
  const foraX = fora.x;
  const foraY = fora.y;
  for (let i = 0; i < 60; i += 1) atualizarOrbes(estado, PASSO);
  const andou = Math.hypot(fora.x - foraX, fora.y - foraY);
  if (andou > 1) {
    falhar(
      0,
      `orbe parado a ${(raioIma * 1.35).toFixed(0)}px (fora do ima de ${raioIma}px) andou ${andou.toFixed(1)}px ` +
        'sozinho em 1s: o raio de coleta nao limita a atracao'
    );
  }
  pool.liberarTodos();

  // 3. Dentro do ima, com o jogador PARADO, o orbe chega. O teto de ticks sai
  // da propria aceleracao minima de content.js (t = sqrt(2d/a)), entao ele
  // acompanha o balanceamento em vez de virar constante no teste.
  const folga = 60;
  const teto = Math.ceil(Math.sqrt((2 * raioIma) / CONTEUDO.xpOrbe.aceleracaoMinima) / PASSO) + folga;
  const alvo = soltarOrbeXp(estado, player.x + raioIma * 0.9, player.y, 3);
  alvo.vx = 0;
  alvo.vy = 0;
  const xpAntes = player.xp;
  let ticks = 0;
  while (alvo.ativo && ticks < teto) {
    atualizarOrbes(estado, PASSO);
    ticks += 1;
  }
  if (alvo.ativo) {
    falhar(
      0,
      `o orbe a ${(raioIma * 0.9).toFixed(0)}px nao foi coletado em ${teto} ticks com o jogador parado: ` +
        'o ima atrai mas o orbe nao encosta, ou a coleta nao dispara'
    );
  }
  if (player.xp !== xpAntes + 3) {
    falhar(0, `o orbe valia 3 de XP e o jogador ganhou ${player.xp - xpAntes}`);
  }
  const problema = pool.verificar();
  if (problema) falhar(0, `pool de orbes inconsistente depois da coleta: ${problema}`);
}

// Carta e dado tambem: o `tipo` da carta de consolo em content.js precisa
// existir no registro de efeitos de cards.js. content.js nao pode importar
// cards.js (ciclo), entao a ligacao dado <-> codigo e verificada aqui, como ja
// acontece com o `comportamento` das armas.
function checarCartasDoConteudo() {
  const problema = verificarCartasDoConteudo();
  if (problema) falhar(0, problema);
}

// Tarefa 3 do contrato: dois niveis de uma vez viram DUAS cartas, uma depois
// da outra. Perder um nivel porque dois cairam no mesmo quadro e um bug que
// nao aparece na tela — a carta some e ninguem percebe que era para ter vindo
// outra. Tambem e aqui que se prova que a carta congela a simulacao.
// Cenario compartilhado por TODA tela que congela a partida (carta, resultado,
// jubilado, pausa). Inimigos vivos, parados e DENTRO do alcance da arma,
// montados a mao: com a arena vazia o teste de congelamento fica verde mesmo
// com atualizarInimigos ou atualizarArmas rodando por tras do overlay — nao ha
// o que se mexer. Estes tres sao a unica coisa que separa "a simulacao
// congelou" de "nao havia simulacao nenhuma para congelar". Fase 07: a loja
// congela igual e reusa isto.
function montarCenarioCongelavel(semente) {
  const estado = novoEstado(semente);
  iniciarAvaliacao(estado);
  limparInimigos(estado);

  const player = estado.player;
  player.x = CONTEUDO.arena.largura / 2;
  player.y = CONTEUDO.arena.altura / 2;

  const alvos = [];
  for (let i = 0; i < 3; i += 1) {
    const inimigo = spawnInimigo(estado);
    if (!inimigo) falhar(0, 'spawnInimigo devolveu null montando o cenario de congelamento');
    inimigo.x = player.x + 90 + i * 25;
    inimigo.y = player.y + (i - 1) * 30;
    inimigo.vx = 0;
    inimigo.vy = 0;
    alvos.push(inimigo);
  }
  return { estado, player, alvos };
}

// Congela por TICKS_CONGELADO ticks com o jogador empurrando para a direita e
// confere que o mundo nao andou um milimetro. Cada sistema tem seu proprio
// sinal — jogador, cronometro, orbe, hp/xp, arma, projeteis, inimigos —
// porque quando uma linha sobra rodando e preciso saber QUAL.
//
// A ORDEM DAS ASSERCOES E PARTE DO TESTE (licao da fase 04): um sinal pode ter
// mais de uma causa, e quem chega primeiro leva a culpa. O orbe PARADO vem
// antes do teste de hp/xp porque coletar um orbe tambem mexe no xp; a CONTAGEM
// de orbes fica por ultimo, com texto neutro, porque ela sobe quando a arma
// mata um inimigo atras do overlay e acusar atualizarOrbes por isso mandaria o
// proximo agente ler o arquivo errado.
function exigirCongelado(estado, alvos, { quando, onde }) {
  const player = estado.player;
  const armaViva = player.armas[0];
  if (!armaViva) falhar(0, `o jogador chegou ${quando} sem arma nenhuma: o cenario de congelamento nao vale`);

  // Um orbe parado DENTRO do raio do ima, criado depois de a tela abrir: se
  // atualizarOrbes() continuar rodando, ele sai do lugar e e coletado. Sem
  // ele, a tela podia aspirar XP a noite inteira sem teste reclamar.
  const orbeParado = soltarOrbeXp(estado, player.x + CONTEUDO.jogador.raioColeta * 0.5, player.y, 1);
  if (!orbeParado) falhar(0, 'soltarOrbeXp devolveu null montando o cenario de congelamento');
  orbeParado.vx = 0;
  orbeParado.vy = 0;

  const antes = {
    x: player.x,
    y: player.y,
    hp: player.hp,
    xp: player.xp,
    decorrido: estado.run.avaliacao.decorrido,
    inimigos: estado.enemies.length,
    cooldown: armaViva.cooldown,
    projeteis: estado.projectiles.length,
    projetilX: estado.projectiles.length > 0 ? estado.projectiles[0].x : 0,
    orbes: estado.xpOrbs.length,
    orbeX: orbeParado.x,
    alvos: alvos.map((e) => ({ ativo: e.ativo, x: e.x, y: e.y, hp: e.hp })),
  };
  estado.input.eixoX = 1;
  for (let i = 0; i < TICKS_CONGELADO; i += 1) atualizar(estado, PASSO);
  estado.input.eixoX = 0;

  if (player.x !== antes.x || player.y !== antes.y) {
    falhar(0, `o jogador andou ${(player.x - antes.x).toFixed(2)}px ${quando}: a simulacao nao congelou`);
  }
  if (estado.run.avaliacao.decorrido !== antes.decorrido) {
    falhar(0, `o cronometro da avaliacao andou ${quando}`);
  }
  if (orbeParado.x !== antes.orbeX || !orbeParado.ativo) {
    falhar(
      0,
      `o orbe parado saiu ${(orbeParado.x - antes.orbeX).toFixed(2)}px${orbeParado.ativo ? '' : ' e foi coletado'} ` +
        `${quando}: atualizarOrbes() roda ${onde}?`
    );
  }
  if (player.hp !== antes.hp || player.xp !== antes.xp) {
    falhar(
      0,
      `o jogador perdeu hp (${antes.hp} -> ${player.hp}) ou ganhou xp (${antes.xp} -> ${player.xp}) ${quando}`
    );
  }
  if (armaViva.cooldown !== antes.cooldown) {
    falhar(
      0,
      `o cooldown da arma foi de ${antes.cooldown.toFixed(3)} para ${armaViva.cooldown.toFixed(3)} ${quando}: ` +
        `atualizarArmas() roda ${onde}?`
    );
  }
  if (
    estado.projectiles.length !== antes.projeteis ||
    (estado.projectiles.length > 0 && estado.projectiles[0].x !== antes.projetilX)
  ) {
    falhar(
      0,
      `os projeteis andaram (${antes.projeteis} -> ${estado.projectiles.length} vivos) ${quando}: ` +
        `atualizarArmas() roda ${onde}?`
    );
  }
  if (estado.enemies.length !== antes.inimigos) {
    falhar(
      0,
      `a arena tinha ${antes.inimigos} inimigos e ficou com ${estado.enemies.length} ${quando}: ` +
        `o spawn (ou a morte) continua rodando ${onde}`
    );
  }
  alvos.forEach((e, i) => {
    const antigo = antes.alvos[i];
    if (e.ativo !== antigo.ativo || e.x !== antigo.x || e.y !== antigo.y || e.hp !== antigo.hp) {
      falhar(
        0,
        `o inimigo ${i} andou ${Math.hypot(e.x - antigo.x, e.y - antigo.y).toFixed(2)}px e foi de ` +
          `${antigo.hp} para ${e.hp} de hp ${quando}: atualizarInimigos() roda ${onde}?`
      );
    }
  });
  // Rede final, de texto neutro: orbe a mais so aparece se alguem morreu atras
  // do overlay, e as verificacoes acima ja apontaram o culpado quando ele existe.
  if (estado.xpOrbs.length !== antes.orbes) {
    falhar(
      0,
      `a arena tinha ${antes.orbes} orbes e ficou com ${estado.xpOrbs.length} ${quando}: ` +
        'alguem matou inimigo atras da tela'
    );
  }
  return orbeParado;
}

function checarFilaDeCartas() {
  const { estado, player, alvos } = montarCenarioCongelavel(SEMENTE + 6);

  // XP de dois niveis de uma vez, exatamente como uma horda que morre junto.
  player.xp = xpParaSubir(1) + xpParaSubir(2);
  atualizar(estado, PASSO);

  if (estado.tela !== TELAS.CARTA) {
    falhar(0, `o jogador subiu de nivel e a tela continuou "${estado.tela}": a carta nao abriu`);
  }
  if (player.nivel !== 3) {
    falhar(
      0,
      `o jogador foi para o nivel ${player.nivel} com XP de dois niveis (esperava 3): ` +
        'o laco de subir de nivel e `if` em vez de `while`?'
    );
  }
  if (estado.cartas.fila !== 2) {
    falhar(0, `fila de cartas em ${estado.cartas.fila} depois de dois niveis (esperava 2)`);
  }
  if (estado.cartas.opcoes.length !== CONTEUDO.cartas.quantidade) {
    falhar(
      0,
      `a carta abriu com ${estado.cartas.opcoes.length} opcoes, content.js pede ${CONTEUDO.cartas.quantidade}`
    );
  }

  exigirCongelado(estado, alvos, { quando: 'com a carta aberta', onde: 'na tela de carta' });

  // Com 4 armas em content.js a opcao 0 nao e mais sempre "Cafe +1": pode ser
  // uma arma nova ou o nivel de qualquer uma das equipadas. Guarda-se o que a
  // opcao PROMETE antes de escolher, para depois conferir o efeito certo —
  // independente de qual carta o sorteio ofereceu (tarefa 5 do contrato desta
  // fase: o sorteio agora tem o que oferecer de verdade).
  const versaoPrimeira = estado.cartas.versao;
  const primeiraOpcao = { ...estado.cartas.opcoes[0] };
  if (!escolherCarta(estado, 0)) falhar(0, 'escolherCarta(0) recusou a primeira carta');
  atualizar(estado, PASSO);

  if (estado.tela !== TELAS.CARTA) {
    falhar(
      0,
      `depois da primeira escolha a tela virou "${estado.tela}": a segunda carta da fila foi comida, ` +
        'dois niveis juntos deram uma carta so'
    );
  }
  if (estado.cartas.versao === versaoPrimeira) {
    falhar(0, 'a segunda carta manteve a versao da primeira: a UI nao redesenharia as opcoes');
  }
  const segundaOpcao = { ...estado.cartas.opcoes[0] };
  if (!escolherCarta(estado, 0)) falhar(0, 'escolherCarta(0) recusou a segunda carta');

  // apontarCarta e o que o mouse (mouseenter) e o foco do DOM chamam — sem
  // trilho, ela podia ser esvaziada e o realce voltaria a nao seguir o mouse,
  // que foi o bloqueio da revisao. Aponta-se a ULTIMA opcao com a escolha ja
  // registrada: prova de uma vez que ela move o cursor, que apontar NAO mexe
  // na escolha pendente (a carta levada continua sendo a 0, verificado logo
  // abaixo) e deixa o cursor fora do zero para a carta seguinte, que e o que
  // da dente a assercao de reset.
  const ultimaOpcao = estado.cartas.opcoes.length - 1;
  if (!apontarCarta(estado, ultimaOpcao)) falhar(0, `apontarCarta(${ultimaOpcao}) recusou uma opcao valida`);
  if (estado.cartas.selecionada !== ultimaOpcao) {
    falhar(
      0,
      `apontarCarta(${ultimaOpcao}) devolveu true mas o cursor ficou em ${estado.cartas.selecionada}: ` +
        'apontar nao escreve em cartas.selecionada, e o mouse nao realca o que aponta'
    );
  }
  if (apontarCarta(estado, estado.cartas.opcoes.length)) {
    falhar(0, 'apontarCarta aceitou um indice fora da faixa: um clique atrasado escolheria carta inexistente');
  }
  if (estado.cartas.selecionada !== ultimaOpcao) {
    falhar(0, 'apontarCarta recusou o indice invalido mas mexeu no cursor assim mesmo');
  }

  atualizar(estado, PASSO);

  if (estado.tela !== TELAS.AVALIACAO) {
    falhar(0, `a fila esvaziou e a tela ficou em "${estado.tela}": a carta nao devolveu o jogo`);
  }
  if (estado.cartas.fila !== 0 || estado.cartas.escolhidas !== 2) {
    falhar(0, `fila=${estado.cartas.fila} escolhidas=${estado.cartas.escolhidas} depois das duas cartas`);
  }
  // As duas opcoes prometidas (guardadas ANTES de cada escolha) precisam ter
  // sido de fato aplicadas — arma-nova equipa, arma-nivel sobe o nivel certo.
  // Sem isso a arma ficaria parada e nada mais neste teste acusaria.
  for (const opcao of [primeiraOpcao, segundaOpcao]) {
    if (opcao.tipo === 'arma-nova') {
      if (!estado.player.armas.some((a) => a.id === opcao.id)) {
        falhar(0, `a carta de arma nova (${opcao.id}) nao equipou nada`);
      }
    } else if (opcao.tipo === 'arma-nivel') {
      const arma = estado.player.armas.find((a) => a.id === opcao.id);
      if (!arma || arma.nivel !== opcao.nivelProximo) {
        falhar(
          0,
          `a carta de nivel (${opcao.id} -> ${opcao.nivelProximo}) nao aplicou: ficou em ` +
            `${arma ? arma.nivel : '(sem arma)'}`
        );
      }
    }
    // Outros tipos (carta de consolo) tem teste dedicado em checarCartasNoMaximo().
  }

  // Navegacao por teclado, que e o plano B da apresentacao se o mouse falhar.
  // O cursor chegou aqui na ultima opcao, posto por apontarCarta la em cima:
  // sem isso a assercao de reset passaria de graca, porque a escolha anterior
  // teria deixado `selecionada` em 0 sozinha.
  if (estado.cartas.selecionada !== ultimaOpcao) {
    falhar(0, `o cursor apontado antes da escolha nao sobreviveu a ela (ficou em ${estado.cartas.selecionada})`);
  }
  player.xp = xpParaSubir(player.nivel);
  atualizar(estado, PASSO);
  if (estado.tela !== TELAS.CARTA) falhar(0, 'terceiro nivel nao abriu carta');
  if (estado.cartas.selecionada !== 0) {
    falhar(
      0,
      `a carta abriu com o cursor na opcao ${estado.cartas.selecionada}: abrirCarta() nao reseta a selecao ` +
        'e o Enter levaria a carta que o jogador apontou na carta ANTERIOR'
    );
  }
  moverSelecaoCarta(estado, -1);
  if (estado.cartas.selecionada !== estado.cartas.opcoes.length - 1) {
    falhar(0, `seta para tras deixou o cursor em ${estado.cartas.selecionada}: a navegacao nao da a volta`);
  }
  moverSelecaoCarta(estado, 1);
  if (estado.cartas.selecionada !== 0) falhar(0, 'seta para frente nao voltou o cursor ao inicio');
}

// Criterio de aceite: com todas as armas no nivel maximo a carta AINDA abre e
// AINDA e escolhivel. Sem a carta de consolo o jogo travaria numa tela de
// escolha sem escolha — e isso acontece no fim da avaliacao, que e o pior
// momento possivel.
function checarCartasNoMaximo() {
  const estado = novoEstado(SEMENTE + 7);
  iniciarAvaliacao(estado);
  limparInimigos(estado);

  for (const dados of CONTEUDO.armas) {
    equiparArma(estado, dados.id);
    let subidas = 0;
    while (subirNivelArma(estado, dados.id)) {
      subidas += 1;
      if (subidas > 50) falhar(0, 'subirNivelArma nunca devolve false montando o cenario de nivel maximo');
    }
  }

  const player = estado.player;
  player.hp = Math.max(1, player.hpMax - CONTEUDO.cartas.consolo.valor);
  player.xp = xpParaSubir(player.nivel);
  limparInimigos(estado);
  atualizar(estado, PASSO);

  if (estado.tela !== TELAS.CARTA) {
    falhar(0, 'com tudo no nivel maximo o nivel novo nao abriu carta nenhuma');
  }
  estado.cartas.opcoes.forEach((opcao, i) => {
    if (!opcao.tipo || !opcao.nome || !opcao.emoji) {
      falhar(0, `opcao ${i} veio vazia com tudo no maximo: falta a carta de consolo de content.js`);
    }
    if (opcao.tipo === 'arma-nivel') {
      falhar(0, `opcao ${i} oferece +1 nivel numa arma ja no maximo (${opcao.id})`);
    }
  });

  const hpAntes = player.hp;
  const ultima = estado.cartas.opcoes.length - 1;
  if (!escolherCarta(estado, ultima)) falhar(0, `escolherCarta(${ultima}) recusou a ultima opcao`);
  limparInimigos(estado);
  atualizar(estado, PASSO);

  if (estado.tela !== TELAS.AVALIACAO) {
    falhar(0, `a carta de consolo nao fechou a tela (ficou em "${estado.tela}")`);
  }
  if (player.hp <= hpAntes) {
    falhar(0, `a carta de consolo nao curou (hp ${hpAntes} -> ${player.hp}): o efeito "cura" foi aplicado?`);
  }
}

// O sorteio das cartas passa pelo rng com semente — se escapasse para
// Math.random(), nada aqui seria reproduzivel. Com uma arma so em content.js o
// sorteio e trivial, entao o cenario injeta armas de teste: e a unica cobertura
// que a carta "arma nova" tem hoje, e ela e metade da regra da tarefa 4.
const SEMENTES_SORTEIO = 12;

function opcoesDoPrimeiroNivel(semente) {
  const estado = novoEstado(semente);
  iniciarAvaliacao(estado);
  limparInimigos(estado);
  estado.player.xp = xpParaSubir(1);
  atualizar(estado, PASSO);
  if (estado.tela !== TELAS.CARTA) falhar(0, 'o cenario de sorteio nao chegou na carta');
  return estado;
}

function checarSorteioDeCartas() {
  const originais = CONTEUDO.armas.slice();
  const base = CONTEUDO.armas[0];
  // Armas de teste: mesmos numeros do Café (o array de niveis e so leitura),
  // id e nome proprios. Somem no finally — a fase 03 aprendeu na marra que
  // restauracao de conteudo nao pode atravessar outra edicao.
  for (const sufixo of ['a', 'b', 'c']) {
    CONTEUDO.armas.push({ ...base, id: `teste-${sufixo}`, nome: `Teste ${sufixo}` });
  }

  try {
    const assinatura = (estado) => estado.cartas.opcoes.map((o) => `${o.tipo}:${o.id}`).join(' | ');
    const primeira = assinatura(opcoesDoPrimeiroNivel(SEMENTE + 8));
    const repetida = assinatura(opcoesDoPrimeiroNivel(SEMENTE + 8));
    if (primeira !== repetida) {
      falhar(0, `a mesma semente sorteou cartas diferentes: [${primeira}] contra [${repetida}]`);
    }

    const vistas = new Set();
    for (let i = 0; i < SEMENTES_SORTEIO; i += 1) {
      const estado = opcoesDoPrimeiroNivel(SEMENTE + 100 + i);
      vistas.add(assinatura(estado));

      const ids = new Set();
      for (const opcao of estado.cartas.opcoes) {
        if (opcao.tipo !== 'arma-nova' && opcao.tipo !== 'arma-nivel') continue;
        if (ids.has(opcao.id)) falhar(0, `a mesma arma (${opcao.id}) apareceu duas vezes na mesma carta`);
        ids.add(opcao.id);
        const dados = dadosDaArma(opcao.id);
        if (opcao.nivelProximo > dados.niveis.length) {
          falhar(0, `carta oferecendo nivel ${opcao.nivelProximo} de ${opcao.id}, o maximo e ${dados.niveis.length}`);
        }
      }
    }
    if (vistas.size < 2) {
      falhar(
        0,
        `${SEMENTES_SORTEIO} sementes diferentes sortearam sempre as mesmas cartas (${[...vistas][0]}): ` +
          'o sorteio nao esta passando pelo rng'
      );
    }

    // Escolher uma carta de arma nova precisa EQUIPAR a arma. Com uma arma so
    // em content.js este caminho nao roda em corrida nenhuma.
    let equipou = false;
    for (let i = 0; i < SEMENTES_SORTEIO && !equipou; i += 1) {
      const estado = opcoesDoPrimeiroNivel(SEMENTE + 200 + i);
      const indice = estado.cartas.opcoes.findIndex((o) => o.tipo === 'arma-nova');
      if (indice < 0) continue;
      const id = estado.cartas.opcoes[indice].id;
      const antes = estado.player.armas.length;
      escolherCarta(estado, indice);
      limparInimigos(estado);
      atualizar(estado, PASSO);
      if (estado.player.armas.length !== antes + 1 || !estado.player.armas.some((a) => a.id === id)) {
        falhar(
          0,
          `a carta de arma nova (${id}) nao equipou nada: player.armas ficou com ${estado.player.armas.length}`
        );
      }
      equipou = true;
    }
    if (!equipou) {
      falhar(0, 'nenhuma semente ofereceu arma nova com 3 armas de teste disponiveis: o sorteio ignora arma-nova?');
    }
  } finally {
    CONTEUDO.armas.length = 0;
    CONTEUDO.armas.push(...originais);
  }
}

// Tarefa 6 do contrato da fase 05: uma corrida de 60s por arma, cada uma
// equipada e levada ao nivel maximo ANTES do primeiro tick (comparacao justa
// entre armas no pico de poder, sem depender da sorte do sorteio de cartas
// pra saber quem cresce mais rapido). O bot roda em circulo, com HP sempre
// cheio — o que se mede e dano, nao sobrevivencia.
//
// O jogador so pode ter a arma especializada: qualquer 'arma-nova' que a
// carta ofereça e removida de estado.player.armas no mesmo tick, antes que
// ela consiga disparar. Sem isso, a carta ainda oferece as outras 3 armas de
// vez em quando (o bot aceita a opcao 0 cegamente, como em toda a corrida
// principal), e cada arma extra que entra MATA inimigos que a arma medida
// mataria — a medida de uma arma passa a depender de quais outras ela por
// acaso pegou. Foi visto acontecendo: bufar o Marca-texto derrubava a
// contagem da Caneta Bic e do Resumo sem tocar em nenhum numero deles.
const MINIMO_KILLS_ESPECIALIZADO = 15; // por arma, em 60s; abaixo disso ela nao esta matando de verdade
const FATOR_MINIMO_ENTRE_ARMAS = 0.4; // a pior nao pode ficar abaixo disto da melhor (criterio de aceite)

function checarArmasEspecializadas() {
  const resultados = [];

  CONTEUDO.armas.forEach((dados, indice) => {
    const estado = novoEstado(SEMENTE + 300 + indice);
    iniciarAvaliacao(estado);

    const arma = equiparArma(estado, dados.id);
    if (!arma) falhar(0, `equiparArma("${dados.id}") falhou montando a corrida especializada`);
    let subidas = 0;
    while (subirNivelArma(estado, dados.id)) {
      subidas += 1;
      if (subidas > 50) falhar(0, `subirNivelArma("${dados.id}") nunca devolve false: o nivel maximo nao segura`);
    }

    let kills = 0;
    let acertos = 0;
    let disparos = 0;
    for (let tick = 1; tick <= TICKS; tick += 1) {
      botCircular(estado, tick);
      estado.player.hp = estado.player.hpMax;
      try {
        atualizar(estado, PASSO);
      } catch (e) {
        falhar(tick, `excecao especializando "${dados.id}": ${e && e.stack ? e.stack : e}`);
      }
      if (estado.tela === TELAS.CARTA) escolherCarta(estado, 0);
      // Isolamento: nenhuma outra arma sobrevive ate o proximo tick.
      if (estado.player.armas.length > 1) {
        estado.player.armas = estado.player.armas.filter((a) => a.id === dados.id);
      }

      for (const evento of estado.eventos) {
        if (evento.tipo === 'arma-acerto' && evento.dados.arma === dados.id) {
          acertos += 1;
          if (evento.dados.matou) kills += 1;
        }
        if (evento.tipo === 'arma-disparo' && evento.dados.arma === dados.id) disparos += 1;
      }
      estado.eventos.length = 0;
    }

    // Teto de disparos dirigido por DADO, nao por lista de nomes de
    // comportamento: qualquer arma cujo nivel maximo tenha campo `cadencia`
    // e DISCRETA (o proprio comportamento decrementa arma.cooldown e so age
    // quando zera — ver o comentario de atualizarArma() em weapons.js). Ela
    // nao pode disparar mais que ceil(T/cadencia)+1 vezes em T segundos; mais
    // que isso e o portao de cadencia parou de bloquear (o bug generico que
    // a descentralizacao do portao na fase 05 poderia introduzir sem
    // ninguem perceber, porque o sintoma que aparece primeiro e sempre
    // indireto — "matou de mais" ou "ninguem tomou dano" — nunca aponta pro
    // `-= dt` que sumiu). orbital e feixe ficam de fora sozinhos: nenhum
    // nivel deles tem `cadencia` em content.js.
    //
    // Roda ANTES da checagem de MINIMO_KILLS_ESPECIALIZADO de proposito: com
    // o portao de cadencia quebrado, um disparo desenfreado tambem produz
    // kills de sobra, entao a checagem de minimo nunca falharia sozinha —
    // ordem errada deixaria essa asserção sem dente em varias das potencias
    // de dano varridas (visto perdendo pra min-kills so por ordem nas mais
    // baixas: /40 e /80 do dano do Resumo).
    const nivelMax = dados.niveis[dados.niveis.length - 1];
    if (typeof nivelMax.cadencia === 'number') {
      const duracao = TICKS * PASSO;
      const teto = Math.ceil(duracao / nivelMax.cadencia) + 1;
      if (disparos > teto) {
        falhar(
          TICKS,
          `arma "${dados.id}" disparou ${disparos}x em ${duracao.toFixed(1)}s, teto calculado pela cadencia ` +
            `(${nivelMax.cadencia}s) e ${teto}: o portao de cadencia (arma.cooldown) parou de bloquear?`
        );
      }
    }

    if (kills < MINIMO_KILLS_ESPECIALIZADO) {
      falhar(
        TICKS,
        `arma "${dados.id}" especializada matou so ${kills} em 60s (minimo ${MINIMO_KILLS_ESPECIALIZADO}): ` +
          'ela esta matando de verdade sozinha?'
      );
    }

    resultados.push({ id: dados.id, nome: dados.nome, kills, acertos, disparos });
  });

  const maior = resultados.reduce((m, r) => (r.kills > m.kills ? r : m), resultados[0]);
  for (const r of resultados) {
    if (r.kills < maior.kills * FATOR_MINIMO_ENTRE_ARMAS) {
      falhar(
        TICKS,
        `arma "${r.id}" matou ${r.kills}, menos que ${(FATOR_MINIMO_ENTRE_ARMAS * 100).toFixed(0)}% da melhor ` +
          `("${maior.id}", ${maior.kills}): ajuste os numeros dela em content.js`
      );
    }
  }

  return resultados;
}

// O numero que o contrato pede: o nivel que o bot atinge em 60s. O HP e
// segurado porque o que se mede aqui e a curva de XP, nao a sobrevivencia — o
// bot circular morre por volta dos 57s desde a fase 03 e a avaliacao
// reiniciaria no meio da medida.
function checarProgressao() {
  const estado = novoEstado(SEMENTE + 5);
  iniciarAvaliacao(estado);

  let cartas = 0;
  let orbesPico = 0;
  let xpColetado = 0;
  let xpSoltado = 0;
  let mortos = 0;

  for (let tick = 1; tick <= TICKS_PROGRESSAO; tick += 1) {
    botCircular(estado, tick);
    estado.player.hp = estado.player.hpMax;
    try {
      atualizar(estado, PASSO);
    } catch (e) {
      falhar(tick, `excecao na corrida de progressao: ${e && e.stack ? e.stack : e}`);
    }
    if (estado.tela === TELAS.CARTA && escolherCarta(estado, 0)) cartas += 1;

    if (estado.xpOrbs.length > orbesPico) orbesPico = estado.xpOrbs.length;
    for (const evento of estado.eventos) {
      if (evento.tipo === 'xp-coletado') xpColetado += evento.dados;
      if (evento.tipo === 'inimigo-morto') {
        mortos += 1;
        xpSoltado += evento.dados.xp;
      }
    }
    estado.eventos.length = 0;
  }

  const nivel = estado.player.nivel;
  if (xpColetado <= 0) {
    falhar(TICKS_PROGRESSAO, `${mortos} inimigos morreram e nenhum XP foi coletado: o orbe e atraido e recolhido?`);
  }
  if (cartas === 0) falhar(TICKS_PROGRESSAO, 'o jogador nao subiu de nivel nenhuma vez em 60s');
  if (cartas !== estado.cartas.escolhidas) {
    falhar(TICKS_PROGRESSAO, `o bot escolheu ${cartas} cartas mas o estado contou ${estado.cartas.escolhidas}`);
  }
  if (estado.player.armas[0].nivel === 1) {
    falhar(TICKS_PROGRESSAO, `${cartas} cartas escolhidas e a arma continua no nivel 1: a escolha aplica o efeito?`);
  }
  if (nivel < NIVEL_MINIMO_60S || nivel > NIVEL_MAXIMO_60S) {
    falhar(
      TICKS_PROGRESSAO,
      `o bot chegou ao nivel ${nivel} em 60s, fora da faixa [${NIVEL_MINIMO_60S}, ${NIVEL_MAXIMO_60S}] — ` +
        'o design §3 pede nivel 5-6; ajuste CONTEUDO.xp.porNivel ou jogador.raioColeta'
    );
  }
  const pool = poolOrbes(estado);
  if (pool.criados !== pool.capacidade) {
    falhar(TICKS_PROGRESSAO, `pool de orbes fabricou ${pool.criados} objetos para capacidade ${pool.capacidade}`);
  }
  const problema = pool.verificar();
  if (problema) falhar(TICKS_PROGRESSAO, `pool de orbes inconsistente: ${problema}`);

  // Conservacao de XP. O bot circular coleta menos da metade do que derruba
  // (ele passa longe de quem morreu do outro lado da arena), e olhar so esse
  // numero nao distingue "orbe esperando no chao" de "orbe que sumiu sem ser
  // coletado nem liberado". Esta conta distingue: todo XP que saiu de um
  // inimigo ou esta no jogador ou esta num orbe vivo.
  let xpNoChao = 0;
  for (const orbe of estado.xpOrbs) xpNoChao += orbe.valor;
  if (pool.reciclados !== 0) {
    falhar(
      TICKS_PROGRESSAO,
      `a pool de orbes reciclou ${pool.reciclados} orbes vivos (teto ${pool.capacidade}) — ` +
        'XP sumindo por lotacao; suba arena.limites.xpOrbs ou faca o orbe expirar'
    );
  }
  if (xpColetado + xpNoChao !== xpSoltado) {
    falhar(
      TICKS_PROGRESSAO,
      `XP nao fecha: ${xpSoltado} soltos por ${mortos} mortes, ${xpColetado} coletados e ${xpNoChao} no chao ` +
        `(faltam ${xpSoltado - xpColetado - xpNoChao}) — orbe nascendo fora da pool ou liberado sem ser coletado`
    );
  }

  return { nivel, cartas, orbesPico, xpColetado, xpSoltado, xpNoChao, mortos };
}

// ----------------------------------------------- fim de avaliacao (fase 06)

// Leva o cenario ate o ultimo tick da avaliacao e deixa o cronometro zerar.
// Devolve o estado ja na tela de fim.
function correrAteOFim(contexto) {
  const { estado } = contexto;
  const av = estado.run.avaliacao;
  av.decorrido = av.duracao;
  atualizar(estado, PASSO);
  return contexto;
}

// Tarefas 1, 2, 3 e 4 do contrato, no caminho de aprovacao: o cronometro zera,
// a nota sai, o conceito e os creditos saem dela, e a partida congela por tras
// do overlay.
function checarTelaDeResultado() {
  const contexto = montarCenarioCongelavel(SEMENTE + 8);
  // Um arranhao antes do fim: com o jogador intacto, hp e hpMax sao o mesmo
  // numero e trocar um pelo outro no calculo da nota passaria despercebido.
  // De quebra, e este o caso comum — terminar ileso e raro.
  receberDano(contexto.estado, DANO_DO_CENARIO);
  // Creditos ja guardados de uma avaliacao anterior: com a run zerada,
  // somar e sobrescrever dao o mesmo numero e o teste nao distinguiria.
  contexto.estado.run.creditos = CREDITOS_ANTERIORES;
  // Mortos de uma avaliacao inteira, postos a mao: um boletim de 0 mortos e
  // degenerado — a parcela de kill fica em zero e qualquer erro nela some.
  contexto.estado.run.avaliacao.kills = KILLS_DO_CENARIO;
  correrAteOFim(contexto);
  const { estado, player, alvos } = contexto;
  const av = estado.run.avaliacao;
  const r = estado.run.resultado;

  if (estado.tela !== TELAS.RESULTADO) {
    falhar(0, `o cronometro zerou e a tela virou "${estado.tela}": sobreviver nao leva a tela de resultado`);
  }
  if (!av.concluida) falhar(0, 'a tela de resultado abriu com avaliacao.concluida em false');
  if (r.motivo !== MOTIVO_TEMPO || !r.aprovado) {
    falhar(0, `resultado de fim por tempo veio motivo="${r.motivo}" aprovado=${r.aprovado}`);
  }
  if (r.id !== av.id || r.kills !== av.kills) {
    falhar(0, `o boletim e de outra avaliacao: id="${r.id}" (${av.id}), kills=${r.kills} (${av.kills})`);
  }
  // A nota da tela precisa ser a que a funcao pura calcula com os MESMOS
  // campos que o boletim mostra. Sem isto, decompor 62% de HP e pagar por 100%
  // passaria despercebido.
  const notaEsperada = calcularNota({
    kills: r.kills,
    hpRestante: r.hp,
    hpMax: r.hpMax,
    ileso: r.ileso,
  });
  if (r.nota !== notaEsperada) {
    falhar(0, `nota do boletim ${r.nota} != calcularNota(${r.kills} kills, ${r.hp}/${r.hpMax} hp) = ${notaEsperada}`);
  }
  const faixa = faixaDaNota(r.nota);
  if (r.conceito !== faixa.conceito) {
    falhar(0, `nota ${r.nota} virou conceito "${r.conceito}" e a faixa diz "${faixa.conceito}"`);
  }
  if (r.creditos !== creditosDaFaixa(faixa)) {
    falhar(0, `conceito ${r.conceito} pagou ${r.creditos} creditos, a faixa manda ${creditosDaFaixa(faixa)}`);
  }
  if (r.creditos <= 0) falhar(0, 'uma avaliacao aprovada pagou 0 creditos: a loja da fase 07 nasceria sem nada');
  if (estado.run.creditos !== CREDITOS_ANTERIORES + r.creditos) {
    falhar(
      0,
      `a run tinha ${CREDITOS_ANTERIORES} creditos, a avaliacao pagou ${r.creditos} e o total ficou ` +
        `${estado.run.creditos}: o ganho nao esta sendo somado em run.creditos`
    );
  }
  if (estado.run.creditos !== r.creditosTotal) {
    falhar(0, `run.creditos=${estado.run.creditos} e o boletim diz creditosTotal=${r.creditosTotal}`);
  }
  // A decomposicao e o que ensina a jogar melhor; se ela sair sem o numero de
  // mortos, virou enfeite.
  const t = CONTEUDO.textos.resultado;
  const linha = decomposicaoDaNota(r);
  const pct = Math.round(r.hpFracao * 100);
  // A conta que a TELA mostra precisa fechar: soma-se o que esta escrito entre
  // parenteses, nao as parcelas do estado. Comparar os valores brutos deixava
  // passar "+5,5 · +3,7" com nota 9,3 — cada parcela arredondada sozinha e a
  // nota arredondada da soma bruta.
  const casas = CONTEUDO.nota.casasDecimais;
  const mostradas = [...linha.matchAll(/\(\+(-?\d+(?:,\d+)?)\)/g)].map((m) => Number(m[1].replace(',', '.')));
  if (mostradas.length !== 3) {
    falhar(0, `a decomposicao "${linha}" devia mostrar 3 parcelas "(+x)" e mostrou ${mostradas.length}`);
  }
  const somaMostrada = mostradas.reduce((acc, v) => acc + v, 0);
  const notaMostrada = Number(formatarNota(r.nota).replace(',', '.'));
  if (Math.round(somaMostrada * 10 ** casas) !== Math.round(notaMostrada * 10 ** casas)) {
    falhar(
      0,
      `a tela mostra "${linha}" (soma ${somaMostrada.toFixed(casas)}) e nota ${formatarNota(r.nota)}: ` +
        'a decomposicao mostra uma conta que nao fecha'
    );
  }
  if (!linha.includes(`${r.kills} ${t.mortos}`)) {
    falhar(0, `a decomposicao "${linha}" nao mostra os ${r.kills} mortos`);
  }
  if (!linha.includes(`${pct}% ${t.hp}`)) {
    falhar(0, `a decomposicao "${linha}" nao mostra os ${pct}% de HP restantes`);
  }
  if (!linha.includes(r.ileso ? t.ileso : t.feriu)) {
    falhar(0, `a decomposicao "${linha}" nao diz se o jogador terminou ileso`);
  }

  checarLinhaDeArmas(estado, 'tela de resultado');

  // Congelamento: e AQUI que a pendencia 9 do ESTADO.md aparece. Enquanto o
  // fim da avaliacao ia para o menu, atualizarPlayer acima do guard de
  // `concluida` era inalcancavel; com um overlay por cima da arena, o jogador
  // passaria a andar por tras dele.
  exigirCongelado(estado, alvos, {
    quando: 'com a tela de resultado aberta',
    onde: 'na tela de resultado',
  });

  // A saida: mesma funcao que o botao e o Enter chamam.
  if (!sairDoResultado(estado)) falhar(0, 'sairDoResultado() recusou a tela de resultado');
  // Fase 07: o aprovado vai para a loja (antes ia ao menu).
  if (estado.tela !== TELAS.LOJA) falhar(0, `sairDoResultado deixou a tela em "${estado.tela}", esperava a loja`);
  if (sairDoResultado(estado)) falhar(0, 'sairDoResultado() agiu fora das telas de fim — ESC deixaria de pausar');
  if (!player.vivo) falhar(0, 'o jogador terminou morto numa avaliacao que acabou por tempo');
}

// Linha de debug do boletim (ajuste pos-checkpoint 1): com
// CONTEUDO.debug.boletimArmas ligada ela mostra o nivel do jogador e cada arma
// com o nivel; desligada ela sai vazia, e vazia e o que a UI esconde. A chave
// e trocada no proprio CONTEUDO (e nao so passada como argumento) para provar
// que o valor padrao da funcao le a chave viva — e o que a fase 15 vai
// desligar.
function checarLinhaDeArmas(estado, onde) {
  // Duas armas em niveis diferentes: com uma so, trocar o nivel de uma pelo
  // de outra passaria despercebido.
  if (!equiparArma(estado, CONTEUDO.arma.inicial)) falhar(0, `${onde}: equiparArma da arma inicial falhou`);
  const outra = CONTEUDO.armas.find((a) => a.id !== CONTEUDO.arma.inicial);
  equiparArma(estado, outra.id);
  subirNivelArma(estado, outra.id);
  subirNivelArma(estado, outra.id);

  const r = estado.run.resultado;
  const t = CONTEUDO.textos.resultado;
  const original = CONTEUDO.debug.boletimArmas;
  try {
    CONTEUDO.debug.boletimArmas = true;
    const ligada = armasDoBoletim(r, estado.player.armas);
    if (!ligada.includes(`${t.nivelJogador} ${r.nivel}`)) {
      falhar(0, `${onde}: a linha de armas "${ligada}" nao mostra o nivel ${r.nivel} do jogador`);
    }
    for (const arma of estado.player.armas) {
      const dados = dadosDaArma(arma.id);
      const esperado = `${dados.nome} ${t.nivelArma}${arma.nivel}`;
      if (!ligada.includes(esperado)) falhar(0, `${onde}: a linha de armas "${ligada}" nao mostra "${esperado}"`);
    }
    CONTEUDO.debug.boletimArmas = false;
    const desligada = armasDoBoletim(r, estado.player.armas);
    if (desligada !== '') {
      falhar(0, `${onde}: com debug.boletimArmas desligada a linha de armas devia sair vazia e saiu "${desligada}"`);
    }
  } finally {
    CONTEUDO.debug.boletimArmas = original;
  }
}

// O outro caminho: HP a zero leva a uma tela DIFERENTE, sem nota e sem
// creditos. A run acabou; pagar o jubilamento seria pagar por perder.
function checarTelaDeJubilado() {
  const { estado, alvos } = montarCenarioCongelavel(SEMENTE + 9);
  const creditosAntes = estado.run.creditos;

  receberDano(estado, estado.player.hpMax * 2);
  if (estado.player.vivo) falhar(0, 'receberDano com o dobro do hpMax nao matou o jogador');
  atualizar(estado, PASSO);

  const r = estado.run.resultado;
  if (estado.tela !== TELAS.JUBILADO) {
    falhar(0, `o jogador morreu e a tela virou "${estado.tela}": morrer nao leva a tela de jubilado`);
  }
  if (r.motivo !== MOTIVO_JUBILADO || r.aprovado) {
    falhar(0, `resultado de morte veio motivo="${r.motivo}" aprovado=${r.aprovado}`);
  }
  if (r.nota !== 0 || r.conceito !== '' || r.creditos !== 0) {
    falhar(0, `jubilado saiu com nota ${r.nota}, conceito "${r.conceito}" e ${r.creditos} creditos`);
  }
  if (estado.run.creditos !== creditosAntes) {
    falhar(0, `jubilamento mexeu nos creditos da run (${creditosAntes} -> ${estado.run.creditos})`);
  }
  if (r.ileso) falhar(0, 'o boletim de um jubilado diz que ele terminou ileso');
  const resumo = resumoDoJubilado(r);
  if (!resumo.includes(String(r.kills))) falhar(0, `o resumo do jubilado "${resumo}" nao mostra os mortos`);
  checarLinhaDeArmas(estado, 'tela de jubilado');

  exigirCongelado(estado, alvos, {
    quando: 'com a tela de jubilado aberta',
    onde: 'na tela de jubilado',
  });
  if (!sairDoResultado(estado)) falhar(0, 'sairDoResultado() recusou a tela de jubilado');
  if (estado.tela !== TELAS.MENU) falhar(0, `sairDoResultado deixou a tela em "${estado.tela}" depois do jubilamento`);
}

// "Jogar" no menu comeca uma run NOVA. Sem isto os creditos de uma partida
// jubilada vazariam para a seguinte — e o bug nao aparece em teste nenhum que
// comece de novoEstado, porque ali a run ja nasce zerada. Chama o mesmo
// caminho que o botao usa (iniciarRun), depois de uma run que juntou
// creditos e foi jubilada.
function checarNovaRunZeraCreditos() {
  const { estado } = montarCenarioCongelavel(SEMENTE + 14);
  estado.run.creditos = CREDITOS_ANTERIORES;
  receberDano(estado, estado.player.hpMax * 2);
  atualizar(estado, PASSO);
  if (!estado.run.jubilado) falhar(0, 'o cenario de nova run nao chegou a jubilar o jogador');
  if (!sairDoResultado(estado)) falhar(0, 'sairDoResultado() recusou a tela de jubilado antes da nova run');

  iniciarRun(estado);
  if (estado.run.creditos !== 0) {
    falhar(0, `uma run nova comecou com ${estado.run.creditos} creditos: vazaram da partida anterior`);
  }
  if (estado.run.jubilado) falhar(0, 'uma run nova comecou marcada como jubilada');
  if (estado.tela !== TELAS.AVALIACAO) falhar(0, `iniciarRun deixou a tela em "${estado.tela}"`);
  if (!estado.player.vivo) falhar(0, 'iniciarRun comecou a avaliacao com o jogador morto');
}

// Tarefa 5: ESC congela de verdade, despausa sem "pular" e o cenario volta a
// andar depois — sem esta ultima parte, o teste de congelamento passaria com
// o jogo travado para sempre.
function checarPausa() {
  const { estado, player, alvos } = montarCenarioCongelavel(SEMENTE + 10);
  // Um tick de avaliacao de verdade antes de pausar: e ele que equipa a arma
  // inicial (garantirArmaInicial roda dentro de atualizarArmas) e enche o
  // cenario com cooldown e projeteis para o congelamento ter o que medir.
  atualizar(estado, PASSO);

  alternarPausa(estado);
  if (estado.tela !== TELAS.PAUSA) falhar(0, `alternarPausa nao pausou (tela "${estado.tela}")`);
  exigirCongelado(estado, alvos, { quando: 'com o jogo pausado', onde: 'na pausa' });

  // Um quadro gigante — a aba que ficou 30s escondida, ou o ESC segurado —
  // nao pode virar 1800 passos de uma vez. O teto e loop.maxPassosPorFrame e
  // a divida restante e DESCARTADA: recuperar o atraso e o que espirala.
  const relogio = criarRelogio();
  const teto = CONTEUDO.loop.maxPassosPorFrame;
  if (avancarRelogio(relogio, PASSO) !== 1) falhar(0, 'um quadro de 1 passo nao rendeu 1 passo');
  const passos = avancarRelogio(relogio, TEMPO_FORA);
  if (passos !== teto) {
    falhar(0, `${TEMPO_FORA}s de aba escondida renderam ${passos} passos num quadro so (teto ${teto})`);
  }
  if (relogio.acumulador !== 0 || relogio.descartado <= 0) {
    falhar(
      0,
      `o acumulador ficou com ${relogio.acumulador.toFixed(3)}s de divida depois do quadro gigante: ` +
        'o proximo quadro adiantaria o jogo de novo'
    );
  }
  if (avancarRelogio(relogio, 0) !== 0) falhar(0, 'um quadro de 0s rendeu passo: o acumulador nao zerou');

  // O quadro real, como main.js o roda: pausado, a aba fica TEMPO_FORA
  // segundos escondida, o relogio rende o teto de passos e todos eles passam
  // por atualizar. Com a tela em pausa nenhum pode mexer no cronometro.
  const relogioDoJogo = criarRelogio();
  const decorridoPausado = estado.run.avaliacao.decorrido;
  const passosPausado = avancarRelogio(relogioDoJogo, TEMPO_FORA);
  for (let i = 0; i < passosPausado; i += 1) atualizar(estado, PASSO);
  if (estado.run.avaliacao.decorrido !== decorridoPausado) {
    falhar(
      0,
      `${passosPausado} passos de quadro pausado andaram o cronometro de ${decorridoPausado} para ` +
        `${estado.run.avaliacao.decorrido}`
    );
  }

  // Despausa e roda UM quadro normal. A divida do quadro gigante foi
  // descartada, entao ele rende exatamente 1 passo — se o acumulador
  // guardasse o tempo da pausa, a avaliacao pularia para a frente ao voltar.
  alternarPausa(estado);
  if (estado.tela !== TELAS.AVALIACAO) falhar(0, `alternarPausa nao despausou (tela "${estado.tela}")`);
  const antes = { x: player.x, decorrido: estado.run.avaliacao.decorrido };
  estado.input.eixoX = 1;
  const passosDepois = avancarRelogio(relogioDoJogo, PASSO);
  for (let i = 0; i < passosDepois; i += 1) atualizar(estado, PASSO);
  estado.input.eixoX = 0;

  if (passosDepois !== 1) {
    falhar(0, `o primeiro quadro de ${PASSO.toFixed(4)}s depois da pausa rendeu ${passosDepois} passos (esperava 1)`);
  }
  const avanco = estado.run.avaliacao.decorrido - antes.decorrido;
  if (avanco <= 0 || player.x === antes.x) {
    falhar(0, 'depois de despausar o jogo continuou congelado: alternarPausa so pausa');
  }
  if (avanco > PASSO + EPSILON) {
    falhar(0, `ao voltar da pausa a avaliacao adiantou ${avanco.toFixed(3)}s num quadro de ${PASSO.toFixed(4)}s`);
  }
}

// Tarefa 6: uma avaliacao INTEIRA, do inicio ao boletim, com o bot de verdade
// e sem segurar o HP dele — a corrida principal segura, e por isso a nota dela
// nao valeria nada. Corrida propria com semente propria, como a de progressao.
function checarAvaliacaoCompleta() {
  const estado = novoEstado(SEMENTE + 11);
  iniciarAvaliacao(estado);

  let cartas = 0;
  let tick = 0;
  while (!telaDeFim(estado) && tick < TICKS_AVALIACAO_COMPLETA) {
    tick += 1;
    botCircular(estado, tick);
    try {
      atualizar(estado, PASSO);
    } catch (e) {
      falhar(tick, `excecao na avaliacao completa: ${e && e.stack ? e.stack : e}`);
    }
    if (estado.tela === TELAS.CARTA && escolherCarta(estado, 0)) cartas += 1;
    estado.eventos.length = 0;
  }

  const r = estado.run.resultado;
  if (!telaDeFim(estado)) {
    falhar(tick, `a avaliacao nao terminou em ${tick} ticks: o cronometro regressivo esta correndo?`);
  }
  if (estado.tela === TELAS.JUBILADO) {
    falhar(
      tick,
      `o bot foi jubilado aos ${r.tempo.toFixed(1)}s de ${r.duracao}s com ${r.kills} mortos — ` +
        'a avaliacao ficou insobrevivivel para quem so anda em circulo (balanceamento de inimigo/arma)'
    );
  }
  if (r.kills <= 0) falhar(tick, 'a avaliacao inteira terminou com 0 mortos');
  if (r.nota <= 0) falhar(tick, `a avaliacao terminou com nota ${r.nota}: os pesos de content.js estao zerados?`);
  if (!r.conceito) falhar(tick, `nota ${r.nota} nao caiu em faixa de conceito nenhuma`);
  if (r.tempo < r.duracao - PASSO) {
    falhar(tick, `o boletim diz ${r.tempo.toFixed(2)}s sobrevividos numa avaliacao de ${r.duracao}s`);
  }
  return {
    nota: r.nota,
    conceito: r.conceito,
    kills: r.kills,
    hpFracao: r.hpFracao,
    ileso: r.ileso,
    creditos: r.creditos,
    cartas,
    ticks: tick,
    decomposicao: decomposicaoDaNota(r),
  };
}

// Ajuste pos-checkpoint 1: o usuario tirou 9,3 (B) parado no canto, sem se
// mexer, e 10,0 jogando normal. Duas corridas proprias, avaliacao inteira e
// HP de verdade, com os dois extremos:
//   - botCanto: prensado no canto a partida toda (o que o usuario fez);
//   - botDesvio: foge de quem chega perto e volta para o meio. NAO e um
//     jogador bom: nao mira, nao busca orbe, nao escolhe carta. Na tabela de
//     antes do ajuste ele reproduzia a partida "jogando normal" do usuario
//     (10,0, ileso, ~210 mortos), e por isso e a regua de "quem se mexe".
// O botCircular nao serve de regua aqui: ele anda sem olhar e passa rente as
// paredes, onde os inimigos nascem — toma tanto dano quanto o canto.
const RAIO_DESVIO = 150; // px: inimigo mais longe que isso nao assusta o botDesvio
const PUXAO_CENTRO = 0.8; // peso da volta ao meio (sem isso ele foge ate a parede e se encurrala)
const IMPULSO_MINIMO = 0.05; // abaixo disso o botDesvio fica parado em vez de tremer

function botCanto(estado) {
  estado.input.eixoX = -1;
  estado.input.eixoY = -1;
}

function botDesvio(estado) {
  const p = estado.player;
  const { largura, altura } = CONTEUDO.arena;
  let fx = 0;
  let fy = 0;
  for (const e of estado.enemies) {
    const dx = p.x - e.x;
    const dy = p.y - e.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > RAIO_DESVIO * RAIO_DESVIO || d2 < EPSILON) continue;
    const d = Math.sqrt(d2);
    const peso = (RAIO_DESVIO - d) / RAIO_DESVIO;
    fx += (dx / d) * peso * peso;
    fy += (dy / d) * peso * peso;
  }
  fx += ((largura / 2 - p.x) / largura) * PUXAO_CENTRO;
  fy += ((altura / 2 - p.y) / altura) * PUXAO_CENTRO;
  const n = Math.hypot(fx, fy);
  estado.input.eixoX = n < IMPULSO_MINIMO ? 0 : fx / n;
  estado.input.eixoY = n < IMPULSO_MINIMO ? 0 : fy / n;
}

function correrAvaliacaoCom(bot, semente, rotulo) {
  const estado = novoEstado(semente);
  iniciarAvaliacao(estado);
  let tick = 0;
  let segundoNivel5 = null;
  while (!telaDeFim(estado) && tick < TICKS_AVALIACAO_COMPLETA) {
    tick += 1;
    bot(estado, tick);
    try {
      atualizar(estado, PASSO);
    } catch (e) {
      falhar(tick, `excecao na corrida ${rotulo}: ${e && e.stack ? e.stack : e}`);
    }
    if (estado.tela === TELAS.CARTA) escolherCarta(estado, 0);
    if (segundoNivel5 === null && estado.player.nivel >= NIVEL_DO_DESIGN) {
      segundoNivel5 = estado.run.avaliacao.decorrido;
    }
    estado.eventos.length = 0;
  }
  if (!telaDeFim(estado)) falhar(tick, `a corrida ${rotulo} nao terminou em ${tick} ticks`);
  const r = estado.run.resultado;
  return {
    jubilado: estado.tela === TELAS.JUBILADO,
    tempo: r.tempo,
    nota: r.nota,
    conceito: r.conceito,
    kills: r.kills,
    hpFracao: r.hpFracao,
    ileso: r.ileso,
    nivel: estado.player.nivel,
    segundoNivel5,
  };
}

const NIVEL_DO_DESIGN = 5; // design §3: nivel 5 antes do fim da primeira avaliacao
const PIOR_CONCEITO_DO_CANTO = 'D'; // "no maximo D": criterio do checkpoint humano 1

function descreverCorrida(c) {
  const fim = c.jubilado
    ? `JUBILADO aos ${c.tempo.toFixed(1)}s`
    : `NOTA ${formatarNota(c.nota)} ${c.conceito}${c.ileso ? ' ileso' : ''}`;
  const n5 = c.segundoNivel5 === null ? 'nunca' : `${c.segundoNivel5.toFixed(1)}s`;
  return `${fim} · ${c.kills} mortos · ${Math.round(c.hpFracao * 100)}% HP · nivel ${c.nivel} · nivel 5 em ${n5}`;
}

function checarCantoContraDesvio() {
  const canto = correrAvaliacaoCom(botCanto, SEMENTE + 12, 'do canto');
  const desvio = correrAvaliacaoCom(botDesvio, SEMENTE + 13, 'do desvio');

  // Parado no canto: jubilado, ou no maximo o conceito D.
  const faixas = CONTEUDO.nota.faixas;
  const indicePior = faixas.findIndex((f) => f.conceito === PIOR_CONCEITO_DO_CANTO);
  if (indicePior < 0) falhar(0, `o conceito "${PIOR_CONCEITO_DO_CANTO}" sumiu de CONTEUDO.nota.faixas`);
  if (!canto.jubilado && faixas.indexOf(faixaDaNota(canto.nota)) < indicePior) {
    falhar(
      0,
      `parado no canto o bot tirou ${formatarNota(canto.nota)} (${canto.conceito}), acima de ` +
        `${PIOR_CONCEITO_DO_CANTO}: ficar parado nao pode pagar (${descreverCorrida(canto)})`
    );
  }
  // Quem se mexe sobrevive, sobe ao nivel do design e tira mais que o canto.
  if (desvio.jubilado) {
    falhar(0, `o bot que desvia foi jubilado (${descreverCorrida(desvio)}): a avaliacao 1 ficou insobrevivivel`);
  }
  if (desvio.segundoNivel5 === null) {
    falhar(0, `o bot que desvia nao chegou ao nivel ${NIVEL_DO_DESIGN} em 60s (${descreverCorrida(desvio)})`);
  }
  if (!canto.jubilado && desvio.nota <= canto.nota) {
    falhar(
      0,
      `desviando o bot tirou ${formatarNota(desvio.nota)} e parado no canto ${formatarNota(canto.nota)}: ` +
        'se mexer tem que pagar mais que ficar parado'
    );
  }
  return { canto, desvio };
}

// ------------------------------------------ relatorio de partida (debug)

// Pedido do todo.md: um relatorio completo que o usuario exporta e manda a
// agentes de balanceamento. Eles vao ler os numeros como fato, entao as
// contas do relatorio precisam fechar com o boletim e com uma contagem feita
// por fora — e a telemetria nao pode mudar a partida que observa.
// Duas corridas do botCircular, escolhidas medindo: +23 aprova apanhando (11
// golpes) e +19 e jubilada por inimigo. Se o balanceamento mudar e elas
// pararem de levar golpe, a assercao de "houve dano" pede outra semente.
const SEMENTE_RELATORIO = SEMENTE + 23;
const SEMENTE_RELATORIO_JUBILADO = SEMENTE + 19;
const TICKS_NA_CARTA = 20; // o bot espera isto com a carta aberta: tempo de decisao > 0
const TIPOS_CONTADOS = ['arma-disparo', 'arma-acerto', 'inimigo-morto', 'inimigo-nasceu', 'jogador-dano', 'carta-aberta'];

// Uma avaliacao inteira com o botCircular e HP de verdade: ele anda rente as
// paredes e apanha, e sem golpe as contas de dano passariam em branco.
// `drenarACada` imita o navegador, que so esvazia a fila uma vez por QUADRO
// (ate loop.maxPassosPorFrame ticks). So com 1 a contagem por fora e
// confiavel: com mais, a fila pode estourar o teto e perder evento ja
// processado.
function correrComTelemetria(semente, { drenarACada = 1, ligada = true } = {}) {
  const original = CONTEUDO.debug.relatorio;
  CONTEUDO.debug.relatorio = ligada;
  try {
    const estado = novoEstado(semente);
    iniciarRun(estado);
    const contagem = {};
    for (const tipo of TIPOS_CONTADOS) contagem[tipo] = 0;
    let tick = 0;
    let naCarta = 0;
    let escolhidas = 0;
    const comecou = Date.now();
    while (!telaDeFim(estado) && tick < TICKS_AVALIACAO_COMPLETA + 2000) {
      tick += 1;
      botCircular(estado, tick);
      try {
        atualizar(estado, PASSO);
      } catch (e) {
        falhar(tick, `excecao na corrida do relatorio: ${e && e.stack ? e.stack : e}`);
      }
      if (estado.tela === TELAS.CARTA) {
        naCarta += 1;
        // Opcoes diferentes a cada carta: sempre a primeira esconderia um
        // indice errado no registro da escolha.
        if (naCarta >= TICKS_NA_CARTA && escolherCarta(estado, escolhidas % CONTEUDO.cartas.quantidade)) {
          escolhidas += 1;
          naCarta = 0;
        }
      }
      if (tick % drenarACada === 0) {
        for (const evento of estado.eventos) if (evento.tipo in contagem) contagem[evento.tipo] += 1;
        estado.eventos.length = 0;
      }
    }
    if (!telaDeFim(estado)) falhar(tick, `a corrida do relatorio nao terminou em ${tick} ticks`);
    return { estado, contagem, tick, ms: Date.now() - comecou };
  } finally {
    CONTEUDO.debug.relatorio = original;
  }
}

// Toda conta do registro contra o boletim e contra a contagem por fora.
// Devolve o registro da avaliacao.
function conferirContasDoRelatorio(corrida, semente) {
  const { estado, contagem } = corrida;
  const tel = estado.telemetria;
  const onde = `relatorio (semente ${semente})`;
  if (!tel || tel.partidas.length !== 1) {
    falhar(0, `${onde}: esperava 1 partida gravada, veio ${tel ? tel.partidas.length : 'telemetria null'}`);
  }
  const partida = tel.partidas[0];
  if (partida.avaliacoes.length !== 1) falhar(0, `${onde}: esperava 1 avaliacao na partida, veio ${partida.avaliacoes.length}`);
  const reg = partida.avaliacoes[0];
  const r = estado.run.resultado;

  const jubilou = estado.tela === TELAS.JUBILADO;
  const esperada = jubilou ? SITUACAO.JUBILADO : SITUACAO.APROVADO;
  if (reg.situacao !== esperada) falhar(0, `${onde}: a tela e "${estado.tela}" e o registro diz "${reg.situacao}"`);
  // Aprovado nao encerra a partida (a loja da fase 07 vem depois); jubilado encerra na hora.
  const partidaEsperada = jubilou ? SITUACAO.JUBILADO : SITUACAO.EM_ANDAMENTO;
  if (partida.situacao !== partidaEsperada) {
    falhar(0, `${onde}: partida "${partida.situacao}" depois de uma avaliacao "${reg.situacao}" (esperava "${partidaEsperada}")`);
  }
  if (!reg.resultado || reg.resultado.kills !== r.kills || reg.resultado.nota !== r.nota) {
    falhar(0, `${onde}: a copia do boletim no registro nao bate com estado.run.resultado`);
  }

  // A contagem por fora precisa bater com o boletim, senao e o teste que esta errado.
  if (contagem['inimigo-morto'] !== r.kills) {
    falhar(0, `${onde}: o proprio teste contou ${contagem['inimigo-morto']} mortes e o boletim ${r.kills}`);
  }
  const soma = (lista, campo) => lista.reduce((s, x) => s + x[campo], 0);
  const contas = [
    ['mortos por tipo de inimigo', soma(reg.inimigos, 'mortos'), r.kills],
    ['mortes por arma', soma(reg.armas, 'mortes'), r.kills],
    ['disparos', soma(reg.armas, 'disparos'), contagem['arma-disparo']],
    ['acertos', soma(reg.armas, 'acertos'), contagem['arma-acerto']],
    ['nascimentos', soma(reg.inimigos, 'nascidos'), contagem['inimigo-nasceu']],
    ['golpes no jogador', reg.jogador.golpes, contagem['jogador-dano']],
    ['golpes listados', reg.golpes.length, contagem['jogador-dano']],
    ['cartas', reg.cartas.length, contagem['carta-aberta']],
    ['subidas de nivel', reg.niveis.length, estado.player.nivel - 1],
    ['cartas por nivel', reg.cartas.length, estado.player.nivel - 1],
    ['mortos nas amostras', soma(reg.amostras, 'mortos'), r.kills],
    ['nascidos nas amostras', soma(reg.amostras, 'nascidos'), contagem['inimigo-nasceu']],
    ['xp solto = coletado + no chao', reg.xp.solto, reg.xp.coletado + reg.xp.noChaoFim],
    ['nivel final', reg.final.nivel, estado.player.nivel],
  ];
  for (const [nome, obtido, esperado] of contas) {
    if (obtido !== esperado) falhar(0, `${onde}: ${nome} = ${obtido}, esperava ${esperado} — evento perdido ou contado duas vezes`);
  }
  const danos = [
    ['dano tomado', reg.jogador.danoTomado, r.danoTomado],
    ['soma dos golpes', soma(reg.golpes, 'dano'), r.danoTomado],
    ['soma das fontes', soma(reg.fontesDano, 'dano'), r.danoTomado],
    ['dano nas amostras', soma(reg.amostras, 'danoTomado'), r.danoTomado],
    ['tempo jogado', reg.tempoJogado, r.tempo],
  ];
  for (const [nome, obtido, esperado] of danos) {
    if (Math.abs(obtido - esperado) > 0.05) falhar(0, `${onde}: ${nome} = ${obtido}, o boletim diz ${esperado}`);
  }
  if (reg.fontesDano.some((f) => f.fonte === FONTE_DESCONHECIDA)) {
    falhar(0, `${onde}: golpe de fonte desconhecida numa partida em que so inimigo bate — o evento jogador-dano sumiu?`);
  }
  for (const i of reg.inimigos) {
    if (i.nascidos - i.mortos - i.vivosFim < 0) {
      falhar(0, `${onde}: ${i.id} com ${i.mortos} mortos + ${i.vivosFim} vivos passando de ${i.nascidos} nascidos`);
    }
  }
  for (const [k, carta] of reg.cartas.entries()) {
    if (carta.escolhida !== k % CONTEUDO.cartas.quantidade) {
      falhar(0, `${onde}: a carta ${k + 1} registrou a opcao ${carta.escolhida} e o bot escolheu ${k % CONTEUDO.cartas.quantidade}`);
    }
    if (carta.decisao < (TICKS_NA_CARTA - 1) * PASSO - EPSILON) {
      falhar(0, `${onde}: a carta ${k + 1} ficou ${TICKS_NA_CARTA} ticks aberta e registrou ${carta.decisao}s de decisao`);
    }
  }
  const amostrasEsperadas = Math.floor(reg.tempoJogado / CONTEUDO.relatorio.amostraSegundos + 1e-6);
  if (reg.amostras.length < amostrasEsperadas || reg.amostras.length > amostrasEsperadas + 1) {
    falhar(0, `${onde}: ${reg.amostras.length} amostras em ${reg.tempoJogado}s (esperava ${amostrasEsperadas} ou +1)`);
  }
  for (let i = 1; i < reg.amostras.length; i += 1) {
    if (!(reg.amostras[i].t > reg.amostras[i - 1].t)) falhar(0, `${onde}: amostra ${i} fora de ordem no tempo`);
  }
  const analise = analisarAvaliacao(reg);
  if (analise.kills !== r.kills || analise.killsBoletim !== r.kills) {
    falhar(0, `${onde}: a analise diz ${analise.kills} mortos e o boletim ${r.kills}`);
  }
  if (jubilou && (!reg.morte || !CONTEUDO.inimigos.some((i) => i.id === reg.morte.fonte))) {
    falhar(0, `${onde}: jubilado por inimigo e a morte registrou a fonte ${JSON.stringify(reg.morte && reg.morte.fonte)}`);
  }
  return reg;
}

function checarRelatorio() {
  const corrida = correrComTelemetria(SEMENTE_RELATORIO);
  const reg = conferirContasDoRelatorio(corrida, SEMENTE_RELATORIO);
  const jubilada = correrComTelemetria(SEMENTE_RELATORIO_JUBILADO);
  const regJubilado = conferirContasDoRelatorio(jubilada, SEMENTE_RELATORIO_JUBILADO);
  // Sem golpe nenhum as contas de dano e a atribuicao de fonte passam em branco.
  if (reg.jogador.golpes + regJubilado.jogador.golpes === 0) {
    falhar(0, `relatorio: as corridas das sementes ${SEMENTE_RELATORIO} e ${SEMENTE_RELATORIO_JUBILADO} nao levaram golpe — escolha sementes em que o botCircular apanha`);
  }
  const { estado } = corrida;
  const tel = estado.telemetria;
  const r = estado.run.resultado;
  const onde = `relatorio (semente ${SEMENTE_RELATORIO})`;

  // O cursor da fila: a mesma partida com a fila esvaziada so a cada quadro
  // de maxPassosPorFrame ticks, como no navegador, grava exatamente o mesmo.
  const porQuadro = correrComTelemetria(SEMENTE_RELATORIO, { drenarACada: CONTEUDO.loop.maxPassosPorFrame });
  if (JSON.stringify(porQuadro.estado.telemetria.partidas) !== JSON.stringify(tel.partidas)) {
    falhar(0, `${onde}: esvaziar a fila a cada ${CONTEUDO.loop.maxPassosPorFrame} ticks mudou a telemetria — o cursor de eventos perde ou repete evento`);
  }

  // So observa: desligada, nada e gravado e a partida e a MESMA, tick a tick.
  const desligada = correrComTelemetria(SEMENTE_RELATORIO, { ligada: false });
  if (desligada.estado.telemetria !== null) falhar(0, `${onde}: com debug.relatorio desligado a telemetria foi criada`);
  const assinatura = (c) =>
    JSON.stringify([c.tick, c.estado.tela, c.estado.run.resultado, c.estado.player.x, c.estado.player.y, c.estado.rng.s, c.estado.enemies.length]);
  if (assinatura(desligada) !== assinatura(corrida)) {
    falhar(0, `${onde}: ligar a telemetria mudou a partida (${assinatura(corrida)} contra ${assinatura(desligada)}) — ela escreve em algo que a simulacao le, ou sorteia`);
  }

  // Os tres escopos saem, com JSON valido e sem numero podre no texto.
  const tamanhos = {};
  for (const escopo of Object.values(ESCOPOS)) {
    const rel = gerarRelatorio(estado, escopo);
    if (!rel || typeof rel.texto !== 'string' || rel.texto.length === 0) falhar(0, `${onde}: gerarRelatorio("${escopo}") nao devolveu texto`);
    for (const podre of ['NaN', 'undefined', 'Infinity', '[object Object]']) {
      if (rel.texto.includes(podre)) {
        const i = rel.texto.indexOf(podre);
        falhar(0, `${onde}: o relatorio "${escopo}" tem "${podre}": ...${rel.texto.slice(Math.max(0, i - 80), i + 20)}...`);
      }
    }
    const bloco = rel.texto.match(/```json\n([\s\S]*)\n```\n$/);
    if (!bloco) falhar(0, `${onde}: o relatorio "${escopo}" nao termina com o bloco JSON`);
    let dados;
    try {
      dados = JSON.parse(bloco[1]);
    } catch (e) {
      falhar(0, `${onde}: o JSON do relatorio "${escopo}" nao e valido: ${e.message}`);
    }
    if (dados.escopo !== escopo) falhar(0, `${onde}: o JSON do relatorio "${escopo}" diz escopo "${dados.escopo}"`);
    const avJson = escopo === ESCOPOS.AVALIACAO ? dados.avaliacao : escopo === ESCOPOS.PARTIDA ? dados.partida.avaliacoes[0] : dados.partidas[0].avaliacoes[0];
    if (!avJson || avJson.analise.kills !== r.kills || avJson.amostras.linhas.length !== reg.amostras.length) {
      falhar(0, `${onde}: o JSON do relatorio "${escopo}" perdeu mortos ou amostras`);
    }
    if (avJson.amostras.linhas.some((linha) => linha.length !== avJson.amostras.colunas.length)) {
      falhar(0, `${onde}: no relatorio "${escopo}" uma linha de amostra tem numero de colunas diferente do cabecalho`);
    }
    // Avaliacao e partida tem a tabela de resumo por avaliacao; a sessao mostra
    // os mortos na tabela de partidas.
    const marca = escopo === ESCOPOS.SESSAO ? `| ${r.kills} |` : `| Mortos | ${r.kills} (`;
    if (!rel.texto.includes(marca)) falhar(0, `${onde}: o relatorio "${escopo}" nao mostra os ${r.kills} mortos ("${marca}")`);
    tamanhos[escopo] = rel.texto.length;
  }
  if (gerarRelatorio(novoEstado(SEMENTE_RELATORIO), ESCOPOS.PARTIDA) !== null) {
    falhar(0, `${onde}: um estado que nunca jogou gerou relatorio — devia devolver null`);
  }

  return { reg, regJubilado, tamanhos, msLigada: corrida.ms, msDesligada: desligada.ms };
}

// Os outros jeitos de uma avaliacao acabar: desistir pela pausa, morrer de
// fonte sem evento, ser atropelada por outra partida — e o teto do historico.
function checarRelatorioFinsAlternativos() {
  const original = CONTEUDO.debug.relatorio;
  CONTEUDO.debug.relatorio = true;
  try {
    const estado = novoEstado(SEMENTE + 16);
    iniciarRun(estado);
    for (let i = 0; i < 120; i += 1) atualizar(estado, PASSO);

    // Quadros do navegador: so contam com a avaliacao rodando.
    registrarQuadro(estado, 0.05, 3);
    alternarPausa(estado);
    registrarQuadro(estado, 30, CONTEUDO.loop.maxPassosPorFrame);
    for (let i = 0; i < 10; i += 1) atualizar(estado, PASSO);
    // O botao "Desistir" da pausa faz exatamente isto (main.js).
    irParaTela(estado, TELAS.MENU);
    atualizar(estado, PASSO);

    const tel = estado.telemetria;
    const primeira = tel.partidas[0];
    const desistida = primeira.avaliacoes[0];
    if (desistida.situacao !== SITUACAO.DESISTIU || primeira.situacao !== SITUACAO.DESISTIU) {
      falhar(0, `relatorio: desistir pela pausa gravou avaliacao "${desistida.situacao}" e partida "${primeira.situacao}"`);
    }
    if (desistida.pausas !== 1 || Math.abs((desistida.telas.pausa || 0) - 10 * PASSO) > EPSILON) {
      falhar(0, `relatorio: 1 pausa de 10 ticks virou ${desistida.pausas} pausa(s) e ${desistida.telas.pausa}s`);
    }
    if (desistida.quadros.quadros !== 1 || desistida.quadros.lentos !== 1) {
      falhar(0, `relatorio: registrarQuadro contou ${desistida.quadros.quadros} quadro(s) (esperava so o de fora da pausa)`);
    }
    if (Math.abs(desistida.tempoJogado - 120 * PASSO) > 1e-6) {
      falhar(0, `relatorio: 120 ticks de avaliacao viraram ${desistida.tempoJogado}s jogados`);
    }

    // Golpe fatal sem evento jogador-dano: o dano entra como fonte
    // desconhecida em vez de sumir, e a partida fecha no mesmo tick.
    iniciarRun(estado);
    atualizar(estado, PASSO);
    receberDano(estado, estado.player.hpMax * 2);
    atualizar(estado, PASSO);
    const segunda = tel.partidas[tel.partidas.length - 1];
    const morta = segunda.avaliacoes[0];
    if (morta.situacao !== SITUACAO.JUBILADO || segunda.situacao !== SITUACAO.JUBILADO) {
      falhar(0, `relatorio: jubilar gravou avaliacao "${morta.situacao}" e partida "${segunda.situacao}"`);
    }
    if (!morta.morte || morta.morte.fonte !== FONTE_DESCONHECIDA || morta.golpes.length !== 1) {
      falhar(0, `relatorio: o golpe fatal sem evento nao virou golpe de fonte desconhecida (${JSON.stringify(morta.morte)})`);
    }

    // Uma partida atropelada por outra sem passar pelo menu fica
    // "interrompida", e o historico guarda so as mais recentes.
    sairDoResultado(estado);
    const teto = CONTEUDO.relatorio.historicoPartidas;
    for (let i = 0; i < teto + 2; i += 1) {
      iniciarRun(estado);
      atualizar(estado, PASSO);
    }
    const iniciadas = 2 + teto + 2;
    if (tel.partidas.length !== teto || tel.sessao.partidasDescartadas !== iniciadas - teto) {
      falhar(0, `relatorio: ${iniciadas} partidas com teto ${teto} deixaram ${tel.partidas.length} guardadas e ${tel.sessao.partidasDescartadas} descartadas`);
    }
    if (tel.partidas[teto - 2].situacao !== SITUACAO.INTERROMPIDA) {
      falhar(0, `relatorio: partida atropelada por outra ficou "${tel.partidas[teto - 2].situacao}"`);
    }
    for (const escopo of Object.values(ESCOPOS)) {
      const rel = gerarRelatorio(estado, escopo);
      if (!rel || rel.texto.includes('NaN') || rel.texto.includes('undefined')) {
        falhar(0, `relatorio: o escopo "${escopo}" quebrou com partidas desistidas, jubiladas e interrompidas`);
      }
    }
  } finally {
    CONTEUDO.debug.relatorio = original;
  }
}

// ------------------------------------------------------ coringas e loja (fase 07)

// Os coringas sao achados pelo EFEITO, nunca pelo id: renomear um coringa em
// content.js nao pode derrubar o teste que prova o efeito.
function coringaComEfeito(efeito) {
  const dados = CONTEUDO.coringas.find((c) => c.efeito === efeito);
  if (!dados) falhar(0, `nenhum coringa em content.js usa o efeito "${efeito}"`);
  return dados;
}

function checarCoringasDoConteudo() {
  const problemas = verificarCoringasDoConteudo();
  if (problemas.length > 0) falhar(0, `coringas de content.js: ${problemas.join(' | ')}`);
  if (HOOKS.length !== 6) falhar(0, `a lista fechada de hooks tem ${HOOKS.length} entradas, o contrato define 6`);
}

// Tarefa 2: o Atestado e o coringa que mais exercita o sistema — golpe fatal,
// memoria por run, e a loja que nao o vende de novo.
function checarAtestado() {
  const atestado = coringaComEfeito('sobreviverFatal');
  const estado = novoEstado(SEMENTE + 40);
  iniciarRun(estado);
  estado.run.coringas.push(novaInstancia(atestado.id));
  const player = estado.player;
  const hpMax = player.hpMax;

  // Golpe fatal: segura com params.hp, conta o dano de verdade e da i-frames.
  if (!receberDano(estado, hpMax * 3)) falhar(0, 'Atestado: o golpe fatal nem foi aplicado');
  if (!player.vivo) falhar(0, 'Atestado: o jogador morreu com o Atestado na mao');
  if (player.hp !== atestado.params.hp) falhar(0, `Atestado: sobrou ${player.hp} de HP, esperava ${atestado.params.hp}`);
  if (Math.abs(estado.run.avaliacao.danoTomado - (hpMax - atestado.params.hp)) > EPSILON) {
    falhar(0, `Atestado: danoTomado ${estado.run.avaliacao.danoTomado}, esperava ${hpMax - atestado.params.hp}`);
  }
  if (!(player.invulneravel > 0)) falhar(0, 'Atestado: sobreviveu sem i-frames — o proximo inimigo mata no quadro seguinte');
  if (!estado.eventos.some((e) => e.tipo === 'coringa-ativado')) falhar(0, 'Atestado: nenhum evento coringa-ativado');
  if (!estado.run.coringasGastos.includes(atestado.id)) falhar(0, 'Atestado: nao entrou em run.coringasGastos');

  // Segundo golpe fatal, mesma avaliacao: morre.
  player.invulneravel = 0;
  receberDano(estado, hpMax * 3);
  if (player.vivo) falhar(0, 'Atestado: salvou duas vezes na mesma avaliacao');

  // 1x por RUN: a avaliacao seguinte da mesma run nao ganha outro.
  comecarAvaliacao(estado, 0, 1);
  receberDano(estado, estado.player.hpMax * 3);
  if (estado.player.vivo) falhar(0, 'Atestado: salvou de novo na avaliacao seguinte — era 1x por run');

  // A loja nao vende um Atestado gasto, nem depois de vendido o usado.
  estado.run.coringas.length = 0;
  estado.run.creditos = 1e6;
  estado.tela = TELAS.RESULTADO;
  estado.run.conceito = CONTEUDO.nota.faixas[0].conceito;
  abrirLoja(estado);
  for (let i = 0; i < 40; i += 1) {
    const ids = estado.loja.itens.slice(0, estado.loja.quantidade).map((it) => it.id);
    if (ids.includes(atestado.id)) falhar(0, 'Atestado: a loja ofereceu de novo um coringa 1x-por-run ja gasto');
    rerolar(estado);
  }

  // Run nova: o Atestado volta a valer.
  iniciarRun(estado);
  estado.run.coringas.push(novaInstancia(atestado.id));
  receberDano(estado, estado.player.hpMax * 3);
  if (!estado.player.vivo) falhar(0, 'Atestado: uma run nova herdou o Atestado gasto da anterior');
}

// Os efeitos de regra, cada um no hook dele, sem rodar partida.
function checarEfeitosDosCoringas() {
  // Vespera: dano x fator so nos ultimos N segundos.
  const vespera = coringaComEfeito('danoNoFim');
  const estado = novoEstado(SEMENTE + 41);
  iniciarRun(estado);
  estado.run.coringas.push(novaInstancia(vespera.id));
  const av = estado.run.avaliacao;
  av.restante = vespera.params.segundos + 1;
  if (aoCalcularDano(estado, 10) !== 10) falhar(0, 'Vespera: mudou o dano fora da janela final');
  av.restante = vespera.params.segundos;
  if (Math.abs(aoCalcularDano(estado, 10) - 10 * vespera.params.fator) > EPSILON) {
    falhar(0, `Vespera: dano ${aoCalcularDano(estado, 10)} na janela final, esperava ${10 * vespera.params.fator}`);
  }

  // Grupo de WhatsApp: soma por morte e zera na avaliacao seguinte.
  const grupo = coringaComEfeito('danoPorMorte');
  const e2 = novoEstado(SEMENTE + 42);
  iniciarRun(e2);
  const inst = novaInstancia(grupo.id);
  e2.run.coringas.push(inst);
  comecarAvaliacao(e2, 0, 0);
  limparInimigos(e2);
  const MORTES = 10;
  // Mata pela porta de sempre: aplicarDano (enemies.js) e quem chama o hook.
  for (let i = 0; i < MORTES; i += 1) {
    const alvo = spawnInimigo(e2);
    if (!alvo) falhar(0, 'Grupo de WhatsApp: spawnInimigo devolveu null');
    if (!aplicarDano(e2, alvo, alvo.hp)) falhar(0, 'Grupo de WhatsApp: o golpe do teste nao matou');
  }
  if (inst.contador !== MORTES) falhar(0, `Grupo de WhatsApp: contou ${inst.contador} mortes de ${MORTES}`);
  const esperado = 10 * (1 + grupo.params.porMorte * MORTES);
  if (Math.abs(aoCalcularDano(e2, 10) - esperado) > EPSILON) {
    falhar(0, `Grupo de WhatsApp: dano ${aoCalcularDano(e2, 10)} depois de ${MORTES} mortes, esperava ${esperado}`);
  }
  comecarAvaliacao(e2, 0, 1);
  if (inst.contador !== 0) falhar(0, 'Grupo de WhatsApp: o bonus atravessou para a avaliacao seguinte');

  // Caderno: a avaliacao abre com a carta do nivel seguinte no primeiro tick.
  const caderno = coringaComEfeito('nivelInicial');
  const e3 = novoEstado(SEMENTE + 43);
  iniciarRun(e3);
  e3.run.coringas.push(novaInstancia(caderno.id));
  comecarAvaliacao(e3, 0, 0);
  atualizar(e3, PASSO);
  if (e3.tela !== TELAS.CARTA || e3.player.nivel !== 1 + caderno.params.niveis) {
    falhar(0, `Caderno: primeiro tick em "${e3.tela}" no nivel ${e3.player.nivel}, esperava a carta no nivel ${1 + caderno.params.niveis}`);
  }

  // Atributos: Energetico e Wi-Fi mudam o player, e o player e o que o jogo le.
  const e4 = novoEstado(SEMENTE + 44);
  iniciarRun(e4);
  const deAtributo = CONTEUDO.coringas.filter((c) => c.efeito === 'atributo');
  for (const c of deAtributo) e4.run.coringas.push(novaInstancia(c.id));
  comecarAvaliacao(e4, 0, 0);
  for (const nome of ATRIBUTOS) {
    let esperadoAtr = CONTEUDO.jogador[nome];
    for (const c of deAtributo) if (c.params.atributo === nome) esperadoAtr *= c.params.fator;
    if (Math.abs(e4.player[nome] - esperadoAtr) > EPSILON) {
      falhar(0, `coringa de atributo: player.${nome} = ${e4.player[nome]}, esperava ${esperadoAtr}`);
    }
  }
  // Velocidade: anda mesmo mais rapido, nao so guarda o numero.
  e4.input.eixoX = 1;
  for (let i = 0; i < 120; i += 1) atualizarPlayer(e4, PASSO);
  const vel = Math.hypot(e4.player.vx, e4.player.vy);
  if (Math.abs(vel - e4.player.velocidade) > 1e-6) {
    falhar(0, `coringa de velocidade: o jogador anda a ${vel.toFixed(2)} px/s, o atributo diz ${e4.player.velocidade}`);
  }
}

// Criterio de aceite: um coringa NOVO entra so por content.js, usando um
// efeito que ja existe, sem tocar em jokers.js. Dois coringas de mentira sao
// postos no proprio CONTEUDO (e tirados no finally): um de XP (hook
// aoGanharXp, que nenhum coringa do MVP usa) e um de HP maximo.
function checarCoringaNovoSoPorConteudo() {
  const original = CONTEUDO.coringas.slice();
  const xp = { id: 'teste-xp', nome: 'Teste XP', emoji: '🧪', descricao: 'x', preco: 10, raridade: 'barato', efeito: 'multiplicarXp', params: { fator: 2 } };
  const hp = { id: 'teste-hp', nome: 'Teste HP', emoji: '🧪', descricao: 'x', preco: 10, raridade: 'barato', efeito: 'atributo', params: { atributo: 'hpMax', fator: 1.5 } };
  try {
    CONTEUDO.coringas.push(xp, hp);
    const problemas = verificarCoringasDoConteudo();
    if (problemas.length > 0) falhar(0, `coringa novo so por content.js foi recusado: ${problemas.join(' | ')}`);

    const estado = novoEstado(SEMENTE + 45);
    iniciarRun(estado);
    estado.run.coringas.push(novaInstancia(xp.id), novaInstancia(hp.id));
    comecarAvaliacao(estado, 0, 0);
    const hpEsperado = CONTEUDO.jogador.hpMax * hp.params.fator;
    if (estado.player.hpMax !== hpEsperado || estado.player.hp !== hpEsperado) {
      falhar(0, `coringa novo de hpMax: player ${estado.player.hp}/${estado.player.hpMax}, esperava ${hpEsperado} cheio`);
    }
    const VALOR = 3;
    const orbe = soltarOrbeXp(estado, estado.player.x, estado.player.y, VALOR);
    orbe.vx = 0;
    orbe.vy = 0;
    const xpAntes = estado.player.xp;
    atualizarOrbes(estado, PASSO);
    if (estado.player.xp - xpAntes !== VALOR * xp.params.fator) {
      falhar(0, `coringa novo de XP: o orbe de ${VALOR} rendeu ${estado.player.xp - xpAntes}, esperava ${VALOR * xp.params.fator}`);
    }

    checarCoringasNovosDaRevisao(xp);

    // E o id duplicado e recusado.
    CONTEUDO.coringas.push({ ...xp });
    if (verificarCoringasDoConteudo().length === 0) falhar(0, 'verificarCoringasDoConteudo aceitou id de coringa repetido');
    CONTEUDO.coringas.pop();
    // E um efeito que nao existe tambem.
    CONTEUDO.coringas.push({ ...xp, id: 'teste-typo', efeito: 'multiplicarXP' });
    if (verificarCoringasDoConteudo().length === 0) falhar(0, 'verificarCoringasDoConteudo aceitou efeito inexistente');
  } finally {
    CONTEUDO.coringas.length = 0;
    CONTEUDO.coringas.push(...original);
  }
}

// Revisao da fase 07. Chamada de dentro do try de checarCoringaNovoSoPorConteudo
// (o finally de la devolve CONTEUDO.coringas ao original). Mais coringas de
// mentira, cada um provando uma coisa so por content.js:
//   - dois do efeito nivelInicial SOMAM (o segundo achava a barra do primeiro
//     ja cheia e dava 0 de XP);
//   - hpMax com fator quebrado sai inteiro;
//   - 'itensLoja' e 'opcoesCarta' sao consultados no ponto de uso (Monitoria
//     e Xerox da expansao entram por eles).
function checarCoringasNovosDaRevisao(modelo) {
  const falso = (id, efeito, params) => ({ ...modelo, id, efeito, params });
  const apostila = falso('teste-apostila', 'nivelInicial', { niveis: 1 });
  const hpQuebrado = falso('teste-hp-quebrado', 'atributo', { atributo: 'hpMax', fator: 1.15 });
  const menosItens = falso('teste-itens-loja', 'atributo', { atributo: 'itensLoja', fator: 0.5 });
  const menosCartas = falso('teste-opcoes-carta', 'atributo', { atributo: 'opcoesCarta', fator: 0.5 });
  CONTEUDO.coringas.push(apostila, hpQuebrado, menosItens, menosCartas);
  const problemas = verificarCoringasDoConteudo();
  if (problemas.length > 0) falhar(0, `coringas de teste da revisao recusados: ${problemas.join(' | ')}`);

  // Caderno + outro nivelInicial: o primeiro tick sobe os niveis dos dois.
  const caderno = coringaComEfeito('nivelInicial');
  const e1 = novoEstado(SEMENTE + 51);
  iniciarRun(e1);
  e1.run.coringas.push(novaInstancia(caderno.id), novaInstancia(apostila.id));
  comecarAvaliacao(e1, 0, 0);
  atualizar(e1, PASSO);
  const niveis = caderno.params.niveis + apostila.params.niveis;
  if (e1.player.nivel !== 1 + niveis || e1.cartas.fila !== niveis) {
    falhar(0, `dois coringas nivelInicial: nivel ${e1.player.nivel} com ${e1.cartas.fila} carta(s) na fila, esperava nivel ${1 + niveis} com ${niveis}`);
  }

  // hpMax x1,15 = 114,99999999999999 sem arredondar.
  const e2 = novoEstado(SEMENTE + 52);
  iniciarRun(e2);
  e2.run.coringas.push(novaInstancia(hpQuebrado.id));
  comecarAvaliacao(e2, 0, 0);
  const hpEsperado = Math.round(CONTEUDO.jogador.hpMax * hpQuebrado.params.fator);
  if (e2.player.hpMax !== hpEsperado || e2.player.hp !== hpEsperado) {
    falhar(0, `hpMax com fator quebrado: player ${e2.player.hp}/${e2.player.hpMax}, esperava ${hpEsperado} inteiro e cheio`);
  }

  // Itens da loja: a vitrine pergunta o numero ao coringa na abertura.
  const e3 = novoEstado(SEMENTE + 53);
  iniciarRun(e3);
  e3.run.coringas.push(novaInstancia(menosItens.id));
  e3.run.conceito = CONTEUDO.nota.faixas[0].conceito;
  e3.tela = TELAS.RESULTADO;
  abrirLoja(e3);
  const itensEsperados = Math.min(e3.loja.itens.length, Math.round(itensDaLoja(e3.run.conceito) * menosItens.params.fator));
  if (e3.loja.quantidade !== itensEsperados) {
    falhar(0, `coringa de itensLoja: a loja abriu ${e3.loja.quantidade} itens, esperava ${itensEsperados}`);
  }

  // Opcoes da carta: o sorteio pergunta o numero ao coringa; o resto dos
  // slots fica vazio (tipo ''), que e o que ui.js esconde.
  const e4 = novoEstado(SEMENTE + 54);
  iniciarRun(e4);
  e4.run.coringas.push(novaInstancia(menosCartas.id));
  comecarAvaliacao(e4, 0, 0);
  e4.player.xp = e4.player.xpProximo;
  atualizar(e4, PASSO);
  if (e4.tela !== TELAS.CARTA) falhar(0, `coringa de opcoesCarta: a carta nao abriu (tela "${e4.tela}")`);
  const slots = e4.cartas.opcoes.length;
  const opcoesEsperadas = Math.max(1, Math.min(slots, Math.round(CONTEUDO.cartas.quantidade * menosCartas.params.fator)));
  const cheias = e4.cartas.opcoes.filter((o) => o.tipo !== '').length;
  if (cheias !== opcoesEsperadas) falhar(0, `coringa de opcoesCarta: a carta mostrou ${cheias} de ${slots} opcoes, esperava ${opcoesEsperadas}`);
}

// Leva uma avaliacao ate o boletim aprovado e entra na loja pela porta de
// sempre (sairDoResultado).
function lojaAberta(semente, creditos) {
  const contexto = montarCenarioCongelavel(semente);
  correrAteOFim(contexto);
  const { estado } = contexto;
  if (estado.tela !== TELAS.RESULTADO) falhar(0, `cenario da loja terminou em "${estado.tela}"`);
  estado.run.creditos = creditos;
  if (!sairDoResultado(estado)) falhar(0, 'sairDoResultado recusou o boletim do cenario da loja');
  if (estado.tela !== TELAS.LOJA) falhar(0, `o aprovado foi para "${estado.tela}", nao para a loja`);
  return estado;
}

function idsNaVitrine(estado) {
  return estado.loja.itens.slice(0, estado.loja.quantidade).map((it) => it.id);
}

// Tarefas 3 e 4: comprar, vender, rerolar, seguir, teto de 5, e o cursor que
// mouse e teclado dividem.
function checarLoja() {
  const cfg = CONTEUDO.loja;
  // Itens por conceito: 4 com B ou A, 3 no resto (design §5).
  for (const faixa of CONTEUDO.nota.faixas) {
    const esperado = faixa.conceito === 'A' || faixa.conceito === 'B' ? 4 : 3;
    if (itensDaLoja(faixa.conceito) !== esperado) {
      falhar(0, `loja: conceito ${faixa.conceito} mostra ${itensDaLoja(faixa.conceito)} itens, o design pede ${esperado}`);
    }
  }

  const estado = lojaAberta(SEMENTE + 46, 0);
  const loja = estado.loja;
  if (loja.quantidade !== itensDaLoja(estado.run.conceito)) {
    falhar(0, `loja: conceito ${estado.run.conceito} abriu ${loja.quantidade} itens, esperava ${itensDaLoja(estado.run.conceito)}`);
  }
  const ids = idsNaVitrine(estado);
  if (ids.some((id) => id === '') || new Set(ids).size !== ids.length) falhar(0, `loja: vitrine com vazio ou repetido (${ids.join(', ')})`);

  // Atraso de abertura (teclado E mouse): o Enter repetido ou o clique duplo
  // do boletim nao compra.
  if (entradaLiberada(estado)) falhar(0, 'loja: teclado/mouse ja compram no mesmo instante em que a loja abre');
  for (let i = 0; i < Math.ceil(cfg.atrasoEntrada / PASSO) + 1; i += 1) atualizar(estado, PASSO);
  if (!entradaLiberada(estado)) falhar(0, `loja: teclado/mouse continuam travados ${cfg.atrasoEntrada}s depois de abrir`);
  if (estado.tela !== TELAS.LOJA) falhar(0, `loja: a tela saiu sozinha para "${estado.tela}"`);

  // Sem credito: recusa, avisa, nao mexe em nada.
  if (comprarItem(estado, 0)) falhar(0, 'loja: comprou sem credito');
  if (loja.aviso !== AVISOS.SEM_CREDITOS || estado.run.coringas.length !== 0) falhar(0, 'loja: a recusa por credito nao avisou ou comprou assim mesmo');
  if (rerolar(estado)) falhar(0, 'loja: rerolou sem credito');

  estado.run.creditos = 10000;
  // Mouse aponta o item 2, Enter compra o item 2 (pendencia 26): o cursor e
  // um so, e e o estado.
  const alvo = loja.itens[2].id;
  if (!apontarLoja(estado, LINHA_VITRINE, 2)) falhar(0, 'loja: apontarLoja recusou o item 2');
  const antes = estado.run.creditos;
  if (!confirmarLoja(estado)) falhar(0, 'loja: Enter no item apontado nao comprou');
  if (estado.run.coringas.length !== 1 || estado.run.coringas[0].id !== alvo) {
    falhar(0, `loja: apontou "${alvo}" e comprou "${estado.run.coringas[0] && estado.run.coringas[0].id}"`);
  }
  if (antes - estado.run.creditos !== loja.itens[2].preco) falhar(0, 'loja: a compra nao cobrou o preco');
  if (comprarItem(estado, 2) || loja.aviso !== AVISOS.VENDIDO) falhar(0, 'loja: vendeu o mesmo item duas vezes');

  // Reroll: cobra o preco, o preco sobe, e nao oferece o que o jogador tem.
  const preco1 = precoReroll(loja);
  if (preco1 !== cfg.rerollBase) falhar(0, `loja: primeiro reroll custa ${preco1}, esperava ${cfg.rerollBase}`);
  const c0 = estado.run.creditos;
  if (!apontarLoja(estado, LINHA_VITRINE, posicaoRerolar(loja)) || !confirmarLoja(estado)) falhar(0, 'loja: Enter no rerolar nao rerolou');
  if (c0 - estado.run.creditos !== preco1) falhar(0, 'loja: o reroll nao cobrou');
  if (precoReroll(loja) !== cfg.rerollBase + cfg.rerollIncremento) falhar(0, 'loja: o preco do reroll nao subiu');
  for (let i = 0; i < 30; i += 1) {
    if (idsNaVitrine(estado).includes(alvo)) falhar(0, 'loja: o reroll ofereceu um coringa que o jogador ja tem');
    rerolar(estado);
  }

  // Teto: enche ate loja.teto comprando de verdade.
  let tentativas = 0;
  while (estado.run.coringas.length < cfg.teto && tentativas < 200) {
    tentativas += 1;
    const i = loja.itens.findIndex((it, k) => k < loja.quantidade && it.id !== '' && !it.vendido);
    if (i < 0 || !comprarItem(estado, i)) rerolar(estado);
  }
  if (estado.run.coringas.length !== cfg.teto) falhar(0, `loja: nao deu para chegar a ${cfg.teto} coringas`);
  rerolar(estado);
  const livre = loja.itens.findIndex((it, k) => k < loja.quantidade && it.id !== '' && !it.vendido);
  if (livre >= 0) {
    if (comprarItem(estado, livre)) falhar(0, `loja: comprou o ${cfg.teto + 1}º coringa — o teto nao segura`);
    if (loja.aviso !== AVISOS.CHEIO) falhar(0, 'loja: a recusa do teto nao avisou');
  }
  if (estado.run.coringas.length !== cfg.teto) falhar(0, 'loja: o teto foi furado');

  // Vender pelo cursor: linha de baixo, Enter.
  if (!trocarLinhaLoja(estado) || loja.linha !== LINHA_CORINGAS) falhar(0, 'loja: nao deu para descer aos coringas do jogador');
  moverSelecaoLoja(estado, 1);
  const vendido = estado.run.coringas[loja.selecionada].id;
  const c1 = estado.run.creditos;
  if (!confirmarLoja(estado)) falhar(0, 'loja: Enter no coringa do jogador nao vendeu');
  const devolvido = estado.run.creditos - c1;
  const dados = CONTEUDO.coringas.find((c) => c.id === vendido);
  if (devolvido !== Math.floor(dados.preco * cfg.fracaoVenda) || devolvido !== valorDeVenda(vendido)) {
    falhar(0, `loja: vender "${vendido}" devolveu ${devolvido}, esperava ${Math.floor(dados.preco * cfg.fracaoVenda)}`);
  }
  if (estado.run.coringas.some((c) => c.id === vendido)) falhar(0, 'loja: o coringa vendido continua na run');
  if (livre >= 0 && !comprarItem(estado, livre)) falhar(0, 'loja: depois de vender, o teto ainda nao deixou comprar');
  // Vender tudo devolve o cursor para a vitrine.
  apontarLoja(estado, LINHA_CORINGAS, 0);
  while (estado.run.coringas.length > 0) venderCoringa(estado, 0);
  if (loja.linha !== LINHA_VITRINE) falhar(0, 'loja: sem coringa nenhum o cursor ficou numa linha vazia');
  if (trocarLinhaLoja(estado)) falhar(0, 'loja: o cursor desceu para uma linha de coringas vazia');

  // Seguir: a proxima avaliacao, com os coringas da run agindo nela.
  const energetico = coringaComEfeito('atributo');
  estado.run.coringas.push(novaInstancia(energetico.id));
  const indiceAntes = estado.run.avaliacaoIndex;
  if (!apontarLoja(estado, LINHA_VITRINE, posicaoSeguir(loja)) || !confirmarLoja(estado)) falhar(0, 'loja: Enter no seguir nao saiu da loja');
  if (estado.tela !== TELAS.AVALIACAO) falhar(0, `loja: seguir levou a "${estado.tela}"`);
  if (estado.run.avaliacaoIndex !== indiceAntes + 1) falhar(0, 'loja: seguir nao avancou para a avaliacao seguinte');
  const atr = energetico.params.atributo;
  if (Math.abs(estado.player[atr] - CONTEUDO.jogador[atr] * energetico.params.fator) > EPSILON) {
    falhar(0, `loja: a avaliacao seguinte comecou sem o coringa comprado (player.${atr} = ${estado.player[atr]})`);
  }
  if (seguirDaLoja(estado) || comprarItem(estado, 0) || rerolar(estado)) falhar(0, 'loja: acao da loja funcionou fora da loja');

  // Fim da lista de avaliacoes: o seguir volta ao menu (a fase 08 poe o TCC).
  const ultimoP = CONTEUDO.periodos.length - 1;
  const ultimoA = CONTEUDO.periodos[ultimoP].avaliacoes.length - 1;
  if (proximaAvaliacao(ultimoP, ultimoA) !== null) falhar(0, 'proximaAvaliacao: existe avaliacao depois da ultima');
  const virada = proximaAvaliacao(0, CONTEUDO.periodos[0].avaliacoes.length - 1);
  if (!virada || virada.periodoIndex !== 1 || virada.avaliacaoIndex !== 0) falhar(0, 'proximaAvaliacao: nao virou o periodo');
  comecarAvaliacao(estado, ultimoP, ultimoA);
  if (avancarRun(estado) || estado.tela !== TELAS.MENU) falhar(0, `avancarRun depois da ultima avaliacao foi a "${estado.tela}"`);
}

// Reroll gratis do conceito A (design §4) e a recusa de um reroll que nao
// traria nada novo. Separado de checarLoja porque precisa escolher o conceito,
// e aquele cenario sai do boletim real da semente.
function checarRerollGratisESemNovidade() {
  const cfg = CONTEUDO.loja;
  const faixas = CONTEUDO.nota.faixas;
  const comGratis = faixas.find((f) => f.rerollsGratis > 0);
  const semGratis = faixas.find((f) => f.rerollsGratis === 0);
  if (!comGratis) falhar(0, 'loja: nenhum conceito da reroll gratis — o design §4 da 1 ao A');
  if (rerollsGratisDaLoja('A') !== 1) falhar(0, `loja: o A da ${rerollsGratisDaLoja('A')} rerolls gratis, o design §4 pede 1`);

  const abrir = (semente, faixa, creditos) => {
    const estado = novoEstado(semente);
    iniciarRun(estado);
    estado.tela = TELAS.RESULTADO;
    estado.run.conceito = faixa.conceito;
    estado.run.creditos = creditos;
    abrirLoja(estado);
    return estado;
  };

  // Com o gratis: sem credito nenhum, o reroll sai; depois o pago comeca do
  // preco base (o gratis nao encarece o seguinte).
  const e1 = abrir(SEMENTE + 48, comGratis, 0);
  if (e1.loja.gratis !== comGratis.rerollsGratis) falhar(0, `loja: conceito ${comGratis.conceito} abriu com ${e1.loja.gratis} rerolls gratis`);
  if (precoReroll(e1.loja) !== 0) falhar(0, 'loja: o reroll gratis tem preco');
  if (rotuloDoReroll(precoReroll(e1.loja)).indexOf(CONTEUDO.textos.loja.gratis) < 0) falhar(0, 'loja: o botao nao diz que o reroll e gratis');
  for (let i = 0; i < comGratis.rerollsGratis; i += 1) {
    if (!rerolar(e1)) falhar(0, 'loja: o reroll gratis foi recusado por falta de credito');
  }
  if (e1.run.creditos !== 0) falhar(0, 'loja: o reroll gratis cobrou');
  if (precoReroll(e1.loja) !== cfg.rerollBase) falhar(0, `loja: depois do gratis o reroll custa ${precoReroll(e1.loja)}, esperava ${cfg.rerollBase}`);
  if (rotuloDoReroll(cfg.rerollBase).indexOf(String(cfg.rerollBase)) < 0) falhar(0, 'loja: o botao de reroll nao mostra o preco');
  if (rerolar(e1) || e1.loja.aviso !== AVISOS.SEM_CREDITOS) falhar(0, 'loja: acabou o gratis e o reroll saiu sem credito');

  // Sem o gratis: o primeiro reroll ja e pago.
  if (semGratis) {
    const e2 = abrir(SEMENTE + 49, semGratis, 0);
    if (e2.loja.gratis !== 0 || precoReroll(e2.loja) !== cfg.rerollBase) falhar(0, `loja: conceito ${semGratis.conceito} ganhou reroll gratis`);
  }

  // Sem novidade: o jogador tem tudo o que nao esta na vitrine. Rerrolar so
  // embaralharia a ordem — recusa e nao cobra.
  const e3 = abrir(SEMENTE + 50, semGratis || comGratis, 1000);
  const vitrine = idsNaVitrine(e3);
  for (const c of CONTEUDO.coringas) if (!vitrine.includes(c.id)) e3.run.coringas.push(novaInstancia(c.id));
  if (rerolarTrazNovidade(e3)) falhar(0, 'loja: rerolarTrazNovidade viu novidade com a vitrine mostrando tudo o que sobra');
  const antes = e3.run.creditos;
  if (rerolar(e3) || e3.loja.aviso !== AVISOS.SEM_NOVIDADE) falhar(0, 'loja: rerrolou sem nada novo para sortear');
  if (e3.run.creditos !== antes) falhar(0, 'loja: a recusa por falta de novidade cobrou');
  // Vendeu um que nao esta a venda: volta a haver o que sortear.
  e3.run.coringas.pop();
  if (!rerolarTrazNovidade(e3) || !rerolar(e3)) falhar(0, 'loja: com um coringa livre fora da vitrine o reroll continuou recusado');

  // Fora da loja nada esta liberado, nem depois do atraso.
  e3.tela = TELAS.MENU;
  if (entradaLiberada(e3)) falhar(0, 'loja: entradaLiberada fora da tela da loja');
}

// Tarefa 5, nos numeros: um coringa caro custa mais que uma avaliacao boa
// rende. "Boa" e o desvio (a regua de quem joga bem) — o boletim real dele.
function checarGuardarDinheiro(desvio) {
  const creditos = creditosDaFaixa(faixaDaNota(desvio.nota));
  const caros = CONTEUDO.coringas.filter((c) => c.raridade === 'caro');
  if (caros.length === 0) falhar(0, 'nenhum coringa caro: guardar dinheiro nunca e necessario');
  for (const c of caros) {
    if (c.preco <= creditos) {
      falhar(0, `"${c.id}" custa ${c.preco} e uma avaliacao boa (desvio, ${desvio.conceito}) rende ${creditos}: nao ha motivo para guardar`);
    }
  }
  return { creditos, caros: caros.map((c) => `${c.emoji}${c.preco}`).join(' ') };
}

// Tarefa 6: uma avaliacao inteira com os 6 coringas forcados (acima do teto,
// de proposito) contra a mesma semente sem nenhum. Nada pode quebrar e o dano
// causado tem que subir. E a rede de seguranca da fase 13.
//
// O dano comparado e o NOMINAL (o que os golpes levam depois dos hooks), nao
// o efetivo: na avaliacao 1 o bot ja mata quase tudo o que nasce, entao o
// efetivo e limitado pelo HP somado do que nasceu e mal se mexe (+2% medido)
// — um aoCalcularDano desligado passaria despercebido por ele.
function correrComCoringas(forcar) {
  const estado = novoEstado(SEMENTE + 47);
  iniciarRun(estado);
  if (forcar) {
    for (const c of CONTEUDO.coringas) estado.run.coringas.push(novaInstancia(c.id));
    comecarAvaliacao(estado, 0, 0);
  }
  let dano = 0;
  let efetivo = 0;
  let tick = 0;
  while (!telaDeFim(estado) && tick < TICKS_AVALIACAO_COMPLETA) {
    tick += 1;
    botDesvio(estado);
    try {
      atualizar(estado, PASSO);
    } catch (e) {
      falhar(tick, `excecao na avaliacao com ${forcar ? '6' : '0'} coringas: ${e && e.stack ? e.stack : e}`);
    }
    for (const ev of estado.eventos) {
      if (ev.tipo !== 'arma-acerto') continue;
      dano += ev.dados.dano;
      efetivo += ev.dados.efetivo;
    }
    estado.eventos.length = 0;
    if (estado.tela === TELAS.CARTA) escolherCarta(estado, 0);
    if (tick % INTERVALO_VARREDURA === 0) {
      const ruim = procurarNumeroInvalido(estado, 'estado', new Set(), 0);
      if (ruim) falhar(tick, `numero invalido com ${forcar ? '6' : '0'} coringas: ${ruim}`);
    }
  }
  if (!telaDeFim(estado)) falhar(tick, 'a avaliacao com coringas nao terminou');
  const r = estado.run.resultado;
  const grupo = estado.run.coringas.find((c) => CONTEUDO.coringas.find((d) => d.id === c.id).efeito === 'danoPorMorte');
  return { dano, efetivo, kills: r.kills, nota: r.nota, conceito: r.conceito, jubilado: estado.tela === TELAS.JUBILADO, hp: r.hpFracao, nivel: estado.player.nivel, grupo, estado };
}

function checarSeisCoringas() {
  const sem = correrComCoringas(false);
  const com = correrComCoringas(true);
  if (com.jubilado) falhar(0, 'com os 6 coringas o bot que desvia foi jubilado');
  if (!(com.dano > sem.dano)) {
    falhar(0, `dano com os 6 coringas (${com.dano.toFixed(0)}) nao passou do dano sem nenhum (${sem.dano.toFixed(0)})`);
  }
  if (com.grupo && com.grupo.contador !== com.kills) {
    falhar(0, `Grupo de WhatsApp contou ${com.grupo.contador} mortes e o boletim tem ${com.kills}`);
  }
  return { sem, com };
}

function descreverComCoringas(c) {
  const fim = c.jubilado ? 'JUBILADO' : `NOTA ${formatarNota(c.nota)} ${c.conceito}`;
  return `dano ${c.dano.toFixed(0)} (efetivo ${c.efetivo.toFixed(0)}) · ${c.kills} mortos · ${fim} · ${Math.round(c.hp * 100)}% HP · nivel ${c.nivel}`;
}

// ------------------------------------------------------------------ corrida

checarReciclagemDaPool();
// Antes de qualquer coisa que dispare: um `comportamento` digitado errado na
// arma inicial mata o update com stack trace cru, e a mensagem limpa daqui e
// que diz o que aconteceu.
checarArmasDoConteudo();
checarNiveisDaArma();
checarGuardaDeGeracao();
checarMemoriaDePerfuracao();
checarGuardaDeGeracaoOrbital();
checarCooldownPorInimigoOrbital();
checarCooldownComEnxameOrbital();
checarFeixeContinuo();
checarCartasDoConteudo();
checarImaDeOrbes();
checarFilaDeCartas();
checarCartasNoMaximo();
checarSorteioDeCartas();
checarTelaDeResultado();
checarTelaDeJubilado();
checarNovaRunZeraCreditos();
checarPausa();
checarCoringasDoConteudo();
checarAtestado();
checarEfeitosDosCoringas();
checarCoringaNovoSoPorConteudo();
checarLoja();
checarRerollGratisESemNovidade();
const coringas = checarSeisCoringas();
const corridaArma = checarArmaSozinha();
const especializacao = checarArmasEspecializadas();
const progressao = checarProgressao();
const boletim = checarAvaliacaoCompleta();
const estilos = checarCantoContraDesvio();
const economia = checarGuardarDinheiro(estilos.desvio);
const relatorio = checarRelatorio();
checarRelatorioFinsAlternativos();

const estado = novoEstado(SEMENTE);
iniciarAvaliacao(estado);

function rodarTick(estado, tick, { reiniciarAvaliacao = true } = {}) {
  botCircular(estado, tick);
  manterCarga(estado);

  try {
    atualizar(estado, PASSO);
  } catch (e) {
    falhar(tick, `excecao em atualizar(): ${e && e.stack ? e.stack : e}`);
  }

  // O bot sempre pega a primeira carta. Sem isso a simulacao congela na tela
  // de carta e a corrida inteira para no primeiro nivel — que e exatamente o
  // que aconteceu quando esta fase ligou a pausa antes de ensinar o bot.
  if (estado.tela === TELAS.CARTA && escolherCarta(estado, 0)) contadores.cartas += 1;

  registrarMovimento(estado);
  registrarDano(estado);

  for (const verificacao of VERIFICACOES) {
    let problema = null;
    try {
      problema = verificacao.rodar(estado, tick);
    } catch (e) {
      problema = `a propria verificacao explodiu: ${e && e.message ? e.message : e}`;
    }
    if (problema) falhar(tick, `[${verificacao.nome}] ${problema}`);
  }

  // Faz o papel do consumidor da fila (audio/juice no navegador).
  for (const evento of estado.eventos) {
    contadores.eventos += 1;
    contadores.porTipo[evento.tipo] = (contadores.porTipo[evento.tipo] || 0) + 1;
  }
  estado.eventos.length = 0;

  // A avaliacao acabou numa das duas telas de fim: fecha o boletim pela mesma
  // porta que o botao e o Enter usam e comeca a proxima, para que os ticks
  // todos rodem dentro da jogabilidade e nao parados numa tela.
  if (telaDeFim(estado)) {
    contadores.avaliacoesConcluidas += 1;
    contadores.notas.push(estado.run.resultado.nota);
    contadores.conceitos.push(estado.run.resultado.conceito || '-');
    if (!sairDoResultado(estado)) falhar(tick, 'sairDoResultado() nao fechou a tela de fim de avaliacao');
    // Aprovado cai na loja, jubilado no menu (fase 07).
    if (!foraDaAvaliacao(estado)) falhar(tick, `depois da tela de fim a tela ficou "${estado.tela}"`);
    if (reiniciarAvaliacao) iniciarAvaliacao(estado);
  }
}

const comecou = Date.now();
for (let tick = 1; tick <= TICKS; tick += 1) rodarTick(estado, tick);

// O caminho de fim por tempo precisa rodar em toda corrida. Duas coisas
// atrapalham: dt fixo acumula erro de ponto flutuante (3600 * 1/60 da
// 59,9999...s, entao uma avaliacao de 60s nao fecha dentro do laco) e, desde
// a fase 02, o jogador morre antes dos 60s e a avaliacao seguinte comeca
// desalinhada. Adianta-se o cronometro para o ultimo segundo e segura-se o hp
// para que o encerramento seja o do timer, nao o de jubilamento.
const TOLERANCIA_FIM = 120;
if (foraDaAvaliacao(estado)) iniciarAvaliacao(estado);
estado.run.avaliacao.decorrido = estado.run.avaliacao.duracao - 1;
let extras = 0;
// rodarTick ja sai da tela de fim assim que ela aparece (aprovado vai para a
// LOJA, jubilado para o MENU), entao o alvo aqui e qualquer um dos dois
// (foraDaAvaliacao): e ele que prova que o ciclo inteiro fechou.
while (!foraDaAvaliacao(estado) && extras < TOLERANCIA_FIM) {
  extras += 1;
  estado.player.hp = estado.player.hpMax;
  rodarTick(estado, TICKS + extras, { reiniciarAvaliacao: false });
}
if (!foraDaAvaliacao(estado)) {
  falhar(TICKS + extras, `a avaliacao nao encerrou ${TOLERANCIA_FIM} ticks depois da duracao`);
}
if (!contadores.porTipo['avaliacao-fim']) {
  falhar(TICKS + extras, 'nenhum evento avaliacao-fim na corrida: o fim por tempo nao rodou');
}
// O evento que a fase 11 vai ouvir para a fanfarra de aprovacao. Ele sai de
// fecharAvaliacao(), entao sem ele nao houve boletim nenhum nesta corrida.
if (!contadores.porTipo['resultado']) {
  falhar(TICKS + extras, 'nenhum evento resultado na corrida: fecharAvaliacao() foi chamado?');
}
if (contadores.notas.length !== contadores.avaliacoesConcluidas) {
  falhar(
    TICKS + extras,
    `${contadores.avaliacoesConcluidas} avaliacoes encerradas e ${contadores.notas.length} notas registradas`
  );
}

// O bot circular gira devagar (uma volta a cada 10s) contra um jogador que
// acelera rapido (~0,14s ate a velocidade maxima) — em 60s+ isso soma muitos
// milhares de px e varre boa parte da arena nos dois eixos. Estes minimos
// ficam bem abaixo do que qualquer movimento real produz; so pegam o jogador
// parado (distancia e amplitude ficariam em 0).
const DISTANCIA_MINIMA = 2000;
const AMPLITUDE_MINIMA = 200;
const amplitudeX = maxX - minX;
const amplitudeY = maxY - minY;
if (distanciaPercorrida < DISTANCIA_MINIMA || amplitudeX < AMPLITUDE_MINIMA || amplitudeY < AMPLITUDE_MINIMA) {
  falhar(
    TICKS + extras,
    `jogador praticamente parado: distancia=${distanciaPercorrida.toFixed(1)}px (minimo ${DISTANCIA_MINIMA}), ` +
      `amplitude=${amplitudeX.toFixed(1)}x${amplitudeY.toFixed(1)}px (minimo ${AMPLITUDE_MINIMA} por eixo) — ` +
      'atualizarPlayer() esta sendo chamado dentro de atualizarAvaliacao()?'
  );
}

// Inimigos: as tres asserções da fase 02 que so valem no fim da corrida. Sem
// elas as verificacoes por tick passariam iguais com o spawn desligado — uma
// arena vazia nao tem inimigo com NaN nem pool crescendo.
if (picos.enemies < MINIMO_INIMIGOS) {
  falhar(TICKS + extras, `pico de inimigos foi ${picos.enemies} (minimo ${MINIMO_INIMIGOS}): o spawn rodou?`);
}
if (danoTotal <= 0) {
  falhar(TICKS + extras, 'o jogador nao tomou dano nenhum: inimigos perseguem e colidem?');
}
if (!contadores.porTipo['inimigo-morto']) {
  falhar(TICKS + extras, 'nenhum inimigo morreu: as armas atiraram e aplicarDano() devolveu alguem a pool?');
}
// Desde a fase 03 nada mais mata inimigo no smoke — quem abatia era um bot de
// mentira, removido junto com esta fase. Se as armas pararem de ser chamadas em
// atualizarAvaliacao(), estas duas assercoes caem juntas.
if (picos.projectiles === 0) {
  falhar(TICKS + extras, 'nenhum projetil foi disparado na corrida: atualizarArmas() roda dentro do update?');
}
const poolFinal = poolInimigos(estado);
if (poolFinal.criados !== poolFinal.capacidade) {
  falhar(
    TICKS + extras,
    `pool de inimigos fabricou ${poolFinal.criados} objetos para uma capacidade de ${poolFinal.capacidade}`
  );
}

const segundos = (Date.now() - comecou) / 1000;
const picosTexto = POOLS.map((p) => `${p}=${picos[p]}`).join(' ');
const poolProjetil = poolProjeteis(estado);
console.log(
  `smoke ok${CARGA ? ' (carga)' : ''} — ${TICKS}+${extras} ticks (${((TICKS + extras) * PASSO).toFixed(1)}s simulados` +
    ` em ${segundos.toFixed(2)}s) · avaliacoes=${contadores.avaliacoesConcluidas}` +
    ` · eventos=${contadores.eventos} · hp=${estado.player.hp}/${estado.player.hpMax}` +
    ` · nivel=${estado.player.nivel} · distancia=${distanciaPercorrida.toFixed(0)}px` +
    ` · amplitude=${amplitudeX.toFixed(0)}x${amplitudeY.toFixed(0)}px` +
    ` · dano=${danoTotal} · jubilado=${contadores.porTipo.jubilado || 0}` +
    ` · mortos=${contadores.porTipo['inimigo-morto'] || 0}` +
    ` · disparos=${contadores.porTipo['arma-disparo'] || 0}` +
    ` acertos=${contadores.porTipo['arma-acerto'] || 0}` +
    ` · pool inimigos: criados=${poolFinal.criados} reciclados=${poolFinal.reciclados}` +
    ` ressinc=${poolFinal.ressincronizacoes}` +
    ` · pool projeteis: criados=${poolProjetil.criados} nascimentos=${poolProjetil.nascimentos}` +
    ` reciclados=${poolProjetil.reciclados}` +
    ` · bot parado: mortos=${corridaArma.mortos} disparos=${corridaArma.disparos}` +
    ` pico=${corridaArma.pico}/${corridaArma.teto}` +
    ` · picos: ${picosTexto}` +
    // O numero de balanceamento que as fases seguintes herdam: nivel atingido
    // em 60s de avaliacao, com o bot pegando sempre a primeira carta.
    // Corrida propria, com semente propria (SEMENTE+5) e HP segurado: por isso
    // esta linha nao muda entre `smoke` e `smoke:carga` — o modo de carga so
    // mexe em spawn.maxSimultaneos, que a curva de spawn nem alcanca em 60s.
    `\n  progressao em 60s (corrida dedicada, semente fixa): NIVEL ${progressao.nivel}` +
    ` · cartas=${progressao.cartas} · xp ${progressao.xpColetado} coletado` +
    ` + ${progressao.xpNoChao} no chao = ${progressao.xpSoltado} solto por ${progressao.mortos} mortes` +
    ` · pico de orbes no chao=${progressao.orbesPico}` +
    // O boletim que o contrato da fase 06 pede impresso. Corrida dedicada
    // (SEMENTE+11), avaliacao inteira, bot circular pegando sempre a primeira
    // carta e SEM segurar o HP — a corrida principal segura, e a nota dela
    // nao valeria nada.
    `\n  boletim em 60s (corrida dedicada, semente fixa): NOTA ${formatarNota(boletim.nota)}` +
    ` · CONCEITO ${boletim.conceito} · ${boletim.creditos} creditos` +
    ` · ${boletim.decomposicao}` +
    // Ajuste pos-checkpoint 1: os dois extremos de estilo, cada um com a
    // sua semente (SEMENTE+12 canto, SEMENTE+13 desvio) e HP de verdade.
    `
  parado no canto (SEMENTE+12): ${descreverCorrida(estilos.canto)}` +
    `
  desviando (SEMENTE+13): ${descreverCorrida(estilos.desvio)}` +
    `\n  6 coringas (desvio, SEMENTE+47): SEM ${descreverComCoringas(coringas.sem)}` +
    `\n                                 COM ${descreverComCoringas(coringas.com)}` +
    `\n  economia: o desvio rende ${economia.creditos} creditos por avaliacao; os caros custam ${economia.caros}` +
    `\n  cartas na corrida principal=${contadores.cartas}` +
    ` · notas da corrida principal=${contadores.notas.map((n) => formatarNota(n)).join('/')}` +
    ` (${contadores.conceitos.join('/')})` +
    // Insumo do balanceamento da fase 13 (tarefa 6 do contrato): cada arma
    // sozinha, no nivel maximo, 60s, corrida propria (SEMENTE+300+indice).
    `\n  arsenal especializado (60s cada, nivel maximo, corridas proprias): ` +
    especializacao.map((r) => `${r.nome}=${r.kills}kills/${r.acertos}acertos`).join(' · ') +
    // O relatorio de balanceamento (debug.relatorio): as contas fecharam com o
    // boletim, e ligar ou desligar nao mudou a partida.
    `\n  relatorio (circular, SEMENTE+23 e +19): ${relatorio.reg.situacao} com ${relatorio.reg.golpes.length} golpes` +
    ` e ${relatorio.regJubilado.situacao} com ${relatorio.regJubilado.golpes.length}` +
    ` · ${relatorio.reg.amostras.length} amostras · ${relatorio.reg.cartas.length} cartas` +
    ` · texto ${Object.entries(relatorio.tamanhos).map(([e, n]) => `${e}=${(n / 1024).toFixed(0)}KB`).join(' ')}` +
    ` · corrida ${relatorio.msLigada}ms ligada / ${relatorio.msDesligada}ms desligada`
);
