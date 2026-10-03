import { CONTEUDO } from '../data/content.js';
import { emitir } from './state.js';
import { obterPool } from './pool.js';
import { aplicarDano, poolInimigos } from './enemies.js';
import { aoCalcularDano } from './jokers.js';

// Armas e projeteis. A regra desta fase: **arma e dado, nao classe**. Cada
// entrada de CONTEUDO.armas aponta um `comportamento` para uma das funcoes
// registradas em COMPORTAMENTOS aqui embaixo, e leva TODOS os seus numeros num
// array `niveis`. Nenhuma arma especifica esta codificada neste arquivo — a
// fase 05 acrescenta Caneta Bic, Resumo e Marca-texto so escrevendo em
// content.js (se o comportamento ja existir) ou registrando uma funcao nova.
//
// O cooldown mora na instancia, dentro do estado (`estado.player.armas`), e
// nunca numa variavel de modulo: iniciarAvaliacao() troca o player inteiro, e
// um cooldown de modulo sobreviveria a troca e ficaria mentindo.

// Registro de comportamentos. Assinatura de todos:
//   (estado, arma, dados, nivel, dt) -> boolean
// `arma` e a instancia no estado, `dados` e a entrada de content.js, `nivel` e
// o objeto de numeros do nivel atual, e `dt` e o passo fixo do quadro. O
// retorno so serve de sinal informativo (nao ha mais gate central de cadencia
// aqui — ver o comentario de atualizarArma() logo abaixo).
//
// A fase 03 entregou so projetilMirado. A fase 05 acrescentou orbital
// (Caneta Bic), ondaArea (Resumo) e feixe (Marca-texto) SEM tocar em nenhuma
// arma especifica: cada uma e so uma entrada em content.js apontando pra uma
// destas funcoes.
const COMPORTAMENTOS = {
  projetilMirado,
  orbital,
  ondaArea,
  feixe,
};

// ------------------------------------------------------------------ armas

export function atualizarArmas(estado, dt) {
  const player = estado.player;
  if (player.vivo) {
    for (let i = 0; i < player.armas.length; i += 1) {
      atualizarArma(estado, player.armas[i], dt);
    }
  }
  atualizarProjeteis(estado, dt);
}

// A fase 03 tinha um portao unico de cadencia aqui: decrementava o cooldown,
// so chamava o comportamento quando zerava, e aplicava nivel.cadencia sozinha
// no retorno. Isso presumia que TODA arma dispara em pulsos discretos — valia
// para o Café, mas orbital e feixe sao CONTINUOS (orbitam e causam dano todo
// quadro, sem pausa entre "disparos"). Um portao central de cadencia mataria
// o continuo; por isso cada comportamento agora controla o proprio ritmo:
// projetilMirado e ondaArea ainda usam arma.cooldown do jeito antigo (o campo
// e o contrato continuam os mesmos), so que a leitura/escrita mora na propria
// funcao. orbital e feixe simplesmente agem a cada quadro.
function atualizarArma(estado, arma, dt) {
  const dados = dadosDaArma(arma.id);
  if (!dados) return;
  const nivel = nivelDaArma(arma);
  if (!nivel) return;

  const comportamento = COMPORTAMENTOS[dados.comportamento];
  if (!comportamento) {
    throw new Error(
      `arma "${dados.id}": comportamento "${dados.comportamento}" nao existe em weapons.js ` +
        `(registrados: ${Object.keys(COMPORTAMENTOS).join(', ')})`
    );
  }

  comportamento(estado, arma, dados, nivel, dt);
}

// A arma inicial (CONTEUDO.arma.inicial) e equipada uma vez, no comeco da
// avaliacao, por run.js comecarAvaliacao() — nao mais a cada tick aqui.
export function equiparArma(estado, id) {
  const dados = dadosDaArma(id);
  if (!dados) return null;
  const existente = acharInstancia(estado, id);
  if (existente) return existente;
  const arma = { id: dados.id, nivel: 1, cooldown: 0 };
  estado.player.armas.push(arma);
  emitir(estado, 'arma-equipada', { arma: dados.id, nivel: 1 });
  return arma;
}

// Fase 04 (carta de nivel) chama isto. Devolve false quando a arma ja esta no
// nivel maximo — quem oferece a carta usa isso para nao oferecer o que nao sobe.
export function subirNivelArma(estado, id) {
  const arma = acharInstancia(estado, id);
  if (!arma) return false;
  const dados = dadosDaArma(id);
  if (!dados || arma.nivel >= dados.niveis.length) return false;
  arma.nivel += 1;
  emitir(estado, 'arma-nivel', { arma: id, nivel: arma.nivel });
  return true;
}

export function dadosDaArma(id) {
  const armas = CONTEUDO.armas;
  for (let i = 0; i < armas.length; i += 1) if (armas[i].id === id) return armas[i];
  return null;
}

// Os numeros do nivel atual de uma instancia. Grampeado nas duas pontas para
// que um nivel fora da faixa nunca vire `undefined` dentro do update.
export function nivelDaArma(arma) {
  const dados = dadosDaArma(arma.id);
  if (!dados || dados.niveis.length === 0) return null;
  const i = Math.min(Math.max(arma.nivel, 1), dados.niveis.length) - 1;
  return dados.niveis[i];
}

function acharInstancia(estado, id) {
  const armas = estado.player.armas;
  for (let i = 0; i < armas.length; i += 1) if (armas[i].id === id) return armas[i];
  return null;
}

// Para o smoke: toda arma de content.js precisa apontar para um comportamento
// que exista aqui. Sem isto, uma arma nova da fase 05 so quebraria no instante
// do primeiro disparo, dentro do update.
export function verificarArmasDoConteudo() {
  for (const arma of CONTEUDO.armas) {
    if (!COMPORTAMENTOS[arma.comportamento]) {
      return `arma "${arma.id}": comportamento "${arma.comportamento}" nao registrado em weapons.js ` +
        `(registrados: ${Object.keys(COMPORTAMENTOS).join(', ')})`;
    }
  }
  if (!dadosDaArma(CONTEUDO.arma.inicial)) {
    return `arma.inicial "${CONTEUDO.arma.inicial}" nao existe em CONTEUDO.armas`;
  }
  return null;
}

// --------------------------------------------------------- comportamentos

// ☕ Café e qualquer arma que atire no inimigo mais proximo. O projetil sai
// reto, na direcao em que o alvo estava no instante do disparo: nao e
// teleguiado de proposito — errar quem desviou e a contrapartida da cadencia
// alta. Com projeteis > 1 o disparo vira um leque de `dispersao` radianos.
//
// Comportamento DISCRETO: controla o proprio arma.cooldown (decrementa dt, so
// age quando chega a zero). Sem alvo, zera o cooldown em vez de deixar
// negativo — senao a arma dispararia uma rajada no instante em que o primeiro
// inimigo aparecesse.
function projetilMirado(estado, arma, dados, nivel, dt) {
  arma.cooldown -= dt;
  if (arma.cooldown > 0) return false;

  const player = estado.player;
  const alvo = inimigoMaisProximo(estado, player.x, player.y, nivel.alcance);
  if (!alvo) {
    arma.cooldown = 0;
    return false;
  }

  const angulo = Math.atan2(alvo.y - player.y, alvo.x - player.x);
  const quantidade = Math.max(1, nivel.projeteis);
  const passo = quantidade > 1 ? nivel.dispersao / (quantidade - 1) : 0;
  const inicio = quantidade > 1 ? angulo - nivel.dispersao / 2 : angulo;

  for (let i = 0; i < quantidade; i += 1) {
    const a = inicio + passo * i;
    dispararProjetil(estado, dados, nivel, player.x, player.y, Math.cos(a), Math.sin(a));
  }
  emitir(estado, 'arma-disparo', { arma: dados.id, x: player.x, y: player.y, angulo });
  // Soma em vez de atribuir: preserva a fracao de segundo que passou do
  // cooldown e mantem a cadencia estavel mesmo com dt fixo.
  arma.cooldown += nivel.cadencia;
  return true;
}

// ✏️ Caneta Bic orbita o jogador continuamente e fere por contato. E
// CONTINUO: nao ha "disparo", o angulo avanca TODO quadro (independente de
// qualquer cooldown) e a colisao roda todo quadro contra os inimigos ativos.
// O cooldown por inimigo (nivel.intervaloDano) existe para um unico inimigo
// parado dentro da caneta nao levar 60 acertos por segundo — sem ele a arma
// mataria tudo que encostasse num unico quadro.
//
// `arma.angulo` acumula a rotacao (a fase 03 ja previa este campo na
// instancia). `arma.golpes` e a memoria de quem foi atingido e quando pode
// ser atingido de novo — mesma guarda de geracao (ref+nasc) que o projetil
// perfurante usa, so que aqui o "ja atingiu" EXPIRA sozinho (`expiraEm`), em
// vez de durar o voo inteiro. Alocada uma unica vez, no primeiro quadro
// depois de equipar — nao a cada quadro — o mesmo padrao de scratch
// preguicoso que `contextoInimigos()` usa em enemies.js.
function orbital(estado, arma, dados, nivel, dt) {
  arma.angulo = (arma.angulo || 0) + nivel.velocidadeAngular * dt;
  if (!arma.golpes) arma.golpes = criarMemoriaGolpes(CONTEUDO.orbital.memoriaAlvos);

  const player = estado.player;
  const inimigos = poolInimigos(estado).ativos;
  const agora = estado.run.avaliacao.decorrido;
  let atingiu = false;

  for (let s = 0; s < nivel.quantidade; s += 1) {
    const pos = posicaoSatelite(player, arma, nivel, s);
    // De tras para frente: aplicarDano() pode liberar o inimigo morto, e
    // liberar() troca o ultimo elemento para o buraco.
    for (let i = inimigos.length - 1; i >= 0; i -= 1) {
      const e = inimigos[i];
      const soma = nivel.raioColisao + e.raio;
      const dx = e.x - pos.x;
      const dy = e.y - pos.y;
      if (dx * dx + dy * dy > soma * soma) continue;
      if (emCooldown(arma.golpes, e, agora)) continue;

      lembrarGolpe(arma.golpes, e, agora + nivel.intervaloDano, agora);
      golpear(estado, e, nivel.dano, dados.id);
      atingiu = true;
    }
  }
  return atingiu;
}

// Posicao de uma caneta orbitando, na ordem i = 0..quantidade-1. Pura (nao
// muta nada): weapons.js usa para colisao e render.js usa para desenhar, sem
// duplicar a formula nem arriscar os dois lados desenharem coisas diferentes.
export function posicaoSatelite(player, arma, nivel, i) {
  const passo = (Math.PI * 2) / nivel.quantidade;
  const angulo = (arma.angulo || 0) + passo * i;
  return {
    x: player.x + Math.cos(angulo) * nivel.raioOrbita,
    y: player.y + Math.sin(angulo) * nivel.raioOrbita,
  };
}

// 📝 Resumo pulsa uma onda circular ao redor do jogador a cada nivel.cadencia
// segundos: dano e empurrao em quem estiver dentro do raio. Sempre "dispara"
// — e uma onda automatica, nao depende de achar alvo — entao arma.cooldown
// funciona identico ao de projetilMirado (DISCRETO, controlado aqui dentro).
//
// O empurrao e um deslocamento INSTANTANEO em px, nao uma velocidade: nao da
// para dar impulso de verdade escrevendo em e.empurraoX/Y, porque
// calcularSeparacao() de enemies.js zera e recalcula esses campos do zero
// TODO quadro a partir da grade de vizinhanca, antes mesmo de moverInimigos
// usa-los — qualquer valor externo escrito ali e apagado antes de ser lido.
// Um empurraozinho de posicao direto e mais simples e nao exige tocar em
// enemies.js (ver decisao no handoff da fase 05).
//
// `arma.animacao` cresce TODO quadro, de 0 ate CONTEUDO.ondaArea.duracaoAnimacao,
// e zera de novo a cada pulso: e o que da ao render.js o "circulo que cresce"
// do telegrafo, sem o qual o dano pareceria aleatorio (tarefa 2 do contrato).
function ondaArea(estado, arma, dados, nivel, dt) {
  arma.animacao = Math.min(CONTEUDO.ondaArea.duracaoAnimacao, (arma.animacao || 0) + dt);

  arma.cooldown -= dt;
  if (arma.cooldown > 0) return false;
  arma.cooldown += nivel.cadencia;
  arma.animacao = 0;

  const player = estado.player;
  const inimigos = poolInimigos(estado).ativos;

  for (let i = inimigos.length - 1; i >= 0; i -= 1) {
    const e = inimigos[i];
    const soma = nivel.raio + e.raio;
    const dx = e.x - player.x;
    const dy = e.y - player.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > soma * soma) continue;

    // O acerto e registrado ANTES do empurrao, no lugar em que a onda pegou.
    // O chefe nao e empurrado (pendencia 77): A Banca fica parada no aviso e
    // na virada de fase, e o aviso da investida mostra o caminho a partir de
    // onde ela esta — empurrada, ela correria por outra faixa.
    const matou = golpear(estado, e, nivel.dano, dados.id);
    if (!matou && !e.chefe) {
      const d = Math.sqrt(d2);
      const dirX = d > 0 ? dx / d : 0;
      const dirY = d > 0 ? dy / d : 0;
      e.x += dirX * nivel.empurrao;
      e.y += dirY * nivel.empurrao;
    }
  }
  // angulo:0 porque a onda nao tem direcao — e simetrica ao redor do jogador.
  emitir(estado, 'arma-disparo', { arma: dados.id, x: player.x, y: player.y, angulo: 0 });
  return true;
}

// 🖍️ Marca-texto e um feixe CONTINUO na direcao do movimento: atravessa todo
// mundo (nao ha projetil nem perfuracao — o "feixe" e so uma forma geometrica
// recalculada a cada quadro) e da nivel.dano por SEGUNDO, nao por acerto —
// `dt` escala o dano deste quadro especifico.
//
// `arma.angulo` guarda a direcao atual e so gira quando o jogador esta
// realmente se movendo (velocidade > 0); parado, mantem a ultima direcao —
// decisao explicita do contrato desta fase para o feixe nao sumir quando o
// jogador para. aplicarAtrito() em player.js zera vx/vy exatamente (nao so
// assintoticamente), entao "parado" aqui e sempre um zero de verdade, sem
// limiar arbitrario para configurar em content.js.
function feixe(estado, arma, dados, nivel, dt) {
  const player = estado.player;
  const vx = player.vx;
  const vy = player.vy;
  if (vx * vx + vy * vy > 0) {
    arma.angulo = Math.atan2(vy, vx);
  } else if (arma.angulo === undefined) {
    arma.angulo = 0; // direcao padrao antes do primeiro movimento
  }

  const dirX = Math.cos(arma.angulo);
  const dirY = Math.sin(arma.angulo);
  const meiaLargura = nivel.largura / 2;
  const dano = nivel.dano * dt;

  const inimigos = poolInimigos(estado).ativos;
  let atingiu = false;
  for (let i = inimigos.length - 1; i >= 0; i -= 1) {
    const e = inimigos[i];
    const dx = e.x - player.x;
    const dy = e.y - player.y;
    // Distancia do inimigo ao segmento [jogador, jogador + direcao*alcance]:
    // projeta no eixo do feixe, depois mede o quanto sobra na perpendicular.
    const proj = dx * dirX + dy * dirY;
    if (proj < -e.raio || proj > nivel.alcance + e.raio) continue;
    const perpX = dx - dirX * proj;
    const perpY = dy - dirY * proj;
    const limite = meiaLargura + e.raio;
    if (perpX * perpX + perpY * perpY > limite * limite) continue;

    golpear(estado, e, dano, dados.id);
    atingiu = true;
  }
  return atingiu;
}

// Porta unica de golpe de arma em inimigo: todo comportamento passa aqui. E
// o UNICO lugar que chama o hook aoCalcularDano — o dano da arma entra cru,
// os coringas o modificam (Vespera, Grupo de WhatsApp) e so entao ele e
// aplicado. O evento leva o dano ja modificado, senao o relatorio de
// balanceamento veria overkill negativo com coringa de dano.
// `efetivo` e o que o golpe realmente tirou de HP; a diferenca para `dano` e
// o desperdicio (overkill) que o relatorio mede por arma.
function golpear(estado, e, danoBase, armaId) {
  const dano = aoCalcularDano(estado, danoBase, e);
  const x = e.x;
  const y = e.y;
  const efetivo = Math.min(dano, e.hp);
  const matou = aplicarDano(estado, e, dano);
  emitir(estado, 'arma-acerto', { arma: armaId, x, y, dano, efetivo, matou });
  return matou;
}

// Varredura linear sobre os inimigos ativos. So roda quando uma arma dispara
// (~2,5x por segundo no Café nivel 1), nao por quadro — medido no handoff da
// fase 03: com 400 inimigos a corrida de carga nao se mexeu. Se a fase 05
// colocar quatro armas de cadencia alta, meca de novo antes de trocar isto por
// uma grade.
function inimigoMaisProximo(estado, x, y, alcance) {
  const inimigos = poolInimigos(estado).ativos;
  let melhor = null;
  let melhorDist = alcance * alcance;
  for (let i = 0; i < inimigos.length; i += 1) {
    const e = inimigos[i];
    const dx = e.x - x;
    const dy = e.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= melhorDist) {
      melhorDist = d2;
      melhor = e;
    }
  }
  return melhor;
}

// -------------------------------------------------------------- projeteis

export function poolProjeteis(estado) {
  return obterPool(estado, 'projectiles', fabricarProjetil).sincronizar();
}

// Forma unica de projetil, com todos os campos criados aqui e numero finito em
// cada um. `atingidos` e um anel de tamanho fixo alocado na abertura da pool —
// nenhum array nasce dentro do update (restricao 5).
function fabricarProjetil() {
  const atingidos = [];
  for (let i = 0; i < CONTEUDO.projetil.memoriaAtingidos; i += 1) {
    atingidos.push({ ref: null, nasc: -1 });
  }
  return {
    ativo: false,
    slot: -1,
    nasc: 0,
    arma: '',
    emoji: '',
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    dano: 0,
    raio: 1,
    vida: 0,
    perfuracao: 0,
    atingidos,
    memoriaIndice: 0,
  };
}

function dispararProjetil(estado, dados, nivel, x, y, dirX, dirY) {
  const p = poolProjeteis(estado).obter();
  p.arma = dados.id;
  p.emoji = dados.emoji;
  p.x = x;
  p.y = y;
  p.vx = dirX * nivel.velocidade;
  p.vy = dirY * nivel.velocidade;
  p.dano = nivel.dano;
  p.raio = nivel.raio;
  p.perfuracao = nivel.perfuracao;
  // O alcance e distancia, nao tempo: dividir pela velocidade da os segundos
  // de voo. O teto existe para que um alcance enorme nao deixe projetil vivo
  // para sempre girando a conta de colisao.
  p.vida = Math.min(CONTEUDO.projetil.vidaMaxima, nivel.alcance / nivel.velocidade);
  esquecerAtingidos(p);
  return p;
}

function atualizarProjeteis(estado, dt) {
  const pool = poolProjeteis(estado);
  const projeteis = pool.ativos;
  if (projeteis.length === 0) return;

  const { largura, altura } = CONTEUDO.arena;
  const margem = CONTEUDO.projetil.margemDescarte;

  // De tras para frente: liberar() e swap-remove, e nesta ordem o elemento que
  // vem para o buraco ja foi visitado.
  for (let i = projeteis.length - 1; i >= 0; i -= 1) {
    const p = projeteis[i];
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vida -= dt;

    if (
      p.vida <= 0 ||
      p.x < -margem ||
      p.x > largura + margem ||
      p.y < -margem ||
      p.y > altura + margem
    ) {
      pool.liberar(p);
      continue;
    }

    if (colidirProjetil(estado, p)) pool.liberar(p);
  }
}

// Devolve true quando o projetil se esgotou e precisa voltar a pool.
function colidirProjetil(estado, p) {
  const inimigos = poolInimigos(estado).ativos;
  // De tras para frente porque aplicarDano() pode liberar o inimigo morto, e
  // liberar() troca o ultimo elemento para o buraco.
  for (let i = inimigos.length - 1; i >= 0; i -= 1) {
    const e = inimigos[i];
    const soma = p.raio + e.raio;
    const dx = e.x - p.x;
    const dy = e.y - p.y;
    if (dx * dx + dy * dy > soma * soma) continue;
    if (jaAtingiu(p, e)) continue;

    lembrarAtingido(p, e);
    golpear(estado, e, p.dano, p.arma);

    if (p.perfuracao <= 0) return true;
    p.perfuracao -= 1;
  }
  return false;
}

// Guarda de geracao. Um inimigo liberado volta para a reserva da pool e pode
// reaparecer como OUTRO inimigo no mesmo objeto; comparar so a referencia faria
// o projetil perfurante confundir o novo inimigo com o que ja atingiu — e o
// novo ficaria imune a ele. `nasc` muda a cada nascimento, entao o par
// (ref, nasc) e a unica identidade que atravessa quadros com seguranca.
function jaAtingiu(p, e) {
  const memoria = p.atingidos;
  for (let i = 0; i < memoria.length; i += 1) {
    if (memoria[i].ref === e && memoria[i].nasc === e.nasc) return true;
  }
  return false;
}

function lembrarAtingido(p, e) {
  const slot = p.atingidos[p.memoriaIndice];
  slot.ref = e;
  slot.nasc = e.nasc;
  p.memoriaIndice = (p.memoriaIndice + 1) % p.atingidos.length;
}

function esquecerAtingidos(p) {
  for (let i = 0; i < p.atingidos.length; i += 1) {
    p.atingidos[i].ref = null;
    p.atingidos[i].nasc = -1;
  }
  p.memoriaIndice = 0;
}

// --------------------------------------------------- guarda de geracao (orbital)

// Mesma ideia do (ref, nasc) dos projeteis, mas para um cooldown que EXPIRA
// sozinho em vez de durar o voo inteiro: cada slot lembra qual inimigo foi
// atingido, com qual `nasc`, e ate quando (`expiraEm`, em segundos de
// avaliacao) ele fica protegido. Sem o `nasc`, um inimigo novo que reusasse o
// objeto do morto herdaria a imunidade — o mesmo bug que a fase 03 blindou
// para os projeteis perfurantes, aqui na sua outra forma.
// As tres funcoes da memoria sao exportadas so para o smoke (pendencia 33):
// o laco de deduplicacao de lembrarGolpe so tem efeito visivel quando alguem
// relembra um inimigo com entrada AINDA viva, e o orbital nunca faz isso (ele
// pergunta emCooldown antes). O teste exercita esse caso direto.
export function criarMemoriaGolpes(tamanho) {
  const itens = [];
  // -1 (nao -Infinity) porque a varredura profunda do smoke reprova qualquer
  // numero nao finito no estado inteiro; -1 ja e menor que qualquer
  // `agora` possivel (avaliacao.decorrido nunca fica negativo).
  for (let i = 0; i < tamanho; i += 1) itens.push({ ref: null, nasc: -1, expiraEm: -1 });
  return { itens, indice: 0 };
}

export function emCooldown(memoria, e, agora) {
  const itens = memoria.itens;
  for (let i = 0; i < itens.length; i += 1) {
    if (itens[i].ref === e && itens[i].nasc === e.nasc) return itens[i].expiraEm > agora;
  }
  return false;
}

// Um MESMO inimigo e atingido varias vezes ao longo da vida dele (a cada
// passe da orbita) — nao e "uma vez so", como a perfuracao do projetil.
// Por isso precisa achar a entrada JA existente para este (ref, nasc) e
// ATUALIZAR o expiraEm nela, em vez de sempre gravar num slot novo do anel:
// gravar sempre num slot novo deixaria uma entrada ANTIGA e ja vencida do
// mesmo inimigo sobrevivendo em outro slot, e como emCooldown() devolve no
// PRIMEIRO match que encontra (nao o mais recente), essa entrada velha
// venceria a nova e o cooldown pareceria nunca ter sido aplicado — foi visto
// isto acontecendo: 15 acertos seguidos no mesmo inimigo parado, num teste
// que so devia permitir 1 por passe.
//
// Para um inimigo NOVO (sem entrada), o slot escolhido tambem importa: um
// enxame maior que CONTEUDO.orbital.memoriaAlvos reabre uma forma diferente
// do mesmo problema se o round-robin sobrescrever um slot cujo cooldown
// AINDA esta vivo (protegendo outro inimigo) — esse outro inimigo perde a
// protecao sem ter vencido o proprio intervaloDano. Por isso procura-se
// primeiro um slot JA VENCIDO (expiraEm <= agora, nao protege ninguem de
// verdade) antes de cair no round-robin. So quando TODOS os slots estao
// vivos — mais inimigos distintos em cooldown ao mesmo tempo do que
// memoriaAlvos consegue lembrar — o round-robin sobrescreve um slot vivo
// mesmo assim; nesse ponto o limite e de capacidade, nao de logica, e quem
// resolve e subir memoriaAlvos (ver checarCooldownComEnxameOrbital()).
//
// O acoplamento com emCooldown (pendencia 33): as duas varrem do indice 0 e
// emCooldown responde pela PRIMEIRA entrada do inimigo. Hoje o orbital so
// relembra quem emCooldown deu como livre, e por isso o 2o laco, sozinho, ja
// poria a entrada nova antes da velha vencida. O 1o laco e o que vale quando a
// entrada ainda esta viva (renovar um cooldown): sem ele a entrada velha, mais
// curta, ficaria na frente e responderia por ele.
export function lembrarGolpe(memoria, e, expiraEm, agora) {
  const itens = memoria.itens;
  for (let i = 0; i < itens.length; i += 1) {
    if (itens[i].ref === e && itens[i].nasc === e.nasc) {
      itens[i].expiraEm = expiraEm;
      return;
    }
  }
  for (let i = 0; i < itens.length; i += 1) {
    if (itens[i].expiraEm <= agora) {
      itens[i].ref = e;
      itens[i].nasc = e.nasc;
      itens[i].expiraEm = expiraEm;
      memoria.indice = (i + 1) % itens.length;
      return;
    }
  }
  const slot = itens[memoria.indice];
  slot.ref = e;
  slot.nasc = e.nasc;
  slot.expiraEm = expiraEm;
  memoria.indice = (memoria.indice + 1) % itens.length;
}
