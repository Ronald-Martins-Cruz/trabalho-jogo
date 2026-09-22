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
import { novoEstado, iniciarAvaliacao, TELAS } from '../src/state.js';
import { atualizar } from '../src/main.js';
import { spawnInimigo, poolInimigos, limparInimigos } from '../src/enemies.js';
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
import { atualizarOrbes, poolOrbes, soltarOrbeXp, xpParaSubir } from '../src/player.js';
import { criarPool } from '../src/pool.js';

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

// Teste de carga: `npm run smoke -- --carga` enche a arena ate o teto da pool
// e mantem o jogador de pe, para medir o custo de IA + separacao + colisao no
// pior caso. Fora desse modo a corrida e a de sempre.
const CARGA = process.argv.includes('--carga');
const ALVO_CARGA = CONTEUDO.arena.limites.enemies;
if (CARGA) CONTEUDO.spawn.maxSimultaneos = ALVO_CARGA;

const POOLS = Object.keys(CONTEUDO.arena.limites).filter((p) => p !== 'eventos');

const picos = {};
for (const pool of POOLS) picos[pool] = 0;
const contadores = { avaliacoesConcluidas: 0, eventos: 0, cartas: 0, porTipo: {} };

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
function checarFilaDeCartas() {
  const estado = novoEstado(SEMENTE + 6);
  iniciarAvaliacao(estado);
  limparInimigos(estado);

  const player = estado.player;
  player.x = CONTEUDO.arena.largura / 2;
  player.y = CONTEUDO.arena.altura / 2;

  // Inimigos vivos, parados e DENTRO do alcance da arma, montados a mao. Com a
  // arena vazia o teste de congelamento fica verde mesmo com atualizarInimigos
  // ou atualizarArmas rodando na tela de carta — nao ha o que se mexer. Estes
  // tres sao a unica coisa que separa "a simulacao congelou" de "nao havia
  // simulacao nenhuma para congelar".
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

  // Congelamento: com a carta aberta e o jogador empurrando para a direita, o
  // mundo nao pode andar um milimetro. Cada sistema tem seu proprio sinal —
  // jogador, cronometro, inimigos, arma e projeteis — porque a fase 07 vai
  // congelar de novo para a loja e a 12 vai mexer no update por causa do
  // juice: se uma linha sobrar rodando, e preciso saber QUAL.
  const armaViva = player.armas[0];
  if (!armaViva) falhar(0, 'o jogador chegou na carta sem arma nenhuma: o cenario de congelamento nao vale');
  // Um orbe parado DENTRO do raio do ima, criado depois de a carta abrir: se
  // atualizarOrbes() continuar rodando, ele sai do lugar e e coletado. Sem
  // ele, a tela de carta podia aspirar XP a noite inteira sem teste reclamar.
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
    falhar(0, `o jogador andou ${(player.x - antes.x).toFixed(2)}px com a carta aberta: a simulacao nao congelou`);
  }
  if (estado.run.avaliacao.decorrido !== antes.decorrido) {
    falhar(0, 'o cronometro da avaliacao andou com a carta aberta');
  }
  // So o orbe PARADO acusa atualizarOrbes, e ele vem antes do teste de hp/xp
  // porque coletar um orbe tambem mexe no xp. A CONTAGEM de orbes fica para o
  // fim, com texto neutro: ela sobe quando a arma mata um inimigo atras da
  // carta, e acusar atualizarOrbes por isso manda o proximo agente ler o
  // arquivo errado.
  if (orbeParado.x !== antes.orbeX || !orbeParado.ativo) {
    falhar(
      0,
      `o orbe parado saiu ${(orbeParado.x - antes.orbeX).toFixed(2)}px${orbeParado.ativo ? '' : ' e foi coletado'} ` +
        'com a carta aberta: atualizarOrbes() roda na tela de carta?'
    );
  }
  if (player.hp !== antes.hp || player.xp !== antes.xp) {
    falhar(
      0,
      `o jogador perdeu hp (${antes.hp} -> ${player.hp}) ou ganhou xp (${antes.xp} -> ${player.xp}) ` +
        'com a carta aberta'
    );
  }
  if (armaViva.cooldown !== antes.cooldown) {
    falhar(
      0,
      `o cooldown da arma foi de ${antes.cooldown.toFixed(3)} para ${armaViva.cooldown.toFixed(3)} com a carta ` +
        'aberta: atualizarArmas() roda na tela de carta?'
    );
  }
  if (
    estado.projectiles.length !== antes.projeteis ||
    (estado.projectiles.length > 0 && estado.projectiles[0].x !== antes.projetilX)
  ) {
    falhar(
      0,
      `os projeteis andaram (${antes.projeteis} -> ${estado.projectiles.length} vivos) com a carta aberta: ` +
        'atualizarArmas() roda na tela de carta?'
    );
  }
  if (estado.enemies.length !== antes.inimigos) {
    falhar(
      0,
      `a arena tinha ${antes.inimigos} inimigos e ficou com ${estado.enemies.length} durante a carta: ` +
        'o spawn (ou a morte) continua rodando na tela de carta'
    );
  }
  alvos.forEach((e, i) => {
    const antigo = antes.alvos[i];
    if (e.ativo !== antigo.ativo || e.x !== antigo.x || e.y !== antigo.y || e.hp !== antigo.hp) {
      falhar(
        0,
        `o inimigo ${i} andou ${Math.hypot(e.x - antigo.x, e.y - antigo.y).toFixed(2)}px e foi de ` +
          `${antigo.hp} para ${e.hp} de hp com a carta aberta: atualizarInimigos() roda na tela de carta?`
      );
    }
  });
  // Rede final, de texto neutro: orbe a mais so aparece se alguem morreu atras
  // da carta, e as verificacoes acima ja apontaram o culpado quando ele existe.
  if (estado.xpOrbs.length !== antes.orbes) {
    falhar(
      0,
      `a arena tinha ${antes.orbes} orbes e ficou com ${estado.xpOrbs.length} durante a carta: ` +
        'alguem matou inimigo atras da carta'
    );
  }

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
const corridaArma = checarArmaSozinha();
const especializacao = checarArmasEspecializadas();
const progressao = checarProgressao();

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

  // A avaliacao acabou: comeca a proxima para que os ticks todos rodem dentro
  // da jogabilidade, nao parados no menu.
  if (estado.tela === TELAS.MENU) {
    contadores.avaliacoesConcluidas += 1;
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
if (estado.tela === TELAS.MENU) iniciarAvaliacao(estado);
estado.run.avaliacao.decorrido = estado.run.avaliacao.duracao - 1;
let extras = 0;
while (estado.tela !== TELAS.MENU && extras < TOLERANCIA_FIM) {
  extras += 1;
  estado.player.hp = estado.player.hpMax;
  rodarTick(estado, TICKS + extras, { reiniciarAvaliacao: false });
}
if (estado.tela !== TELAS.MENU) {
  falhar(TICKS + extras, `a avaliacao nao encerrou ${TOLERANCIA_FIM} ticks depois da duracao`);
}
if (!contadores.porTipo['avaliacao-fim']) {
  falhar(TICKS + extras, 'nenhum evento avaliacao-fim na corrida: o fim por tempo nao rodou');
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
    `\n  cartas na corrida principal=${contadores.cartas}` +
    // Insumo do balanceamento da fase 13 (tarefa 6 do contrato): cada arma
    // sozinha, no nivel maximo, 60s, corrida propria (SEMENTE+300+indice).
    `\n  arsenal especializado (60s cada, nivel maximo, corridas proprias): ` +
    especializacao.map((r) => `${r.nome}=${r.kills}kills/${r.acertos}acertos`).join(' · ')
);
