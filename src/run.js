import { CONTEUDO } from '../data/content.js';
import {
  avaliacaoDosDados,
  dadosDaAvaliacao,
  emitir,
  iniciarAvaliacao,
  irParaTela,
  novaLoja,
  novaRun,
  novasCartas,
  novoPlayer,
  prepararAvaliacao,
  TELAS,
} from './state.js';
import { liberarPoolsDoEstado } from './pool.js';
import { aoIniciarAvaliacao } from './jokers.js';
import { equiparArma } from './weapons.js';
import { receberDano } from './player.js';
import { iniciarBanca, novaBanca } from './boss.js';

// A run e o fim de cada avaliacao.
//
// A maquina de estados da run (fase 08). Cada seta e uma funcao daqui, menos
// as duas que moram em outros arquivos (indicadas):
//
//   MENU --iniciarRun--> ANUNCIO --comecarProxima--> AVALIACAO (<-> CARTA, PAUSA)
//   AVALIACAO --fecharAvaliacao (main.js observa o cronometro e o HP)-->
//        RESULTADO --sairDoResultado (main.js)--> LOJA --seguirDaLoja (shop.js)-->
//        avancarRun --> ANUNCIO da proxima, ou TCC depois da ultima
//   AVALIACAO --HP zerou--> JUBILADO --sairDoResultado--> MENU (a run acabou; sem save)
//   TCC --comecarTcc--> AVALIACAO com A Banca (av.banca; a luta e uma avaliacao
//        sem cronometro, e por isso pausa, carta e HUD sao os de sempre)
//   AVALIACAO do TCC --A Banca caiu (main.js: bancaVencida)--> colarGrau -->
//        COLACAO --sairDaColacao--> MENU
//   AVALIACAO do TCC --HP zerou--> JUBILADO, como em qualquer avaliacao
//
// Nada aqui sabe o que e uma Prova Final nem o que um modificador faz: a
// Prova Final e so uma entrada de CONTEUDO.periodos com numeros maiores, e um
// modificador so mexe em av.regras (state.js), que o resto do jogo le.
//
// Nota, conceito e creditos sao funcoes puras sobre numeros — nenhum peso,
// nenhuma faixa e nenhum multiplicador mora neste arquivo, todos vem de
// CONTEUDO.nota. O design §4 chama equilibrar pesoKill contra pesoHp de "a
// decisao de tunning mais importante do jogo": tunar isso nao pode exigir
// abrir um .js de logica.

export const MOTIVO_TEMPO = 'tempo'; // o cronometro zerou: aprovado
export const MOTIVO_JUBILADO = 'jubilado'; // o HP zerou
export const MOTIVO_BANCA = 'banca'; // A Banca caiu: aprovado no TCC, que nao tem nota

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
  const aprovado = motivo !== MOTIVO_JUBILADO;
  // So a avaliacao de cronometro tem nota (design §4). O TCC aprova pela
  // Banca, e quem fecha a run com um numero e a media (colarGrau).
  const comNota = motivo === MOTIVO_TEMPO;

  r.id = av.id;
  r.nome = av.nome;
  r.materia = av.materia;
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
  // Sem cronometro (o TCC), o tempo e o da luta inteira.
  r.tempo = av.duracao > 0 ? Math.min(av.decorrido, av.duracao) : av.decorrido;
  r.chefe = av.banca !== null;
  r.bancaFracao = av.banca && av.banca.hpMax > 0 ? Math.max(0, av.banca.hp) / av.banca.hpMax : 0;
  r.restantes = av.banca ? 0 : avaliacoesDepois(estado.run.periodoIndex, estado.run.avaliacaoIndex);
  // `ileso` sai de danoTomado, e nao de hp === hpMax, por causa do Lanche da
  // Cantina: quem levou uma paulada e curou depois nao terminou ileso. E e por
  // isso que o grampo de danoTomado (player.js limita o golpe fatal ao HP
  // restante) nao afeta a nota — ela le o campo como "tomou ou nao tomou", e a
  // magnitude do golpe que mata so existiria no caminho do jubilamento, onde
  // nao ha nota.
  r.ileso = aprovado && av.danoTomado <= 0;

  if (comNota) {
    const p = parcelasDaNota({ kills: r.kills, hpRestante: r.hp, hpMax: r.hpMax, ileso: r.ileso }, r.parcelas);
    r.nota = Math.max(0, Math.min(CONTEUDO.nota.maxima, arredondarNota(p.kills + p.hp + p.ileso)));
    const faixa = faixaDaNota(r.nota);
    r.conceito = faixa.conceito;
    r.creditos = creditosDaFaixa(faixa);
    registrarBoletim(estado.run, estado.run.periodoIndex, estado.run.avaliacaoIndex, r);
  } else {
    // Jubilado nao tem nota: a run acabou, nao existe loja depois. A tela
    // mostra o que ele fez (mortos e tempo), nao quanto valeu. O TCC vencido
    // tambem nao: depois dele vem a colacao, nao a loja.
    r.parcelas.kills = 0;
    r.parcelas.hp = 0;
    r.parcelas.ileso = 0;
    r.nota = 0;
    r.conceito = '';
    r.creditos = 0;
  }

  estado.run.nota = r.nota;
  estado.run.conceito = comNota ? r.conceito : null;
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

// ------------------------------------------------------------ a run inteira

// "Jogar" no menu comeca uma run NOVA: sem isto os creditos de uma partida
// jubilada vazariam para a seguinte. Fora do loop (clique de botao), entao
// alocar a run aqui nao fere a regra de pool. A primeira avaliacao tambem
// passa pelo anuncio: e ali que o jogador ve o periodo e a materia.
export function iniciarRun(estado) {
  estado.run = novaRun();
  // A run nasce inteira, e nao so `run`: o jogador, as cartas, a loja e as
  // pools da run anterior ficavam congelados atras do anuncio ate a 1a
  // avaliacao comecar (e a loja, ate a 1a loja abrir). Nada os lia nesse meio
  // tempo, mas "jogar de novo" tem que ser o mesmo que abrir a pagina — e o
  // que test/dom.mjs compara, quadro a quadro (fase 14, tarefa 5). Nada aqui
  // sorteia: a run segue identica.
  estado.player = novoPlayer();
  estado.cartas = novasCartas();
  estado.loja = novaLoja();
  liberarPoolsDoEstado(estado);
  anunciarAvaliacao(estado, 0, 0);
}

// Sorteia os modificadores da avaliacao (p, a) e abre a tela de anuncio. A
// avaliacao em si so nasce no "Comecar" (comecarProxima): ate la a tela e
// neutra, nada roda e a telemetria nao abre registro.
export function anunciarAvaliacao(estado, periodoIndex, avaliacaoIndex) {
  const dados = dadosDaAvaliacao(periodoIndex, avaliacaoIndex);
  const prox = estado.run.proxima;
  prox.periodoIndex = periodoIndex;
  prox.avaliacaoIndex = avaliacaoIndex;
  // Os anteriores sao os da avaliacao que acabou de ser jogada (na 1ª da run,
  // o marcador vazio de novaRun).
  sortearModificadores(estado.rng, dados.modificadores, estado.run.avaliacao.modificadores, prox.modificadores);
  prox.abertaEm = estado.tempo;
  irParaTela(estado, TELAS.ANUNCIO);
  emitir(estado, 'avaliacao-anunciada', { id: dados.id, modificadores: prox.modificadores.slice() });
}

// O "Comecar" do anuncio (botao e Enter). Devolve false fora da tela.
export function comecarProxima(estado) {
  if (estado.tela !== TELAS.ANUNCIO) return false;
  const prox = estado.run.proxima;
  comecarAvaliacao(estado, prox.periodoIndex, prox.avaliacaoIndex, prox.modificadores);
  return true;
}

// O atraso de abertura do anuncio (anuncio.atrasoEntrada). Quem checa e o
// main.js, antes de chamar comecarProxima — como na loja.
export function anuncioLiberado(estado) {
  return estado.tela === TELAS.ANUNCIO && estado.tempo - estado.run.proxima.abertaEm >= CONTEUDO.anuncio.atrasoEntrada;
}

// Toda avaliacao de uma run comeca por aqui: o estado da avaliacao nasce
// (state.js, ja com as regras dos modificadores), os coringas agem sobre ele
// e o jogador recebe a arma inicial. E o UNICO chamador do hook
// aoIniciarAvaliacao — que tambem recalcula os atributos do jogador, entao
// uma avaliacao aberta por outro caminho roda sem os coringas.
export function comecarAvaliacao(estado, periodoIndex = 0, avaliacaoIndex = 0, modificadores = undefined) {
  iniciarAvaliacao(estado, periodoIndex, avaliacaoIndex, modificadores);
  armarJogador(estado);
}

// O que toda avaliacao da run faz depois de o estado dela nascer, o TCC
// inclusive: os coringas agem e o jogador recebe a arma inicial. Aqui, uma
// vez, e nao a cada tick em weapons.js (pendencia 21): o player acabou de
// nascer sem arma nenhuma.
function armarJogador(estado) {
  aoIniciarAvaliacao(estado);
  equiparArma(estado, CONTEUDO.arma.inicial);
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

// "Seguir" da loja: anuncia a proxima avaliacao (virando o periodo quando ele
// acaba) ou, depois da loja da ultima Prova Final, vai ao TCC. Devolve se
// ainda havia avaliacao.
export function avancarRun(estado) {
  const prox = proximaAvaliacao(estado.run.periodoIndex, estado.run.avaliacaoIndex);
  if (!prox) {
    // A tela do TCC e o anuncio da defesa: marca a abertura como o anuncio,
    // e o atraso (tcc.atrasoEntrada) vale do mesmo jeito (pendencia 60).
    estado.run.proxima.abertaEm = estado.tempo;
    irParaTela(estado, TELAS.TCC);
    emitir(estado, 'tcc', null);
    return false;
  }
  anunciarAvaliacao(estado, prox.periodoIndex, prox.avaliacaoIndex);
  return true;
}

// O atraso de abertura da tela do TCC. Quem checa e o main.js, antes de
// chamar comecarTcc — como no anuncio.
export function tccLiberado(estado) {
  return estado.tela === TELAS.TCC && estado.tempo - estado.run.proxima.abertaEm >= CONTEUDO.tcc.atrasoEntrada;
}

// O "Comecar a defesa" (botao e Enter). O TCC e uma avaliacao como as outras
// — mesma porta de nascimento (prepararAvaliacao), coringas e arma inicial
// (armarJogador) —, montada de CONTEUDO.tcc em vez de `periodos`, e com A
// Banca. Nao mexe em run.periodoIndex/avaliacaoIndex: a run continua parada
// na ultima Prova Final. Devolve false fora da tela do TCC.
export function comecarTcc(estado) {
  if (estado.tela !== TELAS.TCC) return false;
  const tcc = CONTEUDO.tcc;
  const avaliacao = avaliacaoDosDados(tcc, tcc.periodo);
  avaliacao.banca = novaBanca();
  prepararAvaliacao(estado, avaliacao);
  armarJogador(estado);
  iniciarBanca(estado);
  return true;
}

// ---------------------------------------------------- boletins e colacao

// O slot de (periodo, avaliacao) em run.boletins: a ordem da run, periodo a
// periodo, como state.js novosBoletins os criou.
export function indiceDoBoletim(periodoIndex, avaliacaoIndex, periodos = CONTEUDO.periodos) {
  let indice = 0;
  for (let p = 0; p < periodoIndex && p < periodos.length; p += 1) indice += periodos[p].avaliacoes.length;
  return indice + avaliacaoIndex;
}

// Quantas avaliacoes da run vem depois de (periodo, avaliacao). O TCC nao
// conta: e a tela de jubilado que diz "e o TCC".
export function avaliacoesDepois(periodoIndex, avaliacaoIndex, periodos = CONTEUDO.periodos) {
  let total = 0;
  for (const periodo of periodos) total += periodo.avaliacoes.length;
  return Math.max(0, total - indiceDoBoletim(periodoIndex, avaliacaoIndex, periodos) - 1);
}

function registrarBoletim(run, periodoIndex, avaliacaoIndex, resultado) {
  const boletim = run.boletins[indiceDoBoletim(periodoIndex, avaliacaoIndex)];
  if (!boletim) return;
  boletim.feita = true;
  boletim.nota = resultado.nota;
  boletim.conceito = resultado.conceito;
}

// A media das notas da run (so os boletins feitos), arredondada como uma
// nota: e ela que escolhe o conceito geral, pela mesma tabela de faixas.
export function mediaDosBoletins(boletins) {
  let soma = 0;
  let feitas = 0;
  for (const b of boletins) {
    if (!b.feita) continue;
    soma += b.nota;
    feitas += 1;
  }
  return feitas > 0 ? arredondarNota(soma / feitas) : 0;
}

// A Banca caiu (main.js, bancaVencida): fecha o TCC como aprovado, calcula o
// conceito geral e atualiza o recorde. A simulacao so escreve no estado
// (estado.recorde) e avisa com o evento 'recorde'; gravar no localStorage e
// com main.js, fora da simulacao.
//
// Pendencia 80: so a run com TODOS os boletins feitos conta como formatura.
// Pelas portas do jogo nao se chega ao TCC sem as 9 avaliacoes; por um atalho
// (teste, estado montado na mao) a media seria a de boletins vazios — um F
// forjado que, gravado, viraria recorde. A colacao abre igual; o recorde fica.
export function colarGrau(estado) {
  fecharAvaliacao(estado, MOTIVO_BANCA);
  const run = estado.run;
  const c = run.colacao;
  c.media = mediaDosBoletins(run.boletins);
  c.conceito = conceitoDaNota(c.media);
  c.tempoTcc = run.resultado.tempo;
  c.feita = true;
  c.abertaEm = estado.tempo;
  const completa = runCompleta(run.boletins);
  c.novoRecorde = completa && registrarFormatura(estado.recorde, c.media, c.conceito);
  irParaTela(estado, TELAS.COLACAO);
  emitir(estado, 'colacao', { media: c.media, conceito: c.conceito, novoRecorde: c.novoRecorde });
  if (completa) emitir(estado, 'recorde', null);
}

// Todas as avaliacoes da run tem nota (o boletim de cada uma foi fechado).
export function runCompleta(boletins) {
  if (boletins.length === 0) return false;
  for (const b of boletins) if (!b.feita) return false;
  return true;
}

// Soma uma formatura e guarda a media se ela for a melhor. Devolve se bateu
// o recorde (a primeira formatura sempre bate).
export function registrarFormatura(recorde, media, conceito) {
  const novo = recorde.formaturas === 0 || media > recorde.melhorMedia;
  recorde.formaturas += 1;
  if (novo) {
    recorde.melhorMedia = media;
    recorde.melhorConceito = conceito;
  }
  return novo;
}

export function colacaoLiberada(estado) {
  return estado.tela === TELAS.COLACAO && estado.tempo - estado.run.colacao.abertaEm >= CONTEUDO.colacao.atrasoEntrada;
}

// A saida da colacao (botao e Enter): a run acabou, volta ao menu.
export function sairDaColacao(estado) {
  if (estado.tela !== TELAS.COLACAO) return false;
  irParaTela(estado, TELAS.MENU);
  return true;
}

// Sorteia `quantos` ids de modificador distintos, sem nenhum de `anteriores`
// (design: o mesmo modificador nao cai em duas avaliacoes seguidas), e os
// escreve em `destino`. Se sobrar menos candidato do que o pedido — o check
// impede isso com os dados do jogo —, sai com o que houver. Nao gasta rng
// quando `quantos` e 0, e por isso a 1ª avaliacao da run joga com a mesma
// semente que jogava antes de existir sorteio.
export function sortearModificadores(rng, quantos, anteriores, destino, lista = CONTEUDO.modificadores) {
  destino.length = 0;
  if (!(quantos > 0)) return destino;
  const candidatos = [];
  for (const mod of lista) if (!anteriores.includes(mod.id)) candidatos.push(mod.id);
  while (destino.length < quantos && candidatos.length > 0) {
    const i = rng.int(0, candidatos.length - 1);
    destino.push(candidatos[i]);
    candidatos.splice(i, 1);
  }
  return destino;
}

// ------------------------------------------------- regras que andam no tempo

export const FONTE_PERDA_HP = 'perdaHp';

// As regras da avaliacao que agem sozinhas a cada tick. Hoje so a perda de HP
// (regras.perdaHp / intervaloPerdaHp; o Controle de Frequencia liga). Chamada
// por main.js dentro da avaliacao, depois do cronometro andar.
//
// A perda ignora i-frames e nao da i-frames: com eles, cada perda deixaria o
// jogador intocavel por um segundo a cada 12 e o modificador viraria bonus no
// meio da horda. Pode matar (o jubilamento e o de sempre, no main.js) e o
// Atestado pode segurar — passa por receberDano como qualquer dano.
export function atualizarRegras(estado, dt) {
  const av = estado.run.avaliacao;
  const regras = av.regras;
  if (!(regras.perdaHp > 0) || !(regras.intervaloPerdaHp > 0)) return;
  av.relogioPerdaHp += dt;
  if (av.relogioPerdaHp < regras.intervaloPerdaHp) return;
  av.relogioPerdaHp -= regras.intervaloPerdaHp;
  const player = estado.player;
  const hpAntes = player.hp;
  if (receberDano(estado, regras.perdaHp, true)) {
    // Daqui, como enemies.js faz com o toque: sem o evento o relatorio
    // chamaria esta perda de "fonte desconhecida" (pendencia 49).
    emitir(estado, 'jogador-dano', { fonte: FONTE_PERDA_HP, dano: hpAntes - player.hp, hp: player.hp, x: player.x, y: player.y });
  }
}
