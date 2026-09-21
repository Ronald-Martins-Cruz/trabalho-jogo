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
  subirNivelArma,
  verificarArmasDoConteudo,
} from '../src/weapons.js';
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

// Teste de carga: `npm run smoke -- --carga` enche a arena ate o teto da pool
// e mantem o jogador de pe, para medir o custo de IA + separacao + colisao no
// pior caso. Fora desse modo a corrida e a de sempre.
const CARGA = process.argv.includes('--carga');
const ALVO_CARGA = CONTEUDO.arena.limites.enemies;
if (CARGA) CONTEUDO.spawn.maxSimultaneos = ALVO_CARGA;

const POOLS = Object.keys(CONTEUDO.arena.limites).filter((p) => p !== 'eventos');

const picos = {};
for (const pool of POOLS) picos[pool] = 0;
const contadores = { avaliacoesConcluidas: 0, eventos: 0, porTipo: {} };

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

    if (estado.projectiles.length > pico) pico = estado.projectiles.length;
    for (const evento of estado.eventos) {
      if (evento.tipo === 'inimigo-morto') mortos += 1;
      if (evento.tipo === 'arma-disparo') disparos += 1;
      if (evento.tipo === 'arma-acerto') acertos += 1;
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

// ------------------------------------------------------------------ corrida

checarReciclagemDaPool();
// Antes de qualquer coisa que dispare: um `comportamento` digitado errado na
// arma inicial mata o update com stack trace cru, e a mensagem limpa daqui e
// que diz o que aconteceu.
checarArmasDoConteudo();
checarNiveisDaArma();
checarGuardaDeGeracao();
checarMemoriaDePerfuracao();
const corridaArma = checarArmaSozinha();

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
    ` · picos: ${picosTexto}`
);
