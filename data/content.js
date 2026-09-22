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
  // render.js desenha. Fase 12 (juice) acrescenta shake e flashes.
  visual: {
    corFundo: '#0d0f1a',
    corGrade: 'rgba(120, 140, 255, 0.07)',
    corBorda: 'rgba(120, 140, 255, 0.35)',
    gradePasso: 60,
    fonteEmoji: '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif',
    tamanhoEmojiJogador: 30,
    corSombraPausa: 'rgba(5, 6, 14, 0.6)',
    corRastro: '#8fd6ff', // rastro simples do jogador (fase 01)
    rastroAlphaMax: 0.35,
    rastroRaioFator: 0.55, // multiplica jogador.raio para o raio do ponto do rastro
    piscaIntervalo: 0.08, // segundos entre estados do pisca-pisca de i-frames
    emojiInimigoFator: 2.2, // tamanho do emoji = raio do inimigo x este fator
    emojiProjetilFator: 2.6, // tamanho do emoji = raio do projetil x este fator
    emojiOrbeFator: 2.4, // tamanho do emoji = raio do orbe de xp x este fator
    corSombraCarta: 'rgba(5, 6, 14, 0.72)', // escurece a arena atras da carta
    emojiSateliteFator: 2.2, // tamanho do emoji = raioColisao da caneta orbital x este fator
    corOndaTelegrafo: 'rgba(255, 210, 90, 0.55)', // anel do telegrafo do Resumo (comportamento ondaArea)
    corFeixe: 'rgba(255, 235, 59, 0.32)', // faixa translucida do Marca-texto (comportamento feixe)
  },

  // O jogador. Fase 01 completa (aceleracao, atrito, i-frames, raio de coleta).
  jogador: {
    emoji: '🎓',
    hpMax: 100,
    raio: 14, // raio de colisao
    // Raio do ima: dentro dele o orbe de XP e atraido. A coleta mesmo acontece
    // ao encostar (raio do jogador + raio do orbe). Era 42 na fase 01 e ficou
    // mesquinho: metade dos orbes do bot morria no chao longe da rota dele.
    // O coringa Wi-Fi da Federal (fase 07) multiplica este numero.
    raioColeta: 120,
    velocidade: 190, // px/s, velocidade maxima
    aceleracao: 1400, // px/s^2 ate atingir a velocidade maxima
    atrito: 2000, // px/s^2 de desaceleracao quando o input solta
    iframesDuracao: 1, // segundos de invulnerabilidade apos tomar dano
    rastroTamanho: 14, // pontos guardados para o rastro visual
  },

  // Curva de XP. Tabela explicita de limiares, nao formula: e mais facil de
  // tunar e de ler num diff. Cada entrada e quanto XP falta para o PROXIMO
  // nivel — indice 0 = nivel 1 -> 2. Passado o fim da tabela, o ultimo valor
  // repete (uma avaliacao nunca chega tao longe, mas o coringa errado pode).
  //
  // Alvo do design §3: nivel 5-6 em 60s. Acumulado ate o nivel 6 = 68 XP e ate
  // o 7 = 103; o bot do smoke coleta ~92 XP por avaliacao de 60s, o que o
  // deixa no nivel 6 em cinco sementes de cinco. Medido junto com
  // jogador.raioColeta: os dois numeros so fazem sentido em par.
  xp: {
    porNivel: [5, 9, 14, 20, 27, 35, 44, 54, 65, 77],
  },

  // Orbe de XP: nasce onde o inimigo morreu, com o valor `xp` daquele tipo de
  // inimigo, e e sugado pelo jogador quando entra em jogador.raioColeta. A
  // aceleracao cresce conforme ele se aproxima — e isso, e nao a velocidade
  // maxima, que da a sensacao de aspirador.
  xpOrbe: {
    emoji: '💡',
    raio: 7, // px: raio de colisao com o jogador
    impulso: 90, // px/s do "pop" na direcao sorteada ao nascer
    atrito: 2.5, // 1/s: freia o impulso do nascimento enquanto ninguem atrai
    aceleracaoMinima: 260, // px/s^2 na borda do raio de coleta
    aceleracaoMaxima: 2600, // px/s^2 colado no jogador
    velocidadeMaxima: 900, // px/s; 15px por quadro, bem abaixo do raio de coleta
  },

  // A carta que cada nivel abre. `quantidade` e quantas opcoes aparecem; os
  // pesos decidem o sorteio entre arma nova e +1 nivel numa arma que o jogador
  // ja tem. Quando nao sobram opcoes validas (tudo no nivel maximo), a carta
  // de consolo completa — sem ela o jogo travaria numa tela sem escolha no fim
  // da avaliacao.
  cartas: {
    quantidade: 3,
    // A fase 04 escreveu pesoArmaNova=5 > pesoArmaNivel=3 com UMA arma no
    // jogo — com so o Café equipavel, "arma nova" nunca era candidata de
    // verdade e o peso nunca rodou de fato. A fase 05 acrescentou as outras
    // tres e deu a este peso a primeira chance real de fazer diferenca.
    //
    // NAO e sobre sobrevivencia: medido nos numeros FINAIS das 4 armas (apos
    // o balanceamento desta fase), 30 sementes, corrida principal completa
    // (HP real, sem segurar) — nenhum dos dois pesos causa jubilado
    // (0/30 jubilados nos dois). Uma medicao anterior deste comentario dizia
    // que 5/3 matava o jogador em 5 de 8 sementes; isso foi medido num
    // estado INTERMEDIARIO desta fase, antes de as 3 armas novas serem
    // calibradas (o Marca-texto, por exemplo, foi de 62 para 100 kills
    // especializados durante a sessao) — a medicao era verdadeira naquele
    // momento e ficou falsa quando os numeros das armas mudaram por baixo
    // dela. Fica registrado aqui como licao: remedir depois de qualquer
    // mudanca nos numeros que a medicao depende, nunca supor que ainda vale.
    //
    // O que pesoArmaNova=2/pesoArmaNivel=5 realmente faz e CONCENTRAR a
    // build: com 4 armas candidatas, 5/3 da a Café cerca de 17% de chance de
    // ser a opcao 0 oferecida contra ~45% em 2/5 (café so concorre com as
    // OUTRAS armas ja equipadas por "arma-nivel", contra 3 candidatas de
    // "arma-nova" cada uma pesando por si). Mortos por avaliacao, mesmas 30
    // sementes: 5/3 media 171,3 (min 159, max 207); 2/5 media 179,8 (min
    // 156, max 219) — cerca de 5% a mais, nao 100%+ como a versao antiga
    // deste comentario dava a entender. Mantido em 2/5 porque concentra a
    // build sem custar sobrevivencia nem esconder arma fraca (a pior das 4,
    // Marca-texto, fica em 49% da melhor — ver o bloco de armas abaixo).
    // Nao e balanceamento final (isso e fase 13).
    pesoArmaNova: 2,
    pesoArmaNivel: 5,
    consolo: {
      id: 'lanche',
      nome: 'Lanche da Cantina',
      descricao: 'Sem mais o que aprender agora. Recupera HP.',
      emoji: '🥪',
      tipo: 'cura', // nome de um efeito registrado em cards.js
      valor: 25, // HP recuperado
    },
  },

  // Regras gerais de arma — nao confundir com `armas` logo abaixo, que e a
  // lista. Aqui so o que vale para todas.
  arma: {
    inicial: 'cafe', // id da arma com que o jogador comeca toda avaliacao
    nivelMaximo: 5, // design §6: toda arma sobe ate 5 e zera no fim da avaliacao
  },

  // Numeros que valem para qualquer projetil, de qualquer arma.
  projetil: {
    margemDescarte: 60, // px alem da borda: projetil que passa disso volta pra pool
    memoriaAtingidos: 4, // alvos que cada projetil lembra (perfuracao nao rebate no mesmo)
    vidaMaxima: 3, // teto de segundos de voo; rede contra projetil eterno
  },

  // Regras gerais do comportamento `orbital` (Caneta Bic e qualquer arma
  // futura que orbite o jogador). `memoriaAlvos` e quantos inimigos distintos
  // a arma lembra ter atingido recentemente, para aplicar o cooldown por
  // inimigo (nivel.intervaloDano) sem crescer sem limite.
  //
  // Era 16; a revisao da fase 05 achou um segundo jeito do mesmo bug de
  // guarda de geracao (ver `lembrarGolpe()` em weapons.js): com mais
  // inimigos distintos em cooldown ao mesmo tempo do que slots existem, o
  // anel sobrescrevia a entrada de um inimigo cujo cooldown ainda estava
  // vivo. O conserto (preferir um slot ja vencido antes do round-robin)
  // reduz o problema mas nao o elimina — se o numero de inimigos distintos
  // realmente atingidos dentro de uma janela de intervaloDano passar de
  // memoriaAlvos, alguem perde a protecao de qualquer jeito, e isso e limite
  // de capacidade, nao de logica. Nao e alcancavel hoje com o unico inimigo
  // do jogo (ele morre num toque so, nunca acumula entrada viva) — fica
  // pronto pra quando a fase 06/10 trouxer um inimigo que aguenta mais de um
  // toque.
  //
  // Subiu de 48 para 160 depois de medir a margem real do teste
  // `checarCooldownComEnxameOrbital()` (N = memoriaAlvos+8): com 48, a
  // primeira violacao medida aparece em N=57 contra um N de teste de 56 —
  // so ~2% de folga, e o `+8` fixo do teste NAO cresce junto se
  // memoriaAlvos subir (verificado). 160 mede limpo (zero violacoes) ate
  // N=172 — o teste roda em N=168, ~3% abaixo do primeiro N que viola de
  // verdade, com uma faixa cheia de 12 valores de N sem nenhum sinal de
  // violacao entre eles (nada de intermitencia logo depois do N do teste,
  // ao contrario do que 48 tinha). Nao subir mais que isso: o teto de
  // `spawn.maxSimultaneos` (180) faz `spawnInimigo()` devolver null pra
  // N >= 181, entao memoriaAlvos+8 tem que sobrar bem abaixo de 180 pra
  // sobrar espaco de medir a violacao de verdade, nao so o limite de spawn.
  // Custo extra medido em `smoke:carga`: nao mensuravel (a variacao entre
  // rodadas e maior que a diferenca entre 48 e valores bem maiores).
  orbital: {
    memoriaAlvos: 160,
  },

  // Regras gerais do comportamento `ondaArea` (Resumo e qualquer arma futura
  // de pulso). `duracaoAnimacao` e puramente cosmetica: quanto tempo o anel do
  // telegrafo leva para crescer e sumir depois de cada pulso — nao afeta dano
  // nem cadencia, so a leitura visual do golpe.
  ondaArea: {
    duracaoAnimacao: 0.35,
  },

  // Armas. A fase 03 montou o sistema com o Café (projetilMirado); a fase 05
  // pendura as outras tres do MVP (design §6) apontando `comportamento` para
  // as funcoes novas de weapons.js — nenhuma arma especifica esta codificada
  // la, so o registro de comportamentos.
  //
  // Contrato de uma entrada:
  //   id, nome, descricao, emoji  identidade e o que a carta mostra
  //   comportamento               nome de uma funcao registrada em weapons.js
  //   niveis[arma.nivelMaximo]    TODOS os numeros da arma, um objeto por nivel
  //
  // Os CAMPOS de cada nivel dependem do comportamento (a arma nunca muda de
  // REGRA entre niveis, so de numero — regra e assunto de coringa):
  //
  //   projetilMirado  dano, cadencia (s entre disparos), velocidade (px/s),
  //                   alcance (px: raio de busca E distancia de voo),
  //                   raio (px de colisao do projetil), projeteis (qtd por
  //                   disparo), dispersao (rad de abertura do leque),
  //                   perfuracao (inimigos atravessados alem do primeiro)
  //   orbital         dano (por contato), quantidade (canetas orbitando),
  //                   raioOrbita (px do jogador ate a caneta),
  //                   velocidadeAngular (rad/s), raioColisao (px da caneta),
  //                   intervaloDano (s de cooldown por inimigo)
  //   ondaArea        dano, cadencia (s entre pulsos), raio (px do pulso),
  //                   empurrao (px de deslocamento instantaneo de quem e
  //                   atingido, para longe do jogador)
  //   feixe           dano (por SEGUNDO, nao por acerto), alcance (px de
  //                   comprimento), largura (px de largura total do feixe)
  //
  // Balanceamento medido por test/smoke.mjs (checarArmasEspecializadas,
  // tarefa 6 da fase 05): cada arma sozinha, no nivel maximo, 60s de bot
  // circular, numa corrida ISOLADA (nenhuma outra arma pode contribuir —
  // sem isso, bufar uma arma rouba inimigos das outras e a medida de cada
  // uma passa a depender do que as outras por acaso pegaram na carta).
  // Resultado: Café 204 · Caneta Bic 145 (71%) · Resumo 162 (79%) ·
  // Marca-texto 100 (49%) — todas acima do minimo de 40% do contrato. Café
  // (fase 03) nao foi tocado; as outras tres foram calibradas para chegar
  // ali. Nao e o balanceamento final (isso e fase 13), e o piso de "nenhuma
  // arma obviamente inutil".
  armas: [
    {
      id: 'cafe',
      nome: 'Café',
      descricao: 'Dispara no inimigo mais próximo. Cadência alta, dano baixo.',
      emoji: '☕',
      comportamento: 'projetilMirado',
      // dano 12 no nivel 1 nao e generosidade: e exatamente o hp do Prazo de
      // Entrega. Medido com o bot do smoke, a mesma dps repartida em dois
      // acertos (dano 10, cadencia 0.34) matava 48 inimigos por avaliacao
      // contra 113 do tiro que mata de primeira — o segundo projetil quase
      // sempre erra um alvo que ja se mexeu, e a arma parecia quebrada.
      niveis: [
        { dano: 12, cadencia: 0.4, velocidade: 430, alcance: 330, raio: 7, projeteis: 1, dispersao: 0, perfuracao: 0 },
        { dano: 14, cadencia: 0.36, velocidade: 450, alcance: 350, raio: 7, projeteis: 1, dispersao: 0, perfuracao: 0 },
        { dano: 16, cadencia: 0.33, velocidade: 470, alcance: 370, raio: 8, projeteis: 1, dispersao: 0, perfuracao: 1 },
        { dano: 18, cadencia: 0.3, velocidade: 490, alcance: 390, raio: 8, projeteis: 2, dispersao: 0.22, perfuracao: 1 },
        { dano: 21, cadencia: 0.26, velocidade: 520, alcance: 420, raio: 9, projeteis: 3, dispersao: 0.3, perfuracao: 2 },
      ],
    },
    {
      id: 'caneta',
      nome: 'Caneta Bic',
      descricao: 'Fica girando ao seu redor cutucando quem chega perto. Nunca erra, nunca corre.',
      emoji: '✏️',
      comportamento: 'orbital',
      // Continua (sem cadencia de disparo): a colisao roda todo quadro contra
      // quem estiver dentro de raioColisao da caneta. intervaloDano e o que
      // evita que um inimigo parado dentro dela leve 60 hits por segundo.
      niveis: [
        { dano: 12, quantidade: 1, raioOrbita: 55, velocidadeAngular: 3.6, raioColisao: 20, intervaloDano: 0.16 },
        { dano: 15, quantidade: 2, raioOrbita: 58, velocidadeAngular: 4.0, raioColisao: 21, intervaloDano: 0.14 },
        { dano: 18, quantidade: 3, raioOrbita: 62, velocidadeAngular: 4.4, raioColisao: 22, intervaloDano: 0.12 },
        { dano: 22, quantidade: 3, raioOrbita: 65, velocidadeAngular: 4.8, raioColisao: 23, intervaloDano: 0.1 },
        { dano: 27, quantidade: 4, raioOrbita: 68, velocidadeAngular: 5.2, raioColisao: 24, intervaloDano: 0.09 },
      ],
    },
    {
      id: 'resumo',
      nome: 'Resumo',
      descricao: 'Resume tudo numa pancada só: uma onda que empurra e machuca quem está por perto.',
      emoji: '📝',
      comportamento: 'ondaArea',
      // Pulso ao redor do proprio jogador: sempre "dispara", nao depende de
      // achar alvo. O empurrao e deslocamento instantaneo (px), nao
      // velocidade — ver decisao no handoff da fase 05 sobre por que nao da
      // pra usar o empurraoX/Y de enemies.js aqui.
      niveis: [
        { dano: 10, cadencia: 2.2, raio: 90, empurrao: 40 },
        { dano: 13, cadencia: 2.0, raio: 100, empurrao: 45 },
        { dano: 16, cadencia: 1.8, raio: 110, empurrao: 50 },
        { dano: 20, cadencia: 1.6, raio: 120, empurrao: 55 },
        { dano: 25, cadencia: 1.4, raio: 135, empurrao: 65 },
      ],
    },
    {
      id: 'marcatexto',
      nome: 'Marca-texto',
      descricao: 'Risca tudo que está na frente. Ninguém sai ileso de um grifo bem passado.',
      emoji: '🖍️',
      comportamento: 'feixe',
      // Continua, sem cadencia: dano e por SEGUNDO (o codigo multiplica por
      // dt a cada quadro), nao por acerto — atravessar mais inimigos nao
      // dilui o dano de ninguem.
      niveis: [
        { dano: 58, alcance: 195, largura: 55 },
        { dano: 70, alcance: 210, largura: 60 },
        { dano: 84, alcance: 225, largura: 67 },
        { dano: 100, alcance: 240, largura: 74 },
        { dano: 122, alcance: 260, largura: 83 },
      ],
    },
  ],

  // Coringas (modificadores passivos comprados na loja). Fase 07.
  // Forma esperada: { id, nome, descricao, emoji, custo, raridade, hook, efeito }
  coringas: [],

  // Inimigos. Fase 02 entrega so o inimigo-base; a fase 09 acrescenta
  // Notificacao, PDF de 300 Paginas e Trabalho em Grupo (design §8).
  // `peso` e a chance relativa no sorteio de tipo da onda.
  inimigos: [
    {
      id: 'prazo',
      nome: 'Prazo de Entrega',
      emoji: '📕',
      hp: 12,
      velocidade: 105, // px/s — ~55% do teto do jogador: alcanca quem para, nao quem corre
      dano: 7, // por encostada; os i-frames do jogador limitam a 1 encostada por segundo
      raio: 11,
      xp: 1, // valor do orbe que ele derruba ao morrer
      peso: 1,
    },
  ],

  // Curva de spawn, parametrizada pelo segundo de avaliacao
  // (run.avaliacao.decorrido, nunca estado.tempo). Entre dois pontos o valor e
  // interpolado linearmente; depois do ultimo ponto, o ultimo vale.
  // `intervalo` = segundos entre ondas. `porOnda` = inimigos por onda (a parte
  // fracionaria vira chance de um a mais). O multiplicador global de
  // dificuldade divide o intervalo e multiplica o tamanho da onda.
  spawn: {
    curvaPadrao: 'padrao',
    curvas: {
      padrao: [
        { t: 0, intervalo: 1.6, porOnda: 1 },
        { t: 15, intervalo: 1.15, porOnda: 2 },
        { t: 30, intervalo: 0.85, porOnda: 3 },
        { t: 45, intervalo: 0.65, porOnda: 4 },
        { t: 60, intervalo: 0.5, porOnda: 5 },
        { t: 90, intervalo: 0.38, porOnda: 6 },
      ],
    },
    intervaloMinimo: 0.25, // piso duro: nem o modificador mais agressivo passa daqui
    porOndaMaximo: 8,
    maxSimultaneos: 180, // teto de jogabilidade, bem abaixo de arena.limites.enemies
    margemDescarte: 320, // px alem da borda: inimigo que passa disso volta pra pool
  },

  // Empurrao suave entre inimigos sobrepostos. Sem isso o bando vira uma
  // mancha unica em cima do jogador e some a leitura visual.
  separacao: {
    forca: 150, // px/s no maximo da sobreposicao
    folga: 3, // px somados aos raios: comecam a se empurrar um pouco antes de encostar
    gradePasso: 48, // lado da celula da grade espacial que evita o O(n^2)
  },

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
      carta: 'Carta',
    },
    // Rotulos que a carta monta com numeros vindos do estado. O texto fixo da
    // tela (titulo, dica de teclado) mora no index.html.
    cartas: {
      novidade: 'Nova arma',
      nivel: 'Nv.',
      seta: '→',
      cura: 'de HP',
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
    exigeNumero(conteudo.jogador.raioColeta, 'jogador.raioColeta', { min: 1 });
    exigeNumero(conteudo.jogador.velocidade, 'jogador.velocidade', { min: 1 });
    exigeNumero(conteudo.jogador.aceleracao, 'jogador.aceleracao', { min: 1 });
    exigeNumero(conteudo.jogador.atrito, 'jogador.atrito', { min: 1 });
    exigeNumero(conteudo.jogador.iframesDuracao, 'jogador.iframesDuracao', { min: 0 });
    exigeNumero(conteudo.jogador.rastroTamanho, 'jogador.rastroTamanho', { min: 1, max: 200 });
    if (typeof conteudo.jogador.emoji !== 'string' || conteudo.jogador.emoji === '') {
      erros.push('jogador.emoji: ausente ou vazio');
    }
  }

  // Curva de XP. E tabela, nao formula: o unico jeito de errar e deixar um
  // limiar zerado (o laco de subir de nivel nunca fecharia) ou fora de ordem
  // (o nivel 4 custando menos que o 3 e sempre engano de digitacao, nunca
  // design).
  if (exigeObjeto(conteudo.xp, 'xp')) {
    const tabela = conteudo.xp.porNivel;
    if (!Array.isArray(tabela) || tabela.length === 0) {
      erros.push('xp.porNivel: esperava um array nao vazio de limiares');
    } else {
      let anterior = 0;
      tabela.forEach((valor, i) => {
        if (exigeNumero(valor, `xp.porNivel[${i}]`, { min: 1 })) {
          if (valor < anterior) {
            erros.push(`xp.porNivel[${i}]: ${valor} e menor que o limiar anterior (${anterior}) — a curva precisa ser nao-decrescente`);
          }
          anterior = valor;
        }
      });
    }
  }

  // Orbe de XP.
  if (exigeObjeto(conteudo.xpOrbe, 'xpOrbe')) {
    exigeNumero(conteudo.xpOrbe.raio, 'xpOrbe.raio', { min: 1 });
    exigeNumero(conteudo.xpOrbe.impulso, 'xpOrbe.impulso', { min: 0 });
    exigeNumero(conteudo.xpOrbe.atrito, 'xpOrbe.atrito', { min: 0 });
    exigeNumero(conteudo.xpOrbe.aceleracaoMinima, 'xpOrbe.aceleracaoMinima', { min: 0 });
    exigeNumero(conteudo.xpOrbe.velocidadeMaxima, 'xpOrbe.velocidadeMaxima', { min: 1 });
    if (typeof conteudo.xpOrbe.emoji !== 'string' || conteudo.xpOrbe.emoji === '') {
      erros.push('xpOrbe.emoji: ausente ou vazio');
    }
    // Aceleracao que nao cresce com a proximidade e um orbe rebocado, nao
    // aspirado: a sensacao de coleta some e ninguem descobre olhando o codigo.
    if (exigeNumero(conteudo.xpOrbe.aceleracaoMaxima, 'xpOrbe.aceleracaoMaxima', { min: 0 })) {
      if (conteudo.xpOrbe.aceleracaoMaxima < conteudo.xpOrbe.aceleracaoMinima) {
        erros.push(
          `xpOrbe.aceleracaoMaxima: ${conteudo.xpOrbe.aceleracaoMaxima} e menor que aceleracaoMinima ` +
            `(${conteudo.xpOrbe.aceleracaoMinima}) — o orbe desaceleraria ao chegar perto`
        );
      }
    }
    // O orbe anda velocidadeMaxima * passo por quadro. Se isso passar do raio
    // de coleta, ele atravessa o jogador sem ser coletado em vez de grudar.
    const passo = conteudo.loop && typeof conteudo.loop.passo === 'number' ? conteudo.loop.passo : 1 / 60;
    const alcanceColeta =
      (typeof conteudo.jogador.raio === 'number' ? conteudo.jogador.raio : 0) +
      (typeof conteudo.xpOrbe.raio === 'number' ? conteudo.xpOrbe.raio : 0);
    if (conteudo.xpOrbe.velocidadeMaxima * passo > alcanceColeta) {
      erros.push(
        `xpOrbe.velocidadeMaxima: ${conteudo.xpOrbe.velocidadeMaxima} px/s anda ` +
          `${(conteudo.xpOrbe.velocidadeMaxima * passo).toFixed(1)}px por quadro e o alcance de coleta e ` +
          `${alcanceColeta}px — o orbe atravessaria o jogador sem ser coletado`
      );
    }
  }

  // Cartas de nivel.
  if (exigeObjeto(conteudo.cartas, 'cartas')) {
    if (exigeNumero(conteudo.cartas.quantidade, 'cartas.quantidade', { min: 1, max: 6 })) {
      if (!Number.isInteger(conteudo.cartas.quantidade)) {
        erros.push(`cartas.quantidade: ${conteudo.cartas.quantidade} precisa ser inteiro`);
      }
    }
    const pesoNova = exigeNumero(conteudo.cartas.pesoArmaNova, 'cartas.pesoArmaNova', { min: 0 });
    const pesoNivel = exigeNumero(conteudo.cartas.pesoArmaNivel, 'cartas.pesoArmaNivel', { min: 0 });
    if (pesoNova && pesoNivel && conteudo.cartas.pesoArmaNova + conteudo.cartas.pesoArmaNivel <= 0) {
      erros.push('cartas: os dois pesos sao 0, o sorteio nao teria o que escolher');
    }
    // A carta de consolo e o que impede a tela de carta sem escolha nenhuma
    // quando tudo ja esta no nivel maximo. Ela nao e opcional.
    if (exigeObjeto(conteudo.cartas.consolo, 'cartas.consolo')) {
      const consolo = conteudo.cartas.consolo;
      for (const campo of ['id', 'nome', 'descricao', 'emoji', 'tipo']) {
        if (typeof consolo[campo] !== 'string' || consolo[campo] === '') {
          erros.push(`cartas.consolo.${campo}: ausente ou vazio`);
        }
      }
      exigeNumero(consolo.valor, 'cartas.consolo.valor', { min: 0 });
    }
  }

  // Armas: regras gerais, projeteis e os numeros de cada nivel. weapons.js le
  // tudo daqui e nao tem numero nenhum dentro — se um nivel vier torto, e
  // melhor o check reprovar do que a arma disparar NaN na tela.
  const nivelMaximo =
    conteudo.arma && typeof conteudo.arma.nivelMaximo === 'number' ? conteudo.arma.nivelMaximo : null;
  if (exigeObjeto(conteudo.arma, 'arma')) {
    exigeNumero(conteudo.arma.nivelMaximo, 'arma.nivelMaximo', { min: 1, max: 20 });
    if (Array.isArray(conteudo.armas) && conteudo.armas.length > 0) {
      const existe = conteudo.armas.some((a) => a && a.id === conteudo.arma.inicial);
      if (!existe) {
        erros.push(`arma.inicial: "${conteudo.arma.inicial}" nao existe em armas — o jogador comecaria desarmado`);
      }
    }
  }

  if (exigeObjeto(conteudo.projetil, 'projetil')) {
    exigeNumero(conteudo.projetil.margemDescarte, 'projetil.margemDescarte', { min: 1 });
    exigeNumero(conteudo.projetil.vidaMaxima, 'projetil.vidaMaxima', { min: 1 / 60 });
    // A memoria e o que impede um projetil perfurante de bater varias vezes no
    // mesmo inimigo em quadros seguidos. Menor que a perfuracao maxima + 1 e a
    // lembranca do primeiro alvo ja teria sido sobrescrita quando ele volta a
    // encostar — o inimigo levaria o dano duas vezes.
    if (exigeNumero(conteudo.projetil.memoriaAtingidos, 'projetil.memoriaAtingidos', { min: 1 })) {
      let maiorPerfuracao = 0;
      for (const arma of Array.isArray(conteudo.armas) ? conteudo.armas : []) {
        for (const nivel of Array.isArray(arma && arma.niveis) ? arma.niveis : []) {
          if (nivel && typeof nivel.perfuracao === 'number' && nivel.perfuracao > maiorPerfuracao) {
            maiorPerfuracao = nivel.perfuracao;
          }
        }
      }
      if (conteudo.projetil.memoriaAtingidos < maiorPerfuracao + 1) {
        erros.push(
          `projetil.memoriaAtingidos: ${conteudo.projetil.memoriaAtingidos} e menor que a maior perfuracao ` +
            `+ 1 (${maiorPerfuracao + 1}) — um projetil perfurante acertaria o mesmo inimigo duas vezes`
        );
      }
    }
  }

  if (exigeObjeto(conteudo.orbital, 'orbital')) {
    exigeNumero(conteudo.orbital.memoriaAlvos, 'orbital.memoriaAlvos', { min: 1 });
  }
  if (exigeObjeto(conteudo.ondaArea, 'ondaArea')) {
    exigeNumero(conteudo.ondaArea.duracaoAnimacao, 'ondaArea.duracaoAnimacao', { min: 1 / 60 });
  }

  // Cada comportamento pede um conjunto proprio de numeros por nivel — nem
  // toda arma "atira projetil", entao nem toda arma tem `dispersao` ou
  // `perfuracao`. Isto e o que content.js sabe sobre cada comportamento SEM
  // importar weapons.js (fecharia ciclo): a ligacao "esse nome de
  // comportamento existe de verdade" e responsabilidade do smoke
  // (verificarArmasDoConteudo), a mesma divisao que ja valia so para o Café.
  const CAMPOS_POR_COMPORTAMENTO = {
    projetilMirado: [
      ['dano', 0.01], ['cadencia', 1 / 60], ['velocidade', 1], ['alcance', 1],
      ['raio', 1], ['projeteis', 1], ['dispersao', 0], ['perfuracao', 0],
    ],
    orbital: [
      ['dano', 0.01], ['quantidade', 1], ['raioOrbita', 1],
      ['velocidadeAngular', 1 / 60], ['raioColisao', 1], ['intervaloDano', 1 / 60],
    ],
    ondaArea: [
      ['dano', 0.01], ['cadencia', 1 / 60], ['raio', 1], ['empurrao', 0],
    ],
    feixe: [
      ['dano', 0.01], ['alcance', 1], ['largura', 1],
    ],
  };
  // Contagem de coisas, nao medida: fracao aqui faria a conta de
  // projetil.memoriaAtingidos fechar por acidente (projeteis/perfuracao) ou o
  // orbital nascer com meia caneta (quantidade).
  const CAMPOS_INTEIROS = new Set(['projeteis', 'perfuracao', 'quantidade']);

  if (Array.isArray(conteudo.armas)) {
    conteudo.armas.forEach((arma, i) => {
      const c = `armas[${i}]`;
      if (typeof arma !== 'object' || arma === null) return;
      if (typeof arma.comportamento !== 'string' || arma.comportamento === '') {
        erros.push(`${c}.comportamento: ausente ou vazio — precisa nomear uma funcao de weapons.js`);
      }
      if (typeof arma.emoji !== 'string' || arma.emoji === '') erros.push(`${c}.emoji: ausente ou vazio`);
      if (typeof arma.descricao !== 'string' || arma.descricao === '') {
        erros.push(`${c}.descricao: ausente ou vazia`);
      }
      if (!Array.isArray(arma.niveis)) {
        erros.push(`${c}.niveis: esperava um array`);
        return;
      }
      if (nivelMaximo !== null && arma.niveis.length !== nivelMaximo) {
        erros.push(`${c}.niveis: ${arma.niveis.length} niveis, arma.nivelMaximo pede ${nivelMaximo}`);
      }
      // Comportamento desconhecido nao tem lista de campos aqui — quem
      // reprova isso e o smoke (a arma nao existe em weapons.js), nao o check.
      const campos = CAMPOS_POR_COMPORTAMENTO[arma.comportamento];
      arma.niveis.forEach((nivel, j) => {
        const cn = `${c}.niveis[${j}]`;
        if (!exigeObjeto(nivel, cn)) return;
        if (!campos) return;
        for (const [campo, min] of campos) exigeNumero(nivel[campo], `${cn}.${campo}`, { min });
        for (const campo of CAMPOS_INTEIROS) {
          if (typeof nivel[campo] === 'number' && !Number.isInteger(nivel[campo])) {
            erros.push(`${cn}.${campo}: ${nivel[campo]} precisa ser inteiro`);
          }
        }
      });
    });
  }

  // Inimigos: campos que enemies.js le de cada tipo.
  if (Array.isArray(conteudo.inimigos)) {
    conteudo.inimigos.forEach((inimigo, i) => {
      const c = `inimigos[${i}]`;
      if (typeof inimigo !== 'object' || inimigo === null) return;
      exigeNumero(inimigo.hp, `${c}.hp`, { min: 1 });
      exigeNumero(inimigo.velocidade, `${c}.velocidade`, { min: 1 });
      exigeNumero(inimigo.dano, `${c}.dano`, { min: 0 });
      exigeNumero(inimigo.raio, `${c}.raio`, { min: 1 });
      exigeNumero(inimigo.xp, `${c}.xp`, { min: 0 });
      exigeNumero(inimigo.peso, `${c}.peso`, { min: 0 });
      if (typeof inimigo.emoji !== 'string' || inimigo.emoji === '') {
        erros.push(`${c}.emoji: ausente ou vazio`);
      }
    });
    const somaPesos = conteudo.inimigos.reduce(
      (soma, inimigo) => soma + (typeof inimigo.peso === 'number' ? inimigo.peso : 0),
      0
    );
    if (conteudo.inimigos.length > 0 && somaPesos <= 0) {
      erros.push('inimigos: soma dos pesos e 0, o sorteio de tipo nao teria o que escolher');
    }
  }

  // Curva de spawn.
  if (exigeObjeto(conteudo.spawn, 'spawn')) {
    exigeNumero(conteudo.spawn.intervaloMinimo, 'spawn.intervaloMinimo', { min: 1 / 60 });
    exigeNumero(conteudo.spawn.porOndaMaximo, 'spawn.porOndaMaximo', { min: 1 });
    exigeNumero(conteudo.spawn.margemDescarte, 'spawn.margemDescarte', { min: 1 });
    const teto = conteudo.arena && conteudo.arena.limites ? conteudo.arena.limites.enemies : Infinity;
    if (exigeNumero(conteudo.spawn.maxSimultaneos, 'spawn.maxSimultaneos', { min: 1 })) {
      if (conteudo.spawn.maxSimultaneos > teto) {
        erros.push(
          `spawn.maxSimultaneos: ${conteudo.spawn.maxSimultaneos} passa de arena.limites.enemies (${teto})`
        );
      }
    }
    if (exigeObjeto(conteudo.spawn.curvas, 'spawn.curvas')) {
      const padrao = conteudo.spawn.curvaPadrao;
      if (!conteudo.spawn.curvas[padrao]) {
        erros.push(`spawn.curvaPadrao: "${padrao}" nao existe em spawn.curvas`);
      }
      for (const [nome, pontos] of Object.entries(conteudo.spawn.curvas)) {
        const c = `spawn.curvas.${nome}`;
        if (!Array.isArray(pontos) || pontos.length === 0) {
          erros.push(`${c}: esperava um array nao vazio de pontos`);
          continue;
        }
        let anteriorT = -Infinity;
        pontos.forEach((ponto, i) => {
          const p = `${c}[${i}]`;
          if (!exigeObjeto(ponto, p)) return;
          if (exigeNumero(ponto.t, `${p}.t`, { min: 0 })) {
            if (ponto.t <= anteriorT) erros.push(`${p}.t: pontos precisam estar em ordem crescente de t`);
            anteriorT = ponto.t;
          }
          exigeNumero(ponto.intervalo, `${p}.intervalo`, { min: 1 / 60 });
          exigeNumero(ponto.porOnda, `${p}.porOnda`, { min: 0 });
        });
      }
    }
  }

  // Separacao entre inimigos.
  if (exigeObjeto(conteudo.separacao, 'separacao')) {
    exigeNumero(conteudo.separacao.forca, 'separacao.forca', { min: 0 });
    const folgaOk = exigeNumero(conteudo.separacao.folga, 'separacao.folga', { min: 0 });
    if (exigeNumero(conteudo.separacao.gradePasso, 'separacao.gradePasso', { min: 4 }) && folgaOk) {
      // A grade so compara cada inimigo com os das 9 celulas ao redor. Se a
      // celula for menor que o alcance do empurrao, dois inimigos que deveriam
      // se empurrar caem em celulas nao vizinhas e a separacao os perde em
      // silencio — nada quebra, o bando so volta a empilhar. Por isso e erro, e
      // nao aviso: quando a fase 09 der raio maior a um inimigo novo, o check
      // avisa antes de alguem descobrir olhando a tela.
      let maiorRaio = 0;
      if (Array.isArray(conteudo.inimigos)) {
        for (const inimigo of conteudo.inimigos) {
          if (inimigo && typeof inimigo.raio === 'number' && inimigo.raio > maiorRaio) {
            maiorRaio = inimigo.raio;
          }
        }
      }
      const minimo = 2 * maiorRaio + conteudo.separacao.folga;
      if (conteudo.separacao.gradePasso < minimo) {
        erros.push(
          `separacao.gradePasso: ${conteudo.separacao.gradePasso} e menor que 2 x maior raio de inimigo ` +
            `+ folga (${minimo}) — a separacao perderia vizinhos entre celulas`
        );
      }
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
