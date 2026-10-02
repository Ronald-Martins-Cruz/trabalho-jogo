import { CONTEUDO } from '../data/content.js';
import { FONTE_DESCONHECIDA, SITUACAO } from './telemetria.js';

// Relatorio de balanceamento: transforma estado.telemetria (src/telemetria.js)
// num arquivo Markdown — resumo, leituras automaticas e tabelas — com o JSON
// completo no fim. O leitor previsto e um agente que vai ajustar
// data/content.js, talvez sem acesso ao codigo: por isso o arquivo explica o
// jogo, define cada metrica e carrega a configuracao usada.
//
// Funcoes puras sobre dados: nada de DOM (quem baixa o arquivo e ui.js) e
// nada de relogio (a hora vem em `ambiente`, montado por main.js). Rodam no
// node igual — o smoke gera os tres escopos, e a fase 13 pode gerar o mesmo
// relatorio a partir dos bots do simulador.
//
// O texto em portugues aqui dentro e de ferramenta de desenvolvimento, como a
// saida do smoke em test/: o jogador nunca o ve, e a chave debug.relatorio o
// desliga para a entrega. Texto de TELA continua em content.js/index.html.

export const ESCOPOS = Object.freeze({
  AVALIACAO: 'avaliacao', // a ultima avaliacao, com o contexto da partida
  PARTIDA: 'partida', // a ultima partida (run), todas as avaliacoes em detalhe
  SESSAO: 'sessao', // todas as partidas guardadas, agregadas
});

export const FORMATO_RELATORIO = 'semana-de-provas/relatorio';
export const VERSAO_RELATORIO = 1;

const EPS = 1e-6;

// Chaves de CONTEUDO que mudam o jogo. Textos, visual, hud e as chaves de
// debug/relatorio ficam fora: trocar uma palavra nao pode mudar o hash.
const CHAVES_DE_JOGO = [
  'ajuste', 'loop', 'arena', 'jogador', 'xp', 'xpOrbe', 'cartas', 'arma', 'projetil',
  'orbital', 'ondaArea', 'armas', 'coringas', 'loja', 'inimigos', 'spawn', 'separacao',
  'modificadores', 'regras', 'periodos', 'nota', 'tcc', 'banca',
];

// ------------------------------------------------------------------ entrada

// Devolve { texto, nomeBase, dados } ou null quando nao ha nada gravado
// (chave desligada, ou nenhuma avaliacao comecou ainda).
export function gerarRelatorio(estado, escopo, ambiente = null) {
  const tel = estado && estado.telemetria;
  if (!tel || !Array.isArray(tel.partidas) || tel.partidas.length === 0) return null;
  const partida = tel.partidas[tel.partidas.length - 1];
  const config = configuracaoDoJogo();

  if (escopo === ESCOPOS.AVALIACAO) {
    const reg = partida.avaliacoes[partida.avaliacoes.length - 1];
    if (!reg) return null;
    return relatorioDaAvaliacao(tel, partida, reg, ambiente, config);
  }
  if (escopo === ESCOPOS.PARTIDA) return relatorioDaPartida(tel, partida, ambiente, config);
  if (escopo === ESCOPOS.SESSAO) return relatorioDaSessao(tel, ambiente, config);
  return null;
}

// Os numeros de jogo em vigor e um hash deles. Dois relatorios com o mesmo
// hash jogaram com os mesmos numeros — e o que deixa agrupar relatorios de
// sessoes diferentes sem adivinhar qual versao de content.js estava valendo.
export function configuracaoDoJogo(conteudo = CONTEUDO) {
  const valores = {};
  for (const chave of CHAVES_DE_JOGO) {
    if (chave in conteudo) valores[chave] = semDescricoes(conteudo[chave]);
  }
  return { hash: fnv1a(JSON.stringify(valores)), valores };
}

// ------------------------------------------------------------------ analise

// Tudo o que o relatorio calcula sobre UMA avaliacao. Vai inteiro para o JSON
// (campo `analise`) e e a unica fonte dos numeros do Markdown: as duas
// metades do arquivo nunca discordam.
export function analisarAvaliacao(reg, conteudo = CONTEUDO) {
  const cfg = conteudo.relatorio;
  const tempo = reg.tempoJogado > 0 ? reg.tempoJogado : reg.pressao.tempo;
  const observado = reg.pressao.tempo > 0 ? reg.pressao.tempo : NaN;
  const j = reg.jogador;
  const r = reg.resultado;
  const kills = somar(reg.inimigos, 'mortos');
  const danoEfetivoTotal = somar(reg.armas, 'danoEfetivo');

  const nivelAos = (t) => {
    let nivel = 1;
    for (const s of reg.niveis) if (s.t <= t + EPS && s.nivel > nivel) nivel = s.nivel;
    return nivel;
  };
  const marcos = [];
  for (let k = 1; k * cfg.marcosNivel <= reg.duracao + EPS; k += 1) {
    const t = k * cfg.marcosNivel;
    marcos.push({ t, nivel: tempo + EPS >= t ? nivelAos(t) : null });
  }
  const alvo = reg.niveis.find((s) => s.nivel >= cfg.alvos.nivel);

  const inicio = { ate: cfg.inicioSegundos, nivel: null, mortos: 0, danoCausado: 0, golpes: 0, danoTomado: 0 };
  if (tempo + EPS >= cfg.inicioSegundos) inicio.nivel = nivelAos(cfg.inicioSegundos);
  for (const a of reg.amostras) {
    if (a.t > cfg.inicioSegundos + EPS) break;
    inicio.mortos += a.mortos;
    inicio.danoCausado += a.danoCausado;
  }
  for (const g of reg.golpes) {
    if (g.t > cfg.inicioSegundos + EPS) break;
    inicio.golpes += 1;
    inicio.danoTomado += g.dano;
  }

  const hpFinal = reg.final ? reg.final.hp : NaN;
  const hpMax = reg.final ? reg.final.hpMax : j.hpMax;

  const armas = reg.armas
    .filter((a) => a.equipadaEm !== null || a.acertos > 0 || a.disparos > 0)
    .map((a) => {
      const tempoEquipada = somar(a.porNivel, 'tempo');
      const nivelFinal = a.nivelFinal > 0 ? a.nivelFinal : a.niveis.length > 0 ? a.niveis[a.niveis.length - 1].nivel : 0;
      return {
        id: a.id,
        nome: nomeArma(a.id, conteudo),
        comportamento: comportamentoArma(a.id, conteudo),
        nivelFinal,
        equipadaEm: a.equipadaEm,
        niveis: a.niveis,
        tempoEquipada,
        disparos: a.disparos,
        acertos: a.acertos,
        mortes: a.mortes,
        fracMortes: razao(a.mortes, kills),
        danoNominal: a.danoNominal,
        danoEfetivo: a.danoEfetivo,
        fracDano: razao(a.danoEfetivo, danoEfetivoTotal),
        overkill: a.danoNominal > 0 ? 1 - a.danoEfetivo / a.danoNominal : NaN,
        dps: razao(a.danoEfetivo, tempoEquipada),
        porNivel: a.porNivel
          .map((n, i) => ({ nivel: i + 1, ...n, dps: razao(n.danoEfetivo, n.tempo) }))
          .filter((n) => n.tempo > 0 || n.acertos > 0 || n.disparos > 0),
      };
    })
    .sort((x, y) => y.danoEfetivo - x.danoEfetivo);

  const inimigos = reg.inimigos
    .filter((i) => i.nascidos > 0 || i.mortos > 0 || i.vivosFim > 0)
    .map((i) => {
      const fonte = reg.fontesDano.find((f) => f.fonte === i.id);
      return {
        id: i.id,
        nome: nomeFonte(i.id, conteudo),
        nascidos: i.nascidos,
        mortos: i.mortos,
        vivosFim: i.vivosFim,
        sumiram: Math.max(0, i.nascidos - i.mortos - i.vivosFim),
        vidaMedia: razao(i.somaVida, i.mortos),
        distanciaMorte: razao(i.somaDistanciaMorte, i.mortos),
        fracForaDaArena: razao(i.mortosForaDaArena, i.mortos),
        golpes: fonte ? fonte.golpes : 0,
        dano: fonte ? fonte.dano : 0,
      };
    });

  const fontes = reg.fontesDano
    .map((f) => ({ fonte: f.fonte, nome: nomeFonte(f.fonte, conteudo), golpes: f.golpes, dano: f.dano, frac: razao(f.dano, j.danoTomado) }))
    .sort((x, y) => y.dano - x.dano);

  let celulaMax = null;
  j.grade.forEach((s, i) => {
    if (!celulaMax || s > celulaMax.segundos) {
      celulaMax = { coluna: i % cfg.gradeColunas, linha: Math.floor(i / cfg.gradeColunas), segundos: s };
    }
  });
  if (celulaMax) celulaMax.frac = celulaMax.segundos / observado;

  const pr = reg.pressao;
  const respondidas = reg.cartas.filter((c) => c.escolhida >= 0);
  const decisoes = respondidas.map((c) => c.decisao);
  const consolo = conteudo.cartas.consolo;
  const consolos = respondidas.filter((c) => c.opcoes[c.escolhida] && c.opcoes[c.escolhida].id === consolo.id).length;

  let nota = null;
  if (r && r.aprovado) {
    const faixas = conteudo.nota.faixas;
    const indice = faixas.findIndex((f) => f.conceito === r.conceito);
    let proximo = null;
    if (indice > 0) {
      const acima = faixas[indice - 1];
      const falta = arred(acima.minimo - r.nota, 3);
      const pesoKill = conteudo.nota.pesoKill;
      const pesoHp = conteudo.nota.pesoHp;
      proximo = {
        conceito: acima.conceito,
        minimo: acima.minimo,
        falta,
        mortes: pesoKill > 0 ? Math.ceil(falta / pesoKill - EPS) : null,
        hp: pesoHp > 0 ? falta / pesoHp : null,
        hpPossivel: pesoHp > 0 && r.hpFracao + falta / pesoHp <= 1 + EPS,
      };
    }
    nota = {
      nota: r.nota,
      conceito: r.conceito,
      parcelas: r.parcelas,
      creditos: r.creditos,
      creditosTotal: r.creditosTotal,
      participacao: {
        kills: razao(r.parcelas.kills, r.nota),
        hp: razao(r.parcelas.hp, r.nota),
        ileso: razao(r.parcelas.ileso, r.nota),
      },
      proximo,
    };
  }

  const q = reg.quadros;
  const quadros =
    q.quadros > 0
      ? {
          quadros: q.quadros,
          fps: q.quadros / q.somaDt,
          maxDtMs: q.maxDt * 1000,
          noTeto: q.noTeto,
          lentos: q.lentos,
          fracLentos: q.lentos / q.quadros,
        }
      : null;

  const golpes = reg.golpes;
  const analise = {
    tempo,
    tempoObservado: reg.pressao.tempo,
    kills,
    killsBoletim: r ? r.kills : null,
    killsPorSegundo: razao(kills, tempo),
    nivelFinal: reg.final ? reg.final.nivel : reg.niveis.length > 0 ? reg.niveis[reg.niveis.length - 1].nivel : 1,
    marcosNivel: marcos,
    nivelAlvoEm: alvo ? alvo.t : null,
    inicio,
    jogador: {
      hpFinal,
      hpMax,
      hpFracao: razao(hpFinal, hpMax),
      hpMin: j.hpMin,
      curado: j.curado,
      danoTomado: j.danoTomado,
      golpes: j.golpes,
      danoPorGolpe: razao(j.danoTomado, j.golpes),
      primeiroGolpeEm: j.primeiroGolpeEm,
      piorSequencia: piorSequenciaDeDano(golpes, cfg.janelaDano),
      maiorTrechoSemDano: maiorTrechoSemDano(golpes, tempo),
    },
    movimento: {
      distancia: j.distancia,
      velocidadeMedia: j.distancia / observado,
      fracParado: j.tempoParado / observado,
      fracComInput: j.tempoComInput / observado,
      fracBorda: j.tempoBorda / observado,
      fracCanto: j.tempoCanto / observado,
      grade: j.grade.map((s) => s / observado),
      celulaMaisUsada: celulaMax,
    },
    pressao: {
      vivosMedio: pr.somaVivos / observado,
      vivosPico: pr.picoVivos,
      naArenaMedio: pr.somaNaArena / observado,
      pertoMedio: pr.somaPerto / observado,
      pertoPico: pr.picoPerto,
      fracComPerto: pr.tempoComPerto / observado,
      tempoNoTeto: pr.tempoNoTeto,
      folgaMedia: razao(pr.somaFolga, pr.tempoComInimigo),
    },
    xp: {
      solto: reg.xp.solto,
      coletado: reg.xp.coletado,
      noChao: reg.xp.noChaoFim,
      orbesNoChao: reg.xp.orbesNoChaoFim,
      orbesPico: reg.xp.orbesPico,
      taxaColeta: razao(reg.xp.coletado, reg.xp.solto),
    },
    armas,
    danoEfetivoTotal,
    inimigos,
    fontes,
    cartas: {
      total: reg.cartas.length,
      respondidas: respondidas.length,
      decisaoMedia: media(decisoes),
      decisaoMax: decisoes.length > 0 ? Math.max(...decisoes) : NaN,
      consolos,
    },
    nota,
    telas: reg.telas,
    pausas: reg.pausas,
    quadros,
    descartados: reg.descartados,
  };
  analise.sinais = sinaisDaAvaliacao(reg, analise, conteudo);
  return analise;
}

function piorSequenciaDeDano(golpes, janela) {
  let pior = null;
  for (let i = 0; i < golpes.length; i += 1) {
    let dano = 0;
    let n = 0;
    for (let k = i; k < golpes.length && golpes[k].t < golpes[i].t + janela - EPS; k += 1) {
      dano += golpes[k].dano;
      n += 1;
    }
    if (!pior || dano > pior.dano) pior = { inicio: golpes[i].t, fim: golpes[i].t + janela, dano, golpes: n };
  }
  return pior;
}

function maiorTrechoSemDano(golpes, tempo) {
  let maior = null;
  let anterior = 0;
  const marcos = golpes.map((g) => g.t).concat([tempo]);
  for (const t of marcos) {
    if (!maior || t - anterior > maior.duracao) maior = { inicio: anterior, fim: t, duracao: t - anterior };
    anterior = t;
  }
  return maior;
}

// "Leituras automaticas": frases curtas que apontam onde olhar. `alerta` marca
// o que passou de um limiar de CONTEUDO.relatorio.alertas ou de um alvo do
// design — o numero aparece sempre, com ou sem alerta.
function sinaisDaAvaliacao(reg, a, conteudo) {
  const cfg = conteudo.relatorio;
  const al = cfg.alertas;
  const sinais = [];
  const add = (alerta, texto) => sinais.push({ alerta: Boolean(alerta), texto });

  if (reg.situacao === SITUACAO.JUBILADO && reg.morte) {
    const m = reg.morte;
    add(
      true,
      `Jubilado aos ${seg(m.t)} de ${reg.duracao}s. Golpe final: ${nomeFonte(m.fonte, conteudo)}, com ${m.perto} ` +
        `inimigo(s) a menos de ${cfg.raioPerto}px e ${m.vivos} vivos na arena, no nível ${m.nivel}.`
    );
  } else if (reg.situacao === SITUACAO.DESISTIU) {
    add(false, `Desistiu (voltou ao menu pela pausa) aos ${seg(a.tempo)} de ${reg.duracao}s.`);
  } else if (reg.situacao === SITUACAO.EM_ANDAMENTO) {
    add(false, `Avaliação ainda em andamento (${seg(a.tempo)} de ${reg.duracao}s): os números são parciais.`);
  } else if (reg.situacao === SITUACAO.INTERROMPIDA) {
    add(true, `Avaliação interrompida por outra que começou por cima (${seg(a.tempo)} jogados): dados parciais.`);
  }

  if (a.nivelAlvoEm !== null) {
    add(
      a.nivelAlvoEm > cfg.alvos.ate + EPS,
      `Nível ${cfg.alvos.nivel} aos ${seg(a.nivelAlvoEm)} (alvo do design: nível ${cfg.alvos.nivel} até ${cfg.alvos.ate}s).`
    );
  } else {
    add(
      a.tempo + EPS >= cfg.alvos.ate,
      `Não chegou ao nível ${cfg.alvos.nivel} (terminou no ${a.nivelFinal}); alvo do design: até ${cfg.alvos.ate}s.`
    );
  }
  const marcos = a.marcosNivel.filter((m) => m.nivel !== null).map((m) => `${m.t}s → ${m.nivel}`);
  if (marcos.length > 0) add(false, `Nível ao longo da avaliação: ${marcos.join(' · ')}.`);

  const ini = a.inicio;
  if (ini.nivel !== null) {
    add(
      ini.golpes > 0,
      `Primeiros ${ini.ate}s: nível ${ini.nivel}, ${ini.mortos} mortos, ${num(ini.danoTomado, 0)} de dano sofrido ` +
        `em ${ini.golpes} golpe(s) (o design chama esse trecho de "indefeso" se a curva de XP for lenta).`
    );
  }

  if (a.nota) {
    const n = a.nota;
    const dominante =
      n.parcelas.kills >= n.parcelas.hp
        ? `mortes pesaram mais (${pct(n.participacao.kills)} da nota)`
        : `HP pesou mais (${pct(n.participacao.hp)} da nota)`;
    add(
      false,
      `Nota ${num(n.nota)} (${n.conceito}) = mortes +${num(n.parcelas.kills)} · HP +${num(n.parcelas.hp)} · ` +
        `ileso +${num(n.parcelas.ileso)}; ${dominante}. Pagou ${n.creditos} créditos.`
    );
    if (n.proximo) {
      const p = n.proximo;
      add(
        false,
        `Para ${p.conceito} (${num(p.minimo)}) faltaram ${num(p.falta)}: ≈ ${p.mortes} mortes a mais` +
          (p.hp === null ? '' : ` ou ${pct(p.hp)} de HP a mais${p.hpPossivel ? '' : ' (impossível só com HP)'}`) +
          '.'
      );
    }
  }
  if (a.killsBoletim !== null && a.killsBoletim !== a.kills) {
    add(true, `A telemetria contou ${a.kills} mortos e o boletim ${a.killsBoletim}: eventos se perderam, desconfie das contas.`);
  }

  const mv = a.movimento;
  add(
    false,
    `Percorreu ${num(mv.distancia, 0)}px (${num(mv.velocidadeMedia, 0)} px/s em média; o máximo do jogador é ` +
      `${conteudo.jogador.velocidade}); parado ${pct(mv.fracParado)}, rente à borda ${pct(mv.fracBorda)}, ` +
      `no canto ${pct(mv.fracCanto)} do tempo.`
  );
  if (mv.fracCanto >= al.fracaoCanto) add(true, `${pct(mv.fracCanto)} do tempo no canto (limiar ${pct(al.fracaoCanto)}): jogou acampado.`);
  if (mv.fracBorda >= al.fracaoBorda) add(true, `${pct(mv.fracBorda)} do tempo rente à borda (limiar ${pct(al.fracaoBorda)}), onde os inimigos nascem.`);
  if (mv.fracParado >= al.fracaoParado) add(true, `${pct(mv.fracParado)} do tempo parado (limiar ${pct(al.fracaoParado)}).`);

  if (a.armas.length > 0 && a.danoEfetivoTotal > 0) {
    const partes = a.armas.map((x) => `${x.nome} ${pct(x.fracDano)}`);
    add(false, `Dano efetivo por arma: ${partes.join(' · ')} (total ${num(a.danoEfetivoTotal, 0)}).`);
  }
  for (const x of a.armas) {
    if (x.tempoEquipada >= al.tempoMinimoArma && x.fracDano < al.participacaoArma) {
      add(
        true,
        `${x.nome} ficou ${seg(x.tempoEquipada)} equipada e causou só ${pct(x.fracDano)} do dano ` +
          `(limiar ${pct(al.participacaoArma)}); DPS efetivo ${num(x.dps)}.`
      );
    }
    if (x.overkill >= al.overkill && x.danoNominal > 0) {
      add(
        true,
        `${x.nome} desperdiçou ${pct(x.overkill)} do dano nominal em overkill (limiar ${pct(al.overkill)}): ` +
          'o golpe passa muito do HP que o inimigo ainda tinha.'
      );
    }
  }

  if (a.xp.solto > 0) {
    add(
      a.xp.taxaColeta < al.coletaXp,
      `Coletou ${pct(a.xp.taxaColeta)} do XP solto (${a.xp.coletado} de ${a.xp.solto}); ${a.xp.noChao} ficou no chão ` +
        `em ${a.xp.orbesNoChao} orbes (pico de ${a.xp.orbesPico} orbes).`
    );
  }

  const pr = a.pressao;
  add(
    false,
    `Pressão: ${num(pr.vivosMedio)} inimigos vivos em média (pico ${pr.vivosPico}); ${num(pr.pertoMedio)} a menos de ` +
      `${cfg.raioPerto}px (pico ${pr.pertoPico}); algum perto em ${pct(pr.fracComPerto)} do tempo; folga média até o ` +
      `mais próximo ${num(pr.folgaMedia, 0)}px.`
  );
  if (pr.tempoNoTeto > 0) {
    add(
      true,
      `A arena ficou ${seg(pr.tempoNoTeto)} no teto de ${conteudo.spawn.maxSimultaneos} inimigos simultâneos ` +
        '(spawn.maxSimultaneos): as ondas desse trecho foram descartadas em silêncio.'
    );
  }

  const jd = a.jogador;
  if (jd.golpes > 0) {
    const pior = jd.piorSequencia;
    const trecho = jd.maiorTrechoSemDano;
    add(
      false,
      `Levou ${jd.golpes} golpe(s), ${num(jd.danoTomado, 0)} de dano (${num(jd.danoPorGolpe)} por golpe); primeiro aos ` +
        `${seg(jd.primeiroGolpeEm)}; pior sequência de ${cfg.janelaDano}s: ${num(pior.dano, 0)} de dano em ` +
        `${pior.golpes} golpe(s) a partir de ${seg(pior.inicio)}; maior trecho sem dano: ${seg(trecho.duracao)} ` +
        `(${seg(trecho.inicio)} a ${seg(trecho.fim)}). HP mínimo ${num(jd.hpMin, 0)}.`
    );
  } else if (reg.situacao !== SITUACAO.EM_ANDAMENTO) {
    add(false, 'Terminou sem levar dano nenhum.');
  }

  for (const i of a.inimigos) {
    add(
      i.sumiram > 0,
      `${i.nome}: ${i.nascidos} nasceram, ${i.mortos} morreram (vida média ${seg(i.vidaMedia)}, a ` +
        `${num(i.distanciaMorte, 0)}px do jogador; ${pct(i.fracForaDaArena)} morreram antes de entrar na arena)` +
        (i.sumiram > 0 ? `, ${i.sumiram} sumiram sem morrer.` : '.')
    );
  }

  if (a.cartas.total > 0) {
    add(
      false,
      `${a.cartas.total} carta(s) de nível; decisão média ${seg(a.cartas.decisaoMedia)} (máx. ${seg(a.cartas.decisaoMax)})` +
        (a.cartas.consolos > 0 ? `; ${a.cartas.consolos} vez(es) a carta de consolo (arsenal inteiro no máximo).` : '.')
    );
  }
  if (a.pausas > 0) add(false, `Pausou ${a.pausas} vez(es), ${seg(a.telas.pausa || 0)} no total.`);

  if (a.quadros) {
    const q = a.quadros;
    add(
      q.fps < al.fps,
      `Rodou a ${num(q.fps, 0)} fps em média (pior quadro ${num(q.maxDtMs, 0)} ms; ${q.lentos} quadros abaixo de ` +
        `${fpsLento()} fps; ${q.noTeto} no teto de passos, que descarta tempo).`
    );
  }

  const d = a.descartados;
  if (d.golpes + d.cartas + d.amostras + d.niveis > 0) {
    add(true, `Listas truncadas pelo teto relatorio.maxRegistros: ${JSON.stringify(d)}.`);
  }
  return sinais;
}

// --------------------------------------------------------------- relatorios

// "1º Período · Avaliação 2 · Algoritmos · modificadores: salaLotada". A
// avaliacao de mesmo id muda de modificador a cada run (fase 08), e sem eles
// no titulo duas avaliacoes iguais no nome seriam incomparaveis.
function rotuloDaAvaliacao(reg) {
  const partes = [reg.periodo, reg.nome];
  if (reg.materia) partes.push(reg.materia);
  const mods = Array.isArray(reg.modificadores) ? reg.modificadores : [];
  partes.push(mods.length > 0 ? `modificadores: ${mods.join(', ')}` : 'sem modificador');
  return partes.join(' · ');
}

function relatorioDaAvaliacao(tel, partida, reg, ambiente, config) {
  const analise = analisarAvaliacao(reg);
  const anteriores = partida.avaliacoes.filter((x) => x !== reg);
  const titulo = `Avaliação ${reg.id} — ${rotuloDaAvaliacao(reg)}`;
  const partes = [
    `# Relatório de balanceamento — ${titulo}`,
    `> Semana de Provas · escopo **avaliação**: a ${ordinal(reg.indice)} avaliação da partida #${partida.numero} ` +
      `(${rotuloSituacao(partida.situacao)}). Resumo e leituras primeiro; tabelas depois; JSON completo no fim.`,
    secaoContexto(tel, ambiente, config, `avaliação \`${reg.id}\` (${rotuloDaAvaliacao(reg)}), ${ordinal(reg.indice)} da partida #${partida.numero}`),
    secaoSobreOJogo(),
    secaoComoLer(),
  ];
  if (anteriores.length > 0) {
    partes.push('## Avaliações anteriores desta partida', tabelaDasAvaliacoes(anteriores));
  }
  partes.push(secoesDaAvaliacao(reg, analise, '##'), secaoConfiguracao(config), secaoJson());

  const dados = {
    ...cabecalhoJson(ESCOPOS.AVALIACAO, tel, ambiente, config),
    partida: exportarPartida(partida, false),
    avaliacao: exportarAvaliacao(reg, analise),
  };
  return montar(partes, dados, `partida-${partida.numero}_${reg.id}`);
}

function relatorioDaPartida(tel, partida, ambiente, config) {
  const analises = partida.avaliacoes.map((reg) => analisarAvaliacao(reg));
  const partes = [
    `# Relatório de balanceamento — Partida #${partida.numero}`,
    `> Semana de Provas · escopo **partida**: ${partida.avaliacoes.length} avaliação(ões), ` +
      `${rotuloSituacao(partida.situacao)}. Resumo da partida, depois cada avaliação em detalhe; JSON completo no fim.`,
    secaoContexto(tel, ambiente, config, `partida #${partida.numero} inteira`),
    secaoSobreOJogo(),
    secaoComoLer(),
    '## Resumo da partida',
    resumoDaPartida(partida, analises),
    '## Avaliações',
    tabelaDasAvaliacoes(partida.avaliacoes),
  ];
  partida.avaliacoes.forEach((reg, i) => {
    partes.push(`## ${ordinal(reg.indice)} avaliação — ${rotuloDaAvaliacao(reg)} (\`${reg.id}\`)`);
    partes.push(secoesDaAvaliacao(reg, analises[i], '###'));
  });
  partes.push(secaoConfiguracao(config), secaoJson());

  const dados = {
    ...cabecalhoJson(ESCOPOS.PARTIDA, tel, ambiente, config),
    partida: exportarPartida(partida, true, analises),
  };
  return montar(partes, dados, `partida-${partida.numero}`);
}

function relatorioDaSessao(tel, ambiente, config) {
  const analisesPorPartida = tel.partidas.map((p) => p.avaliacoes.map((reg) => analisarAvaliacao(reg)));
  const agregado = agregarSessao(tel, analisesPorPartida);
  const partes = [
    '# Relatório de balanceamento — Sessão inteira',
    `> Semana de Provas · escopo **sessão**: ${tel.partidas.length} partida(s) guardada(s), ` +
      `${agregado.avaliacoes} avaliação(ões). Agregados primeiro; depois cada partida; JSON completo no fim.`,
    secaoContexto(tel, ambiente, config, 'todas as partidas guardadas nesta sessão (desde que a página abriu)'),
    secaoSobreOJogo(),
    secaoComoLer(),
    '## Resumo da sessão',
    resumoDaSessao(tel, agregado),
    '## Por avaliação (agregado de todas as partidas)',
    tabelaAgregadaPorAvaliacao(agregado),
    '## Armas (agregado)',
    tabelaAgregadaDeArmas(agregado),
    '## Cartas de nível (agregado)',
    tabelaAgregadaDeCartas(agregado),
    '## Dano recebido por fonte (agregado)',
    tabelaAgregadaDeFontes(agregado),
    '## Partidas',
    tabela(
      ['#', 'situação', 'avaliações', 'créditos', 'notas', 'mortos', 'dano sofrido', 'tempo jogado'],
      tel.partidas.map((p, i) => {
        const as = analisesPorPartida[i];
        return [
          p.numero,
          rotuloSituacao(p.situacao),
          p.avaliacoes.length,
          p.creditos,
          p.avaliacoes.map((r) => (r.resultado && r.resultado.aprovado ? `${num(r.resultado.nota)} ${r.resultado.conceito}` : rotuloSituacao(r.situacao))).join(' / '),
          somar(as, 'kills'),
          num(as.reduce((s, x) => s + x.jogador.danoTomado, 0), 0),
          seg(as.reduce((s, x) => s + x.tempo, 0)),
        ];
      })
    ),
  ];
  tel.partidas.forEach((p, i) => {
    partes.push(`## Partida #${p.numero} — ${rotuloSituacao(p.situacao)}`);
    partes.push(tabelaDasAvaliacoes(p.avaliacoes));
    p.avaliacoes.forEach((reg, k) => {
      partes.push(`**${ordinal(reg.indice)} avaliação (\`${reg.id}\`) — leituras:**`);
      partes.push(listaDeSinais(analisesPorPartida[i][k].sinais));
    });
  });
  partes.push(secaoConfiguracao(config), secaoJson());

  const dados = {
    ...cabecalhoJson(ESCOPOS.SESSAO, tel, ambiente, config),
    agregado: agregado.json,
    partidas: tel.partidas.map((p, i) => exportarPartida(p, true, analisesPorPartida[i])),
  };
  return montar(partes, dados, 'sessao');
}

function montar(partes, dados, nomeBase) {
  const json = jsonLegivel(dados);
  const texto = `${partes.join('\n\n')}\n\n\`\`\`json\n${json}\n\`\`\`\n`;
  return { texto, nomeBase, dados };
}

// ------------------------------------------------------- secoes comuns

function secaoContexto(tel, ambiente, config, escopo) {
  const linhas = [
    '## Contexto',
    `- **Escopo:** ${escopo}.`,
    `- **Gerado em:** ${ambiente && ambiente.geradoEmLocal ? `${ambiente.geradoEmLocal}${ambiente.fusoHorario ? ` (${ambiente.fusoHorario})` : ''}` : 'sem relógio (gerado fora do navegador)'}.`,
    `- **Versão da configuração:** \`${config.hash}\` — hash dos números de jogo de \`data/content.js\`. ` +
      'Relatórios com o mesmo hash jogaram com exatamente os mesmos números.',
    `- **Semente do rng da sessão:** ${tel.semente}. As entradas do jogador não são gravadas, então a semente sozinha ` +
      'não reproduz a partida.',
  ];
  if (ambiente) {
    linhas.push(
      `- **Ambiente:** ${ambiente.navegador} · tela ${ambiente.tela} · janela ${ambiente.janela} · ` +
        `pixel ratio ${ambiente.pixelRatio} · idioma ${ambiente.idioma}.`
    );
  } else {
    linhas.push('- **Ambiente:** headless (node), sem medição de quadros.');
  }
  const s = tel.sessao;
  const telas = Object.entries(s.telas)
    .map(([tela, t]) => `${tela} ${seg(t)}`)
    .join(' · ');
  linhas.push(
    `- **Sessão:** ${s.partidasIniciadas} partida(s) iniciada(s)` +
      (s.partidasDescartadas > 0 ? `, ${s.partidasDescartadas} já fora do histórico (teto ${CONTEUDO.relatorio.historicoPartidas})` : '') +
      `; tempo em cada tela: ${telas || '—'}.`
  );
  if (s.quadros.quadros > 0) {
    linhas.push(
      `- **Desempenho na sessão:** ${num(s.quadros.quadros / s.quadros.somaDt, 0)} fps médios jogando, pior quadro ` +
        `${num(s.quadros.maxDt * 1000, 0)} ms, ${s.quadros.lentos} de ${s.quadros.quadros} quadros abaixo de ${fpsLento()} fps.`
    );
  }
  return linhas.join('\n');
}

function secaoSobreOJogo() {
  const n = CONTEUDO.nota;
  const faixas = n.faixas.map((f) => `${f.conceito} ≥ ${num(f.minimo)} (×${f.creditosFator} créditos)`).join(' · ');
  return [
    '## Sobre o jogo (para quem não conhece o código)',
    '**Semana de Provas** é um survivor: as armas atacam sozinhas e o jogador só se move. Uma **partida** (run) é ' +
      'uma sequência de **avaliações** com cronômetro; sobreviver até zerar aprova, e HP a zero **jubila**, o que ' +
      'encerra a partida inteira. Os inimigos nascem fora das bordas e perseguem o jogador. Quem morre solta XP, e ' +
      'cada nível abre uma carta com opções: arma nova ou +1 nível numa arma que já tem (com tudo no máximo, vira ' +
      'cura). As armas zeram a cada avaliação.',
    `A nota não aprova nem reprova, só decide os créditos da loja: **nota = mortos × ${n.pesoKill} + (HP restante ÷ ` +
      `HP máx.) × ${n.pesoHp} + ${n.bonusIleso} se não levou dano**, com cada parcela arredondada a ${n.casasDecimais} ` +
      `casa(s) e teto ${n.maxima}. Conceitos: ${faixas}; base de ${n.creditosBase} créditos.`,
    'Todo número de balanceamento mora em `data/content.js`. O resumo está em **Configuração usada**, e a ' +
      'configuração completa em `configuracao.valores`, no JSON.',
  ].join('\n\n');
}

function secaoComoLer() {
  const r = CONTEUDO.relatorio;
  return [
    '## Como ler',
    '- Tempos em segundos do **cronômetro da avaliação**. Carta e pausa congelam o cronômetro. "Tempo de tela" é a ' +
      'exceção: conta tudo.',
    '- Números com ponto decimal. "—" é valor que não se aplica (divisão por zero, trecho não jogado).',
    '- **Dano efetivo** é o HP que o golpe realmente tirou. **Nominal** é o dano da arma. **Overkill** é a diferença, ' +
      'desperdiçada em quem já ia morrer.',
    '- **Acertos** do comportamento `feixe` (Marca-texto) são contatos por quadro, não golpes. Compare as armas por ' +
      'dano, não por acertos.',
    `- **Perto**: inimigo com centro a até ${r.raioPerto}px do centro do jogador. **Folga**: distância de borda a ` +
      'borda até o inimigo mais próximo (0 = encostado).',
    `- **Rente à borda**: corpo do jogador a até ${r.margemBorda}px de uma parede. **No canto**: a até ` +
      `${r.margemCanto}px de duas paredes. **Parado**: abaixo de ${r.velocidadeParado} px/s.`,
    '- **Sumiram**: inimigos que nasceram e não morreram nem estavam vivos no fim (descartados por se afastar demais).',
    `- A **linha do tempo** agrupa amostras de ${r.amostraSegundos}s em janelas de ${r.janelaTabela}s. Colunas de ` +
      'estado (HP, nível, vivos...) são o valor no fim da janela; colunas de contagem (mortos, dano...) são a soma ' +
      'dentro dela.',
    '- **Leituras automáticas** comparam com os alvos do design e com os limiares de `CONTEUDO.relatorio.alertas`. ' +
      'São pistas para investigar, não conclusões. ⚠ marca o que passou de um limiar.',
  ].join('\n');
}

function secaoJson() {
  return [
    '## Dados brutos (JSON)',
    'Tudo o que foi medido, incluindo o que as tabelas resumem. `amostras` vem em colunas: `colunas` nomeia cada ' +
      'posição de `linhas`, uma linha por amostra. As colunas de contagem valem da amostra anterior até esta. ' +
      '`analise` traz os números derivados que o Markdown mostra.',
  ].join('\n\n');
}

function secaoConfiguracao(config) {
  const v = config.valores;
  const partes = ['## Configuração usada', `Hash \`${config.hash}\`. Valores completos em \`configuracao.valores\`, no JSON.`];
  const jg = v.jogador;
  const topicos = [
    `- **Jogador:** HP ${jg.hpMax} · velocidade ${jg.velocidade} px/s · aceleração ${jg.aceleracao} · raio ${jg.raio}px · ` +
      `ímã de XP ${jg.raioColeta}px · i-frames ${jg.iframesDuracao}s.`,
    `- **XP por nível** (quanto falta do nível N para o N+1): ${v.xp.porNivel.join(', ')}.`,
    `- **Cartas:** ${v.cartas.quantidade} opções · peso arma nova ${v.cartas.pesoArmaNova} · peso +1 nível ` +
      `${v.cartas.pesoArmaNivel} · consolo +${v.cartas.consolo.valor} HP.`,
    `- **Spawn:** dificuldade global ×${v.ajuste.dificuldade} · teto de ${v.spawn.maxSimultaneos} vivos · até ` +
      `${v.spawn.porOndaMaximo} por onda · intervalo mínimo ${v.spawn.intervaloMinimo}s · nascem ${v.arena.margemSpawn}px ` +
      `fora da parede da arena de cada avaliação (a tela é ${v.arena.largura}×${v.arena.altura}; um modificador de ` +
      'arena a encolhe em volta do centro).',
  ];
  if (v.coringas.length > 0) topicos.push(`- **Coringas:** ${v.coringas.map((c) => c.id).join(', ')}.`);
  if (v.modificadores.length > 0) topicos.push(`- **Modificadores:** ${v.modificadores.map((m) => m.id).join(', ')}.`);
  partes.push(topicos.join('\n'));
  partes.push(
    tabela(
      ['inimigo', 'HP', 'velocidade', 'dano', 'raio', 'xp', 'peso'],
      v.inimigos.map((i) => [`${i.emoji} ${i.nome} (\`${i.id}\`)`, i.hp, i.velocidade, i.dano, i.raio, i.xp, i.peso])
    )
  );
  const curva = v.spawn.curvas[v.spawn.curvaPadrao] || [];
  partes.push(
    `Curva de spawn \`${v.spawn.curvaPadrao}\` (interpolada entre os pontos):`,
    tabela(['t (s)', 'intervalo entre ondas (s)', 'inimigos por onda'], curva.map((p) => [p.t, p.intervalo, p.porOnda]))
  );
  const linhasArmas = [];
  for (const arma of v.armas) {
    arma.niveis.forEach((nivel, i) => {
      linhasArmas.push([
        i === 0 ? `${arma.emoji} ${arma.nome} (\`${arma.comportamento}\`)` : '',
        i + 1,
        Object.entries(nivel).map(([k, x]) => `${k} ${x}`).join(' · '),
      ]);
    });
  }
  partes.push('Armas, nível a nível:', tabela(['arma', 'nível', 'números'], linhasArmas));
  partes.push(
    tabela(
      ['período', 'avaliação', 'matéria', 'id', 'tipo', 'duração (s)', 'dificuldade', 'modificadores sorteados'],
      v.periodos.flatMap((p) =>
        p.avaliacoes.map((av) => [p.nome, av.nome, av.materia, `\`${av.id}\``, av.tipo, av.duracao, av.dificuldade, av.modificadores])
      )
    )
  );
  return partes.join('\n\n');
}

// ---------------------------------------------------- secoes da avaliacao

function secoesDaAvaliacao(reg, a, h) {
  const partes = [
    `${h} Resumo`,
    tabelaResumo(reg, a),
    `${h} Leituras automáticas`,
    listaDeSinais(a.sinais),
    `${h} Linha do tempo`,
    tabelaLinhaDoTempo(reg, a),
    `${h} Armas`,
    tabelaArmas(a),
    'Por nível (o tempo é quanto a arma passou naquele nível; o DPS divide o dano efetivo por ele):',
    tabelaArmasPorNivel(a),
    `${h} Cartas de nível`,
    tabelaCartas(reg),
    `${h} Dano recebido`,
    tabelaFontes(a),
    tabelaGolpes(reg),
    `${h} Inimigos`,
    tabelaInimigos(a),
    `${h} Movimento e posição`,
    listaMovimento(a),
    `Mapa de calor: % do tempo em cada região da arena desta avaliação (${rotuloDaArena(arenaDoRegistro(reg))}; ` +
      'rótulos em coordenadas da tela; y cresce para baixo; o maior valor em negrito).',
    mapaDeCalor(a, arenaDoRegistro(reg)),
    `${h} Pressão`,
    listaPressao(a),
    `${h} Tempo de tela e desempenho`,
    listaTelasEDesempenho(a),
  ];
  return partes.filter((p) => p !== '').join('\n\n');
}

function tabelaResumo(reg, a) {
  const linhas = [];
  linhas.push(['Resultado', descreverResultado(reg, a)]);
  if (a.nota) {
    const n = a.nota;
    linhas.push([
      'Nota',
      `**${num(n.nota)} (${n.conceito})** = mortes +${num(n.parcelas.kills)} · HP +${num(n.parcelas.hp)} · ileso +${num(n.parcelas.ileso)}`,
    ]);
    linhas.push(['Créditos', `+${n.creditos} (partida: ${n.creditosTotal})`]);
  }
  linhas.push(['Mortos', `${a.kills} (${num(a.killsPorSegundo, 2)}/s)`]);
  linhas.push([
    'Dano sofrido',
    `${num(a.jogador.danoTomado, 0)} em ${a.jogador.golpes} golpe(s) · HP final ${num(a.jogador.hpFinal, 0)}/${a.jogador.hpMax}` +
      ` · HP mínimo ${num(a.jogador.hpMin, 0)} · curado ${num(a.jogador.curado, 0)}`,
  ]);
  const alvo = CONTEUDO.relatorio.alvos.nivel;
  linhas.push([
    'Nível',
    `${a.nivelFinal} (nível ${alvo} ${a.nivelAlvoEm !== null ? `aos ${seg(a.nivelAlvoEm)}` : 'não alcançado'})`,
  ]);
  linhas.push([
    'XP',
    `${a.xp.solto} solto · ${a.xp.coletado} coletado (${pct(a.xp.taxaColeta)}) · ${a.xp.noChao} no chão no fim`,
  ]);
  linhas.push(['Armas no fim', reg.final ? reg.final.armas.map((x) => `${nomeArma(x.id)} nv${x.nivel}`).join(' · ') || '—' : '—']);
  linhas.push(['Cartas', `${a.cartas.total} (decisão média ${seg(a.cartas.decisaoMedia)})`]);
  linhas.push([
    'Tempo de tela',
    `${seg(a.telas.avaliacao || 0)} jogando · ${seg(a.telas.carta || 0)} em cartas · ${seg(a.telas.pausa || 0)} pausado ` +
      `(${a.pausas} pausa(s))`,
  ]);
  return tabela(['campo', 'valor'], linhas);
}

function descreverResultado(reg, a) {
  // O TCC (fase 10) nao tem cronometro: duracao 0 diria "aos 0s".
  if (!(reg.duracao > 0)) {
    if (reg.situacao === SITUACAO.APROVADO) return `✅ A Banca caiu aos ${seg(reg.tempoJogado)} de defesa`;
    if (reg.situacao === SITUACAO.JUBILADO) return `❌ jubilado aos ${seg(reg.morte ? reg.morte.t : a.tempo)} de defesa`;
    return `⏹ defesa ${reg.situacao} aos ${seg(a.tempo)}`;
  }
  switch (reg.situacao) {
    case SITUACAO.APROVADO:
      return `✅ aprovado: sobreviveu aos ${reg.duracao}s`;
    case SITUACAO.JUBILADO:
      return `❌ jubilado aos ${seg(reg.morte ? reg.morte.t : a.tempo)} de ${reg.duracao}s`;
    case SITUACAO.DESISTIU:
      return `🚪 desistiu aos ${seg(a.tempo)} de ${reg.duracao}s`;
    case SITUACAO.INTERROMPIDA:
      return `⏹ interrompida aos ${seg(a.tempo)} de ${reg.duracao}s`;
    default:
      return `⏳ em andamento (${seg(a.tempo)} de ${reg.duracao}s)`;
  }
}

function listaDeSinais(sinais) {
  if (sinais.length === 0) return '_(nenhuma)_';
  return sinais.map((s) => `- ${s.alerta ? '⚠ ' : ''}${s.texto}`).join('\n');
}

function tabelaLinhaDoTempo(reg, a) {
  const cfg = CONTEUDO.relatorio;
  const janelas = janelasDaLinhaDoTempo(reg, cfg.janelaTabela);
  if (janelas.length === 0) return '_(sem amostras: a avaliação não chegou a 1 amostra)_';
  const ativas = reg.armas.map((x, i) => ({ id: x.id, i })).filter((x) => a.armas.some((y) => y.id === x.id));
  const cabecalho = [
    't (s)', 'HP', 'nível', 'vivos', 'na arena', 'perto', 'nasceram', 'mortos', 'golpes', 'dano sofrido', 'dano causado',
    ...ativas.map((x) => `dano ${x.id}`), 'XP coletado', 'orbes no chão', 'distância', 'posição',
  ];
  const linhas = janelas.map((jn) => {
    const u = jn.ultima;
    return [
      `${num(jn.inicio, 0)}–${num(Math.min(jn.fim, reg.duracao), 0)}`,
      num(u.hp, 0),
      u.nivel,
      u.vivos,
      u.naArena,
      u.perto,
      jn.nascidos,
      jn.mortos,
      jn.golpes,
      num(jn.danoTomado, 0),
      num(jn.danoCausado, 0),
      ...ativas.map((x) => num(jn.danoPorArma[x.i] || 0, 0)),
      jn.xpColetado,
      u.orbes,
      num(jn.distancia, 0),
      `${u.x},${u.y}`,
    ];
  });
  return tabela(cabecalho, linhas);
}

function janelasDaLinhaDoTempo(reg, tamanho) {
  const ultima = Math.max(1, Math.ceil(reg.duracao / tamanho - EPS));
  const janelas = [];
  for (const a of reg.amostras) {
    const k = Math.min(ultima, Math.max(1, Math.ceil(a.t / tamanho - EPS)));
    let jn = janelas[janelas.length - 1];
    if (!jn || jn.k !== k) {
      jn = {
        k,
        inicio: (k - 1) * tamanho,
        fim: k * tamanho,
        ultima: a,
        nascidos: 0,
        mortos: 0,
        golpes: 0,
        danoTomado: 0,
        danoCausado: 0,
        danoPorArma: a.danoPorArma.map(() => 0),
        xpColetado: 0,
        distancia: 0,
      };
      janelas.push(jn);
    }
    jn.ultima = a;
    jn.nascidos += a.nascidos;
    jn.mortos += a.mortos;
    jn.golpes += a.golpes;
    jn.danoTomado += a.danoTomado;
    jn.danoCausado += a.danoCausado;
    a.danoPorArma.forEach((d, i) => {
      jn.danoPorArma[i] = (jn.danoPorArma[i] || 0) + d;
    });
    jn.xpColetado += a.xpColetado;
    jn.distancia += a.distancia;
  }
  return janelas;
}

function tabelaArmas(a) {
  if (a.armas.length === 0) return '_(nenhuma arma registrada)_';
  return tabela(
    ['arma', 'nível final', 'equipada em', 'níveis (quando)', 'tempo equipada', 'disparos', 'acertos', 'mortes', '% mortes', 'dano efetivo', '% dano', 'overkill', 'DPS efetivo'],
    a.armas.map((x) => [
      `${x.nome} (\`${x.comportamento}\`)`,
      x.nivelFinal,
      seg(x.equipadaEm),
      x.niveis.map((n) => `${n.nivel}@${num(n.t)}s`).join(' → ') || '—',
      seg(x.tempoEquipada),
      x.disparos,
      x.acertos,
      x.mortes,
      pct(x.fracMortes),
      num(x.danoEfetivo, 0),
      pct(x.fracDano),
      pct(x.overkill),
      num(x.dps),
    ])
  );
}

function tabelaArmasPorNivel(a) {
  const linhas = [];
  for (const x of a.armas) {
    for (const n of x.porNivel) {
      linhas.push([x.nome, n.nivel, seg(n.tempo), n.disparos, n.acertos, n.mortes, num(n.danoEfetivo, 0), num(n.danoNominal - n.danoEfetivo, 0), num(n.dps)]);
    }
  }
  return tabela(['arma', 'nível', 'tempo', 'disparos', 'acertos', 'mortes', 'dano efetivo', 'overkill', 'DPS efetivo'], linhas);
}

function tabelaCartas(reg) {
  if (reg.cartas.length === 0) return '_(nenhuma carta nesta avaliação)_';
  return tabela(
    ['#', 't (s)', 'nível', 'opções (★ = escolhida)', 'decisão (s)'],
    reg.cartas.map((c, i) => [
      i + 1,
      num(c.t),
      c.nivel,
      c.opcoes.map((o, k) => `${k === c.escolhida ? '★ ' : ''}${descreverOpcao(o)}`).join(' / '),
      c.escolhida >= 0 ? num(c.decisao) : 'sem resposta',
    ])
  );
}

function descreverOpcao(o) {
  const consolo = CONTEUDO.cartas.consolo;
  if (o.id === consolo.id || o.para <= 0) return `${consolo.emoji} ${consolo.nome} (+${o.valor} HP)`;
  if (o.de <= 0) return `${nomeArma(o.id)} (nova)`;
  return `${nomeArma(o.id)} ${o.de}→${o.para}`;
}

function tabelaFontes(a) {
  if (a.fontes.length === 0) return 'Nenhum dano recebido.';
  return tabela(
    ['fonte', 'golpes', 'dano', '% do dano'],
    a.fontes.map((f) => [f.nome, f.golpes, num(f.dano, 0), pct(f.frac)])
  );
}

function tabelaGolpes(reg) {
  if (reg.golpes.length === 0) return '';
  return (
    'Golpe a golpe:\n\n' +
    tabela(
      ['#', 't (s)', 'fonte', 'dano', 'HP depois', 'perto', 'vivos', 'nível', 'jogador em', 'inimigo em'],
      reg.golpes.map((g, i) => [
        i + 1,
        num(g.t),
        nomeFonte(g.fonte),
        num(g.dano, 0),
        num(g.hp, 0),
        g.perto,
        g.vivos,
        g.nivel,
        `${g.jogadorX},${g.jogadorY}`,
        `${g.x},${g.y}`,
      ])
    )
  );
}

function tabelaInimigos(a) {
  if (a.inimigos.length === 0) return '_(nenhum inimigo registrado)_';
  return tabela(
    ['tipo', 'nasceram', 'morreram', 'vivos no fim', 'sumiram', 'vida média', 'distância ao morrer', 'mortos fora da arena', 'golpes no jogador', 'dano no jogador'],
    a.inimigos.map((i) => [
      i.nome,
      i.nascidos,
      i.mortos,
      i.vivosFim,
      i.sumiram,
      seg(i.vidaMedia),
      `${num(i.distanciaMorte, 0)}px`,
      pct(i.fracForaDaArena),
      i.golpes,
      num(i.dano, 0),
    ])
  );
}

function listaMovimento(a) {
  const m = a.movimento;
  const c = m.celulaMaisUsada;
  return [
    `- Distância percorrida: ${num(m.distancia, 0)}px · velocidade média ${num(m.velocidadeMedia, 0)} px/s ` +
      `(máximo do jogador: ${CONTEUDO.jogador.velocidade}).`,
    `- Parado ${pct(m.fracParado)} · com tecla de movimento apertada ${pct(m.fracComInput)} · rente à borda ` +
      `${pct(m.fracBorda)} · no canto ${pct(m.fracCanto)} do tempo.`,
    c ? `- Região mais usada: coluna ${c.coluna + 1}, linha ${c.linha + 1} (${pct(c.frac)} do tempo).` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// A telemetria mede parede, canto e grade relativos a arena da avaliacao
// (menor com um modificador de arena). Registro sem ela: a tela inteira.
function arenaDoRegistro(reg) {
  if (reg && reg.arena) return reg.arena;
  return { esquerda: 0, topo: 0, direita: CONTEUDO.arena.largura, base: CONTEUDO.arena.altura };
}

function rotuloDaArena(ar) {
  const { largura, altura } = CONTEUDO.arena;
  const w = Math.round(ar.direita - ar.esquerda);
  const h = Math.round(ar.base - ar.topo);
  return w === largura && h === altura ? `${w}×${h}px, a tela inteira` : `${w}×${h}px dentro da tela de ${largura}×${altura}`;
}

function mapaDeCalor(a, arena) {
  const { gradeColunas: colunas, gradeLinhas: linhas } = CONTEUDO.relatorio;
  const { esquerda, topo } = arena;
  const largura = arena.direita - esquerda;
  const altura = arena.base - topo;
  const grade = a.movimento.grade;
  let maior = -1;
  for (const f of grade) if (Number.isFinite(f) && f > maior) maior = f;
  const cabecalho = ['y \\ x'];
  for (let c = 0; c < colunas; c += 1) {
    cabecalho.push(`${Math.round(esquerda + (c * largura) / colunas)}–${Math.round(esquerda + ((c + 1) * largura) / colunas)}`);
  }
  const corpo = [];
  for (let l = 0; l < linhas; l += 1) {
    const linha = [`${Math.round(topo + (l * altura) / linhas)}–${Math.round(topo + ((l + 1) * altura) / linhas)}`];
    for (let c = 0; c < colunas; c += 1) {
      const f = grade[l * colunas + c];
      const texto = pct(f);
      linha.push(f === maior && f > 0 ? `**${texto}**` : texto);
    }
    corpo.push(linha);
  }
  return tabela(cabecalho, corpo);
}

function listaPressao(a) {
  const p = a.pressao;
  const r = CONTEUDO.relatorio;
  return [
    `- Inimigos vivos: ${num(p.vivosMedio)} em média, pico ${p.vivosPico} (teto do jogo: ${CONTEUDO.spawn.maxSimultaneos}).`,
    `- Dentro da arena (visíveis): ${num(p.naArenaMedio)} em média.`,
    `- A menos de ${r.raioPerto}px: ${num(p.pertoMedio)} em média, pico ${p.pertoPico}; algum perto em ${pct(p.fracComPerto)} do tempo.`,
    `- Folga média até o inimigo mais próximo: ${num(p.folgaMedia, 0)}px.`,
    `- Tempo com a arena no teto de simultâneos: ${seg(p.tempoNoTeto)}.`,
  ].join('\n');
}

function listaTelasEDesempenho(a) {
  const t = a.telas;
  const linhas = [
    `- Jogando ${seg(t.avaliacao || 0)} · cartas ${seg(t.carta || 0)} · pausa ${seg(t.pausa || 0)} (${a.pausas} pausa(s))` +
      (t.resultado || t.jubilado ? ` · boletim ${seg((t.resultado || 0) + (t.jubilado || 0))}` : '') +
      '.',
  ];
  if (a.quadros) {
    const q = a.quadros;
    linhas.push(
      `- ${q.quadros} quadros a ${num(q.fps, 1)} fps médios · pior quadro ${num(q.maxDtMs, 0)} ms · ` +
        `${q.lentos} (${pct(q.fracLentos, 1)}) abaixo de ${fpsLento()} fps · ${q.noTeto} no teto de passos (tempo descartado).`
    );
  } else {
    linhas.push('- Quadros não medidos (sem navegador).');
  }
  return linhas.join('\n');
}

// ---------------------------------------------------- partida e sessao

function tabelaDasAvaliacoes(avaliacoes) {
  return tabela(
    ['#', 'avaliação', 'período', 'resultado', 'tempo', 'nota', 'conceito', 'créditos', 'mortos', 'dano sofrido', 'HP final', 'nível', 'armas no fim'],
    avaliacoes.map((reg) => {
      const r = reg.resultado;
      const aprovado = r && r.aprovado;
      return [
        reg.indice,
        `${reg.nome} (\`${reg.id}\`)`,
        reg.periodo,
        rotuloSituacao(reg.situacao),
        `${seg(reg.tempoJogado)} / ${reg.duracao}s`,
        aprovado ? num(r.nota) : '—',
        aprovado ? r.conceito : '—',
        aprovado ? r.creditos : '—',
        somar(reg.inimigos, 'mortos'),
        num(reg.jogador.danoTomado, 0),
        reg.final ? `${num(reg.final.hp, 0)}/${reg.final.hpMax}` : '—',
        reg.final ? reg.final.nivel : '—',
        reg.final ? reg.final.armas.map((x) => `${x.id}${x.nivel}`).join(' ') : '—',
      ];
    })
  );
}

function resumoDaPartida(partida, analises) {
  const aprovadas = partida.avaliacoes.filter((r) => r.situacao === SITUACAO.APROVADO);
  const notas = aprovadas.map((r) => r.resultado.nota);
  return [
    `- **Situação:** ${rotuloSituacao(partida.situacao)}.`,
    `- **Avaliações:** ${partida.avaliacoes.length} jogada(s), ${aprovadas.length} aprovada(s).`,
    `- **Notas:** ${notas.length > 0 ? `${notas.map((n) => num(n)).join(' / ')} (média ${num(media(notas))})` : '—'}.`,
    `- **Créditos acumulados:** ${partida.creditos}.`,
    `- **Coringas:** ${partida.coringas.length > 0 ? partida.coringas.join(', ') : 'nenhum'}.`,
    `- **Total:** ${somar(analises, 'kills')} mortos · ${num(analises.reduce((s, a) => s + a.jogador.danoTomado, 0), 0)} ` +
      `de dano sofrido · ${seg(analises.reduce((s, a) => s + a.tempo, 0))} de cronômetro.`,
  ].join('\n');
}

function agregarSessao(tel, analisesPorPartida) {
  const cfg = CONTEUDO.relatorio;
  const porAvaliacao = new Map();
  const armas = new Map();
  const cartas = new Map();
  const fontes = new Map();
  let avaliacoes = 0;

  tel.partidas.forEach((partida, i) => {
    partida.avaliacoes.forEach((reg, k) => {
      const a = analisesPorPartida[i][k];
      avaliacoes += 1;
      let g = porAvaliacao.get(reg.id);
      if (!g) {
        g = {
          id: reg.id, nome: reg.nome, periodo: reg.periodo, duracao: reg.duracao, jogadas: 0,
          situacoes: {}, notas: [], conceitos: {}, tempoDeMorte: [], mortos: [], dano: [], hpFinal: [], nivelFinal: [], nivelAos: {},
        };
        porAvaliacao.set(reg.id, g);
      }
      g.jogadas += 1;
      g.situacoes[reg.situacao] = (g.situacoes[reg.situacao] || 0) + 1;
      if (reg.resultado && reg.resultado.aprovado) {
        g.notas.push(reg.resultado.nota);
        g.conceitos[reg.resultado.conceito] = (g.conceitos[reg.resultado.conceito] || 0) + 1;
      }
      if (reg.situacao === SITUACAO.JUBILADO) g.tempoDeMorte.push(reg.morte ? reg.morte.t : a.tempo);
      g.mortos.push(a.kills);
      g.dano.push(a.jogador.danoTomado);
      if (Number.isFinite(a.jogador.hpFinal)) g.hpFinal.push(a.jogador.hpFinal);
      g.nivelFinal.push(a.nivelFinal);
      for (const m of a.marcosNivel) {
        if (m.nivel === null) continue;
        if (!g.nivelAos[m.t]) g.nivelAos[m.t] = [];
        g.nivelAos[m.t].push(m.nivel);
      }

      for (const x of a.armas) {
        let ga = armas.get(x.id);
        if (!ga) {
          ga = { id: x.id, nome: x.nome, presente: 0, niveis: [], fracDano: [], dps: [], overkill: [], mortes: 0 };
          armas.set(x.id, ga);
        }
        ga.presente += 1;
        ga.niveis.push(x.nivelFinal);
        if (Number.isFinite(x.fracDano)) ga.fracDano.push(x.fracDano);
        if (Number.isFinite(x.dps)) ga.dps.push(x.dps);
        if (Number.isFinite(x.overkill)) ga.overkill.push(x.overkill);
        ga.mortes += x.mortes;
      }

      for (const c of reg.cartas) {
        c.opcoes.forEach((o, idx) => {
          const tipoCarta = o.de <= 0 && o.para > 0 ? 'nova' : o.para > 0 ? 'nível' : 'consolo';
          const chave = `${o.id}|${tipoCarta}`;
          let gc = cartas.get(chave);
          if (!gc) {
            gc = { id: o.id, tipo: tipoCarta, nome: o.para > 0 ? nomeArma(o.id) : descreverOpcao(o), oferecida: 0, escolhida: 0 };
            cartas.set(chave, gc);
          }
          gc.oferecida += 1;
          if (idx === c.escolhida) gc.escolhida += 1;
        });
      }

      for (const f of reg.fontesDano) {
        let gf = fontes.get(f.fonte);
        if (!gf) {
          gf = { fonte: f.fonte, nome: nomeFonte(f.fonte), golpes: 0, dano: 0 };
          fontes.set(f.fonte, gf);
        }
        gf.golpes += f.golpes;
        gf.dano += f.dano;
      }
    });
  });

  const listaAvaliacoes = [...porAvaliacao.values()];
  const listaArmas = [...armas.values()];
  const listaCartas = [...cartas.values()].sort((x, y) => y.oferecida - x.oferecida);
  const listaFontes = [...fontes.values()].sort((x, y) => y.dano - x.dano);
  const partidasPorSituacao = {};
  for (const p of tel.partidas) partidasPorSituacao[p.situacao] = (partidasPorSituacao[p.situacao] || 0) + 1;

  return {
    avaliacoes,
    partidasPorSituacao,
    porAvaliacao: listaAvaliacoes,
    armas: listaArmas,
    cartas: listaCartas,
    fontes: listaFontes,
    marcos: cfg.marcosNivel,
    json: {
      avaliacoes,
      partidasPorSituacao,
      porAvaliacao: listaAvaliacoes.map((g) => ({
        id: g.id,
        jogadas: g.jogadas,
        situacoes: g.situacoes,
        taxaJubilamento: razao(g.situacoes[SITUACAO.JUBILADO] || 0, g.jogadas),
        notaMedia: media(g.notas),
        conceitos: g.conceitos,
        tempoMedioDeMorte: media(g.tempoDeMorte),
        mortosMedio: media(g.mortos),
        danoMedio: media(g.dano),
        hpFinalMedio: media(g.hpFinal),
        nivelFinalMedio: media(g.nivelFinal),
        nivelMedioAos: Object.fromEntries(Object.entries(g.nivelAos).map(([t, ns]) => [t, media(ns)])),
      })),
      armas: listaArmas.map((g) => ({
        id: g.id,
        presenteEm: razao(g.presente, avaliacoes),
        nivelFinalMedio: media(g.niveis),
        fracDanoMedia: media(g.fracDano),
        dpsMedio: media(g.dps),
        overkillMedio: media(g.overkill),
        mortes: g.mortes,
      })),
      cartas: listaCartas.map((g) => ({ id: g.id, tipo: g.tipo, oferecida: g.oferecida, escolhida: g.escolhida, taxa: razao(g.escolhida, g.oferecida) })),
      fontes: listaFontes.map((g) => ({ fonte: g.fonte, golpes: g.golpes, dano: g.dano })),
    },
  };
}

function resumoDaSessao(tel, ag) {
  const situacoes = Object.entries(ag.partidasPorSituacao)
    .map(([s, n]) => `${rotuloSituacao(s)} ${n}`)
    .join(' · ');
  return [
    `- **Partidas guardadas:** ${tel.partidas.length} (${situacoes || '—'}).`,
    `- **Avaliações jogadas:** ${ag.avaliacoes}.`,
    `- **Partidas iniciadas na sessão:** ${tel.sessao.partidasIniciadas}` +
      (tel.sessao.partidasDescartadas > 0 ? ` (${tel.sessao.partidasDescartadas} mais antigas já saíram do histórico).` : '.'),
  ].join('\n');
}

function tabelaAgregadaPorAvaliacao(ag) {
  const marcos = new Set();
  for (const g of ag.porAvaliacao) for (const t of Object.keys(g.nivelAos)) marcos.add(Number(t));
  const ordem = [...marcos].sort((x, y) => x - y);
  return tabela(
    ['avaliação', 'jogadas', 'aprovado', 'jubilado', 'desistiu', 'nota média', 'conceitos', 'morte média', 'mortos médio', 'dano médio', 'HP final médio', 'nível final médio', ...ordem.map((t) => `nível aos ${t}s`)],
    ag.porAvaliacao.map((g) => [
      `${g.periodo} · ${g.nome} (\`${g.id}\`)`,
      g.jogadas,
      g.situacoes[SITUACAO.APROVADO] || 0,
      g.situacoes[SITUACAO.JUBILADO] || 0,
      g.situacoes[SITUACAO.DESISTIU] || 0,
      num(media(g.notas)),
      Object.entries(g.conceitos).map(([c, n]) => `${c}${n}`).join(' ') || '—',
      seg(media(g.tempoDeMorte)),
      num(media(g.mortos), 0),
      num(media(g.dano), 0),
      num(media(g.hpFinal), 0),
      num(media(g.nivelFinal)),
      ...ordem.map((t) => num(media(g.nivelAos[t] || []))),
    ])
  );
}

function tabelaAgregadaDeArmas(ag) {
  if (ag.armas.length === 0) return '_(nenhuma)_';
  return tabela(
    ['arma', 'presente em', 'nível final médio', '% médio do dano', 'DPS médio', 'overkill médio', 'mortes'],
    ag.armas.map((g) => [
      g.nome,
      `${g.presente} de ${ag.avaliacoes} (${pct(razao(g.presente, ag.avaliacoes))})`,
      num(media(g.niveis)),
      pct(media(g.fracDano)),
      num(media(g.dps)),
      pct(media(g.overkill)),
      g.mortes,
    ])
  );
}

function tabelaAgregadaDeCartas(ag) {
  if (ag.cartas.length === 0) return '_(nenhuma carta)_';
  return tabela(
    ['opção', 'tipo', 'oferecida', 'escolhida', 'taxa de escolha'],
    ag.cartas.map((g) => [g.nome, g.tipo, g.oferecida, g.escolhida, pct(razao(g.escolhida, g.oferecida))])
  );
}

function tabelaAgregadaDeFontes(ag) {
  if (ag.fontes.length === 0) return 'Nenhum dano recebido em toda a sessão.';
  const total = ag.fontes.reduce((s, f) => s + f.dano, 0);
  return tabela(
    ['fonte', 'golpes', 'dano', '% do dano'],
    ag.fontes.map((f) => [f.nome, f.golpes, num(f.dano, 0), pct(razao(f.dano, total))])
  );
}

// ------------------------------------------------------------------ JSON

function cabecalhoJson(escopo, tel, ambiente, config) {
  return {
    formato: FORMATO_RELATORIO,
    versao: VERSAO_RELATORIO,
    versaoTelemetria: tel.versao,
    escopo,
    geradoEm: ambiente && ambiente.geradoEm ? ambiente.geradoEm : null,
    ambiente: ambiente || null,
    configuracao: config,
    instrumento: CONTEUDO.relatorio,
    sessao: { semente: tel.semente, ...tel.sessao },
  };
}

function exportarPartida(partida, detalhe, analises = null) {
  const base = {
    numero: partida.numero,
    situacao: partida.situacao,
    iniciadaEm: partida.iniciadaEm,
    encerradaEm: partida.encerradaEm,
    creditos: partida.creditos,
    coringas: partida.coringas,
  };
  if (detalhe) {
    base.avaliacoes = partida.avaliacoes.map((reg, i) => exportarAvaliacao(reg, analises ? analises[i] : analisarAvaliacao(reg)));
  } else {
    base.avaliacoes = partida.avaliacoes.map((reg) => ({
      indice: reg.indice,
      id: reg.id,
      situacao: reg.situacao,
      tempoJogado: reg.tempoJogado,
      nota: reg.resultado ? reg.resultado.nota : null,
      conceito: reg.resultado ? reg.resultado.conceito : null,
      creditos: reg.resultado ? reg.resultado.creditos : null,
      mortos: somar(reg.inimigos, 'mortos'),
      danoTomado: reg.jogador.danoTomado,
    }));
  }
  return base;
}

function exportarAvaliacao(reg, analise) {
  const { amostras, ...resto } = reg;
  return { ...resto, amostras: amostrasEmColunas(reg), analise };
}

function amostrasEmColunas(reg) {
  const ids = reg.armas.map((a) => a.id);
  const colunas = [
    't', 'hp', 'nivel', 'xp', 'xpProximo', 'vivos', 'naArena', 'perto', 'folga', 'orbes', 'xpNoChao', 'projeteis',
    'x', 'y', 'mortos', 'nascidos', 'golpes', 'danoTomado', 'danoCausado', ...ids.map((id) => `dano:${id}`),
    'xpColetado', 'distancia',
  ];
  const linhas = reg.amostras.map((a) => [
    a.t, a.hp, a.nivel, a.xp, a.xpProximo, a.vivos, a.naArena, a.perto, a.folga, a.orbes, a.xpNoChao, a.projeteis,
    a.x, a.y, a.mortos, a.nascidos, a.golpes, a.danoTomado, a.danoCausado,
    ...ids.map((_, i) => (Number.isFinite(a.danoPorArma[i]) ? a.danoPorArma[i] : 0)),
    a.xpColetado, a.distancia,
  ]);
  return { colunas, linhas };
}

// JSON legivel e compacto: listas de numeros ficam numa linha so (uma amostra
// por linha), objetos curtos tambem. Numero nao finito vira null, e fracao
// fica com 6 algarismos significativos: some a cauda de ponto flutuante sem
// estragar valor pequeno de configuracao (loop.passo = 1/60).
function jsonLegivel(valor, recuo = '') {
  if (valor === null || valor === undefined) return 'null';
  if (typeof valor === 'number') return Number.isFinite(valor) ? String(arredJson(valor)) : 'null';
  if (typeof valor !== 'object') return JSON.stringify(valor);
  const dentro = `${recuo}  `;
  if (Array.isArray(valor)) {
    if (valor.length === 0) return '[]';
    if (valor.every(ehPrimitivo)) return `[${valor.map((v) => jsonLegivel(v)).join(', ')}]`;
    return `[\n${valor.map((v) => dentro + jsonLegivel(v, dentro)).join(',\n')}\n${recuo}]`;
  }
  const chaves = Object.keys(valor).filter((k) => valor[k] !== undefined && typeof valor[k] !== 'function');
  if (chaves.length === 0) return '{}';
  const plano = chaves.every((k) => ehPrimitivo(valor[k]) || (Array.isArray(valor[k]) && valor[k].every(ehPrimitivo)));
  if (plano) {
    const linha = `{ ${chaves.map((k) => `${JSON.stringify(k)}: ${jsonLegivel(valor[k])}`).join(', ')} }`;
    if (linha.length <= 150) return linha;
  }
  return `{\n${chaves.map((k) => `${dentro}${JSON.stringify(k)}: ${jsonLegivel(valor[k], dentro)}`).join(',\n')}\n${recuo}}`;
}

function ehPrimitivo(v) {
  return v === null || v === undefined || typeof v !== 'object';
}

function arredJson(v) {
  if (Number.isInteger(v)) return v;
  const r = Number(v.toPrecision(6));
  return Object.is(r, -0) ? 0 : r;
}

// ----------------------------------------------------------- utilitarios

function tabela(cabecalho, linhas) {
  if (linhas.length === 0) return '_(vazio)_';
  const celula = (v) => String(v === null || v === undefined ? '—' : v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const saida = [`| ${cabecalho.map(celula).join(' | ')} |`, `|${cabecalho.map(() => '---').join('|')}|`];
  for (const linha of linhas) saida.push(`| ${linha.map(celula).join(' | ')} |`);
  return saida.join('\n');
}

function num(v, casas = 1) {
  return Number.isFinite(v) ? v.toFixed(casas) : '—';
}

function pct(fracao, casas = 0) {
  return Number.isFinite(fracao) ? `${(fracao * 100).toFixed(casas)}%` : '—';
}

function seg(t, casas = 1) {
  return Number.isFinite(t) ? `${t.toFixed(casas)}s` : '—';
}

function razao(a, b) {
  return b > 0 ? a / b : NaN;
}

function media(lista) {
  const validos = lista.filter(Number.isFinite);
  return validos.length > 0 ? validos.reduce((s, v) => s + v, 0) / validos.length : NaN;
}

function somar(lista, campo) {
  let total = 0;
  for (const item of lista) if (Number.isFinite(item[campo])) total += item[campo];
  return total;
}

function arred(valor, casas) {
  const fator = 10 ** casas;
  return Math.round(valor * fator) / fator;
}

function ordinal(n) {
  return `${n}ª`;
}

function rotuloSituacao(situacao) {
  switch (situacao) {
    case SITUACAO.APROVADO:
      return 'aprovado';
    case SITUACAO.JUBILADO:
      return 'jubilado';
    case SITUACAO.DESISTIU:
      return 'desistiu';
    case SITUACAO.ENCERRADA:
      return 'encerrada (voltou ao menu depois de aprovado)';
    case SITUACAO.INTERROMPIDA:
      return 'interrompida';
    case SITUACAO.EM_ANDAMENTO:
      return 'em andamento';
    default:
      return String(situacao);
  }
}

function nomeArma(id, conteudo = CONTEUDO) {
  const arma = conteudo.armas.find((a) => a.id === id);
  return arma ? `${arma.emoji} ${arma.nome}` : String(id);
}

function comportamentoArma(id, conteudo = CONTEUDO) {
  const arma = conteudo.armas.find((a) => a.id === id);
  return arma ? arma.comportamento : '?';
}

// Exportada para o smoke (pendencia 49): toda fonte de 'jogador-dano' tem
// que ter nome aqui, e nao cair no String(id) cru.
export function nomeFonte(id, conteudo = CONTEUDO) {
  if (id === FONTE_DESCONHECIDA) return 'fonte desconhecida (sem evento jogador-dano)';
  const inimigo = conteudo.inimigos.find((i) => i.id === id);
  if (inimigo) return `${inimigo.emoji} ${inimigo.nome}`;
  // Fase 10: o corpo da Banca (contato e investida) e as perguntas do leque.
  const banca = conteudo.banca;
  if (banca && id === banca.id) return `${banca.emoji} ${banca.nome}`;
  if (banca && banca.pergunta && id === banca.pergunta.id) return `${banca.pergunta.emoji} ${banca.pergunta.nome}`;
  return String(id);
}

function semDescricoes(valor) {
  if (Array.isArray(valor)) return valor.map(semDescricoes);
  if (valor === null || typeof valor !== 'object') return valor;
  const copia = {};
  for (const [chave, item] of Object.entries(valor)) {
    if (chave === 'descricao' || typeof item === 'function') continue;
    copia[chave] = semDescricoes(item);
  }
  return copia;
}

// FNV-1a de 32 bits: curto, deterministico e sem dependencia. Nao e
// criptografia, e so identidade de versao.
function fnv1a(texto) {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i += 1) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// telemetria.js conta como lento o quadro com mais de dois passos de
// simulacao; o texto mostra o fps que isso significa em vez de um numero solto.
function fpsLento() {
  return Math.round(1 / (2 * CONTEUDO.loop.passo));
}
