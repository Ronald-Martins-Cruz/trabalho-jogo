import { CONTEUDO } from '../data/content.js';
import { emitir } from './state.js';
import { receberDano, soltarOrbeXp } from './player.js';
import { obterPool, obterScratch } from './pool.js';

// Spawn, IA e morte dos inimigos. Nenhum objeto nasce aqui dentro do update:
// tudo sai da pool de src/pool.js, aberta com o teto de
// CONTEUDO.arena.limites.enemies. Nenhum numero de jogabilidade mora neste
// arquivo — curva de spawn, stats e forca de separacao vem de content.js.
//
// O relogio de spawn anda com run.avaliacao.decorrido, nunca com estado.tempo
// (que cresce tambem no menu e na pausa — inimigo nascendo durante a pausa e
// exatamente o bug que isso evita).

export function atualizarInimigos(estado, dt) {
  const pool = poolInimigos(estado);
  const scratchInimigos = contextoInimigos(estado);

  atualizarSpawn(estado, pool, scratchInimigos, dt);
  moverInimigos(estado, pool, scratchInimigos, dt);
  colidirComJogador(estado, pool);
}

// Unica porta para a pool de inimigos. O sincronizar() aqui e o que mantem a
// pool consistente depois de iniciarAvaliacao() esvaziar estado.enemies por
// fora: quem pega a pool ja a pega reconciliada, incluindo os testes.
export function poolInimigos(estado) {
  return obterPool(estado, 'enemies', fabricarInimigo).sincronizar();
}

// Forma unica de inimigo: todos os campos nascem aqui, com numero finito, e
// so sao reescritos em spawnInimigo(). Objeto monomorfico e sem buraco de NaN.
function fabricarInimigo() {
  return {
    ativo: false,
    slot: -1,
    nasc: 0,
    tipo: '',
    emoji: '',
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    hp: 1,
    hpMax: 1,
    velocidade: 0,
    dano: 0,
    raio: 1,
    xp: 0,
    empurraoX: 0,
    empurraoY: 0,
    nascidoEm: 0, // avaliacao.decorrido do nascimento; o relatorio mede quanto cada um viveu
  };
}

// --------------------------------------------------- scratch dos inimigos

function contextoInimigos(estado) {
  const scratch = obterScratch(estado);
  if (!scratch.inimigos) {
    scratch.inimigos = {
      relogio: 0,
      decorridoAnterior: -1,
      avaliacaoId: null,
      grade: criarGrade(),
    };
  }
  return scratch.inimigos;
}

function criarGrade() {
  const { largura, altura } = CONTEUDO.arena;
  const passo = CONTEUDO.separacao.gradePasso;
  const colunas = Math.max(1, Math.ceil(largura / passo));
  const linhas = Math.max(1, Math.ceil(altura / passo));
  const celulas = [];
  for (let i = 0; i < colunas * linhas; i += 1) celulas.push([]);
  return { passo, colunas, linhas, celulas };
}

// ------------------------------------------------------------------- spawn

function atualizarSpawn(estado, pool, scratchInimigos, dt) {
  const av = estado.run.avaliacao;

  // Avaliacao nova (ou a mesma reiniciada, quando decorrido volta pra tras):
  // o relogio de onda recomeca junto.
  if (scratchInimigos.avaliacaoId !== av.id || av.decorrido < scratchInimigos.decorridoAnterior) {
    scratchInimigos.avaliacaoId = av.id;
    scratchInimigos.relogio = 0;
  }
  scratchInimigos.decorridoAnterior = av.decorrido;

  if (!estado.player.vivo || av.concluida) return;

  const cfg = CONTEUDO.spawn;
  const curva = cfg.curvas[cfg.curvaPadrao];
  const dificuldade = CONTEUDO.ajuste.dificuldade;

  scratchInimigos.relogio += dt;
  const intervalo = Math.max(
    cfg.intervaloMinimo,
    valorNaCurva(curva, av.decorrido, 'intervalo') / dificuldade
  );
  if (scratchInimigos.relogio < intervalo) return;
  scratchInimigos.relogio -= intervalo;

  const quantidade = tamanhoDaOnda(estado.rng, curva, av.decorrido, dificuldade);
  for (let i = 0; i < quantidade; i += 1) spawnInimigo(estado);
}

// Interpolacao linear entre os pontos-chave da curva. Antes do primeiro ponto
// vale o primeiro; depois do ultimo, o ultimo.
export function valorNaCurva(pontos, t, campo) {
  if (t <= pontos[0].t) return pontos[0][campo];
  for (let i = 1; i < pontos.length; i += 1) {
    const a = pontos[i - 1];
    const b = pontos[i];
    if (t <= b.t) {
      const k = (t - a.t) / (b.t - a.t);
      return a[campo] + (b[campo] - a[campo]) * k;
    }
  }
  return pontos[pontos.length - 1][campo];
}

// A parte fracionaria da curva vira chance do inimigo extra: com porOnda=2.4,
// 40% das ondas trazem 3. Sem isso a curva andaria aos degraus.
function tamanhoDaOnda(rng, curva, decorrido, dificuldade) {
  const cfg = CONTEUDO.spawn;
  const bruto = valorNaCurva(curva, decorrido, 'porOnda') * dificuldade;
  let quantidade = Math.floor(bruto);
  if (rng.chance(bruto - quantidade)) quantidade += 1;
  return Math.max(0, Math.min(cfg.porOndaMaximo, quantidade));
}

// Nasce na borda, fora da vista, ja com os stats do tipo sorteado. Devolve o
// inimigo ou null quando o teto de simultaneos foi atingido. Fase 09 usa isto
// para as rajadas da Notificacao e para os filhotes do Trabalho em Grupo.
export function spawnInimigo(estado, tipoId = null) {
  const pool = poolInimigos(estado);
  if (pool.ativos.length >= CONTEUDO.spawn.maxSimultaneos) return null;

  const tipo = tipoId === null ? sortearTipo(estado.rng) : acharTipo(tipoId);
  if (!tipo) return null;

  const inimigo = pool.obter();
  inimigo.tipo = tipo.id;
  inimigo.emoji = tipo.emoji;
  inimigo.hpMax = tipo.hp;
  inimigo.hp = tipo.hp;
  inimigo.velocidade = tipo.velocidade;
  inimigo.dano = tipo.dano;
  inimigo.raio = tipo.raio;
  inimigo.xp = tipo.xp;
  inimigo.vx = 0;
  inimigo.vy = 0;
  inimigo.empurraoX = 0;
  inimigo.empurraoY = 0;
  inimigo.nascidoEm = estado.run.avaliacao.decorrido;
  posicionarNaBorda(inimigo, estado.rng);
  emitir(estado, 'inimigo-nasceu', { tipo: tipo.id });
  return inimigo;
}

function sortearTipo(rng) {
  const tipos = CONTEUDO.inimigos;
  let total = 0;
  for (let i = 0; i < tipos.length; i += 1) total += tipos[i].peso;
  if (total <= 0) return tipos[0] || null;
  let sorteio = rng.float() * total;
  for (let i = 0; i < tipos.length; i += 1) {
    sorteio -= tipos[i].peso;
    if (sorteio <= 0) return tipos[i];
  }
  return tipos[tipos.length - 1];
}

function acharTipo(id) {
  const tipos = CONTEUDO.inimigos;
  for (let i = 0; i < tipos.length; i += 1) if (tipos[i].id === id) return tipos[i];
  return null;
}

function posicionarNaBorda(inimigo, rng) {
  const { largura, altura, margemSpawn } = CONTEUDO.arena;
  const fora = margemSpawn + inimigo.raio;
  switch (rng.int(0, 3)) {
    case 0: // topo
      inimigo.x = rng.range(-fora, largura + fora);
      inimigo.y = -fora;
      break;
    case 1: // direita
      inimigo.x = largura + fora;
      inimigo.y = rng.range(-fora, altura + fora);
      break;
    case 2: // base
      inimigo.x = rng.range(-fora, largura + fora);
      inimigo.y = altura + fora;
      break;
    default: // esquerda
      inimigo.x = -fora;
      inimigo.y = rng.range(-fora, altura + fora);
      break;
  }
}

// ---------------------------------------------------------------------- IA

function moverInimigos(estado, pool, scratchInimigos, dt) {
  const inimigos = pool.ativos;
  if (inimigos.length === 0) return;

  preencherGrade(scratchInimigos.grade, inimigos);
  calcularSeparacao(scratchInimigos.grade, inimigos);

  const player = estado.player;
  const forca = CONTEUDO.separacao.forca;
  const descarte = CONTEUDO.spawn.margemDescarte;
  const { largura, altura } = CONTEUDO.arena;

  // De tras para frente: liberar() troca o ultimo elemento para o buraco, e
  // de tras para frente esse elemento ja foi visitado.
  for (let i = inimigos.length - 1; i >= 0; i -= 1) {
    const e = inimigos[i];

    let dx = player.x - e.x;
    let dy = player.y - e.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 0) {
      dx /= dist;
      dy /= dist;
    } else {
      dx = 0;
      dy = 0;
    }

    e.vx = dx * e.velocidade + e.empurraoX * forca;
    e.vy = dy * e.velocidade + e.empurraoY * forca;
    e.x += e.vx * dt;
    e.y += e.vy * dt;

    if (e.x < -descarte || e.x > largura + descarte || e.y < -descarte || e.y > altura + descarte) {
      pool.liberar(e);
    }
  }
}

// Grade espacial: sem ela a separacao e O(n^2) e 400 inimigos derrubam o
// quadro. As celulas sao arrays fixos, so esvaziados a cada quadro
// (length = 0), e guardam indices, nao referencias.
function preencherGrade(grade, inimigos) {
  const celulas = grade.celulas;
  for (let i = 0; i < celulas.length; i += 1) celulas[i].length = 0;
  for (let i = 0; i < inimigos.length; i += 1) {
    const e = inimigos[i];
    if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) continue;
    celulas[linhaDe(grade, e.y) * grade.colunas + colunaDe(grade, e.x)].push(i);
  }
}

function calcularSeparacao(grade, inimigos) {
  const folga = CONTEUDO.separacao.folga;

  for (let i = 0; i < inimigos.length; i += 1) {
    const e = inimigos[i];
    e.empurraoX = 0;
    e.empurraoY = 0;
    if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) continue;

    const cx = colunaDe(grade, e.x);
    const cy = linhaDe(grade, e.y);

    for (let oy = cy - 1; oy <= cy + 1; oy += 1) {
      if (oy < 0 || oy >= grade.linhas) continue;
      for (let ox = cx - 1; ox <= cx + 1; ox += 1) {
        if (ox < 0 || ox >= grade.colunas) continue;
        const celula = grade.celulas[oy * grade.colunas + ox];
        for (let k = 0; k < celula.length; k += 1) {
          const j = celula[k];
          if (j === i) continue;
          empurrar(e, inimigos[j], i, j, folga);
        }
      }
    }
  }
}

function empurrar(e, outro, i, j, folga) {
  const dx = e.x - outro.x;
  const dy = e.y - outro.y;
  const minima = e.raio + outro.raio + folga;
  const d2 = dx * dx + dy * dy;
  if (d2 >= minima * minima) return;

  // Sobreposicao exata: dividir pela distancia zero viraria NaN. O desempate
  // usa a ordem dos indices para continuar deterministico.
  if (d2 < 1e-6) {
    e.empurraoX += i < j ? 1 : -1;
    return;
  }
  const d = Math.sqrt(d2);
  const peso = (minima - d) / minima; // 0 encostando, 1 sobrepostos
  e.empurraoX += (dx / d) * peso;
  e.empurraoY += (dy / d) * peso;
}

function colunaDe(grade, x) {
  const c = Math.floor(x / grade.passo);
  if (c < 0) return 0;
  return c >= grade.colunas ? grade.colunas - 1 : c;
}

function linhaDe(grade, y) {
  const l = Math.floor(y / grade.passo);
  if (l < 0) return 0;
  return l >= grade.linhas ? grade.linhas - 1 : l;
}

// -------------------------------------------------------------------- dano

function colidirComJogador(estado, pool) {
  const player = estado.player;
  if (!player.vivo) return;

  const inimigos = pool.ativos;
  for (let i = 0; i < inimigos.length; i += 1) {
    const e = inimigos[i];
    const soma = e.raio + player.raio;
    const dx = e.x - player.x;
    const dy = e.y - player.y;
    if (dx * dx + dy * dy > soma * soma) continue;
    // Uma encostada por vez: com os i-frames ligados as outras nao valeriam
    // nada mesmo.
    const hpAntes = player.hp;
    if (receberDano(estado, e.dano)) {
      // Daqui, e nao de receberDano(): player.js nao importa state.js. Fonte
      // de dano que chame receberDano() por outro caminho (chefe, modificador)
      // emite o seu — sem isso o relatorio a registra como fonte desconhecida.
      emitir(estado, 'jogador-dano', { fonte: e.tipo, dano: hpAntes - player.hp, hp: player.hp, x: e.x, y: e.y });
      break;
    }
  }
}

// Porta unica de dano em inimigo: weapons.js chama a cada acerto de projetil.
// Devolve se o inimigo morreu com este golpe. Idempotente de proposito — dois
// projeteis que matam o mesmo inimigo no mesmo quadro emitem um evento so,
// porque o segundo encontra `ativo === false`.
export function aplicarDano(estado, inimigo, dano) {
  // Antes de olhar `ativo`: se estado.enemies foi esvaziado por fora, a flag
  // do inimigo ainda estaria mentindo que ele existe.
  const pool = poolInimigos(estado);
  if (!inimigo || !inimigo.ativo || !(dano > 0)) return false;

  inimigo.hp -= dano;
  if (inimigo.hp > 0) return false;

  inimigo.hp = 0;
  estado.run.avaliacao.kills += 1;
  // O orbe nasce no lugar da morte, antes de o objeto voltar para a pool (o
  // proximo spawn pode reaproveita-lo no mesmo quadro e a posicao mudaria).
  // Chamada direta, e nao um consumidor da fila de eventos: a fila e esvaziada
  // uma vez por QUADRO, nao por tick, e com dt fixo um quadro pode ter ate
  // maxPassosPorFrame ticks — um consumidor dentro do update veria o mesmo
  // 'inimigo-morto' varias vezes e cada morte viraria varios orbes.
  soltarOrbeXp(estado, inimigo.x, inimigo.y, inimigo.xp);
  emitir(estado, 'inimigo-morto', {
    tipo: inimigo.tipo,
    x: inimigo.x,
    y: inimigo.y,
    xp: inimigo.xp,
    vida: estado.run.avaliacao.decorrido - inimigo.nascidoEm, // segundos entre nascer e morrer
  });
  pool.liberar(inimigo);
  return true;
}

// Devolve todos os inimigos a pool. A fase 08 deve chamar isto em
// iniciarAvaliacao no lugar de `estado.enemies.length = 0` — a pool se
// conserta sozinha quando o array e esvaziado por fora, mas custa uma
// ressincronizacao O(capacidade).
export function limparInimigos(estado) {
  poolInimigos(estado).liberarTodos();
}
