import { CONTEUDO } from '../data/content.js';

// Pool de objetos generica — o coracao da restricao 5 do CLAUDE.md. Tudo que
// nasce e morre dentro do loop (inimigos agora; projeteis, orbes de XP e
// particulas nas fases seguintes) sai daqui: os objetos sao fabricados de uma
// vez so na abertura da pool e depois apenas trocam de mao entre `reserva`
// (livres) e `ativos` (em uso). Nenhum `new` dentro de update.
//
// A pool escreve tres campos em cada objeto. A fabrica pode cria-los, mas
// ninguem mais pode usa-los para outra coisa:
//   ativo — se esta em uso
//   slot  — indice do objeto dentro de `ativos` (mantido pelo swap-remove)
//   nasc  — ordem de nascimento; e o que permite reciclar o mais antigo
//
// Iteracao: `pool.ativos` contem SO os objetos em uso, entao
// `for (const x of pool.ativos)` ja e a iteracao barata. Para liberar durante
// a varredura, percorra de tras para frente — `liberar()` troca o ultimo
// elemento para o buraco, e de tras para frente esse elemento ja foi visto.

export function criarPool(capacidade, fabrica, ativos = []) {
  if (!Number.isInteger(capacidade) || capacidade < 1) {
    throw new Error(`criarPool: capacidade precisa ser inteiro >= 1, veio ${capacidade}`);
  }
  if (typeof fabrica !== 'function') throw new Error('criarPool: fabrica precisa ser funcao');

  const todos = [];
  const reserva = [];

  const pool = {
    capacidade,
    ativos, // mesma referencia do array do estado (ex.: estado.enemies)
    todos,
    reserva,
    criados: 0, // chamadas de fabrica(); depois da abertura NAO pode crescer
    nascimentos: 0,
    reciclados: 0,
    ressincronizacoes: 0,
    emUso: 0,

    // `ativos` e o array do estado e alguem de fora pode esvazia-lo:
    // iniciarAvaliacao faz `estado.enemies.length = 0`. Enquanto isso nao for
    // reconciliado, os objetos esvaziados ficam fora de `ativos` E fora de
    // `reserva` — nao se perdem, mas a pool fica inconsistente para quem
    // olhar. Toda porta de entrada da pool passa por aqui primeiro; custa uma
    // comparacao de inteiros. Devolve a propria pool para encadear.
    sincronizar() {
      if (ativos.length !== pool.emUso) pool.ressincronizar();
      return pool;
    },

    obter() {
      pool.sincronizar();
      if (reserva.length === 0) pool.reciclarMaisAntigo();

      const obj = reserva.length > 0 ? reserva.pop() : pool.fabricar();
      obj.ativo = true;
      obj.slot = ativos.length;
      pool.nascimentos += 1;
      obj.nasc = pool.nascimentos;
      ativos.push(obj);
      pool.emUso = ativos.length;
      return obj;
    },

    liberar(obj) {
      if (!obj || !obj.ativo) return false;
      const i = obj.slot;
      if (ativos[i] !== obj) {
        pool.ressincronizar();
        if (!obj.ativo) return false;
      }
      const alvo = obj.slot;
      const ultimo = ativos.pop();
      if (ultimo !== obj) {
        ativos[alvo] = ultimo;
        ultimo.slot = alvo;
      }
      obj.ativo = false;
      obj.slot = -1;
      reserva.push(obj);
      pool.emUso = ativos.length;
      return true;
    },

    liberarTodos() {
      for (let i = ativos.length - 1; i >= 0; i -= 1) pool.liberar(ativos[i]);
    },

    // Pool cheia: o contrato manda reciclar o mais antigo em vez de alocar.
    // A varredura e O(n) mas so roda quando a pool estourou, e `ativos` nunca
    // passa da capacidade por causa dela.
    reciclarMaisAntigo() {
      if (ativos.length === 0) return false;
      let maisAntigo = ativos[0];
      for (let i = 1; i < ativos.length; i += 1) {
        if (ativos[i].nasc < maisAntigo.nasc) maisAntigo = ativos[i];
      }
      if (!pool.liberar(maisAntigo)) return false;
      pool.reciclados += 1;
      return true;
    },

    // Reconstroi reserva/slots a partir de `ativos`, que e a fonte da verdade.
    ressincronizar() {
      for (let i = 0; i < todos.length; i += 1) {
        todos[i].ativo = false;
        todos[i].slot = -1;
      }
      for (let i = 0; i < ativos.length; i += 1) {
        ativos[i].ativo = true;
        ativos[i].slot = i;
      }
      reserva.length = 0;
      for (let i = 0; i < todos.length; i += 1) {
        if (!todos[i].ativo) reserva.push(todos[i]);
      }
      pool.emUso = ativos.length;
      pool.ressincronizacoes += 1;
    },

    fabricar() {
      const obj = fabrica();
      obj.ativo = false;
      obj.slot = -1;
      obj.nasc = 0;
      todos.push(obj);
      pool.criados += 1;
      return obj;
    },

    // Invariantes, para o smoke. Devolve string de erro ou null. O ponto que
    // mais importa e `criados === todos.length === capacidade`: se crescer,
    // alguem esta alocando dentro do loop.
    verificar() {
      if (pool.criados !== todos.length) {
        return `criados=${pool.criados} mas todos=${todos.length}`;
      }
      if (ativos.length + reserva.length !== todos.length) {
        return `ativos(${ativos.length}) + reserva(${reserva.length}) != todos(${todos.length})`;
      }
      if (ativos.length !== pool.emUso) {
        return `ativos=${ativos.length} mas emUso=${pool.emUso}`;
      }
      for (let i = 0; i < ativos.length; i += 1) {
        const obj = ativos[i];
        if (!obj.ativo) return `ativos[${i}] com ativo=false`;
        if (obj.slot !== i) return `ativos[${i}] com slot=${obj.slot}`;
      }
      for (let i = 0; i < reserva.length; i += 1) {
        if (reserva[i].ativo) return `reserva[${i}] com ativo=true`;
      }
      return null;
    },
  };

  for (let i = 0; i < capacidade; i += 1) reserva.push(pool.fabricar());
  return pool;
}

// Container nao enumeravel para o que e scratch de runtime: pools, grades
// espaciais, relogios de spawn. Fica fora de JSON.stringify(estado) e fora da
// varredura do smoke de proposito — sao dados reconstruiveis, nao estado de
// jogo, e o estado continua serializavel como o CLAUDE.md exige.
export function obterScratch(estado) {
  if (!estado.scratch) {
    Object.defineProperty(estado, 'scratch', {
      value: {},
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
  return estado.scratch;
}

// Pool amarrada a um array do estado: `estado[chave]` e a lista de ativos e a
// capacidade sai de CONTEUDO.arena.limites[chave] — e o que obriga toda pool
// nova a ser registrada la (o smoke vigia esse teto sozinho).
export function obterPool(estado, chave, fabrica) {
  const scratch = obterScratch(estado);
  if (!scratch.pools) scratch.pools = {};
  let pool = scratch.pools[chave];
  if (!pool) {
    const capacidade = CONTEUDO.arena.limites[chave];
    if (typeof capacidade !== 'number') {
      throw new Error(`obterPool: registre o teto da pool "${chave}" em CONTEUDO.arena.limites`);
    }
    if (!Array.isArray(estado[chave])) {
      throw new Error(`obterPool: estado.${chave} precisa ser um array`);
    }
    pool = criarPool(capacidade, fabrica, estado[chave]);
    scratch.pools[chave] = pool;
  }
  // A pool grava na REFERENCIA do array que recebeu na abertura. Trocar
  // `estado.enemies = []` (em vez de `.length = 0`) deixaria a pool escrevendo
  // num array orfao enquanto render e testes leem o array novo, sempre vazio —
  // e `verificar()` passaria, porque olha o orfao. Falha silenciosa; melhor
  // estourar aqui.
  if (pool.ativos !== estado[chave]) {
    throw new Error(
      `obterPool: estado.${chave} foi trocado por outro array depois da abertura da pool. ` +
        'Para esvaziar, chame liberarPoolsDoEstado(estado) — nunca reatribua o array.'
    );
  }
  return pool;
}

// Devolve a pool inteira de cada colecao de entidade do estado. E o que
// `iniciarAvaliacao` deve chamar: esvaziar `estado.enemies.length = 0` por fora
// tira os objetos de `ativos` sem devolve-los a `reserva`, e a pool so se
// conserta na proxima chamada de sincronizar(). Colecao ainda sem pool (fases
// 03/04 antes de chegarem) so e esvaziada.
export function liberarPoolsDoEstado(estado) {
  const pools = estado.scratch && estado.scratch.pools;
  for (const chave of Object.keys(CONTEUDO.arena.limites)) {
    // `eventos` mora em limites como teto da fila, nao como pool de entidade:
    // emitir() ja descarta o mais antigo sozinho, e limpar a fila aqui comeria
    // eventos do mesmo quadro (o 'jubilado' que acabou de ser emitido).
    if (chave === 'eventos') continue;
    const pool = pools && pools[chave];
    if (pool) pool.liberarTodos();
    else if (Array.isArray(estado[chave])) estado[chave].length = 0;
  }
}
