// TODO o balanceamento do jogo mora aqui. Nenhum numero de jogabilidade pode
// existir dentro de um .js de logica — se voce precisou de um numero novo la,
// ele pertence a este arquivo.
//
// As chaves abaixo ja existem vazias de proposito: cada fase seguinte preenche
// a sua sem mudar a forma do objeto debaixo dos testes.

export const CONTEUDO = {
  // Multiplicador global de dificuldade. Toda funcao de escalonamento
  // (vida de inimigo, taxa de spawn, dano) multiplica por ele. Existe desde o
  // dia 1 para que Mestrado/Doutorado sejam so um numero diferente.
  ajuste: {
    dificuldade: 1,
    // fase 13 pode acrescentar: { vidaInimigo, taxaSpawn, danoInimigo }
  },

  // Loop principal. dt fixo: a simulacao nunca le o relogio, o que a deixa
  // deterministica e testavel no node.
  loop: {
    passo: 1 / 60,
    maxPassosPorFrame: 5, // teto para nao espiralar quando a aba volta do background
  },

  // Arena de combate e limites duros de pool. Os limites nao sao decoracao:
  // test/smoke.mjs falha se qualquer pool passar deles.
  arena: {
    largura: 960,
    altura: 540,
    margemSpawn: 40, // distancia fora da borda onde inimigos nascem
    limites: {
      enemies: 400,
      projectiles: 600,
      xpOrbs: 600,
      particles: 800,
      eventos: 256, // fila de eventos para audio/juice; emitir() descarta o mais antigo
    },
  },

  // Aparencia do canvas. O CSS cuida das telas em DOM; aqui so o que o
  // render.js desenha. Fase 12 (juice) acrescenta shake, rastro e flashes.
  visual: {
    corFundo: '#0d0f1a',
    corGrade: 'rgba(120, 140, 255, 0.07)',
    corBorda: 'rgba(120, 140, 255, 0.35)',
    gradePasso: 60,
    fonteEmoji: '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif',
    tamanhoEmojiJogador: 30,
    corSombraPausa: 'rgba(5, 6, 14, 0.6)',
  },

  // O jogador. Fase 01 completa (aceleracao, atrito, i-frames, raio de coleta).
  jogador: {
    emoji: '🎓',
    hpMax: 100,
    raio: 14,
    velocidade: 190,
    xpBase: 5, // XP do nivel 1 -> 2; fase 04 define a curva
  },

  // Armas. Fases 03 e 05.
  // Forma esperada por entrada:
  // { id, nome, descricao, emoji, niveis: [{ dano, cadencia, alcance, ... }] }
  armas: [],

  // Coringas (modificadores passivos comprados na loja). Fase 07.
  // Forma esperada: { id, nome, descricao, emoji, custo, raridade, hook, efeito }
  coringas: [],

  // Inimigos. Fases 02 e 09.
  // Forma esperada: { id, nome, emoji, hp, velocidade, dano, raio, xp, peso }
  inimigos: [],

  // Modificadores de avaliacao (a "regra" daquela prova). Fases 06 e 09.
  // Forma esperada: { id, nome, descricao, emoji, efeito }
  modificadores: [],

  // Estrutura da run: 3 periodos x (av1, av2, prova final) + TCC.
  // Fases 06 e 08 acrescentam a cada avaliacao: modificadores, tabela de spawn
  // e recompensa. Aqui ficam so nome e duracao, que a fase 00 ja usa no timer.
  periodos: [
    {
      id: 'periodo-1',
      nome: '1º Período',
      avaliacoes: [
        { id: 'p1-av1', nome: 'Avaliação 1', tipo: 'comum', duracao: 60 },
        { id: 'p1-av2', nome: 'Avaliação 2', tipo: 'comum', duracao: 60 },
        { id: 'p1-final', nome: 'Prova Final', tipo: 'final', duracao: 75 },
      ],
    },
    {
      id: 'periodo-2',
      nome: '2º Período',
      avaliacoes: [
        { id: 'p2-av1', nome: 'Avaliação 1', tipo: 'comum', duracao: 65 },
        { id: 'p2-av2', nome: 'Avaliação 2', tipo: 'comum', duracao: 65 },
        { id: 'p2-final', nome: 'Prova Final', tipo: 'final', duracao: 80 },
      ],
    },
    {
      id: 'periodo-3',
      nome: '3º Período',
      avaliacoes: [
        { id: 'p3-av1', nome: 'Avaliação 1', tipo: 'comum', duracao: 70 },
        { id: 'p3-av2', nome: 'Avaliação 2', tipo: 'comum', duracao: 70 },
        { id: 'p3-final', nome: 'Prova Final', tipo: 'final', duracao: 85 },
      ],
    },
  ],

  // Nota, conceito e economia. Fase 06 usa os pesos; fase 07 usa a recompensa.
  // nota = kills * pesoKill + (hp/hpMax) * pesoHp + bonusIleso
  nota: {
    pesoKill: 0,
    pesoHp: 0,
    bonusIleso: 0,
    maxima: 10,
    // Faixas em ordem decrescente de exigencia. A primeira cuja nota minima
    // for atingida vence. creditos/itens/rerolls entram na fase 07.
    faixas: [
      { conceito: 'A', minimo: 9.5 },
      { conceito: 'B', minimo: 8.5 },
      { conceito: 'C', minimo: 7 },
      { conceito: 'D', minimo: 6 },
      { conceito: 'F', minimo: 0 },
    ],
  },

  // Toda string visivel ao jogador que nao esta no index.html mora aqui.
  textos: {
    telas: {
      menu: 'Menu',
      avaliacao: 'Avaliação',
      pausa: 'Pausa',
    },
  },
};

// Chamado por test/check.mjs. Devolve { erros, avisos } — o check falha se
// houver qualquer erro. Cresce junto com o conteudo: cada fase que adiciona
// uma colecao ganha de graca a checagem de id unico e campos obrigatorios.
export function validarConteudo(conteudo = CONTEUDO) {
  const erros = [];
  const avisos = [];

  const exigeObjeto = (valor, caminho) => {
    if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) {
      erros.push(`${caminho}: esperava um objeto`);
      return false;
    }
    return true;
  };

  const exigeNumero = (valor, caminho, { min = -Infinity, max = Infinity } = {}) => {
    if (typeof valor !== 'number' || !Number.isFinite(valor)) {
      erros.push(`${caminho}: esperava numero finito, veio ${JSON.stringify(valor)}`);
      return false;
    }
    if (valor < min || valor > max) {
      erros.push(`${caminho}: ${valor} fora do intervalo [${min}, ${max}]`);
      return false;
    }
    return true;
  };

  // Colecoes: podem estar vazias enquanto a fase dona nao chegou, mas toda
  // entrada precisa de id unico e nome.
  const colecoes = ['armas', 'coringas', 'inimigos', 'modificadores'];
  for (const chave of colecoes) {
    const lista = conteudo[chave];
    if (!Array.isArray(lista)) {
      erros.push(`${chave}: esperava um array`);
      continue;
    }
    const vistos = new Set();
    lista.forEach((item, i) => {
      const caminho = `${chave}[${i}]`;
      if (!exigeObjeto(item, caminho)) return;
      if (typeof item.id !== 'string' || item.id === '') {
        erros.push(`${caminho}: id ausente ou vazio`);
      } else if (vistos.has(item.id)) {
        erros.push(`${caminho}: id duplicado "${item.id}"`);
      } else {
        vistos.add(item.id);
      }
      if (typeof item.nome !== 'string' || item.nome === '') {
        erros.push(`${caminho}: nome ausente ou vazio`);
      }
    });
    if (lista.length === 0) avisos.push(`${chave}: vazio (fase dona ainda nao chegou)`);
  }

  // Arena e limites de pool.
  if (exigeObjeto(conteudo.arena, 'arena')) {
    exigeNumero(conteudo.arena.largura, 'arena.largura', { min: 1 });
    exigeNumero(conteudo.arena.altura, 'arena.altura', { min: 1 });
    exigeNumero(conteudo.arena.margemSpawn, 'arena.margemSpawn', { min: 0 });
    if (exigeObjeto(conteudo.arena.limites, 'arena.limites')) {
      for (const [pool, valor] of Object.entries(conteudo.arena.limites)) {
        exigeNumero(valor, `arena.limites.${pool}`, { min: 1 });
      }
    }
  }

  // Loop.
  if (exigeObjeto(conteudo.loop, 'loop')) {
    exigeNumero(conteudo.loop.passo, 'loop.passo', { min: 1 / 240, max: 1 / 10 });
    exigeNumero(conteudo.loop.maxPassosPorFrame, 'loop.maxPassosPorFrame', { min: 1, max: 60 });
  }

  // Ajuste global de dificuldade.
  if (exigeObjeto(conteudo.ajuste, 'ajuste')) {
    exigeNumero(conteudo.ajuste.dificuldade, 'ajuste.dificuldade', { min: 0.01 });
  }

  // Jogador.
  if (exigeObjeto(conteudo.jogador, 'jogador')) {
    exigeNumero(conteudo.jogador.hpMax, 'jogador.hpMax', { min: 1 });
    exigeNumero(conteudo.jogador.raio, 'jogador.raio', { min: 1 });
    exigeNumero(conteudo.jogador.velocidade, 'jogador.velocidade', { min: 1 });
    exigeNumero(conteudo.jogador.xpBase, 'jogador.xpBase', { min: 1 });
    if (typeof conteudo.jogador.emoji !== 'string' || conteudo.jogador.emoji === '') {
      erros.push('jogador.emoji: ausente ou vazio');
    }
  }

  // Periodos e avaliacoes.
  if (!Array.isArray(conteudo.periodos)) {
    erros.push('periodos: esperava um array');
  } else {
    if (conteudo.periodos.length === 0) erros.push('periodos: vazio, a run precisa de pelo menos um');
    const idsAvaliacao = new Set();
    conteudo.periodos.forEach((periodo, i) => {
      const caminho = `periodos[${i}]`;
      if (!exigeObjeto(periodo, caminho)) return;
      if (typeof periodo.nome !== 'string' || periodo.nome === '') {
        erros.push(`${caminho}: nome ausente ou vazio`);
      }
      if (!Array.isArray(periodo.avaliacoes) || periodo.avaliacoes.length === 0) {
        erros.push(`${caminho}.avaliacoes: esperava um array nao vazio`);
        return;
      }
      periodo.avaliacoes.forEach((av, j) => {
        const c = `${caminho}.avaliacoes[${j}]`;
        if (!exigeObjeto(av, c)) return;
        if (typeof av.id !== 'string' || av.id === '') {
          erros.push(`${c}: id ausente ou vazio`);
        } else if (idsAvaliacao.has(av.id)) {
          erros.push(`${c}: id duplicado "${av.id}"`);
        } else {
          idsAvaliacao.add(av.id);
        }
        exigeNumero(av.duracao, `${c}.duracao`, { min: 1 });
      });
    });
  }

  // Nota e faixas de conceito.
  if (exigeObjeto(conteudo.nota, 'nota')) {
    exigeNumero(conteudo.nota.pesoKill, 'nota.pesoKill', { min: 0 });
    exigeNumero(conteudo.nota.pesoHp, 'nota.pesoHp', { min: 0 });
    exigeNumero(conteudo.nota.bonusIleso, 'nota.bonusIleso', { min: 0 });
    exigeNumero(conteudo.nota.maxima, 'nota.maxima', { min: 1 });
    if (!Array.isArray(conteudo.nota.faixas) || conteudo.nota.faixas.length === 0) {
      erros.push('nota.faixas: esperava um array nao vazio');
    } else {
      let anterior = Infinity;
      conteudo.nota.faixas.forEach((faixa, i) => {
        const c = `nota.faixas[${i}]`;
        if (!exigeObjeto(faixa, c)) return;
        if (typeof faixa.conceito !== 'string' || faixa.conceito === '') {
          erros.push(`${c}: conceito ausente ou vazio`);
        }
        if (exigeNumero(faixa.minimo, `${c}.minimo`, { min: 0 })) {
          if (faixa.minimo >= anterior) {
            erros.push(`${c}: faixas devem estar em ordem decrescente de minimo`);
          }
          anterior = faixa.minimo;
        }
      });
      const ultima = conteudo.nota.faixas[conteudo.nota.faixas.length - 1];
      if (ultima && ultima.minimo !== 0) {
        erros.push('nota.faixas: a ultima faixa precisa ter minimo 0 para cobrir toda nota');
      }
      if (conteudo.nota.pesoKill === 0 && conteudo.nota.pesoHp === 0) {
        avisos.push('nota: pesos zerados (fase 06 ainda nao chegou)');
      }
    }
  }

  return { erros, avisos };
}
