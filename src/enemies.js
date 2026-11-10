import { CONTEUDO } from '../data/content.js';
import { emitir } from './state.js';
import { limitarNaArena, receberDano, soltarOrbeXp } from './player.js';
import { obterPool, obterScratch } from './pool.js';
import { aoMatarInimigo } from './jokers.js';
import { contarMorteParaLanche } from './lanches.js';

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
  colidirComJogador(estado, pool, dt);
}

// Registro de comportamentos de MOVIMENTO — o mesmo padrao "dado, nao
// classe" que weapons.js usa para COMPORTAMENTOS de arma. Cada funcao recebe
// (e, player, tempoDeVida) e devolve um vetor UNITARIO { x, y } de direcao;
// moverInimigos() escala pela velocidade do inimigo. `tempoDeVida` e
// segundos desde o nascimento (av.decorrido - e.nascidoEm), usado pelo ruido
// senoidal da Notificacao para nao depender de estado.tempo (que anda
// tambem na pausa).
const MOVIMENTOS = {
  perseguir: moverPerseguir,
  errante: moverErrante,
  rumo: moverRumo,
};

// Fase 10: linha reta num rumo fixo (e.rumoX/e.rumoY, unitario), sem olhar
// para o jogador — a investida da Banca. Quem escreve o rumo e quem troca o
// `comportamento` da instancia para 'rumo' e src/boss.js; o resto (separacao,
// colisao, dano) e o de qualquer inimigo.
function moverRumo(e) {
  direcaoScratch.x = e.rumoX;
  direcaoScratch.y = e.rumoY;
  return direcaoScratch;
}

function moverPerseguir(e, player) {
  return direcaoPerseguicao(e, player);
}

// Vetor de direcao reaproveitado entre chamadas: moverInimigos() le x/y no
// mesmo instante em que MOVIMENTOS[...] devolve e nunca guarda a referencia
// de um inimigo para o proximo, entao um objeto so evita alocar um vetor por
// inimigo por quadro (180-400 deles — regra 5 do CLAUDE.md, design §8 cita
// "alocar por frame com 200+ inimigos" nomeadamente). moverErrante() escreve
// nele DEPOIS de ler base.x/base.y para dentro de variaveis locais, entao a
// mesma referencia servir de entrada e saida nao embaralha o calculo.
const direcaoScratch = { x: 0, y: 0 };

// 🔔 Notificacao: gira o ANGULO de perseguicao com uma senoide (nao soma um
// vetor solto) para o desvio nunca reduzir a velocidade efetiva — um vetor
// perpendicular somado encolheria a componente de avanco no pico do ruido;
// girar o angulo mantem o modulo em 1 o tempo todo.
//
// Correcao pos-revisao: `ruidoFrequencia` e Hz (content.js e o validador
// sempre disseram isso), e Hz vira radianos/s multiplicando por 2*PI — sem
// isso 1,4 "Hz" andava a 1,4 RAD/s de verdade, um ciclo a cada ~4,49s em vez
// de ~0,71s (a curva em S ficava lenta e previsivel, o oposto do que o
// design pede).
function moverErrante(e, player, tempoDeVida) {
  const base = direcaoPerseguicao(e, player);
  if (base.x === 0 && base.y === 0) return base;
  const anguloBase = Math.atan2(base.y, base.x);
  const desvio = e.ruidoAmplitude * Math.sin(2 * Math.PI * e.ruidoFrequencia * tempoDeVida + e.ruidoFase);
  const angulo = anguloBase + desvio;
  direcaoScratch.x = Math.cos(angulo);
  direcaoScratch.y = Math.sin(angulo);
  return direcaoScratch;
}

function direcaoPerseguicao(e, player) {
  const dx = player.x - e.x;
  const dy = player.y - e.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= 0) {
    direcaoScratch.x = 0;
    direcaoScratch.y = 0;
    return direcaoScratch;
  }
  direcaoScratch.x = dx / dist;
  direcaoScratch.y = dy / dist;
  return direcaoScratch;
}

// Para o smoke: todo inimigo de content.js precisa apontar para um
// comportamento que exista aqui. Mesmo papel de verificarArmasDoConteudo em
// weapons.js.
// Fase 10: boss.js confere o `comportamento` da Banca (que nao mora em
// CONTEUDO.inimigos) por aqui, sem precisar conhecer o registro.
export function existeMovimento(nome) {
  return Object.prototype.hasOwnProperty.call(MOVIMENTOS, nome);
}

export function verificarInimigosDoConteudo() {
  for (const tipo of CONTEUDO.inimigos) {
    if (!MOVIMENTOS[tipo.comportamento]) {
      return `inimigo "${tipo.id}": comportamento "${tipo.comportamento}" nao registrado em enemies.js ` +
        `(registrados: ${Object.keys(MOVIMENTOS).join(', ')})`;
    }
  }
  return null;
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
    comportamento: '',
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
    // Fase 09: campos opcionais por tipo, sempre presentes (numero finito
    // ou string vazia em quem nao usa) para o objeto continuar monomorfico.
    empurraoContato: 0, // px/s aplicados ao jogador em contato (📄 PDF)
    ruidoAmplitude: 0, // rad — comportamento 'errante' (🔔 Notificacao)
    ruidoFrequencia: 0, // Hz
    ruidoFase: 0, // sorteada no nascimento (estado.rng), nao Math.random
    geracao: 0, // 0 = nascido normal; N = filhote de N-esima divisao (📱)
    nascidoEm: 0, // avaliacao.decorrido do nascimento; o relatorio mede quanto cada um viveu
    // Fase 10. `chefe`: o alvo e A Banca (tipo.chefe). A separacao nao o
    // empurra, e coringas futuros que nao devem valer contra chefe (Cola na
    // Regua, pendencia 55) leem daqui. Reescrito em TODO nascimento, entao o
    // objeto da Banca reaproveitado por um 📕 (a pool e LIFO) deixa de ser chefe.
    chefe: false,
    rumoX: 0, // direcao unitaria do comportamento 'rumo' (investida da Banca)
    rumoY: 0,
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
      rajadas: {}, // relogio proprio por tipo com `rajada` (fase 09)
    };
  }
  return scratch.inimigos;
}

// Cobre o canvas inteiro, uma vez so: a arena de uma avaliacao (av.arena) e
// sempre um retangulo dentro dele, e quem esta fora cai na celula da borda
// pelo grampo de colunaDe/linhaDe. Por isso a Sala Lotada nao precisa de
// grade nova — so usa menos celulas.
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
  // os relogios de onda e de rajada recomecam junto.
  if (scratchInimigos.avaliacaoId !== av.id || av.decorrido < scratchInimigos.decorridoAnterior) {
    scratchInimigos.avaliacaoId = av.id;
    scratchInimigos.relogio = 0;
    scratchInimigos.rajadas = {};
  }
  scratchInimigos.decorridoAnterior = av.decorrido;

  if (!estado.player.vivo || av.concluida) return;

  const cfg = CONTEUDO.spawn;
  // Fase 10: cada avaliacao aponta a sua curva (o TCC tem uma propria, mais
  // rala); a padrao e a rede de seguranca, como em composicaoDaAvaliacao.
  const curva = cfg.curvas[av.curvaSpawn] || cfg.curvas[cfg.curvaPadrao];
  // A global (Mestrado/Doutorado um dia) vezes a da avaliacao: a regra
  // `dificuldade` ja traz o numero da avaliacao em content.js e o de qualquer
  // modificador que mexa nela (state.js, regrasDaAvaliacao).
  const dificuldade = CONTEUDO.ajuste.dificuldade * av.regras.dificuldade;
  const composicao = composicaoDaAvaliacao(av);

  scratchInimigos.relogio += dt;
  const intervalo = Math.max(
    cfg.intervaloMinimo,
    valorNaCurva(curva, av.decorrido, 'intervalo') / dificuldade
  );
  if (scratchInimigos.relogio >= intervalo) {
    scratchInimigos.relogio -= intervalo;
    const quantidade = tamanhoDaOnda(estado.rng, curva, av.decorrido, dificuldade);
    for (let i = 0; i < quantidade; i += 1) spawnInimigo(estado);
  }

  // Fora da onda normal, num relogio proprio por tipo: a rajada da
  // Notificacao (design §8). So conta o tempo para tipos que estao na
  // composicao desta avaliacao — sem isso p1-av1 ("so o Prazo") ganharia
  // rajadas de um tipo que nem deveria poder nascer ali.
  for (let i = 0; i < CONTEUDO.inimigos.length; i += 1) {
    const tipo = CONTEUDO.inimigos[i];
    if (!tipo.rajada || !(pesoNaComposicao(composicao, tipo.id) > 0)) continue;

    if (scratchInimigos.rajadas[tipo.id] === undefined) {
      scratchInimigos.rajadas[tipo.id] = tipo.rajada.intervalo / dificuldade;
    }
    scratchInimigos.rajadas[tipo.id] -= dt;
    if (scratchInimigos.rajadas[tipo.id] > 0) continue;
    scratchInimigos.rajadas[tipo.id] += Math.max(cfg.intervaloMinimo, tipo.rajada.intervalo / dificuldade);

    spawnRajada(estado, tipo, tipo.rajada.tamanho);
  }
}

// A composicao de spawn (quais tipos, com que peso) da avaliacao corrente —
// CONTEUDO.spawn.composicoes[av.composicaoSpawn], com a mesma rede de
// seguranca que curvaPadrao tem para quem chega aqui sem passar por uma
// avaliacao de verdade (ex.: teste que monta `estado.run.avaliacao` na mao).
function composicaoDaAvaliacao(av) {
  const cfg = CONTEUDO.spawn;
  return cfg.composicoes[av.composicaoSpawn] || cfg.composicoes[cfg.composicaoPadrao];
}

function pesoNaComposicao(composicao, id) {
  const peso = composicao[id];
  return typeof peso === 'number' ? peso : 0;
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
// para as rajadas da Notificacao (tipoId explicito).
export function spawnInimigo(estado, tipoId = null) {
  const pool = poolInimigos(estado);
  if (pool.ativos.length >= CONTEUDO.spawn.maxSimultaneos) return null;

  const av = estado.run.avaliacao;
  const tipo = tipoId === null ? sortearTipo(estado.rng, composicaoDaAvaliacao(av)) : acharTipo(tipoId);
  if (!tipo) return null;

  const inimigo = pool.obter();
  inicializarInimigo(inimigo, tipo, av, estado.rng);
  posicionarNaBorda(inimigo, estado.rng, av.arena);
  emitir(estado, 'inimigo-nasceu', { tipo: tipo.id });
  return inimigo;
}

// Fase 10: nasce um inimigo de um tipo que NAO mora em CONTEUDO.inimigos — A
// Banca (CONTEUDO.banca), com o mesmo contrato de campos — num ponto dado.
// Sem o teto de spawn.maxSimultaneos: o chefe nasce numa arena recem-limpa
// (iniciarAvaliacao esvazia a pool) e nao pode ficar de fora por causa dele.
// Mesmo caminho de inicializacao de todo inimigo, entao as regras da
// avaliacao (hpInimigo, velocidadeInimigo) valem para ele tambem.
export function spawnTipo(estado, tipo, x, y) {
  const pool = poolInimigos(estado);
  const inimigo = pool.obter();
  inicializarInimigo(inimigo, tipo, estado.run.avaliacao, estado.rng);
  inimigo.x = x;
  inimigo.y = y;
  emitir(estado, 'inimigo-nasceu', { tipo: tipo.id });
  return inimigo;
}

// Escreve TODOS os campos de jogabilidade de um inimigo (nao mexe em
// x/y — spawnInimigo poe na borda, dividirSeAplicavel poe no lugar da morte).
// `overrides` e so usado pelos filhotes do Trabalho em Grupo: os fatores de
// tipo.divisao E a geracao. Sem overrides, e exatamente o nascimento normal
// (fatores 1, geracao 0) — um so caminho para as regras da avaliacao
// (Professor Rigido, Sexta as 18h) entrarem, filhote ou nao.
function inicializarInimigo(inimigo, tipo, av, rng, overrides = null) {
  const hpFator = overrides ? overrides.hpFator : 1;
  const velocidadeFator = overrides ? overrides.velocidadeFator : 1;
  const raioFator = overrides ? overrides.raioFator : 1;
  const xpFator = overrides ? overrides.xpFator : 1;
  const danoFator = overrides ? overrides.danoFator : 1;

  inimigo.tipo = tipo.id;
  inimigo.emoji = tipo.emoji;
  inimigo.comportamento = tipo.comportamento;
  inimigo.hpMax = tipo.hp * hpFator * av.regras.hpInimigo;
  inimigo.hp = inimigo.hpMax;
  inimigo.velocidade = tipo.velocidade * velocidadeFator * av.regras.velocidadeInimigo;
  inimigo.dano = tipo.dano * danoFator;
  inimigo.raio = tipo.raio * raioFator;
  inimigo.xp = tipo.xp * xpFator;
  inimigo.empurraoContato = tipo.empurraoContato || 0;
  inimigo.ruidoAmplitude = tipo.ruido ? tipo.ruido.amplitude : 0;
  inimigo.ruidoFrequencia = tipo.ruido ? tipo.ruido.frequencia : 0;
  // Fase sorteada no nascimento (nao no fabricarInimigo, que so roda na
  // abertura da pool): cada Notificacao oscila fora de sincronia das outras,
  // senao a rajada inteira balancaria junto como um bloco so.
  inimigo.ruidoFase = tipo.ruido ? rng.float() * Math.PI * 2 : 0;
  inimigo.geracao = overrides ? overrides.geracao : 0;
  inimigo.chefe = tipo.chefe === true;
  inimigo.rumoX = 0;
  inimigo.rumoY = 0;
  inimigo.vx = 0;
  inimigo.vy = 0;
  inimigo.empurraoX = 0;
  inimigo.empurraoY = 0;
  inimigo.nascidoEm = av.decorrido;
}

function sortearTipo(rng, composicao) {
  const tipos = CONTEUDO.inimigos;
  let total = 0;
  for (let i = 0; i < tipos.length; i += 1) total += pesoNaComposicao(composicao, tipos[i].id);
  if (total <= 0) return tipos[0] || null;
  let sorteio = rng.float() * total;
  for (let i = 0; i < tipos.length; i += 1) {
    const peso = pesoNaComposicao(composicao, tipos[i].id);
    if (peso <= 0) continue;
    sorteio -= peso;
    if (sorteio <= 0) return tipos[i];
  }
  for (let i = tipos.length - 1; i >= 0; i -= 1) {
    if (pesoNaComposicao(composicao, tipos[i].id) > 0) return tipos[i];
  }
  return tipos[0] || null;
}

function acharTipo(id) {
  const tipos = CONTEUDO.inimigos;
  for (let i = 0; i < tipos.length; i += 1) if (tipos[i].id === id) return tipos[i];
  return null;
}

// Em volta da arena DA AVALIACAO: com a Sala Lotada eles nascem a mesma
// distancia da parede de sempre, e o tempo ate chegar no jogador nao muda —
// muda o espaco que ele tem para desviar.
function posicionarNaBorda(inimigo, rng, arena) {
  const { margemSpawn } = CONTEUDO.arena;
  const fora = margemSpawn + inimigo.raio;
  const { esquerda, topo, direita, base } = arena;
  switch (rng.int(0, 3)) {
    case 0: // topo
      inimigo.x = rng.range(esquerda - fora, direita + fora);
      inimigo.y = topo - fora;
      break;
    case 1: // direita
      inimigo.x = direita + fora;
      inimigo.y = rng.range(topo - fora, base + fora);
      break;
    case 2: // base
      inimigo.x = rng.range(esquerda - fora, direita + fora);
      inimigo.y = base + fora;
      break;
    default: // esquerda
      inimigo.x = esquerda - fora;
      inimigo.y = rng.range(topo - fora, base + fora);
      break;
  }
}

// Correcao pos-revisao: a rajada nasce AGRUPADA no espaco, nao espalhada nos
// 4 lados da arena — sorteia-se UM ponto de borda por rajada (pontoNaBorda) e
// cada membro desliza ate `rajada.espalhamento` px dali, sempre COLADO na
// mesma borda (posicionarNoGrupo). Antes, cada spawnInimigo() sorteava o lado
// de novo, e uma rajada de 4 podia cair em 3 lados diferentes — indistinguivel
// da onda normal para o jogador. spawnInimigo() continua sendo quem decide
// stats e o teto de spawn.maxSimultaneos (aqui so a POSICAO e sobrescrita
// depois); a arena usada e a da avaliacao corrente (av.arena), entao a Sala
// Lotada encolhe o grupo junto com o resto do spawn.
function spawnRajada(estado, tipo, quantidade) {
  const av = estado.run.avaliacao;
  const fora = CONTEUDO.arena.margemSpawn + tipo.raio;
  const ancora = pontoNaBorda(estado.rng, av.arena, fora, ANCORA_RAJADA);
  const espalhamento = (tipo.rajada && tipo.rajada.espalhamento) || 0;

  for (let i = 0; i < quantidade; i += 1) {
    const inimigo = spawnInimigo(estado, tipo.id);
    if (inimigo) posicionarNoGrupo(inimigo, estado.rng, av.arena, ancora, fora, espalhamento);
  }
}

// A ancora da rajada, reaproveitada (pendencia 71): spawnRajada a escreve e
// le no mesmo tick, e nada guarda a referencia depois.
const ANCORA_RAJADA = { lado: 0, x: 0, y: 0 };

// Mesma escolha de lado/coordenada de posicionarNaBorda, mas sorteada UMA vez
// (por rajada, nao por inimigo) e guardando o lado — e o que deixa
// posicionarNoGrupo saber em qual eixo espalhar os membros. Escreve em
// `saida`; a ordem dos sorteios e a de sempre (lado, depois a coordenada).
function pontoNaBorda(rng, arena, fora, saida) {
  const { esquerda, topo, direita, base } = arena;
  const lado = rng.int(0, 3);
  saida.lado = lado;
  switch (lado) {
    case 0: // topo
      saida.x = rng.range(esquerda - fora, direita + fora);
      saida.y = topo - fora;
      break;
    case 1: // direita
      saida.x = direita + fora;
      saida.y = rng.range(topo - fora, base + fora);
      break;
    case 2: // base
      saida.x = rng.range(esquerda - fora, direita + fora);
      saida.y = base + fora;
      break;
    default: // esquerda
      saida.x = esquerda - fora;
      saida.y = rng.range(topo - fora, base + fora);
      break;
  }
  return saida;
}

// Desliza um membro da rajada ao redor da ancora, SO ao longo da borda (o
// eixo perpendicular fica preso na mesma distancia da parede que
// posicionarNaBorda usaria) — mantem o grupo "na borda", nao numa nuvem solta
// dentro da arena, e clampado ao mesmo intervalo que o sorteio normal usaria
// para essa borda.
function posicionarNoGrupo(inimigo, rng, arena, ancora, fora, espalhamento) {
  const { esquerda, topo, direita, base } = arena;
  const offset = espalhamento > 0 ? rng.range(-espalhamento, espalhamento) : 0;
  if (ancora.lado === 0 || ancora.lado === 2) { // topo/base: desliza em x
    inimigo.x = Math.min(direita + fora, Math.max(esquerda - fora, ancora.x + offset));
    inimigo.y = ancora.y;
  } else { // esquerda/direita: desliza em y
    inimigo.x = ancora.x;
    inimigo.y = Math.min(base + fora, Math.max(topo - fora, ancora.y + offset));
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
  const av = estado.run.avaliacao;
  const { esquerda, topo, direita, base } = av.arena;

  // De tras para frente: liberar() troca o ultimo elemento para o buraco, e
  // de tras para frente esse elemento ja foi visitado.
  for (let i = inimigos.length - 1; i >= 0; i -= 1) {
    const e = inimigos[i];

    // `comportamento` decide so a DIRECAO (perseguir vs errante); a mistura
    // com a separacao (empurraoX/Y) e sempre a mesma, senao um inimigo
    // erratico atravessaria o resto do bando.
    const movimento = MOVIMENTOS[e.comportamento] || MOVIMENTOS.perseguir;
    const dir = movimento(e, player, av.decorrido - e.nascidoEm);

    e.vx = dir.x * e.velocidade + e.empurraoX * forca;
    e.vy = dir.y * e.velocidade + e.empurraoY * forca;
    e.x += e.vx * dt;
    e.y += e.vy * dt;

    if (e.x < esquerda - descarte || e.x > direita + descarte || e.y < topo - descarte || e.y > base + descarte) {
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
    // O chefe abre caminho: o bando e empurrado por ele (o laco dos OUTROS o
    // ve como vizinho), mas ele nao e empurrado pelo bando — senao os 📕 que
    // ele mesmo invoca o arrastariam no meio do aviso de um padrao.
    if (e.chefe) continue;

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

// Alem do dano por contato, o 📄 PDF de 300 Paginas EMPURRA o jogador
// enquanto os corpos se sobrepoem (tipo.empurraoContato, px/s) — e o que
// cumpre "bloqueia rota de fuga" (design §8) sem exigir IA nova nenhuma: o
// corpo grande dele e o obstaculo.
function colidirComJogador(estado, pool, dt) {
  const player = estado.player;
  if (!player.vivo) return;

  const inimigos = pool.ativos;
  let empurraoX = 0;
  let empurraoY = 0;
  let houveDano = false;

  for (let i = 0; i < inimigos.length; i += 1) {
    const e = inimigos[i];
    const soma = e.raio + player.raio;
    const dx = player.x - e.x;
    const dy = player.y - e.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > soma * soma) continue;

    if (e.empurraoContato > 0) {
      const d = Math.sqrt(d2);
      if (d > 0) {
        empurraoX += (dx / d) * e.empurraoContato;
        empurraoY += (dy / d) * e.empurraoContato;
      } else {
        // Sobreposicao exata: direcao arbitraria mas deterministica, so pra
        // nao dividir por zero — nunca acontece na pratica (o inimigo chega
        // perseguindo, nao nasce em cima do jogador).
        empurraoX += e.empurraoContato;
      }
    }

    // Uma encostada de DANO por vez: com os i-frames ligados as outras nao
    // valeriam nada mesmo. O empurrao, acima, nao tem essa trava — e contato
    // fisico, nao dano, e continua enquanto os corpos se sobrepuserem.
    if (houveDano) continue;
    const hpAntes = player.hp;
    if (receberDano(estado, e.dano)) {
      // Daqui, e nao de receberDano(): player.js nao importa state.js. Fonte
      // de dano que chame receberDano() por outro caminho (chefe, modificador)
      // emite o seu — sem isso o relatorio a registra como fonte desconhecida.
      emitir(estado, 'jogador-dano', { fonte: e.tipo, dano: hpAntes - player.hp, hp: player.hp, x: e.x, y: e.y });
      houveDano = true;
    }
  }

  if (empurraoX !== 0 || empurraoY !== 0) {
    player.x += empurraoX * dt;
    player.y += empurraoY * dt;
    // O push acontece FORA do passo normal de atualizarPlayer (que ja rodou
    // este quadro, antes dos inimigos) — sem grampear aqui, o jogador ficaria
    // fora da arena ate o proximo quadro clamar de novo.
    limitarNaArena(player, estado.run.avaliacao.arena);
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
  // Pos-entrega: de tantas em tantas mortes, um biscoito (lanches.js).
  contarMorteParaLanche(estado, inimigo.x, inimigo.y);
  // Hook de coringa, ainda com o inimigo inteiro (tipo, posicao) antes de ele
  // voltar para a pool.
  aoMatarInimigo(estado, inimigo);
  emitir(estado, 'inimigo-morto', {
    tipo: inimigo.tipo,
    x: inimigo.x,
    y: inimigo.y,
    xp: inimigo.xp,
    vida: estado.run.avaliacao.decorrido - inimigo.nascidoEm, // segundos entre nascer e morrer
  });

  // Capturado ANTES de liberar: depois de pool.liberar(inimigo) o objeto pode
  // ser reciclado por qualquer obter() seguinte (inclusive o dos proprios
  // filhotes, mais abaixo) e passar a representar outra coisa.
  const tipo = acharTipo(inimigo.tipo);
  const x = inimigo.x;
  const y = inimigo.y;
  const geracao = inimigo.geracao;

  pool.liberar(inimigo);

  // 📱 Trabalho em Grupo (ou qualquer tipo futuro com `divisao`): SO depois
  // de liberar, nunca antes — pool.obter() dentro da divisao pode reciclar o
  // objeto mais antigo da pool, e se a pool estiver cheia esse "mais antigo"
  // poderia ser o proprio `inimigo` que este bloco ainda estivesse segurando.
  // Liberado primeiro, ele volta pra `reserva` como qualquer outro objeto
  // morto — reaproveita-lo num filhote e o caminho normal da pool, nao um
  // caso especial.
  if (tipo) dividirSeAplicavel(estado, pool, tipo, geracao, x, y);
  return true;
}

// Profundidade travada por tipo.divisao.geracaoMaxima (1 = filhote nao
// divide de novo) e por CONTEUDO.spawn.maxSimultaneos, verificado ANTES de
// cada obter(): com o pool no teto, uma morte simplesmente nao produz
// filhote nenhum — recursao de divisao com pool cheio e o jeito mais curto
// de travar o jogo (tarefa 3 do contrato da fase 09), entao o teto tem que
// ganhar sempre, nunca so no primeiro filhote.
// Os fatores do filhote, reaproveitados (pendencia 71): inicializarInimigo os
// le na hora e ninguem guarda a referencia.
const FATORES_FILHOTE = { hpFator: 1, velocidadeFator: 1, raioFator: 1, xpFator: 1, danoFator: 1, geracao: 0 };

function dividirSeAplicavel(estado, pool, tipo, geracao, x, y) {
  const divisao = tipo.divisao;
  if (!divisao || geracao >= divisao.geracaoMaxima) return;

  const av = estado.run.avaliacao;
  const overrides = FATORES_FILHOTE;
  overrides.hpFator = divisao.hpFator;
  overrides.velocidadeFator = divisao.velocidadeFator;
  overrides.raioFator = divisao.raioFator;
  overrides.xpFator = divisao.xpFator;
  overrides.danoFator = divisao.danoFator;
  overrides.geracao = geracao + 1;

  for (let i = 0; i < divisao.filhos; i += 1) {
    if (pool.ativos.length >= CONTEUDO.spawn.maxSimultaneos) return;

    const filhote = pool.obter();
    inicializarInimigo(filhote, tipo, av, estado.rng, overrides);
    const angulo = estado.rng.float() * Math.PI * 2;
    filhote.x = x + Math.cos(angulo) * divisao.raioSpawn;
    filhote.y = y + Math.sin(angulo) * divisao.raioSpawn;
    emitir(estado, 'inimigo-nasceu', { tipo: tipo.id });
  }
}

// Devolve todos os inimigos a pool. A fase 08 deve chamar isto em
// iniciarAvaliacao no lugar de `estado.enemies.length = 0` — a pool se
// conserta sozinha quando o array e esvaziado por fora, mas custa uma
// ressincronizacao O(capacidade).
export function limparInimigos(estado) {
  poolInimigos(estado).liberarTodos();
}
