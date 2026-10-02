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
    // Distancia fora da borda onde inimigos nascem. Era 40 ate o checkpoint
    // humano 1: com o inimigo nascendo quase colado na parede, quem corria
    // rente a borda trombava nele ao nascer, e o canto (que so recebe
    // inimigo de um quadrante, em fila) ficava MAIS seguro que andar. Com 150
    // eles levam ~1,4s para entrar na arena. Precisa ficar abaixo de
    // spawn.margemDescarte, senao o inimigo nasce ja descartado.
    margemSpawn: 150,
    limites: {
      enemies: 400,
      projectiles: 600,
      xpOrbs: 600,
      particles: 800,
      // Fase 10: os projeteis da Banca (o leque de perguntas). Pool propria,
      // e nao a dos projeteis do jogador: estes acertam o JOGADOR, nunca um
      // inimigo. Pico medido na luta inteira (8 sementes, fase 2 com 2 salvas
      // de 11): 22 vivas ao mesmo tempo. 96 e ~4x isso.
      perguntas: 96,
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
    corForaArena: 'rgba(0, 0, 0, 0.55)', // o que fica fora da arena encolhida (regras.arena < 1)
    // A Banca (fase 10). O emoji e maior que o corpo de colisao (banca.raio):
    // o raio fica preso pela regra da grade de separacao (separacao.gradePasso)
    // e o tamanho na tela e o que diz "chefe".
    banca: {
      tamanhoEmoji: 76,
      raioAura: 46, // px do circulo colorido por baixo do emoji
      // Uma cor por fase (banca.fases): e a "mudanca de cor" da transicao.
      corAura: ['rgba(122, 162, 255, 0.30)', 'rgba(255, 93, 122, 0.42)'],
      corTelegrafo: 'rgba(255, 93, 122, 0.85)', // linhas, faixa e circulos de aviso
      alphaTelegrafoMin: 0.18, // o aviso nasce fraco...
      alphaTelegrafoMax: 0.75, // ...e fica forte ate o golpe sair
      alcanceRaioLeque: 560, // px das linhas do aviso do leque (a pergunta voa alem)
      larguraRaioLeque: 3,
      emojiPerguntaFator: 2.6, // tamanho do ❓ = banca.pergunta.raio x este fator
      fonteTexto: 'bold 34px ui-monospace, "Cascadia Mono", Consolas, monospace',
      fonteSubtexto: '20px ui-monospace, "Cascadia Mono", Consolas, monospace',
      corTexto: '#ffd0d8',
      corSombraTexto: 'rgba(5, 6, 14, 0.75)', // faixa atras do texto da transicao
      faixaTextoY: 0.36, // fracao da altura do canvas onde a faixa do texto comeca
      faixaTextoAltura: 0.22, // fracao da altura do canvas
      pulsoTransicao: 6, // Hz do pulso da aura durante a transicao
    },
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
  // Alvo do design §3: nivel 5-6 em 60s. Acumulado ate o nivel 6 = 75 XP e ate
  // o 7 = 110. Medido no ajuste pos-checkpoint 1 (corrida de progressao do
  // smoke: bot circular, HP segurado, sementes SEMENTE+5..+9): o bot coleta
  // de 98 a 137 XP por avaliacao de 60s e termina no nivel 7 em quatro
  // sementes de cinco (nivel 6 na outra). O nivel 5 chega entre 36s e 43s
  // na media de 16 sementes (canto, desvio e circular). A curva nao mudou no
  // ajuste; quem subiu foi o numero de inimigos. Medido junto com
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
    // Remedido no ajuste pos-checkpoint 1 (inimigo com 14 de HP, mais
    // inimigos, feixe do Marca-texto mais largo): 30 sementes, avaliacao
    // inteira com o bot circular e HP real — 5/3 jubila 5/30 e mata 153,0 em
    // media (min 53, max 203); 2/5 jubila 4/30 e mata 195,4 (min 126, max
    // 263). Com o inimigo aguentando um tiro do Café nivel 1, concentrar a
    // build passou a pesar: +28% de mortos, contra ~5% antes do ajuste.
    //
    // Historico da fase 05: nos numeros de entao nenhum dos dois pesos
    // jubilava (0/30). Uma medicao anterior deste comentario dizia
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
    // sementes, na fase 05: 5/3 media 171,3 (min 159, max 207); 2/5 media
    // 179,8 (min 156, max 219). Mantido em 2/5 porque concentra a build sem
    // custar sobrevivencia nem esconder arma fraca (a pior das 4, Marca-texto,
    // fica em 45% da melhor — ver o bloco de armas abaixo).
    // Nao e balanceamento final (isso e fase 13).
    pesoArmaNova: 2,
    pesoArmaNivel: 5,
    // Segundos, depois de a carta abrir (e de cada carta seguinte da fila),
    // em que escolher por clique ou tecla e ignorado. Com o Caderno a carta
    // abre no 1º tick da avaliacao: sem isto, o Enter repetido ou o clique
    // duplo no "Começar" do anuncio escolhia uma carta as cegas.
    atrasoEntrada: 0.35,
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
  // de capacidade, nao de logica. Desde o ajuste pos-checkpoint 1 o Prazo de
  // Entrega tem 14 de HP e aguenta um toque da Caneta nivel 1 (12), entao o
  // anel acumula entrada viva de verdade. Medido: Caneta no nivel maximo
  // desde o primeiro tick, 24 avaliacoes de 60s (bot circular, canto e
  // centro, HP segurado) — pico de 5 entradas vivas ao mesmo tempo, contra
  // 160 slots. A janela e curta demais (intervaloDano <= 0,16s) para o
  // enxame chegar perto do teto.
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
  // Resultado depois do ajuste pos-checkpoint 1: Café 256 · Caneta Bic 168
  // (66%) · Resumo 202 (79%) · Marca-texto 114 (45%) — todas acima do minimo
  // de 40% do contrato. Na fase 05 eram 204 · 145 · 162 · 100 (49%); com o
  // inimigo novo (mais HP, mais rapido, nascendo mais longe da borda) o
  // Marca-texto caiu para 83 (32%) e so a LARGURA do feixe o trouxe de volta
  // — dano e alcance quase nao mexiam no numero (122->150 de dano: 83->82),
  // porque ele so pega quem esta na frente do movimento. Nao e o
  // balanceamento final (isso e fase 13), e o piso de "nenhuma arma
  // obviamente inutil".
  armas: [
    {
      id: 'cafe',
      nome: 'Café',
      descricao: 'Dispara no inimigo mais próximo. Cadência alta, dano baixo.',
      emoji: '☕',
      comportamento: 'projetilMirado',
      // Fase 03: dano 12 era exatamente o hp do Prazo de Entrega (12). Medido
      // na epoca, a mesma dps repartida em dois acertos (dano 10, cadencia
      // 0.34) matava 48 inimigos por avaliacao contra 113 do tiro que mata de
      // primeira — o segundo projetil quase sempre erra um alvo que ja se
      // mexeu. No ajuste pos-checkpoint 1 o Prazo foi a 14 de HP e o nivel 1
      // passou a precisar de DOIS tiros; o nivel 2 (14) volta a matar de
      // primeira. E de proposito e medido: dar 14 ao nivel 1 devolvia a
      // vantagem ao canto (0 jubilados em 16 sementes, contra 5/16 assim) —
      // o aperto dos primeiros ~20s e o que pune quem para.
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
        { dano: 58, alcance: 195, largura: 62 },
        { dano: 70, alcance: 210, largura: 75 },
        { dano: 84, alcance: 225, largura: 90 },
        { dano: 100, alcance: 240, largura: 108 },
        { dano: 122, alcance: 260, largura: 130 },
      ],
    },
  ],

  // Coringas (design §7): passivos comprados na loja, que DURAM A RUN INTEIRA.
  // As armas zeram a cada avaliacao; sao os coringas que dao curva de poder a
  // run. Cada um e so dado:
  //   { id, nome, emoji, descricao, preco, raridade, efeito, params }
  // `efeito` e o nome de um efeito registrado em src/jokers.js (EFEITOS), e
  // `params` sao os numeros dele. Um coringa novo que use um efeito que ja
  // existe entra so aqui, sem tocar em jokers.js. Os efeitos existentes e os
  // parametros que cada um pede:
  //   atributo       { atributo, fator }   multiplica um atributo do jogador
  //                                         (velocidade, raioColeta, hpMax)
  //   nivelInicial   { niveis }            comeca a avaliacao com XP para N niveis
  //   danoNoFim      { segundos, fator }   dano x fator nos ultimos N segundos
  //   danoPorMorte   { porMorte }          +porMorte de dano por morte, na avaliacao
  //   sobreviverFatal{ hp }                1x por run, o golpe fatal deixa `hp`
  //   multiplicarXp  { fator }             multiplica o XP de cada orbe
  //
  // Precos (a loja paga em creditos por conceito: F 30 · D 60 · C 78 · B 96 ·
  // A 120). Guardar dinheiro precisa ser jogada valida, entao os `caro`
  // custam MAIS que o melhor boletim possivel (o validador exige): so se
  // compra um deles guardando de uma avaliacao para a outra. Os `barato`
  // cabem num D.
  //
  // A `descricao` repete os numeros de `params` em texto: mudou um, mude o
  // outro (fase 13).
  coringas: [
    {
      id: 'energetico',
      nome: 'Energético',
      emoji: '🔋',
      descricao: '+15% de velocidade de movimento.',
      preco: 40,
      raridade: 'barato',
      efeito: 'atributo',
      params: { atributo: 'velocidade', fator: 1.15 },
    },
    {
      id: 'wifi',
      nome: 'Wi-Fi da Federal',
      emoji: '📶',
      descricao: '+80% no raio de coleta de XP.',
      preco: 35,
      raridade: 'barato',
      efeito: 'atributo',
      params: { atributo: 'raioColeta', fator: 1.8 },
    },
    {
      id: 'caderno',
      nome: 'Caderno Emprestado',
      emoji: '📚',
      descricao: 'Toda avaliação começa no nível 2.',
      preco: 70,
      raridade: 'medio',
      efeito: 'nivelInicial',
      params: { niveis: 1 },
    },
    {
      id: 'vespera',
      nome: 'Véspera da Prova',
      emoji: '🌙',
      descricao: 'Nos últimos 15s da avaliação, dano ×2.',
      preco: 80,
      raridade: 'medio',
      efeito: 'danoNoFim',
      params: { segundos: 15, fator: 2 },
    },
    {
      id: 'whatsapp',
      nome: 'Grupo de WhatsApp',
      emoji: '📱',
      descricao: 'Cada morte soma +0,5% de dano, cumulativo dentro da avaliação.',
      preco: 140,
      raridade: 'caro',
      efeito: 'danoPorMorte',
      params: { porMorte: 0.005 },
    },
    {
      id: 'atestado',
      nome: 'Atestado Médico',
      emoji: '🏥',
      descricao: '1× por run: sobrevive a um golpe fatal com 1 HP.',
      preco: 125,
      raridade: 'caro',
      efeito: 'sobreviverFatal',
      params: { hp: 1 },
    },
  ],

  // A loja entre avaliacoes (design §5). Quantos itens aparecem e quantos
  // rerolls saem de graca dependem do conceito (nota.faixas[].itensLoja e
  // .rerollsGratis).
  loja: {
    teto: 5, // coringas ao mesmo tempo; cheio, comprar exige vender um
    fracaoVenda: 0.5, // vender devolve esta fracao do preco (arredondada para baixo)
    // Preco do primeiro reroll PAGO de cada visita, e quanto cada reroll pago
    // seguinte encarece. 10/15/20...: um reroll custa um quarto de barato, e
    // o terceiro na mesma visita ja e metade de um coringa medio.
    rerollBase: 10,
    rerollIncremento: 5,
    // Segundos, depois de a loja abrir, em que comprar, vender, rerolar e
    // seguir sao ignorados (teclado E mouse). Quem apertou Enter duas vezes,
    // ou deu clique duplo no "Continuar" do boletim, nao gasta credito sem ter
    // visto a loja.
    atrasoEntrada: 0.35,
  },

  // Inimigos (design §8). Cada tipo aponta um `comportamento` de movimento
  // registrado em MOVIMENTOS (enemies.js) — o mesmo padrao de "dado, nao
  // classe" que armas.js usa para COMPORTAMENTOS. `peso` e a chance relativa
  // de um sorteio SEM composicao por avaliacao (hoje so o relatorio mostra
  // esse numero; quem decide o sorteio de verdade e `spawn.composicoes`,
  // abaixo, que cada avaliacao referencia por `composicaoSpawn`).
  //
  // Campos opcionais, so quando o tipo precisa:
  //   rajada     { intervalo, tamanho, espalhamento }  nasce em grupo, num
  //              relogio PROPRIO (alem da onda normal), so quando o tipo esta
  //              na composicao da avaliacao corrente — o grupo nasce num
  //              UNICO ponto de borda sorteado por rajada, com cada membro
  //              espalhado ate `espalhamento` px dali (px, opcional, default
  //              0 = todos empilhados no mesmo ponto) — ver spawnRajada() e o
  //              laco de rajadas em atualizarSpawn(), em enemies.js
  //   empurraoContato  px/s de deslocamento aplicado ao jogador enquanto
  //              encosta nele (alem do dano normal por contato)
  //   ruido      { amplitude (rad), frequencia (Hz) }  desvio senoidal do
  //              angulo de perseguicao — so o comportamento 'errante' le isto
  //   divisao    { filhos, geracaoMaxima, hpFator, velocidadeFator,
  //                raioFator, xpFator, danoFator, raioSpawn }  ao morrer com
  //              `geracao` (campo de runtime, 0 no nascimento normal) menor
  //              que geracaoMaxima, vira `filhos` copias menores no lugar da
  //              morte, com geracao+1 — geracaoMaxima trava a profundidade
  //              (1 = filhote nao divide de novo)
  //
  // Numeros de primeiro corte (fase 09), sem pressao de balanceamento fino —
  // isso e fase 13. O que importa aqui e cada tipo ter um papel distinto.
  inimigos: [
    {
      id: 'prazo',
      nome: 'Prazo de Entrega',
      emoji: '📕',
      // Ajuste pos-checkpoint 1 (era hp 12, velocidade 105, dano 7): o
      // usuario tirou 9,3 parado no canto. 14 de HP e o que mais pune o canto
      // — um inimigo que aguenta um tiro chega perto de quem nao foge; 12
      // com mais inimigos e mais velocidade nao bastou (ver o handoff 06).
      hp: 14,
      velocidade: 115, // px/s — ~60% do teto do jogador: alcanca quem para, nao quem corre
      dano: 8, // por encostada; os i-frames do jogador limitam a 1 encostada por segundo
      raio: 11,
      xp: 1, // valor do orbe que ele derruba ao morrer
      peso: 1,
      comportamento: 'perseguir',
    },
    {
      id: 'notificacao',
      nome: 'Notificação',
      emoji: '🔔',
      // Mais fragil que o Prazo (morre num tiro do Cafe nivel 1) e mais
      // devagar que ele — o perigo dela e vir em rajada e ser dificil de
      // prever, nao dano ou velocidade brutos.
      hp: 9,
      velocidade: 90, // px/s — abaixo do Prazo (115): "media" fica entre o Prazo e o PDF (55)
      dano: 6,
      raio: 10,
      xp: 1,
      peso: 0.5,
      comportamento: 'errante',
      // O angulo de perseguicao oscila +-0,85 rad (~49°) numa senoide de
      // 1,4 Hz — rapido o suficiente para nao dar pra prever a rota olhando
      // so a posicao atual, devagar o suficiente para nao virar um giro
      // aleatorio sem leitura nenhuma.
      ruido: { amplitude: 0.85, frequencia: 1.4 },
      // Fora da onda normal: a cada ~13s (dividido pela dificuldade, como o
      // resto do spawn) nascem 4 de uma vez, perto uma da outra na borda —
      // a "rajada" do design §8. `espalhamento` (px) e o quanto cada membro
      // desliza do ponto de borda sorteado para o grupo (spawnRajada, em
      // enemies.js); 40px mantem as 4 visivelmente juntas sem empilhar no
      // mesmo pixel. So dispara quando notificacao esta na composicao da
      // avaliacao corrente (enemies.js atualizarSpawn).
      rajada: { intervalo: 13, tamanho: 4, espalhamento: 40 },
    },
    {
      id: 'pdf',
      nome: 'PDF de 300 Páginas',
      emoji: '📄',
      // Tanque: 5x o HP do Prazo, metade da velocidade. O raio grande (24,
      // o dobro do Prazo) e o que faz ele "bloquear rota de fuga" so de
      // estar no caminho — ver separacao.gradePasso abaixo, que teve que
      // crescer para caber esse raio nas 9 celulas vizinhas da grade.
      hp: 70,
      velocidade: 55, // px/s — ~29% do teto do jogador: da pra fugir andando, nao parado
      dano: 11,
      raio: 24,
      xp: 4,
      peso: 0.3,
      comportamento: 'perseguir',
      // px/s de deslocamento aplicado ao jogador enquanto os dois corpos se
      // sobrepoem (colidirComJogador, enemies.js) — empurra pra fora do
      // caminho dele em vez de so descontar HP, cumprindo o "bloqueia rota
      // de fuga" do design sem exigir IA nova nenhuma.
      empurraoContato: 95,
    },
    {
      id: 'trabalhoGrupo',
      nome: 'Trabalho em Grupo',
      emoji: '📱',
      hp: 20,
      velocidade: 100,
      dano: 7,
      raio: 13,
      xp: 2,
      peso: 0.35,
      comportamento: 'perseguir',
      divisao: {
        filhos: 2,
        geracaoMaxima: 1, // filhote (geracao 1) nao divide de novo
        hpFator: 0.45,
        velocidadeFator: 1.2, // os filhotes saem mais rapidos — "punem dano em area"
        raioFator: 0.65,
        xpFator: 0.5,
        danoFator: 0.75,
        raioSpawn: 16, // px do centro da morte ate cada filhote, pra nao nascerem empilhados
      },
    },
  ],

  // Curva de spawn, parametrizada pelo segundo de avaliacao
  // (run.avaliacao.decorrido, nunca estado.tempo). Entre dois pontos o valor e
  // interpolado linearmente; depois do ultimo ponto, o ultimo vale.
  // `intervalo` = segundos entre ondas. `porOnda` = inimigos por onda (a parte
  // fracionaria vira chance de um a mais). O multiplicador global de
  // dificuldade divide o intervalo e multiplica o tamanho da onda.
  //
  // Ajuste pos-checkpoint 1: dos 30s em diante a curva sobe mais rapido (era
  // 3 por onda aos 30s e 5 aos 60s; agora 3,5 e 6). Sem essa rampa as armas
  // crescem mais rapido que a horda e o fim da avaliacao fica mais facil que
  // o meio. O teto da rampa (60s em diante) so vale para as avaliacoes mais
  // longas, que a fase 13 ainda vai medir.
  spawn: {
    curvaPadrao: 'padrao',
    curvas: {
      padrao: [
        { t: 0, intervalo: 1.6, porOnda: 1 },
        { t: 15, intervalo: 1.1, porOnda: 2 },
        { t: 30, intervalo: 0.8, porOnda: 3.5 },
        { t: 45, intervalo: 0.6, porOnda: 5 },
        { t: 60, intervalo: 0.45, porOnda: 6 },
        { t: 90, intervalo: 0.35, porOnda: 8 },
      ],
      // Fase 10: o fiozinho de 📕 por tras da Banca no TCC. Quem enche a arena
      // ali e a propria Banca (padrao `horda`); isto so garante XP para o
      // jogador, que comeca a defesa no nivel 1 como em toda avaliacao.
      tcc: [
        { t: 0, intervalo: 2.2, porOnda: 1 },
        { t: 60, intervalo: 1.6, porOnda: 1.5 },
        { t: 120, intervalo: 1.2, porOnda: 2 },
      ],
    },
    intervaloMinimo: 0.25, // piso duro: nem o modificador mais agressivo passa daqui
    porOndaMaximo: 8,
    maxSimultaneos: 180, // teto de jogabilidade, bem abaixo de arena.limites.enemies
    margemDescarte: 320, // px alem da borda: inimigo que passa disso volta pra pool

    // Composicao de spawn por avaliacao (fase 09): quais tipos podem nascer
    // e com que peso, no MESMO formato ponderado de `inimigos[].peso` (o
    // sorteio soma os pesos dos tipos presentes e escolhe proporcional —
    // tipo ausente do mapa tem peso 0, nunca nasce). Cada avaliacao de
    // `periodos` aponta uma composicao pelo nome (`composicaoSpawn`), do
    // mesmo jeito que ja aponta uma curva por `curvaPadrao`/`curvas`.
    // `composicaoPadrao` e so a rede de seguranca de quem chama spawnInimigo
    // fora de uma avaliacao de verdade (ex.: um teste que nao passou por
    // comecarAvaliacao) — a run real sempre tem `composicaoSpawn` valido,
    // e o validador exige isso de cada avaliacao.
    composicaoPadrao: 'p1',
    composicoes: {
      // 1a avaliacao da run: so o Prazo de Entrega, pelo mesmo motivo de ela
      // nao sortear modificador (state.js/handoff 08) — ensina o jogo base
      // com os numeros que as fases 01-07 mediram.
      p1: { prazo: 1 },
      // Resto do 1o periodo: Notificacao entra na 2a avaliacao...
      p1Notificacao: { prazo: 1, notificacao: 0.5 },
      // ...e o PDF entra so na Prova Final, o "modificador pesado" do 1o
      // periodo (design §2).
      p1Final: { prazo: 1, notificacao: 0.6, pdf: 0.3 },
      // 2o periodo em diante: os 4 tipos, pesos fixos (fase 13 balanceia).
      todos: { prazo: 1, notificacao: 0.6, pdf: 0.3, trabalhoGrupo: 0.35 },
      // TCC (fase 10): so o Prazo no fio de fundo — os 📱 da fase 2 vem da
      // Banca, nao do sorteio.
      tcc: { prazo: 1 },
    },
  },

  // Empurrao suave entre inimigos sobrepostos. Sem isso o bando vira uma
  // mancha unica em cima do jogador e some a leitura visual.
  separacao: {
    forca: 150, // px/s no maximo da sobreposicao
    folga: 3, // px somados aos raios: comecam a se empurrar um pouco antes de encostar
    // 2 x maior raio de inimigo + folga e o minimo que o validador aceita
    // (armadilha documentada no handoff 02/05). O PDF de 300 Paginas (raio
    // 24, fase 09) empurrou isso de 48 para 56: 2*24+3=51 <= 56.
    gradePasso: 56,
  },

  // As REGRAS de uma avaliacao sem modificador nenhum. Toda avaliacao nasce
  // com uma copia disto (state.js, novaAvaliacao) e o jogo le as regras de
  // estado.run.avaliacao.regras — nunca daqui direto. Cada regra multiplica
  // (ou liga) um numero que o jogo ja tinha:
  //   dificuldade          x ajuste.dificuldade no spawn (a avaliacao multiplica
  //                        pelo proprio `dificuldade`, e um modificador pode tambem)
  //   arena                fracao da largura E da altura da arena, centrada
  //   coringas             1 = coringas agem, 0 = desligados (so jokers.js le)
  //   hpInimigo            x o `hp` de cada tipo de inimigo, no spawn
  //   velocidadeInimigo    x a `velocidade` de cada tipo de inimigo, no spawn
  //   velocidadeInicial    x a velocidade maxima do jogador no segundo 0...
  //   recuperacaoVelocidade ...que volta a x1 em linha reta nestes segundos
  //                        (0 = o fator vale a avaliacao inteira)
  //   perdaHp              HP que o jogador perde a cada `intervaloPerdaHp` s
  //   intervaloPerdaHp     (perdaHp 0 = nada acontece)
  regras: {
    dificuldade: 1,
    arena: 1,
    coringas: 1,
    hpInimigo: 1,
    velocidadeInimigo: 1,
    velocidadeInicial: 1,
    recuperacaoVelocidade: 0,
    perdaHp: 0,
    intervaloPerdaHp: 0,
  },

  // Modificadores de avaliacao (design §9): a "regra" daquela prova, sorteada
  // e anunciada antes de ela comecar. Um modificador NAO e codigo: e so dado
  // que mexe nas `regras` acima.
  //   { id, nome, emoji, descricao, fatores: { regra: x }, somas: { regra: +n } }
  // `fatores` multiplicam a regra, `somas` somam a ela. Modificador novo que
  // so mexa em regra que ja existe entra so aqui; um que precise de regra nova
  // pede a regra em `regras` e o ponto do jogo que a le.
  //
  // A `descricao` repete os numeros em texto: mudou um, mude o outro (fase 13).
  // Primeiro corte, sem medicao de balanceamento — os numeros sao os do design.
  modificadores: [
    {
      id: 'aula7h',
      nome: 'Aula das 7h',
      emoji: '🌅',
      descricao: 'Você começa a −40% de velocidade e só acorda de vez em 20s.',
      fatores: { velocidadeInicial: 0.6 },
      somas: { recuperacaoVelocidade: 20 },
    },
    {
      id: 'salaLotada',
      nome: 'Sala Lotada',
      emoji: '🪑',
      descricao: 'A arena encolhe para 65% da largura e da altura.',
      fatores: { arena: 0.65 },
    },
    {
      id: 'semConsulta',
      nome: 'Prova sem Consulta',
      emoji: '🚫',
      descricao: 'Seus coringas ficam desativados nesta avaliação.',
      fatores: { coringas: 0 },
    },
    {
      id: 'professorRigido',
      nome: 'Professor Rígido',
      emoji: '👨‍🏫',
      descricao: 'Inimigos com +40% de HP.',
      fatores: { hpInimigo: 1.4 },
    },
    {
      id: 'sexta18h',
      nome: 'Sexta às 18h',
      emoji: '🕕',
      descricao: 'Inimigos com +35% de velocidade.',
      fatores: { velocidadeInimigo: 1.35 },
    },
    {
      id: 'frequencia',
      nome: 'Controle de Frequência',
      emoji: '📉',
      descricao: 'Você perde 1 HP a cada 12s, aconteça o que acontecer.',
      somas: { perdaHp: 1, intervaloPerdaHp: 12 },
    },
  ],

  // Estrutura da run (design §2): 3 periodos x (av1, av2, prova final), com a
  // loja depois de cada uma, e o TCC no fim. Cada avaliacao:
  //   id, nome        identidade; `nome` e o que o HUD e o boletim mostram
  //   materia         a disciplina: humor de graca e o jogador se localiza
  //   tipo            so descricao (relatorio). NENHUM codigo le isto: a Prova
  //                   Final e uma avaliacao como as outras, com numeros maiores
  //   duracao         segundos do cronometro
  //   dificuldade     x ajuste.dificuldade no spawn: divide o intervalo entre
  //                   ondas E multiplica o tamanho da onda, entao o ritmo de
  //                   nascimento cresce com o QUADRADO (1,3 da ~1,7x inimigos)
  //   modificadores   quantos o anuncio sorteia (design §9: 1-2)
  //   composicaoSpawn nome de uma entrada em spawn.composicoes (fase 09):
  //                   quais tipos de inimigo podem nascer nesta avaliacao
  //
  // A 1ª avaliacao da run nao sorteia modificador: ela ensina o jogo base, e e
  // nela que os numeros medidos das fases 01-07 continuam valendo. A Prova
  // Final e a "horda massiva com modificador pesado" do design so por dado:
  // mais dificuldade, dois modificadores e mais tempo.
  //
  // Primeiro corte. A fase 13 mede a run inteira (tabela do smoke) e ajusta.
  periodos: [
    {
      id: 'periodo-1',
      nome: '1º Período',
      avaliacoes: [
        { id: 'p1-av1', nome: 'Avaliação 1', materia: 'Cálculo I', tipo: 'comum', duracao: 60, dificuldade: 1, modificadores: 0, composicaoSpawn: 'p1' },
        { id: 'p1-av2', nome: 'Avaliação 2', materia: 'Algoritmos', tipo: 'comum', duracao: 60, dificuldade: 1.05, modificadores: 1, composicaoSpawn: 'p1Notificacao' },
        { id: 'p1-final', nome: 'Prova Final', materia: 'Física Experimental', tipo: 'final', duracao: 75, dificuldade: 1.15, modificadores: 2, composicaoSpawn: 'p1Final' },
      ],
    },
    {
      id: 'periodo-2',
      nome: '2º Período',
      avaliacoes: [
        { id: 'p2-av1', nome: 'Avaliação 1', materia: 'Estruturas de Dados', tipo: 'comum', duracao: 65, dificuldade: 1.1, modificadores: 1, composicaoSpawn: 'todos' },
        { id: 'p2-av2', nome: 'Avaliação 2', materia: 'Álgebra Linear', tipo: 'comum', duracao: 65, dificuldade: 1.15, modificadores: 1, composicaoSpawn: 'todos' },
        { id: 'p2-final', nome: 'Prova Final', materia: 'Cálculo II', tipo: 'final', duracao: 80, dificuldade: 1.25, modificadores: 2, composicaoSpawn: 'todos' },
      ],
    },
    {
      id: 'periodo-3',
      nome: '3º Período',
      avaliacoes: [
        { id: 'p3-av1', nome: 'Avaliação 1', materia: 'Banco de Dados', tipo: 'comum', duracao: 70, dificuldade: 1.2, modificadores: 1, composicaoSpawn: 'todos' },
        { id: 'p3-av2', nome: 'Avaliação 2', materia: 'Probabilidade e Estatística', tipo: 'comum', duracao: 70, dificuldade: 1.25, modificadores: 1, composicaoSpawn: 'todos' },
        { id: 'p3-final', nome: 'Prova Final', materia: 'Compiladores', tipo: 'final', duracao: 85, dificuldade: 1.35, modificadores: 2, composicaoSpawn: 'todos' },
      ],
    },
  ],

  // Tela de anuncio da avaliacao (antes de cada uma). Mesmo papel do
  // loja.atrasoEntrada: quem saiu da loja com clique duplo, ou Enter
  // repetido, nao comeca a prova sem ter lido os modificadores.
  anuncio: {
    atrasoEntrada: 0.35,
  },

  // O TCC (design §2 e §10): depois da loja da ultima Prova Final. E uma
  // avaliacao como as outras para o resto do jogo (jogador do zero, arma
  // inicial, coringas, cartas, pausa), com tres diferencas, todas daqui:
  //   - nao tem cronometro (`duracao` 0): acaba quando A Banca cai (colacao)
  //     ou quando o jogador cai (jubilado);
  //   - a curva e a composicao de spawn sao proprias (`curvaSpawn`,
  //     `composicaoSpawn`): quem enche a arena e a Banca;
  //   - A Banca (bloco `banca`, abaixo) nasce no comeco.
  // `nome`, `materia` e `periodo` sao o que o HUD e o boletim mostram.
  tcc: {
    id: 'tcc-defesa',
    nome: 'Defesa',
    materia: 'TCC',
    periodo: 'Fim do curso',
    tipo: 'defesa', // so descricao, como `tipo` das avaliacoes
    dificuldade: 1, // x ajuste.dificuldade na curva de fundo
    curvaSpawn: 'tcc',
    composicaoSpawn: 'tcc',
    // Pendencia 60: a tela do TCC abre logo depois do "Seguir" da ultima
    // loja; o Enter repetido nao pode comecar a defesa sem ela ser lida.
    atrasoEntrada: 0.35,
  },

  // A Banca (design §10). Herda TUDO de inimigo: as primeiras linhas sao o
  // mesmo contrato de `inimigos[]` (enemies.js a cria com spawnTipo e ela anda,
  // colide e toma dano como qualquer um). Ela nao mora em `inimigos[]` para
  // nunca entrar num sorteio de spawn nem nas corridas por tipo do smoke.
  //   chefe        marca o alvo como chefe (inimigo.chefe): a separacao nao o
  //                empurra, e coringas futuros (Cola na Regua, pendencia 55)
  //                sabem exclui-lo
  //   entrada      { duracao (s parada depois de nascer), margem (px abaixo do
  //                topo da arena onde ela nasce) }
  //   transicao    { duracao }: a pausa entre fases — parada, sem atacar e sem
  //                perder HP abaixo do limiar da fase que acabou
  //   pergunta     o projetil do leque: { id (a `fonte` do 'jogador-dano'),
  //                nome, emoji, raio, vidaMaxima (s), margemDescarte (px) }
  //   fases[]      em ordem; a fase i vale enquanto HP/hpMax > `ate`. A ultima
  //                tem ate 0. Cada uma: { nome, ate, velocidadeFator (x
  //                velocidade ao perseguir), intervalo (s perseguindo entre um
  //                padrao e o proximo), sequencia (nomes de padroes, em ciclo),
  //                padroes: { nome: parametros } }
  //
  // Padroes (o nome e uma funcao registrada em src/boss.js, PADROES). Todo
  // padrao tem `telegrafo` (s de aviso antes do golpe; >= 0,5, o validador
  // exige — dano sem aviso le como bug) e `recuperacao` (s parada depois):
  //   leque      { projeteis, abertura (rad, do primeiro ao ultimo), velocidade
  //              (px/s), dano, salvas, intervaloSalvas (s) } — mira no jogador
  //              no INICIO do aviso; o golpe sai nas linhas mostradas
  //   investida  { velocidade (px/s), distancia (px), dano (de contato durante
  //              a corrida) } — para, mostra a faixa, corre em linha reta
  //   horda      { tipo (id de inimigos[]), quantidade, raio (px da Banca ate
  //              cada ponto) } — circulos no chao, depois os inimigos ali
  //
  // Primeiro corte, sem medicao fina (fase 13). O design pede "~2min". Medido
  // com o botDesvio do smoke, SEM coringas e do nivel 1 (o pior jogador que
  // ainda se mexe), 8 sementes: com HP segurado A Banca cai em 54-114s
  // (mediana ~95s); com HP de verdade o bot cai em 4 das 8, com a Banca entre
  // 17% e 26% — ele nao desvia de pergunta nenhuma. Com 1400 de HP a luta
  // durava 43-83s: curta para um chefe. A luta dedicada do smoke imprime o
  // numero da semente fixa (SEMENTE+900).
  banca: {
    id: 'banca',
    nome: 'A Banca',
    emoji: '📋',
    hp: 2200,
    velocidade: 62, // px/s: devagar — o perigo sao os padroes, nao a perseguicao
    dano: 14, // por encostada, fora da investida
    raio: 26, // 2 x 26 + folga cabe na grade de separacao (gradePasso 56)
    xp: 0,
    comportamento: 'perseguir',
    chefe: true,
    // margem 120: o HUD (barras e coringas) cobre o topo do canvas; com menos
    // que isso ela nasceria escondida atras da propria barra de HP.
    entrada: { duracao: 1.2, margem: 120 },
    transicao: { duracao: 1.8 },
    pergunta: {
      id: 'pergunta',
      nome: 'Pergunta da Banca',
      emoji: '❓',
      raio: 9,
      vidaMaxima: 4,
      margemDescarte: 40,
    },
    fases: [
      {
        nome: 'Arguição',
        ate: 0.5,
        velocidadeFator: 1,
        intervalo: 2.4,
        sequencia: ['leque', 'horda'],
        padroes: {
          leque: {
            telegrafo: 0.8, recuperacao: 0.4,
            projeteis: 7, abertura: 1.0, velocidade: 220, dano: 10, salvas: 1, intervaloSalvas: 0,
          },
          horda: { telegrafo: 1.0, recuperacao: 0.4, tipo: 'prazo', quantidade: 6, raio: 80 },
        },
      },
      {
        nome: 'Réplica',
        ate: 0,
        velocidadeFator: 1.3,
        intervalo: 1.8,
        sequencia: ['investida', 'leque', 'investida', 'horda'],
        padroes: {
          leque: {
            telegrafo: 0.7, recuperacao: 0.4,
            projeteis: 11, abertura: 1.5, velocidade: 250, dano: 10, salvas: 2, intervaloSalvas: 0.35,
          },
          investida: { telegrafo: 0.9, recuperacao: 0.8, velocidade: 520, distancia: 460, dano: 20 },
          horda: { telegrafo: 1.0, recuperacao: 0.4, tipo: 'trabalhoGrupo', quantidade: 4, raio: 80 },
        },
      },
    ],
  },

  // A tela de colacao de grau (fim da run vencida). O atraso e maior que o
  // das outras telas: e o resumo da run inteira, e ninguem quer pula-lo com
  // a tecla que ainda estava apertada na luta.
  colacao: {
    atrasoEntrada: 0.6,
  },

  // O unico estado que sobrevive entre runs (main.js, lerRecorde/gravarRecorde):
  // melhor conceito geral e quantas vezes se formou. `chave` e o nome no
  // localStorage do navegador.
  recorde: {
    chave: 'semana-de-provas/recorde',
  },

  // Nota, conceito e economia (design §4). A nota nao aprova nem reprova —
  // sobreviver ao cronometro ja aprova. Ela decide quantos creditos a loja
  // recebe, e por isso e o unico motivo mecanico para jogar bem.
  //
  //   nota = kills * pesoKill + (hp/hpMax) * pesoHp + (ileso ? bonusIleso : 0)
  //
  // arredondada para uma casa e grampeada em `maxima`. O design chama
  // equilibrar pesoKill contra pesoHp de "a decisao de tunning mais importante
  // do jogo": pesoKill paga quem cacca, pesoHp paga quem preserva, e os dois
  // estilos precisam chegar em notas parecidas por caminhos diferentes.
  //
  // Recalibrado no ajuste pos-checkpoint 1. Antes (pesoKill 0,032, pesoHp 4,
  // ileso 1) o usuario tirou 10,0 jogando normal e 9,3 PARADO NO CANTO: as
  // armas automaticas matam tudo o que nasce, entao quem fica parado mata
  // tanto quanto quem anda, e as mortes dominavam a nota. Agora as mortes
  // pesam metade e o HP pesa mais; quem manda na nota e o HP que sobra.
  //
  // Medido com tres bots do smoke (avaliacao inteira, HP real, pegando
  // sempre a primeira carta), 16 sementes cada:
  //   - desviando (foge de quem chega perto; reproduzia a partida "jogando
  //     normal" do usuario antes do ajuste): media 8,4 — A1 B8 C6 D1, nenhum
  //     jubilado. O A exige terminar ileso E cacar: 279 mortos com ileso.
  //   - parado no canto: 5 jubilados; quem sobrevive tira 6,0 em media —
  //     C2 D2 F7. Duas sementes em 16 ainda passam de D (7,9 e 8,1).
  //   - circular (anda em circulo sem olhar, rente as paredes): 3 jubilados,
  //     media 5,9 — C3 D2 F8. Ele toma tanto dano quanto o canto.
  // Nas sementes fixas do smoke: circular 5,7 (F), canto 5,3 (F), desviando
  // 8,2 (C).
  //
  // Pontas conferidas: quem se esconde sem matar nada, HP cheio e ileso,
  // tira 5,0 = F; a nota maxima exige 310 mortos com ileso (341 sem ileso).
  // Os dois estilos do design chegam perto por caminhos diferentes:
  // defensivo com 150 mortos e HP cheio da 6,9 (D), 7,4 (C) se ileso;
  // agressivo com 300 mortos e 40% de HP da 6,6 (D).
  //
  // O que estes numeros NAO cobrem, e a fase 13 precisa olhar: como kills e
  // termo absoluto, uma avaliacao de 85s (prova final) rende mais mortos e
  // portanto nota maior que uma de 60s, mesmo jogando igual.
  nota: {
    pesoKill: 0.016, // por inimigo morto; 250 mortos valem 4,0
    pesoHp: 4.5, // multiplica a fracao de HP restante: HP cheio vale 4,5 pontos
    bonusIleso: 0.5, // so para quem terminou sem tomar UM ponto de dano
    maxima: 10,
    // Casas decimais da nota. Nao e cosmetico: e a nota ARREDONDADA que
    // escolhe a faixa, senao a tela mostraria 8,5 e pagaria creditos de C.
    casasDecimais: 1,
    // Creditos = creditosBase * creditosFator da faixa (design §4: D base,
    // C +30%, B +60%, A +100%). A loja da fase 07 vende na casa dos 60-120,
    // entao uma avaliacao rende de meia a duas compras.
    creditosBase: 60,
    // Faixas em ordem decrescente de exigencia. A primeira cuja nota minima
    // for atingida vence.
    faixas: [
      // itensLoja: quantos coringas a loja mostra depois deste conceito
      // (design §5: 3, ou 4 com B ou A). rerollsGratis: quantos rerolls da
      // visita saem de graca, antes do primeiro pago (design §4: 1 com A).
      { conceito: 'A', minimo: 9.5, creditosFator: 2, itensLoja: 4, rerollsGratis: 1 },
      { conceito: 'B', minimo: 8.5, creditosFator: 1.6, itensLoja: 4, rerollsGratis: 0 },
      { conceito: 'C', minimo: 7, creditosFator: 1.3, itensLoja: 3, rerollsGratis: 0 },
      { conceito: 'D', minimo: 6, creditosFator: 1, itensLoja: 3, rerollsGratis: 0 },
      // F nao existe na tabela do design §4. Existe aqui porque a run continua
      // (a nota nao reprova) e mandar o jogador para uma loja sem um credito
      // sequer transformaria uma avaliacao ruim em duas.
      { conceito: 'F', minimo: 0, creditosFator: 0.5, itensLoja: 3, rerollsGratis: 0 },
    ],
  },

  // Chaves de desenvolvimento. NADA aqui muda a simulacao: so o que a tela
  // mostra para quem esta testando. A fase 15 confere que tudo esta desligado
  // antes da entrega.
  debug: {
    // Linha extra no boletim (resultado e jubilado) com o nivel do jogador e
    // as armas equipadas com seus niveis. Pedido do checkpoint humano 1 para
    // dar feedback de balanceamento durante o desenvolvimento.
    boletimArmas: true,
    // Telemetria da partida (src/telemetria.js) e os botoes que exportam o
    // relatorio de balanceamento (src/relatorio.js) nas telas de fim e no
    // menu. Pedido do usuario (todo.md): um relatorio completo para mandar a
    // agentes que balanceiam o jogo. So observa — desligar nao muda um numero
    // da simulacao, e o smoke prova isso rodando a mesma semente dos dois
    // jeitos.
    relatorio: true,
  },

  // Parametros do INSTRUMENTO de medida (debug.relatorio), nao do jogo: nada
  // aqui muda a partida, so como ela e observada e resumida. Moram aqui pela
  // regra 4 — nenhum numero solto em .js de logica.
  relatorio: {
    amostraSegundos: 1, // resolucao da linha do tempo guardada no JSON
    janelaTabela: 5, // a tabela em Markdown agrupa as amostras nesta janela (s)
    raioPerto: 120, // px entre centros: inimigo "perto" do jogador (pressao)
    margemBorda: 60, // px da parede ate o corpo do jogador: "rente a borda"
    margemCanto: 140, // px de DUAS paredes ao mesmo tempo: "no canto"
    velocidadeParado: 20, // px/s: abaixo disso o jogador conta como parado
    gradeColunas: 8, // mapa de calor da posicao do jogador
    gradeLinhas: 4,
    marcosNivel: 15, // s: o relatorio mostra o nivel a cada tantos segundos
    inicioSegundos: 15, // "os primeiros 15s", que o design §3 chama de indefesos
    janelaDano: 10, // s: tamanho da janela da "pior sequencia de dano"
    maxRegistros: 400, // teto de linhas por lista (golpes, cartas, amostras) por avaliacao
    historicoPartidas: 12, // partidas guardadas na sessao; a mais antiga sai
    // Alvos do design que as leituras automaticas comparam.
    alvos: {
      nivel: 5, // design §3: nivel 5-6...
      ate: 60, // ...em 60s
    },
    // Limiares das leituras automaticas. Sao so gatilhos de "vale olhar":
    // o relatorio mostra o numero de qualquer jeito.
    alertas: {
      fracaoCanto: 0.35, // tempo no canto acima disto: jogou acampado
      fracaoBorda: 0.5, // tempo rente a borda acima disto
      fracaoParado: 0.4, // tempo parado acima disto
      participacaoArma: 0.1, // arma equipada ha tempo que causou menos que isto do dano
      tempoMinimoArma: 15, // s equipada antes de a participacao contar
      overkill: 0.3, // fracao do dano nominal desperdicada em quem ja ia morrer
      coletaXp: 0.5, // fracao do XP solto que foi coletada, abaixo disto
      fps: 50, // fps medio abaixo disto: a maquina pesou na dificuldade
    },
  },

  // HUD. Numeros de apresentacao que o ui.js le; o que o canvas desenha fica
  // em `visual`.
  hud: {
    // Segundos finais em que o cronometro entra em vermelho pulsante. E a
    // unica informacao de "acabando" que o jogador tem sem ficar lendo numero.
    timerUrgente: 10,
  },

  // Toda string visivel ao jogador que nao esta no index.html mora aqui.
  textos: {
    telas: {
      menu: 'Menu',
      avaliacao: 'Avaliação',
      pausa: 'Pausa',
      carta: 'Carta',
      resultado: 'Resultado',
      jubilado: 'Jubilado',
      loja: 'Loja',
      anuncio: 'Anúncio',
      tcc: 'TCC',
      colacao: 'Colação de Grau',
    },
    // Fase 10. Os textos com {chave} sao modelos: ui.js troca cada {chave}
    // pelo valor (preencher). Modelo inteiro, e nao pedacos colados, porque
    // a ordem das palavras e do portugues, nao do codigo.
    banca: {
      transicao: 'A Banca se reúne', // o texto grande da pausa entre fases
      fase: 'Fase {n} — {nome}', // embaixo dele, e no HUD ao lado da barra
    },
    jubilado: {
      onde: 'Caiu em {avaliacao} — {periodo}.',
      faltavaTempo: 'Faltavam {tempo} para o fim da prova',
      faltavaBanca: 'A Banca ainda tinha {hp}% de HP',
      restamVarias: ', e ainda {n} avaliações e o TCC até a formatura.',
      restaUma: ', e ainda 1 avaliação e o TCC até a formatura.',
      soTcc: ', e depois só o TCC.',
      ultimaEtapa: ' — era a última etapa antes da formatura.',
    },
    colacao: {
      tcc: 'TCC aprovado pela Banca em {tempo}',
      media: 'Média {media}',
      conceito: 'Conceito geral {conceito}',
      semCoringa: 'Formou-se sem nenhum coringa.',
      novoRecorde: 'Novo recorde! Melhor conceito geral: {conceito} ({media}) · formaturas: {formaturas}',
      recorde: 'Recorde: {conceito} ({media}) · formaturas: {formaturas}',
    },
    // A linha do menu, so depois da primeira formatura.
    recorde: {
      menu: '🎓 Formado {formaturas}× · melhor conceito geral: {conceito} ({media})',
    },
    // A tela de anuncio monta a linha "Avaliação 1 · 1:00" e a lista de
    // modificadores; o texto fixo (titulo, dica, botao) mora no index.html.
    anuncio: {
      semModificador: 'Sem modificadores: aula normal.',
    },
    // A loja: rotulos que ui.js monta com numeros do estado. O texto fixo
    // (titulo, dica de teclado) mora no index.html.
    loja: {
      rerolar: 'Rerrolar',
      gratis: 'grátis',
      seguir: 'Seguir →',
      vendido: 'Vendido',
      vazio: 'Esgotado',
      vender: 'vender por',
      gasto: 'já usado',
      semCoringa: 'vazio',
      avisos: {
        semCreditos: 'Créditos insuficientes.',
        cheio: 'Você já tem o máximo de coringas. Venda um primeiro.',
        vendido: 'Esse item já foi comprado.',
        semNovidade: 'Não há outros coringas para sortear.',
      },
    },
    // Rotulos que a carta monta com numeros vindos do estado. O texto fixo da
    // tela (titulo, dica de teclado) mora no index.html.
    cartas: {
      novidade: 'Nova arma',
      nivel: 'Nv.',
      seta: '→',
      cura: 'de HP',
    },
    // A decomposicao da nota: "47 mortos (+1,5) · 62% de HP (+2,5) · sem levar
    // dano (+1,0)". Sem ela a nota e um numero arbitrario e o jogador nao tem
    // como descobrir que caccar e preservar HP pagam os dois.
    resultado: {
      conceito: 'Conceito',
      mortos: 'mortos',
      hp: 'de HP',
      ileso: 'sem levar dano',
      feriu: 'levou dano', // aparece com +0,0: o bonus perdido ensina que ele existe
      separador: ' · ',
      creditos: 'créditos',
      simboloCredito: '◉',
      sobreviveu: 'sobreviveu',
      de: 'de',
      // Linha de debug do boletim (debug.boletimArmas): "Nível 7 · ☕ Café nv3".
      nivelJogador: 'Nível',
      nivelArma: 'nv',
    },
    // Retorno dos botoes de exportar relatorio (debug.relatorio). O texto do
    // relatorio em si e ferramenta de desenvolvimento e mora em
    // src/relatorio.js, como a saida do smoke mora em test/.
    relatorio: {
      baixado: '✓ arquivo baixado',
      copiado: 'texto copiado',
      semCopia: 'não deu para copiar, use o arquivo',
      vazio: 'nada registrado ainda',
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
      // `comportamento` e um nome de funcao de movimento registrada em
      // MOVIMENTOS (enemies.js) — o mesmo split de responsabilidade de
      // `armas[].comportamento`: content.js so sabe que a string existe,
      // quem confere se ela esta registrada de verdade e o smoke
      // (verificarInimigosDoConteudo), nunca este validador (importar
      // enemies.js aqui fecharia um ciclo com content.js).
      if (typeof inimigo.comportamento !== 'string' || inimigo.comportamento === '') {
        erros.push(`${c}.comportamento: ausente ou vazio — precisa nomear uma funcao de enemies.js`);
      }
      if (inimigo.empurraoContato !== undefined) {
        exigeNumero(inimigo.empurraoContato, `${c}.empurraoContato`, { min: 0 });
      }
      if (inimigo.ruido !== undefined && exigeObjeto(inimigo.ruido, `${c}.ruido`)) {
        exigeNumero(inimigo.ruido.amplitude, `${c}.ruido.amplitude`, { min: 0, max: Math.PI });
        // Hz de verdade (enemies.js multiplica por 2*PI antes de usar como
        // angular): minimo de 1/60 Hz = 1 ciclo a cada 60s, ainda faz sentido
        // como piso — abaixo disso o desvio praticamente nao oscila dentro
        // de uma avaliacao. Sem maximo declarado: nao ha tipo hoje perto de
        // um limite pratico (fase 13 mede se precisar).
        exigeNumero(inimigo.ruido.frequencia, `${c}.ruido.frequencia`, { min: 1 / 60 });
      }
      if (inimigo.rajada !== undefined && exigeObjeto(inimigo.rajada, `${c}.rajada`)) {
        exigeNumero(inimigo.rajada.intervalo, `${c}.rajada.intervalo`, { min: 1 / 60 });
        if (exigeNumero(inimigo.rajada.tamanho, `${c}.rajada.tamanho`, { min: 1 }) && !Number.isInteger(inimigo.rajada.tamanho)) {
          erros.push(`${c}.rajada.tamanho: ${inimigo.rajada.tamanho} precisa ser inteiro`);
        }
        if (inimigo.rajada.espalhamento !== undefined) {
          exigeNumero(inimigo.rajada.espalhamento, `${c}.rajada.espalhamento`, { min: 0 });
        }
      }
      if (inimigo.divisao !== undefined && exigeObjeto(inimigo.divisao, `${c}.divisao`)) {
        const d = inimigo.divisao;
        if (exigeNumero(d.filhos, `${c}.divisao.filhos`, { min: 1 }) && !Number.isInteger(d.filhos)) {
          erros.push(`${c}.divisao.filhos: ${d.filhos} precisa ser inteiro`);
        }
        if (exigeNumero(d.geracaoMaxima, `${c}.divisao.geracaoMaxima`, { min: 0 }) && !Number.isInteger(d.geracaoMaxima)) {
          erros.push(`${c}.divisao.geracaoMaxima: ${d.geracaoMaxima} precisa ser inteiro`);
        }
        exigeNumero(d.velocidadeFator, `${c}.divisao.velocidadeFator`, { min: 0.01 });
        exigeNumero(d.xpFator, `${c}.divisao.xpFator`, { min: 0 });
        exigeNumero(d.danoFator, `${c}.divisao.danoFator`, { min: 0 });
        exigeNumero(d.raioSpawn, `${c}.divisao.raioSpawn`, { min: 0 });
        // hpFator e raioFator precisam deixar o filhote VIAVEL: hp e raio
        // minimos sao 1, os mesmos que o validador exige da entrada base —
        // um filhote com raio < 1 ou hp < 1 nasceria fora das regras que o
        // resto do jogo assume de todo inimigo.
        //
        // Esta conta so olha UMA geracao (tipo.hp * hpFator), mas isso cobre
        // QUALQUER geracaoMaxima da forma como enemies.js calcula hoje:
        // inicializarInimigo() sempre multiplica a partir do tipo BASE
        // (tipo.hp), nunca do hp ja reduzido do pai — um neto (geracaoMaxima
        // >= 2) usaria o MESMO hpFator sobre o MESMO tipo.hp, nao um fator ao
        // quadrado. Se um dia isso mudar para compor fatores entre geracoes,
        // esta validacao precisa mudar junto (fica registrado para a fase 13
        // no handoff da revisao pos-fase-09).
        if (exigeNumero(d.hpFator, `${c}.divisao.hpFator`, { min: 0.01 }) && typeof inimigo.hp === 'number') {
          const hpFilhote = inimigo.hp * d.hpFator;
          if (hpFilhote < 1) {
            erros.push(`${c}.divisao.hpFator: ${d.hpFator} da um filhote com ${hpFilhote.toFixed(2)} de HP (minimo 1)`);
          }
        }
        // raioFator nao tem maximo aqui: um filhote MAIOR que o pai (fator >
        // 1) e viavel por si so, mas so "cabe" na grade espacial se
        // separacao.gradePasso continuar >= 2 x MAIOR raio + folga — e esse
        // maior raio precisa contar o filhote, nao so os tipos base. Ver
        // `maiorRaio` no bloco de `separacao` abaixo, que agora inclui
        // `raio * divisao.raioFator` de quem tem `divisao`.
        if (exigeNumero(d.raioFator, `${c}.divisao.raioFator`, { min: 0.01 }) && typeof inimigo.raio === 'number') {
          const raioFilhote = inimigo.raio * d.raioFator;
          if (raioFilhote < 1) {
            erros.push(`${c}.divisao.raioFator: ${d.raioFator} da um filhote com raio ${raioFilhote.toFixed(2)} (minimo 1)`);
          }
        }
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
    if (exigeNumero(conteudo.spawn.margemDescarte, 'spawn.margemDescarte', { min: 1 }) && conteudo.arena) {
      // O inimigo nasce a margemSpawn + raio fora da borda; se isso passar do
      // descarte, ele volta para a pool no mesmo quadro em que nasceu e o
      // spawn parece desligado.
      const maiorRaio = Array.isArray(conteudo.inimigos)
        ? conteudo.inimigos.reduce((m, i) => (i && typeof i.raio === 'number' && i.raio > m ? i.raio : m), 0)
        : 0;
      if (conteudo.arena.margemSpawn + maiorRaio >= conteudo.spawn.margemDescarte) {
        erros.push(
          `arena.margemSpawn: ${conteudo.arena.margemSpawn} + raio ${maiorRaio} alcanca spawn.margemDescarte ` +
            `(${conteudo.spawn.margemDescarte}) — o inimigo seria descartado ao nascer`
        );
      }
    }
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

    // Composicao de spawn por avaliacao (fase 09): mesmo padrao de
    // curvaPadrao/curvas, mas para QUAIS tipos podem nascer e com que peso.
    const idsInimigo = new Set(
      Array.isArray(conteudo.inimigos) ? conteudo.inimigos.map((i) => i && i.id).filter(Boolean) : []
    );
    if (exigeObjeto(conteudo.spawn.composicoes, 'spawn.composicoes')) {
      const padrao = conteudo.spawn.composicaoPadrao;
      if (!conteudo.spawn.composicoes[padrao]) {
        erros.push(`spawn.composicaoPadrao: "${padrao}" nao existe em spawn.composicoes`);
      }
      for (const [nome, pesos] of Object.entries(conteudo.spawn.composicoes)) {
        const c = `spawn.composicoes.${nome}`;
        if (!exigeObjeto(pesos, c)) continue;
        let soma = 0;
        for (const [tipoId, peso] of Object.entries(pesos)) {
          if (!idsInimigo.has(tipoId)) {
            erros.push(`${c}.${tipoId}: "${tipoId}" nao e um id em inimigos`);
            continue;
          }
          if (exigeNumero(peso, `${c}.${tipoId}`, { min: 0 })) soma += peso;
        }
        if (soma <= 0) erros.push(`${c}: soma dos pesos e 0 — nenhum tipo nasceria nesta avaliacao`);
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
          if (!inimigo || typeof inimigo.raio !== 'number') continue;
          if (inimigo.raio > maiorRaio) maiorRaio = inimigo.raio;
          // Um filhote com raioFator > 1 nasce MAIOR que o pai — ele tambem
          // precisa caber nas 9 celulas vizinhas da grade, senao a regra
          // abaixo aprovaria um raioFator que na pratica quebra a separacao
          // (correcao pos-revisao da fase 09).
          if (inimigo.divisao && typeof inimigo.divisao.raioFator === 'number') {
            const raioFilhote = inimigo.raio * inimigo.divisao.raioFator;
            if (raioFilhote > maiorRaio) maiorRaio = raioFilhote;
          }
        }
      }
      // A Banca (fase 10) mora na mesma pool e passa pela mesma grade.
      if (conteudo.banca && typeof conteudo.banca.raio === 'number' && conteudo.banca.raio > maiorRaio) {
        maiorRaio = conteudo.banca.raio;
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
        exigeNumero(av.dificuldade, `${c}.dificuldade`, { min: 0.1, max: 10 });
        for (const campo of ['nome', 'materia']) {
          if (typeof av[campo] !== 'string' || av[campo] === '') erros.push(`${c}.${campo}: ausente ou vazio`);
        }
        if (exigeNumero(av.modificadores, `${c}.modificadores`, { min: 0 }) && !Number.isInteger(av.modificadores)) {
          erros.push(`${c}.modificadores: ${av.modificadores} precisa ser inteiro`);
        }
        if (typeof av.composicaoSpawn !== 'string' || av.composicaoSpawn === '') {
          erros.push(`${c}.composicaoSpawn: ausente ou vazio`);
        } else if (conteudo.spawn && conteudo.spawn.composicoes && !conteudo.spawn.composicoes[av.composicaoSpawn]) {
          erros.push(`${c}.composicaoSpawn: "${av.composicaoSpawn}" nao existe em spawn.composicoes`);
        }
      });
    });

    // O sorteio nao repete um modificador da avaliacao anterior. Duas
    // avaliacoes seguidas com N e M modificadores precisam de N + M distintos,
    // senao a segunda sairia com menos do que o dado pede.
    const lista = Array.isArray(conteudo.modificadores) ? conteudo.modificadores : [];
    const seguidas = [];
    for (const periodo of conteudo.periodos) {
      for (const av of Array.isArray(periodo && periodo.avaliacoes) ? periodo.avaliacoes : []) {
        if (av && typeof av.modificadores === 'number') seguidas.push(av);
      }
    }
    for (let i = 0; i < seguidas.length; i += 1) {
      const antes = i > 0 ? seguidas[i - 1].modificadores : 0;
      if (antes + seguidas[i].modificadores > lista.length) {
        erros.push(
          `periodos: "${seguidas[i].id}" sorteia ${seguidas[i].modificadores} modificador(es) depois de uma ` +
            `avaliacao com ${antes}, e so existem ${lista.length} — o sorteio sem repeticao nao fecha`
        );
      }
    }
  }

  // Regras neutras e modificadores. Um modificador so pode citar regra que
  // existe: uma chave digitada errado seria um modificador que nao faz nada,
  // anunciado na tela como se fizesse.
  const regras = conteudo.regras;
  if (exigeObjeto(regras, 'regras')) {
    for (const [chave, valor] of Object.entries(regras)) exigeNumero(valor, `regras.${chave}`, { min: 0 });
    if (regras.arena !== 1 || regras.coringas !== 1) {
      erros.push('regras: arena e coringas neutros precisam valer 1 — sao elas que valem sem modificador');
    }
  }
  if (Array.isArray(conteudo.modificadores) && regras) {
    conteudo.modificadores.forEach((mod, i) => {
      const c = `modificadores[${i}]`;
      if (typeof mod !== 'object' || mod === null) return;
      for (const campo of ['emoji', 'descricao']) {
        if (typeof mod[campo] !== 'string' || mod[campo] === '') erros.push(`${c}.${campo}: ausente ou vazio`);
      }
      const efeito = { ...regras };
      const declaradas = [];
      for (const grupo of ['fatores', 'somas']) {
        if (mod[grupo] === undefined) continue;
        if (!exigeObjeto(mod[grupo], `${c}.${grupo}`)) continue;
        for (const [chave, valor] of Object.entries(mod[grupo])) {
          if (!(chave in regras)) {
            erros.push(`${c}.${grupo}.${chave}: nao e uma regra (${Object.keys(regras).join(', ')})`);
            continue;
          }
          if (!exigeNumero(valor, `${c}.${grupo}.${chave}`, { min: 0 })) continue;
          const antes = efeito[chave];
          efeito[chave] = grupo === 'fatores' ? efeito[chave] * valor : efeito[chave] + valor;
          declaradas.push({ grupo, chave, valor, mudou: efeito[chave] !== antes });
        }
      }
      // Cada chave declarada e uma promessa do anuncio ("+40% de HP"). Uma que
      // deixa a regra no neutro (x1, +0, ou x qualquer coisa sobre neutro 0)
      // passaria verde e o jogador leria um efeito que nao existe.
      for (const d of declaradas) {
        if (d.mudou && efeito[d.chave] !== regras[d.chave]) continue;
        erros.push(
          `${c}.${d.grupo}.${d.chave}: ${d.valor} deixa a regra no valor neutro (${regras[d.chave]}) — ` +
            'o anuncio promete um efeito que nao existe'
        );
      }
      if (declaradas.length === 0) erros.push(`${c}: nao mexe em regra nenhuma — seria anunciado e nao faria nada`);
      if (efeito.perdaHp > 0 && !(efeito.intervaloPerdaHp > 0)) {
        erros.push(`${c}: perdaHp ${efeito.perdaHp} sem intervaloPerdaHp — o HP sairia a cada tick`);
      }
      if (efeito.arena > 1) erros.push(`${c}: arena x${efeito.arena} passa da tela (o canvas e o tamanho maximo)`);
      // Arena menor que o jogador com folga para desviar nao e modificador, e
      // armadilha: 4 corpos de jogador e o minimo para ainda dar um passo.
      const jogador = conteudo.jogador || {};
      const arena = conteudo.arena || {};
      const menor = Math.min(arena.largura || 0, arena.altura || 0) * efeito.arena;
      if (typeof jogador.raio === 'number' && menor < jogador.raio * 8) {
        erros.push(`${c}: arena x${efeito.arena} deixa ${menor.toFixed(0)}px no lado menor — nao cabe o jogador desviando`);
      }
    });
  }

  if (exigeObjeto(conteudo.anuncio, 'anuncio')) {
    exigeNumero(conteudo.anuncio.atrasoEntrada, 'anuncio.atrasoEntrada', { min: 0, max: 2 });
  }
  if (conteudo.cartas) exigeNumero(conteudo.cartas.atrasoEntrada, 'cartas.atrasoEntrada', { min: 0, max: 2 });

  // TCC e A Banca (fase 10).
  const exigeTexto = (valor, caminho) => {
    if (typeof valor !== 'string' || valor === '') {
      erros.push(`${caminho}: ausente ou vazio`);
      return false;
    }
    return true;
  };
  const exigeInteiro = (valor, caminho, limites) => {
    if (exigeNumero(valor, caminho, limites) && !Number.isInteger(valor)) {
      erros.push(`${caminho}: ${valor} precisa ser inteiro`);
    }
  };
  const idsDeInimigo = new Set(Array.isArray(conteudo.inimigos) ? conteudo.inimigos.map((i) => i && i.id) : []);

  if (exigeObjeto(conteudo.tcc, 'tcc')) {
    const t = conteudo.tcc;
    for (const campo of ['id', 'nome', 'materia', 'periodo', 'tipo']) exigeTexto(t[campo], `tcc.${campo}`);
    exigeNumero(t.dificuldade, 'tcc.dificuldade', { min: 0.1, max: 10 });
    exigeNumero(t.atrasoEntrada, 'tcc.atrasoEntrada', { min: 0, max: 2 });
    if (conteudo.spawn && conteudo.spawn.curvas && !conteudo.spawn.curvas[t.curvaSpawn]) {
      erros.push(`tcc.curvaSpawn: "${t.curvaSpawn}" nao existe em spawn.curvas`);
    }
    if (conteudo.spawn && conteudo.spawn.composicoes && !conteudo.spawn.composicoes[t.composicaoSpawn]) {
      erros.push(`tcc.composicaoSpawn: "${t.composicaoSpawn}" nao existe em spawn.composicoes`);
    }
    // O id do TCC nao pode colidir com o de uma avaliacao: o relatorio e o
    // boletim identificam cada registro por ele.
    for (const periodo of Array.isArray(conteudo.periodos) ? conteudo.periodos : []) {
      for (const av of Array.isArray(periodo && periodo.avaliacoes) ? periodo.avaliacoes : []) {
        if (av && av.id === t.id) erros.push(`tcc.id: "${t.id}" repete o id de uma avaliacao de periodos`);
      }
    }
  }

  if (exigeObjeto(conteudo.colacao, 'colacao')) {
    exigeNumero(conteudo.colacao.atrasoEntrada, 'colacao.atrasoEntrada', { min: 0, max: 3 });
  }
  if (exigeObjeto(conteudo.recorde, 'recorde')) exigeTexto(conteudo.recorde.chave, 'recorde.chave');

  // Os campos que cada padrao da Banca pede, alem de telegrafo/recuperacao.
  // Mesma divisao de CAMPOS_POR_COMPORTAMENTO: aqui so o que content.js sabe
  // sem importar logica; se o NOME do padrao existe em boss.js, quem confere
  // e o smoke (verificarBancaDoConteudo).
  const CAMPOS_POR_PADRAO = {
    leque: [['projeteis', 1], ['abertura', 0], ['velocidade', 1], ['dano', 0], ['salvas', 1], ['intervaloSalvas', 0]],
    investida: [['velocidade', 1], ['distancia', 1], ['dano', 0]],
    horda: [['quantidade', 1], ['raio', 0]],
  };
  const PADROES_INTEIROS = new Set(['projeteis', 'salvas', 'quantidade']);
  // Contrato da fase 10, tarefa 4: todo padrao avisa pelo menos isto antes.
  const TELEGRAFO_MINIMO = 0.5;

  if (exigeObjeto(conteudo.banca, 'banca')) {
    const b = conteudo.banca;
    for (const campo of ['id', 'nome', 'emoji', 'comportamento']) exigeTexto(b[campo], `banca.${campo}`);
    exigeNumero(b.hp, 'banca.hp', { min: 1 });
    exigeNumero(b.velocidade, 'banca.velocidade', { min: 1 });
    exigeNumero(b.dano, 'banca.dano', { min: 0 });
    exigeNumero(b.raio, 'banca.raio', { min: 1 });
    exigeNumero(b.xp, 'banca.xp', { min: 0 });
    if (b.chefe !== true) erros.push('banca.chefe: precisa ser true — e o que marca o alvo como chefe (inimigo.chefe)');
    if (idsDeInimigo.has(b.id)) erros.push(`banca.id: "${b.id}" repete um id de inimigos — o relatorio confundiria as fontes`);
    if (exigeObjeto(b.entrada, 'banca.entrada')) {
      exigeNumero(b.entrada.duracao, 'banca.entrada.duracao', { min: 0 });
      exigeNumero(b.entrada.margem, 'banca.entrada.margem', { min: 0 });
    }
    // A pausa entre fases tem que ser vista: menos que isto e um piscar.
    if (exigeObjeto(b.transicao, 'banca.transicao')) {
      exigeNumero(b.transicao.duracao, 'banca.transicao.duracao', { min: 0.5, max: 5 });
    }
    const jogadorRaio = conteudo.jogador && typeof conteudo.jogador.raio === 'number' ? conteudo.jogador.raio : 0;
    const passoLoop = conteudo.loop && typeof conteudo.loop.passo === 'number' ? conteudo.loop.passo : 1 / 60;
    if (exigeObjeto(b.pergunta, 'banca.pergunta')) {
      const p = b.pergunta;
      for (const campo of ['id', 'nome', 'emoji']) exigeTexto(p[campo], `banca.pergunta.${campo}`);
      exigeNumero(p.raio, 'banca.pergunta.raio', { min: 1 });
      exigeNumero(p.vidaMaxima, 'banca.pergunta.vidaMaxima', { min: 0.1 });
      exigeNumero(p.margemDescarte, 'banca.pergunta.margemDescarte', { min: 0 });
      if (idsDeInimigo.has(p.id) || p.id === b.id) {
        erros.push(`banca.pergunta.id: "${p.id}" repete outro id de fonte de dano — o relatorio confundiria as fontes`);
      }
    }
    if (!Array.isArray(b.fases) || b.fases.length === 0) {
      erros.push('banca.fases: esperava um array nao vazio');
    } else {
      let anterior = 1;
      b.fases.forEach((fase, i) => {
        const c = `banca.fases[${i}]`;
        if (!exigeObjeto(fase, c)) return;
        exigeTexto(fase.nome, `${c}.nome`);
        if (exigeNumero(fase.ate, `${c}.ate`, { min: 0, max: 1 })) {
          if (fase.ate >= anterior) erros.push(`${c}.ate: ${fase.ate} precisa ser menor que o da fase anterior (${anterior})`);
          anterior = fase.ate;
        }
        exigeNumero(fase.velocidadeFator, `${c}.velocidadeFator`, { min: 0.01 });
        exigeNumero(fase.intervalo, `${c}.intervalo`, { min: 0.1 });
        if (!exigeObjeto(fase.padroes, `${c}.padroes`)) return;
        if (!Array.isArray(fase.sequencia) || fase.sequencia.length === 0) {
          erros.push(`${c}.sequencia: esperava um array nao vazio de nomes de padrao`);
        } else {
          for (const nome of fase.sequencia) {
            if (!fase.padroes[nome]) erros.push(`${c}.sequencia: "${nome}" nao tem parametros em ${c}.padroes`);
          }
        }
        for (const [nome, padrao] of Object.entries(fase.padroes)) {
          const cp = `${c}.padroes.${nome}`;
          if (!exigeObjeto(padrao, cp)) continue;
          exigeNumero(padrao.telegrafo, `${cp}.telegrafo`, { min: TELEGRAFO_MINIMO });
          exigeNumero(padrao.recuperacao, `${cp}.recuperacao`, { min: 0 });
          const campos = CAMPOS_POR_PADRAO[nome];
          if (!campos) {
            erros.push(`${cp}: padrao desconhecido (conhecidos: ${Object.keys(CAMPOS_POR_PADRAO).join(', ')})`);
            continue;
          }
          for (const [campo, min] of campos) {
            if (PADROES_INTEIROS.has(campo)) exigeInteiro(padrao[campo], `${cp}.${campo}`, { min });
            else exigeNumero(padrao[campo], `${cp}.${campo}`, { min });
          }
          if (nome === 'leque') {
            if (typeof padrao.abertura === 'number' && padrao.abertura > Math.PI * 2) {
              erros.push(`${cp}.abertura: ${padrao.abertura} rad passa de uma volta inteira`);
            }
            if (padrao.salvas > 1 && !(padrao.intervaloSalvas > 0)) {
              erros.push(`${cp}.intervaloSalvas: com ${padrao.salvas} salvas precisa ser > 0 — sairiam todas no mesmo tick`);
            }
            // A pergunta anda isto por quadro; mais que o alcance da colisao
            // e ela atravessa o jogador sem acertar.
            const alcance = jogadorRaio + (b.pergunta && typeof b.pergunta.raio === 'number' ? b.pergunta.raio : 0);
            if (padrao.velocidade * passoLoop > alcance) {
              erros.push(`${cp}.velocidade: ${padrao.velocidade} px/s anda mais que ${alcance}px por quadro — a pergunta atravessaria o jogador`);
            }
          }
          if (nome === 'investida' && padrao.velocidade * passoLoop > jogadorRaio + (typeof b.raio === 'number' ? b.raio : 0)) {
            erros.push(`${cp}.velocidade: ${padrao.velocidade} px/s anda mais que o contato por quadro — a Banca atravessaria o jogador`);
          }
          if (nome === 'horda' && !idsDeInimigo.has(padrao.tipo)) {
            erros.push(`${cp}.tipo: "${padrao.tipo}" nao e um id em inimigos`);
          }
        }
      });
      if (anterior !== 0) erros.push(`banca.fases: a ultima fase precisa de ate 0 (tem ${anterior}) — senao a Banca nunca cai`);
      const cores = conteudo.visual && conteudo.visual.banca && conteudo.visual.banca.corAura;
      if (!Array.isArray(cores) || cores.length < b.fases.length) {
        erros.push(`visual.banca.corAura: precisa de uma cor por fase da Banca (${b.fases.length})`);
      }
    }
  }

  // Nota e faixas de conceito.
  if (exigeObjeto(conteudo.nota, 'nota')) {
    exigeNumero(conteudo.nota.pesoKill, 'nota.pesoKill', { min: 0 });
    exigeNumero(conteudo.nota.pesoHp, 'nota.pesoHp', { min: 0 });
    exigeNumero(conteudo.nota.bonusIleso, 'nota.bonusIleso', { min: 0 });
    exigeNumero(conteudo.nota.maxima, 'nota.maxima', { min: 1 });
    exigeNumero(conteudo.nota.creditosBase, 'nota.creditosBase', { min: 0 });
    if (exigeNumero(conteudo.nota.casasDecimais, 'nota.casasDecimais', { min: 0, max: 3 })) {
      if (!Number.isInteger(conteudo.nota.casasDecimais)) {
        erros.push(`nota.casasDecimais: ${conteudo.nota.casasDecimais} precisa ser inteiro`);
      }
    }
    if (!Array.isArray(conteudo.nota.faixas) || conteudo.nota.faixas.length === 0) {
      erros.push('nota.faixas: esperava um array nao vazio');
    } else {
      let anterior = Infinity;
      const conceitosVistos = new Set();
      conteudo.nota.faixas.forEach((faixa, i) => {
        const c = `nota.faixas[${i}]`;
        if (!exigeObjeto(faixa, c)) return;
        if (typeof faixa.conceito !== 'string' || faixa.conceito === '') {
          erros.push(`${c}: conceito ausente ou vazio`);
        } else if (conceitosVistos.has(faixa.conceito)) {
          // Dois "B" com minimos diferentes: a tela de resultado mostraria o
          // mesmo conceito com creditos diferentes e ninguem entenderia.
          erros.push(`${c}: conceito duplicado "${faixa.conceito}"`);
        } else {
          conceitosVistos.add(faixa.conceito);
        }
        if (exigeNumero(faixa.minimo, `${c}.minimo`, { min: 0 })) {
          if (faixa.minimo >= anterior) {
            erros.push(`${c}: faixas devem estar em ordem decrescente de minimo`);
          }
          anterior = faixa.minimo;
        }
        exigeNumero(faixa.creditosFator, `${c}.creditosFator`, { min: 0 });
        if (exigeNumero(faixa.itensLoja, `${c}.itensLoja`, { min: 1, max: 8 }) && !Number.isInteger(faixa.itensLoja)) {
          erros.push(`${c}.itensLoja: ${faixa.itensLoja} precisa ser inteiro`);
        }
        if (exigeNumero(faixa.rerollsGratis, `${c}.rerollsGratis`, { min: 0, max: 5 }) && !Number.isInteger(faixa.rerollsGratis)) {
          erros.push(`${c}.rerollsGratis: ${faixa.rerollsGratis} precisa ser inteiro`);
        }
      });
      const ultima = conteudo.nota.faixas[conteudo.nota.faixas.length - 1];
      if (ultima && ultima.minimo !== 0) {
        erros.push('nota.faixas: a ultima faixa precisa ter minimo 0 para cobrir toda nota');
      }
      if (conteudo.nota.pesoKill === 0 && conteudo.nota.pesoHp === 0) {
        erros.push('nota: pesoKill e pesoHp zerados — toda avaliacao daria a mesma nota');
      }
      // A faixa mais exigente precisa ser alcancavel: com o teto de kills que
      // o grampo de `maxima` permite, o maximo teorico e HP cheio + ileso +
      // kills ate o grampo. Se nem isso chega no minimo da primeira faixa, o
      // conceito A e decoracao — e so o check pode perceber, porque na tela
      // ele simplesmente nunca aparece.
      const primeira = conteudo.nota.faixas[0];
      const tetoAlcancavel = conteudo.nota.maxima;
      if (primeira && typeof primeira.minimo === 'number' && primeira.minimo > tetoAlcancavel) {
        erros.push(
          `nota.faixas[0]: o conceito "${primeira.conceito}" pede ${primeira.minimo} e a nota e grampeada ` +
            `em ${tetoAlcancavel} — ele nunca sairia`
        );
      }
      // Sem kill nenhum e com HP cheio (o jogador que se esconde no canto os
      // 60s inteiros) a nota nao pode ja cair na faixa de cima: e o criterio
      // de aceite "sobreviver parado no canto nao deveria funcionar".
      const notaDoCovarde = conteudo.nota.pesoHp + conteudo.nota.bonusIleso;
      if (primeira && typeof primeira.minimo === 'number' && notaDoCovarde >= primeira.minimo) {
        erros.push(
          `nota: HP cheio + ileso somam ${notaDoCovarde} e a melhor faixa pede ${primeira.minimo} — ` +
            'quem se esconder no canto sem matar nada tira o conceito maximo'
        );
      }
    }
  }

  // Coringas e loja. Se o `efeito` existe em jokers.js e os `params` que ele
  // pede, quem confere e test/check.mjs (content.js nao importa logica).
  const RARIDADES = ['barato', 'medio', 'caro'];
  if (Array.isArray(conteudo.coringas)) {
    const idsCoringa = new Set();
    conteudo.coringas.forEach((coringa, i) => {
      const c = `coringas[${i}]`;
      if (typeof coringa !== 'object' || coringa === null) return;
      if (idsCoringa.has(coringa.id)) erros.push(`${c}: id "${coringa.id}" repetido`);
      idsCoringa.add(coringa.id);
      if (exigeNumero(coringa.preco, `${c}.preco`, { min: 1 }) && !Number.isInteger(coringa.preco)) {
        erros.push(`${c}.preco: ${coringa.preco} precisa ser inteiro`);
      }
      for (const campo of ['id', 'nome', 'emoji', 'descricao', 'efeito']) {
        if (typeof coringa[campo] !== 'string' || coringa[campo] === '') erros.push(`${c}.${campo}: ausente ou vazio`);
      }
      if (!RARIDADES.includes(coringa.raridade)) {
        erros.push(`${c}.raridade: "${coringa.raridade}" nao e uma de ${RARIDADES.join(', ')}`);
      }
      exigeObjeto(coringa.params, `${c}.params`);
    });

    // Tarefa 5 da fase 07: guardar dinheiro e jogada valida. O coringa caro
    // tem que custar mais que o MELHOR boletim paga, senao comprar na hora
    // sempre ganha de guardar. E o barato tem que caber num boletim medio
    // (fator 1), senao a primeira loja da run nao vende nada.
    const nota = conteudo.nota;
    if (nota && Array.isArray(nota.faixas) && typeof nota.creditosBase === 'number') {
      const pagamentos = nota.faixas
        .filter((f) => f && typeof f.creditosFator === 'number')
        .map((f) => Math.round(nota.creditosBase * f.creditosFator));
      const melhor = pagamentos.length > 0 ? Math.max(...pagamentos) : 0;
      for (const coringa of conteudo.coringas) {
        if (!coringa || typeof coringa.preco !== 'number') continue;
        if (coringa.raridade === 'caro' && coringa.preco <= melhor) {
          erros.push(
            `coringas "${coringa.id}": caro por ${coringa.preco} e o melhor boletim paga ${melhor} — ` +
              'comprar na hora sempre ganharia de guardar dinheiro'
          );
        }
        if (coringa.raridade === 'barato' && coringa.preco > nota.creditosBase) {
          erros.push(
            `coringas "${coringa.id}": barato por ${coringa.preco} nao cabe num boletim D (${nota.creditosBase})`
          );
        }
      }
    }
  }

  if (exigeObjeto(conteudo.loja, 'loja')) {
    const l = conteudo.loja;
    if (exigeNumero(l.teto, 'loja.teto', { min: 1, max: 10 }) && !Number.isInteger(l.teto)) {
      erros.push(`loja.teto: ${l.teto} precisa ser inteiro`);
    }
    exigeNumero(l.fracaoVenda, 'loja.fracaoVenda', { min: 0, max: 1 });
    exigeNumero(l.rerollBase, 'loja.rerollBase', { min: 0 });
    exigeNumero(l.rerollIncremento, 'loja.rerollIncremento', { min: 0 });
    exigeNumero(l.atrasoEntrada, 'loja.atrasoEntrada', { min: 0, max: 2 });
  }

  // Debug: so chaves booleanas. Um "false" em string ligaria a chave por ser
  // truthy, e a fase 15 acharia que desligou.
  if (exigeObjeto(conteudo.debug, 'debug')) {
    for (const [chave, valor] of Object.entries(conteudo.debug)) {
      if (typeof valor !== 'boolean') erros.push(`debug.${chave}: esperava true/false, veio ${JSON.stringify(valor)}`);
    }
  }

  // Instrumento do relatorio. Nada aqui mexe no jogo, mas um zero no lugar
  // errado vira divisao por zero no meio do relatorio — e o relatorio e o que
  // os agentes de balanceamento vao ler como fato.
  if (exigeObjeto(conteudo.relatorio, 'relatorio')) {
    const r = conteudo.relatorio;
    exigeNumero(r.amostraSegundos, 'relatorio.amostraSegundos', { min: 1 / 60 });
    if (exigeNumero(r.janelaTabela, 'relatorio.janelaTabela', { min: 1 / 60 })) {
      if (typeof r.amostraSegundos === 'number' && r.janelaTabela < r.amostraSegundos) {
        erros.push(
          `relatorio.janelaTabela: ${r.janelaTabela}s e menor que relatorio.amostraSegundos ` +
            `(${r.amostraSegundos}s) — a tabela teria janelas sem amostra nenhuma`
        );
      }
    }
    exigeNumero(r.raioPerto, 'relatorio.raioPerto', { min: 1 });
    exigeNumero(r.margemBorda, 'relatorio.margemBorda', { min: 0 });
    exigeNumero(r.margemCanto, 'relatorio.margemCanto', { min: 0 });
    exigeNumero(r.velocidadeParado, 'relatorio.velocidadeParado', { min: 0 });
    exigeNumero(r.marcosNivel, 'relatorio.marcosNivel', { min: 1 });
    exigeNumero(r.inicioSegundos, 'relatorio.inicioSegundos', { min: 1 });
    exigeNumero(r.janelaDano, 'relatorio.janelaDano', { min: 1 });
    for (const campo of ['gradeColunas', 'gradeLinhas', 'maxRegistros', 'historicoPartidas']) {
      const limites = campo.startsWith('grade') ? { min: 1, max: 32 } : { min: 1 };
      if (exigeNumero(r[campo], `relatorio.${campo}`, limites) && !Number.isInteger(r[campo])) {
        erros.push(`relatorio.${campo}: ${r[campo]} precisa ser inteiro`);
      }
    }
    if (exigeObjeto(r.alvos, 'relatorio.alvos')) {
      exigeNumero(r.alvos.nivel, 'relatorio.alvos.nivel', { min: 2 });
      exigeNumero(r.alvos.ate, 'relatorio.alvos.ate', { min: 1 });
    }
    if (exigeObjeto(r.alertas, 'relatorio.alertas')) {
      for (const campo of ['fracaoCanto', 'fracaoBorda', 'fracaoParado', 'participacaoArma', 'overkill', 'coletaXp']) {
        exigeNumero(r.alertas[campo], `relatorio.alertas.${campo}`, { min: 0, max: 1 });
      }
      exigeNumero(r.alertas.tempoMinimoArma, 'relatorio.alertas.tempoMinimoArma', { min: 0 });
      exigeNumero(r.alertas.fps, 'relatorio.alertas.fps', { min: 1 });
    }
  }

  // HUD.
  if (exigeObjeto(conteudo.hud, 'hud')) {
    const maiorDuracao = Array.isArray(conteudo.periodos)
      ? conteudo.periodos.reduce(
          (maior, p) =>
            (Array.isArray(p && p.avaliacoes) ? p.avaliacoes : []).reduce(
              (m, av) => (av && typeof av.duracao === 'number' && av.duracao > m ? av.duracao : m),
              maior
            ),
          0
        )
      : 0;
    // Urgencia que comeca antes da avaliacao inteira deixaria o cronometro
    // vermelho do primeiro segundo ao ultimo, e o alerta vira ruido.
    if (exigeNumero(conteudo.hud.timerUrgente, 'hud.timerUrgente', { min: 0 }) && maiorDuracao > 0) {
      if (conteudo.hud.timerUrgente >= maiorDuracao) {
        erros.push(
          `hud.timerUrgente: ${conteudo.hud.timerUrgente}s cobre a avaliacao mais longa inteira ` +
            `(${maiorDuracao}s) — o alerta ficaria ligado o tempo todo`
        );
      }
    }
  }

  // Textos que a UI monta com numeros. Faltar um deles nao quebra nada: sai
  // "undefined" na tela de resultado, que e pior.
  if (exigeObjeto(conteudo.textos, 'textos')) {
    if (exigeObjeto(conteudo.textos.resultado, 'textos.resultado')) {
      const campos = [
        'conceito', 'mortos', 'hp', 'ileso', 'feriu',
        'separador', 'creditos', 'simboloCredito', 'sobreviveu', 'de',
        'nivelJogador', 'nivelArma',
      ];
      for (const campo of campos) {
        if (typeof conteudo.textos.resultado[campo] !== 'string' || conteudo.textos.resultado[campo] === '') {
          erros.push(`textos.resultado.${campo}: ausente ou vazio`);
        }
      }
    }
    if (exigeObjeto(conteudo.textos.loja, 'textos.loja')) {
      const t = conteudo.textos.loja;
      for (const campo of ['rerolar', 'gratis', 'seguir', 'vendido', 'vazio', 'vender', 'gasto', 'semCoringa']) {
        if (typeof t[campo] !== 'string' || t[campo] === '') erros.push(`textos.loja.${campo}: ausente ou vazio`);
      }
      if (exigeObjeto(t.avisos, 'textos.loja.avisos')) {
        for (const campo of ['semCreditos', 'cheio', 'vendido', 'semNovidade']) {
          if (typeof t.avisos[campo] !== 'string' || t.avisos[campo] === '') {
            erros.push(`textos.loja.avisos.${campo}: ausente ou vazio`);
          }
        }
      }
    }
    if (exigeObjeto(conteudo.textos.anuncio, 'textos.anuncio')) {
      if (typeof conteudo.textos.anuncio.semModificador !== 'string' || conteudo.textos.anuncio.semModificador === '') {
        erros.push('textos.anuncio.semModificador: ausente ou vazio');
      }
    }
    // Fase 10: telas de fim e a Banca.
    const CAMPOS_DE_TEXTO = {
      banca: ['transicao', 'fase'],
      jubilado: ['onde', 'faltavaTempo', 'faltavaBanca', 'restamVarias', 'restaUma', 'soTcc', 'ultimaEtapa'],
      colacao: ['tcc', 'media', 'conceito', 'semCoringa', 'novoRecorde', 'recorde'],
      recorde: ['menu'],
    };
    for (const [grupo, campos] of Object.entries(CAMPOS_DE_TEXTO)) {
      if (!exigeObjeto(conteudo.textos[grupo], `textos.${grupo}`)) continue;
      for (const campo of campos) exigeTexto(conteudo.textos[grupo][campo], `textos.${grupo}.${campo}`);
    }
    if (exigeObjeto(conteudo.textos.relatorio, 'textos.relatorio')) {
      for (const campo of ['baixado', 'copiado', 'semCopia', 'vazio']) {
        if (typeof conteudo.textos.relatorio[campo] !== 'string' || conteudo.textos.relatorio[campo] === '') {
          erros.push(`textos.relatorio.${campo}: ausente ou vazio`);
        }
      }
    }
  }

  return { erros, avisos };
}
