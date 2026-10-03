import { CONTEUDO } from '../data/content.js';
import { maxItensLoja, TELAS } from './state.js';
import { coringasDesligados, dadosDoCoringa } from './jokers.js';
import { ESTADOS_BANCA } from './boss.js';
import {
  LINHA_VITRINE,
  posicaoRerolar,
  posicaoSeguir,
  precoReroll,
  rerolarTrazNovidade,
  valorDeVenda,
} from './shop.js';

// Camadas de UI em DOM por cima do canvas. Le o estado e escreve no DOM,
// nunca o contrario. Todo texto visivel esta no index.html ou em content.js;
// aqui so entram numeros formatados.

export function criarUi(doc) {
  const el = {
    menu: doc.getElementById('menu'),
    hud: doc.getElementById('hud'),
    pausa: doc.getElementById('pausa'),
    hpBarra: doc.getElementById('hp-barra'),
    hpFantasma: doc.getElementById('hp-fantasma'),
    hpTexto: doc.getElementById('hp-texto'),
    xpBarra: doc.getElementById('xp-barra'),
    nivel: doc.getElementById('nivel'),
    timer: doc.getElementById('timer'),
    avaliacaoNome: doc.getElementById('avaliacao-nome'),
    periodoNome: doc.getElementById('periodo-nome'),
    carta: doc.getElementById('carta'),
    cartaOpcoes: doc.getElementById('carta-opcoes'),
    resultado: doc.getElementById('resultado'),
    resultadoPeriodo: doc.getElementById('resultado-periodo'),
    resultadoAvaliacao: doc.getElementById('resultado-avaliacao'),
    resultadoNota: doc.getElementById('resultado-nota'),
    resultadoConceito: doc.getElementById('resultado-conceito'),
    resultadoDecomposicao: doc.getElementById('resultado-decomposicao'),
    resultadoCreditos: doc.getElementById('resultado-creditos'),
    jubilado: doc.getElementById('jubilado'),
    jubiladoResumo: doc.getElementById('jubilado-resumo'),
    resultadoArmas: doc.getElementById('resultado-armas'),
    jubiladoArmas: doc.getElementById('jubilado-armas'),
    botaoJogar: doc.getElementById('botao-jogar'),
    botaoContinuar: doc.getElementById('botao-continuar'),
    botaoMenu: doc.getElementById('botao-menu'),
    botaoResultado: doc.getElementById('botao-resultado'),
    botaoJubilado: doc.getElementById('botao-jubilado'),
    hudCoringas: doc.getElementById('hud-coringas'),
    hudGrupoCoringas: doc.getElementById('hud-grupo-coringas'),
    hudGrupoModificadores: doc.getElementById('hud-grupo-modificadores'),
    loja: doc.getElementById('loja'),
    lojaDicaCompra: doc.getElementById('loja-dica-compra'),
    lojaCreditos: doc.getElementById('loja-creditos'),
    lojaItens: doc.getElementById('loja-itens'),
    lojaCoringas: doc.getElementById('loja-coringas'),
    lojaContagem: doc.getElementById('loja-contagem'),
    lojaAviso: doc.getElementById('loja-aviso'),
    botaoRerolar: doc.getElementById('botao-rerolar'),
    botaoSeguir: doc.getElementById('botao-seguir'),
    hudModificadores: doc.getElementById('hud-modificadores'),
    anuncio: doc.getElementById('anuncio'),
    anuncioNovoPeriodo: doc.getElementById('anuncio-novo-periodo'),
    anuncioPeriodo: doc.getElementById('anuncio-periodo'),
    anuncioMateria: doc.getElementById('anuncio-materia'),
    anuncioAvaliacao: doc.getElementById('anuncio-avaliacao'),
    anuncioDuracao: doc.getElementById('anuncio-duracao'),
    anuncioModificadores: doc.getElementById('anuncio-modificadores'),
    anuncioSemModificador: doc.getElementById('anuncio-sem-modificador'),
    botaoComecar: doc.getElementById('botao-comecar'),
    tcc: doc.getElementById('tcc'),
    tccDescricao: doc.getElementById('tcc-descricao'),
    botaoTcc: doc.getElementById('botao-tcc'),
    botaoMudo: doc.getElementById('botao-mudo'),
    // Fase 10: a barra da Banca no HUD, as telas de fim e o recorde no menu.
    bancaHud: doc.getElementById('banca-hud'),
    bancaNome: doc.getElementById('banca-nome'),
    bancaFase: doc.getElementById('banca-fase'),
    bancaBarra: doc.getElementById('banca-barra'),
    bancaMarcas: doc.getElementById('banca-marcas'),
    jubiladoOnde: doc.getElementById('jubilado-onde'),
    jubiladoFaltava: doc.getElementById('jubilado-faltava'),
    colacao: doc.getElementById('colacao'),
    colacaoTcc: doc.getElementById('colacao-tcc'),
    colacaoMedia: doc.getElementById('colacao-media'),
    colacaoConceito: doc.getElementById('colacao-conceito'),
    colacaoBoletins: doc.getElementById('colacao-boletins'),
    colacaoCoringas: doc.getElementById('colacao-coringas'),
    colacaoRecorde: doc.getElementById('colacao-recorde'),
    botaoColacao: doc.getElementById('botao-colacao'),
    menuRecorde: doc.getElementById('menu-recorde'),
  };

  // Barras de relatorio (debug.relatorio): uma em cada tela de fim e uma no
  // menu. Achadas por atributo, e nao por id, porque sao tres copias do mesmo
  // bloco. `data-relatorio-menu` so aparece quando ja existe partida gravada.
  const barrasRelatorio = doc.querySelectorAll ? Array.from(doc.querySelectorAll('[data-relatorio-barra]')) : [];
  const statusRelatorio = doc.querySelectorAll ? Array.from(doc.querySelectorAll('[data-relatorio-status]')) : [];

  const cache = {};
  const texto = (no, valor) => {
    if (!no) return;
    if (cache[no.id] === valor) return;
    cache[no.id] = valor;
    no.textContent = valor;
  };
  const largura = (no, fracao) => {
    if (!no) return;
    const pct = `${Math.max(0, Math.min(1, fracao)) * 100}%`;
    if (cache[`${no.id}:w`] === pct) return;
    cache[`${no.id}:w`] = pct;
    no.style.width = pct;
  };
  const visivel = (no, mostrar) => {
    if (!no) return;
    no.classList.toggle('oculto', !mostrar);
  };
  const classe = (no, nome, ligada) => {
    if (!no) return;
    no.classList.toggle(nome, ligada);
  };

  // Fase 12: os tempos das transicoes moram em content.js (juice.css) e o CSS
  // so os le como variaveis. A apresentacao da Banca na tela do TCC sai dos
  // numeros de banca.fases, e e fixa: escrita uma vez.
  aplicarVariaveisCss(doc.documentElement);
  texto(el.tccDescricao, textoDaBancaNoTcc());

  // Recomeca a animacao de entrada (CSS, classe `entrando`) de um bloco que ja
  // esta na tela: tirar a classe, forcar o layout e devolver. Para a 2a carta
  // de uma fila e para o reroll da loja, que trocam o conteudo sem a tela
  // sumir e voltar.
  function reiniciarEntrada(no) {
    if (!no || !no.classList) return;
    no.classList.remove('entrando');
    void no.offsetWidth;
    no.classList.add('entrando');
  }

  // ------------------------------------------------------- chips do HUD
  // Coringas da run e modificadores da avaliacao, um chip por item, montados
  // uma vez (o teto de coringas da loja; o maior `modificadores` de
  // periodos) e so trocando de conteudo. O nome e a descricao ficam num
  // tooltip de CSS (:hover): e so leitura, nao move cursor nenhum nem decide
  // acao, entao nao precisa passar pelo estado (pendencia 26).
  function montarChips(container, quantos) {
    const chips = [];
    if (!container) return chips;
    for (let i = 0; i < quantos; i += 1) {
      const chip = span('hud-chip');
      const emoji = span('hud-chip-emoji');
      const dica = span('hud-tooltip');
      const nome = span('hud-tooltip-nome');
      const descricao = span('hud-tooltip-descricao');
      dica.append(nome, descricao);
      chip.append(emoji, dica);
      container.appendChild(chip);
      chips.push({ chip, emoji, nome, descricao, gasto: false });
    }
    return chips;
  }

  let maxModificadores = 0;
  for (const periodo of CONTEUDO.periodos) {
    for (const av of periodo.avaliacoes) if (av.modificadores > maxModificadores) maxModificadores = av.modificadores;
  }
  const chipsCoringas = montarChips(el.hudCoringas, CONTEUDO.loja.teto);
  const chipsModificadores = montarChips(el.hudModificadores, maxModificadores);

  // `dados(i, saida)` preenche `saida` ({ emoji, nome, descricao, gasto }) e a
  // devolve, ou devolve null. Devolve quantos chips ficaram visiveis.
  const CHIP = { emoji: '', nome: '', descricao: '', gasto: false };

  function sincronizarChips(chips, dados) {
    let visiveis = 0;
    for (let i = 0; i < chips.length; i += 1) {
      const c = chips[i];
      const d = dados(i, CHIP);
      visivel(c.chip, d !== null);
      if (d === null) continue;
      visiveis += 1;
      escrever(c.emoji, d.emoji);
      escrever(c.nome, d.nome);
      escrever(c.descricao, d.descricao);
      if (c.gasto !== d.gasto) {
        c.gasto = d.gasto;
        classe(c.chip, 'gasto', d.gasto);
      }
    }
    return visiveis;
  }

  // As opcoes da carta sao montadas UMA vez, na abertura, e depois so trocam
  // de texto. Nada de innerHTML a cada carta: o DOM fica estavel, os
  // escutadores de clique ficam presos ao indice e a animacao de hover nao
  // reinicia no meio. E o padrao que a loja (fase 07) copia.
  const opcoes = [];

  function montarOpcoes() {
    if (!el.cartaOpcoes || opcoes.length > 0) return;
    for (let i = 0; i < CONTEUDO.cartas.quantidade; i += 1) {
      const botao = doc.createElement('button');
      botao.type = 'button';
      botao.className = 'carta-opcao';

      const atalho = doc.createElement('span');
      atalho.className = 'carta-atalho';
      atalho.textContent = String(i + 1);

      const emoji = doc.createElement('span');
      emoji.className = 'carta-emoji';

      const nome = doc.createElement('span');
      nome.className = 'carta-nome';

      const nivel = doc.createElement('span');
      nivel.className = 'carta-nivel';

      const descricao = doc.createElement('span');
      descricao.className = 'carta-descricao';

      botao.append(atalho, emoji, nome, nivel, descricao);
      el.cartaOpcoes.appendChild(botao);
      opcoes.push({ botao, emoji, nome, nivel, descricao });
    }
  }

  montarOpcoes();

  // `aoApontar` move o cursor, `aoEscolher` confirma. Os dois escrevem no
  // ESTADO, nunca na classe CSS: `sincronizarCartas` roda todo frame e refaz
  // `.selecionada` a partir de `cartas.selecionada`, entao qualquer destaque
  // pintado aqui na mao seria desfeito em menos de 16ms — e o jogador levaria
  // a carta do cursor, nao a que ele estava apontando.
  function ligarCartas(aoEscolher, aoApontar) {
    opcoes.forEach((opcao, i) => {
      if (aoEscolher) {
        opcao.botao.addEventListener('click', () => {
          aoEscolher(i);
          // Sem isto o botao clicado continua com o foco do DOM; se a fila
          // abrir a carta seguinte, o anel de foco fica na opcao da carta
          // anterior enquanto o cursor ja voltou para a primeira.
          if (opcao.botao.blur) opcao.botao.blur();
        });
      }
      if (aoApontar) {
        opcao.botao.addEventListener('mouseenter', () => aoApontar(i));
        // Foco tambem aponta: quem chega na carta com Tab enxerga o mesmo
        // destaque de quem chega com a seta.
        opcao.botao.addEventListener('focus', () => aoApontar(i));
      }
    });
  }

  let versaoDesenhada = -1;

  function sincronizarCartas(estado) {
    const cartas = estado.cartas;
    const t = CONTEUDO.textos.cartas;

    if (versaoDesenhada !== cartas.versao) {
      versaoDesenhada = cartas.versao;
      // As cartas entram deslizando a cada sorteio novo, inclusive a 2a de
      // uma fila (a tela nao some entre as duas).
      reiniciarEntrada(el.cartaOpcoes);
      for (let i = 0; i < opcoes.length; i += 1) {
        const opcao = opcoes[i];
        const dados = cartas.opcoes[i];
        opcao.botao.classList.toggle('oculto', !dados || dados.tipo === '');
        if (!dados || dados.tipo === '') continue;
        opcao.emoji.textContent = dados.emoji;
        opcao.nome.textContent = dados.nome;
        opcao.descricao.textContent = dados.descricao;
        opcao.nivel.textContent = rotuloDeNivel(dados, t);
        opcao.botao.classList.toggle('carta-nova', dados.nivelAtual === 0 && dados.nivelProximo > 0);
      }
    }

    for (let i = 0; i < opcoes.length; i += 1) {
      opcoes[i].botao.classList.toggle('selecionada', i === cartas.selecionada);
    }
  }

  // ------------------------------------------------------------------ loja
  // Mesmo padrao das cartas: os botoes nascem UMA vez (o maior numero de
  // itens que uma loja pode ter e o teto de coringas), os escutadores ficam
  // presos ao indice, e o sincronizar de cada frame so troca texto e classe
  // a partir de estado.loja. O destaque sai de (loja.linha, loja.selecionada)
  // e de nada mais: o mouse escreve nesse cursor via apontarLoja (shop.js).
  // Um :hover proprio no CSS poria dois itens acesos ao mesmo tempo, e o
  // Enter compraria o do cursor (pendencia 26).
  const itensLoja = [];
  const slotsCoringa = [];

  // Nos gerados nao tem id, entao nao servem ao cache do texto(): o valor
  // escrito fica guardado no proprio no.
  const escrever = (no, valor) => {
    if (no.__valor === valor) return;
    no.__valor = valor;
    no.textContent = valor;
  };

  function span(classeCss) {
    const no = doc.createElement('span');
    no.className = classeCss;
    return no;
  }

  function montarLoja() {
    if (el.lojaItens && itensLoja.length === 0) {
      for (let i = 0; i < maxItensLoja(); i += 1) {
        const botao = doc.createElement('button');
        botao.type = 'button';
        botao.className = 'carta-opcao loja-item';
        const atalho = span('carta-atalho');
        atalho.textContent = String(i + 1);
        const emoji = span('carta-emoji');
        const nome = span('carta-nome');
        const preco = span('loja-preco');
        const descricao = span('carta-descricao');
        botao.append(atalho, emoji, nome, preco, descricao);
        el.lojaItens.appendChild(botao);
        itensLoja.push({ botao, emoji, nome, preco, descricao, raridade: '' });
      }
    }
    if (el.lojaCoringas && slotsCoringa.length === 0) {
      for (let i = 0; i < CONTEUDO.loja.teto; i += 1) {
        const botao = doc.createElement('button');
        botao.type = 'button';
        botao.className = 'loja-slot';
        const emoji = span('loja-slot-emoji');
        const nome = span('loja-slot-nome');
        const venda = span('loja-slot-venda');
        botao.append(emoji, nome, venda);
        el.lojaCoringas.appendChild(botao);
        slotsCoringa.push({ botao, emoji, nome, venda });
      }
    }
  }

  montarLoja();

  function soltarFoco(botao) {
    if (botao && botao.blur) botao.blur();
  }

  // `acoes`: { comprar(i), vender(i), apontarItem(i), apontarCoringa(i),
  // rerolar(), seguir(), apontarRerolar(), apontarSeguir() } — todas escrevem
  // no estado pelas funcoes de shop.js.
  function ligarLoja(acoes) {
    itensLoja.forEach((item, i) => {
      item.botao.addEventListener('click', () => {
        acoes.comprar(i);
        soltarFoco(item.botao);
      });
      item.botao.addEventListener('mouseenter', () => acoes.apontarItem(i));
      item.botao.addEventListener('focus', () => acoes.apontarItem(i));
    });
    slotsCoringa.forEach((slot, i) => {
      slot.botao.addEventListener('click', () => {
        acoes.vender(i);
        soltarFoco(slot.botao);
      });
      slot.botao.addEventListener('mouseenter', () => acoes.apontarCoringa(i));
      slot.botao.addEventListener('focus', () => acoes.apontarCoringa(i));
    });
    const ligarAcao = (botao, agir, apontar) => {
      if (!botao) return;
      botao.addEventListener('click', () => {
        agir();
        soltarFoco(botao);
      });
      botao.addEventListener('mouseenter', apontar);
      botao.addEventListener('focus', apontar);
    };
    ligarAcao(el.botaoRerolar, acoes.rerolar, acoes.apontarRerolar);
    ligarAcao(el.botaoSeguir, acoes.seguir, acoes.apontarSeguir);
  }

  let vitrineDesenhada = '';

  function sincronizarLoja(estado) {
    const loja = estado.loja;
    const run = estado.run;
    const t = CONTEUDO.textos.loja;
    const simbolo = CONTEUDO.textos.resultado.simboloCredito;
    const naVitrine = loja.linha === LINHA_VITRINE;

    texto(el.lojaCreditos, `${simbolo} ${run.creditos}`);
    texto(el.lojaContagem, `${run.coringas.length}/${CONTEUDO.loja.teto}`);
    texto(el.lojaAviso, loja.aviso ? t.avisos[loja.aviso] || '' : '');
    texto(el.lojaDicaCompra, dicaDaLoja(loja.quantidade));
    // Uma vitrine nova (abertura ou reroll) entra deslizando como as cartas.
    const vitrine = `${loja.abertaEm}:${loja.rerolls}:${loja.gratis}`;
    if (vitrine !== vitrineDesenhada) {
      vitrineDesenhada = vitrine;
      reiniciarEntrada(el.lojaItens);
    }

    for (let i = 0; i < itensLoja.length; i += 1) {
      const no = itensLoja[i];
      const item = loja.itens[i];
      const existe = i < loja.quantidade;
      visivel(no.botao, existe);
      if (!existe) continue;
      const dados = item.id ? dadosDoCoringa(item.id) : null;
      escrever(no.emoji, dados ? dados.emoji : '');
      escrever(no.nome, dados ? dados.nome : t.vazio);
      escrever(no.descricao, dados ? dados.descricao : '');
      escrever(no.preco, !dados ? '' : item.vendido ? t.vendido : `${simbolo} ${item.preco}`);
      classe(no.botao, 'vendido', !dados || item.vendido);
      classe(no.botao, 'sem-credito', Boolean(dados) && !item.vendido && run.creditos < item.preco);
      const raridade = dados ? `raridade-${dados.raridade}` : '';
      if (no.raridade !== raridade) {
        if (no.raridade) no.botao.classList.remove(no.raridade);
        if (raridade) no.botao.classList.add(raridade);
        no.raridade = raridade;
      }
      classe(no.botao, 'selecionada', naVitrine && loja.selecionada === i);
    }

    const reroll = precoReroll(loja);
    texto(el.botaoRerolar, rotuloDoReroll(reroll, t, simbolo));
    classe(el.botaoRerolar, 'selecionada', naVitrine && loja.selecionada === posicaoRerolar(loja));
    classe(el.botaoRerolar, 'sem-credito', run.creditos < reroll);
    classe(el.botaoRerolar, 'inativo', !rerolarTrazNovidade(estado));
    texto(el.botaoSeguir, t.seguir);
    classe(el.botaoSeguir, 'selecionada', naVitrine && loja.selecionada === posicaoSeguir(loja));

    for (let i = 0; i < slotsCoringa.length; i += 1) {
      const no = slotsCoringa[i];
      const inst = run.coringas[i];
      const dados = inst ? dadosDoCoringa(inst.id) : null;
      escrever(no.emoji, dados ? dados.emoji : '');
      escrever(no.nome, dados ? dados.nome : t.semCoringa);
      escrever(no.venda, dados ? rotuloDeVenda(inst, valorDeVenda(inst.id), t, simbolo) : '');
      classe(no.botao, 'vazio', !dados);
      classe(no.botao, 'gasto', Boolean(inst && inst.gasto));
      classe(no.botao, 'selecionada', !naVitrine && loja.selecionada === i);
    }
  }

  // --------------------------------------------------------------- anuncio
  // Mesmo padrao das cartas e da loja: um slot por modificador que uma
  // avaliacao pode sortear (o maior `modificadores` de CONTEUDO.periodos),
  // montados uma vez e so trocando de texto.
  const slotsModificador = [];

  function montarAnuncio() {
    if (!el.anuncioModificadores || slotsModificador.length > 0) return;
    let maximo = 0;
    for (const periodo of CONTEUDO.periodos) {
      for (const av of periodo.avaliacoes) if (av.modificadores > maximo) maximo = av.modificadores;
    }
    for (let i = 0; i < maximo; i += 1) {
      const caixa = doc.createElement('div');
      caixa.className = 'anuncio-modificador';
      const emoji = span('anuncio-mod-emoji');
      const nome = span('anuncio-mod-nome');
      const descricao = span('anuncio-mod-descricao');
      caixa.append(emoji, nome, descricao);
      el.anuncioModificadores.appendChild(caixa);
      slotsModificador.push({ caixa, emoji, nome, descricao });
    }
  }

  montarAnuncio();

  function sincronizarAnuncio(estado) {
    const prox = estado.run.proxima;
    const periodo = CONTEUDO.periodos[prox.periodoIndex];
    const dados = periodo ? periodo.avaliacoes[prox.avaliacaoIndex] : null;
    if (!dados) return;
    visivel(el.anuncioNovoPeriodo, prox.avaliacaoIndex === 0);
    texto(el.anuncioPeriodo, periodo.nome);
    texto(el.anuncioMateria, dados.materia);
    texto(el.anuncioAvaliacao, dados.nome);
    texto(el.anuncioDuracao, formatarTempo(dados.duracao));
    for (let i = 0; i < slotsModificador.length; i += 1) {
      const slot = slotsModificador[i];
      const mod = dadosDoModificador(prox.modificadores[i]);
      visivel(slot.caixa, Boolean(mod));
      if (!mod) continue;
      escrever(slot.emoji, mod.emoji);
      escrever(slot.nome, mod.nome);
      escrever(slot.descricao, mod.descricao);
    }
    const nenhum = prox.modificadores.length === 0;
    texto(el.anuncioSemModificador, nenhum ? CONTEUDO.textos.anuncio.semModificador : '');
    visivel(el.anuncioSemModificador, nenhum);
  }

  // ---------------------------------------------------------------- A Banca
  // A barra de HP no topo do HUD (design §10). As marcas de fase saem de
  // content.js (banca.fases[].ate), montadas uma vez: o jogador ve, antes de
  // chegar la, onde a Banca vai virar.
  function montarBanca() {
    if (!el.bancaMarcas || el.bancaMarcas.childElementCount > 0) return;
    const fases = CONTEUDO.banca.fases;
    for (let i = 0; i < fases.length - 1; i += 1) {
      const marca = doc.createElement('span');
      marca.className = 'banca-marca';
      marca.style.left = `${fases[i].ate * 100}%`;
      el.bancaMarcas.appendChild(marca);
    }
  }

  montarBanca();

  function sincronizarBanca(estado, emJogo) {
    const b = estado.run.avaliacao.banca;
    visivel(el.bancaHud, emJogo && b !== null);
    if (!b) return;
    const fases = CONTEUDO.banca.fases;
    const fase = fases[Math.min(b.fase, fases.length - 1)];
    texto(el.bancaNome, `${CONTEUDO.banca.emoji} ${CONTEUDO.banca.nome}`);
    texto(el.bancaFase, preencher(CONTEUDO.textos.banca.fase, { n: b.fase + 1, nome: fase.nome }));
    largura(el.bancaBarra, b.hpMax > 0 ? b.hp / b.hpMax : 0);
    for (let i = 0; i < fases.length; i += 1) classe(el.bancaHud, `fase-${i + 1}`, i === b.fase);
    classe(el.bancaHud, 'transicao', b.estado === ESTADOS_BANCA.TRANSICAO);
  }

  // --------------------------------------------------------------- colacao
  // O resumo da run: uma coluna por periodo, uma linha por avaliacao, todas
  // montadas uma vez a partir de CONTEUDO.periodos (a mesma ordem de
  // run.boletins) e so trocando de texto.
  const linhasBoletim = [];

  function montarColacao() {
    if (!el.colacaoBoletins || linhasBoletim.length > 0) return;
    for (const periodo of CONTEUDO.periodos) {
      const coluna = doc.createElement('div');
      coluna.className = 'colacao-periodo';
      const titulo = span('colacao-periodo-nome');
      titulo.textContent = periodo.nome;
      coluna.appendChild(titulo);
      for (const av of periodo.avaliacoes) {
        const linha = doc.createElement('div');
        linha.className = 'colacao-linha';
        const materia = span('colacao-materia');
        materia.textContent = av.materia;
        const nome = span('colacao-avaliacao');
        nome.textContent = av.nome;
        const nota = span('colacao-nota');
        const conceito = span('colacao-conceito-av');
        linha.append(materia, nome, nota, conceito);
        coluna.appendChild(linha);
        linhasBoletim.push({ linha, nota, conceito, letra: '' });
      }
      el.colacaoBoletins.appendChild(coluna);
    }
  }

  montarColacao();

  function sincronizarColacao(estado) {
    const run = estado.run;
    const c = run.colacao;
    const t = CONTEUDO.textos.colacao;
    texto(el.colacaoTcc, textoDoTcc(c));
    texto(el.colacaoMedia, formatarNota(c.media));
    texto(el.colacaoConceito, preencher(t.conceito, { conceito: c.conceito }));
    for (let i = 0; i < linhasBoletim.length; i += 1) {
      const no = linhasBoletim[i];
      const b = run.boletins[i];
      const feita = Boolean(b && b.feita);
      escrever(no.nota, feita ? formatarNota(b.nota) : '—');
      escrever(no.conceito, feita ? b.conceito : '');
      // A letra pinta a linha (conceito-A, conceito-F...): o olho acha a
      // pior prova da run sem ler os numeros.
      const letra = feita ? `conceito-${b.conceito}` : '';
      if (no.letra !== letra) {
        if (no.letra) no.linha.classList.remove(no.letra);
        if (letra) no.linha.classList.add(letra);
        no.letra = letra;
      }
    }
    texto(el.colacaoCoringas, run.coringas.length > 0 ? nomesDosCoringas(run.coringas) : t.semCoringa);
    texto(el.colacaoRecorde, textoDoRecorde(estado.recorde, c.novoRecorde));
    classe(el.colacaoRecorde, 'novo', c.novoRecorde);
  }

  function ligarBotoes({ jogar, continuar, menu, resultado, jubilado, comecar, tcc, colacao }) {
    if (el.botaoJogar && jogar) el.botaoJogar.addEventListener('click', jogar);
    if (el.botaoContinuar && continuar) el.botaoContinuar.addEventListener('click', continuar);
    if (el.botaoMenu && menu) el.botaoMenu.addEventListener('click', menu);
    if (el.botaoResultado && resultado) el.botaoResultado.addEventListener('click', resultado);
    if (el.botaoJubilado && jubilado) el.botaoJubilado.addEventListener('click', jubilado);
    // O foco sai do botao depois do clique: o Enter seguinte nao pode
    // "clicar" de novo num botao que ja nao esta na tela.
    const soltando = (botao, acao) => () => {
      acao();
      soltarFoco(botao);
    };
    if (el.botaoComecar && comecar) el.botaoComecar.addEventListener('click', soltando(el.botaoComecar, comecar));
    if (el.botaoTcc && tcc) el.botaoTcc.addEventListener('click', soltando(el.botaoTcc, tcc));
    if (el.botaoColacao && colacao) el.botaoColacao.addEventListener('click', soltando(el.botaoColacao, colacao));
  }

  // `gerar(escopo)` devolve { nome, texto } ou null (nada gravado ainda). O
  // arquivo e baixado E o texto vai para a area de transferencia: o destino
  // normal e colar no chat de um agente, e o arquivo fica de copia.
  function ligarRelatorio(gerar) {
    for (const barra of barrasRelatorio) {
      const status = barra.querySelector('[data-relatorio-status]');
      for (const botao of barra.querySelectorAll('[data-relatorio]')) {
        botao.addEventListener('click', () => {
          if (botao.blur) botao.blur();
          const t = CONTEUDO.textos.relatorio;
          const arquivo = gerar(botao.getAttribute('data-relatorio'));
          if (!arquivo) {
            escreverStatus(status, t.vazio);
            return;
          }
          // A copia sai primeiro, ainda dentro do gesto do clique: e ele que
          // autoriza a area de transferencia, e o download pode tirar o foco.
          const copia = copiarTexto(arquivo.texto);
          baixarArquivo(doc, arquivo.nome, arquivo.texto);
          escreverStatus(status, `${t.baixado} (${arquivo.nome})`);
          copia.then((copiou) => {
            escreverStatus(status, `${t.baixado} · ${copiou ? t.copiado : t.semCopia}`);
          });
        });
      }
    }
  }

  function escreverStatus(no, valor) {
    if (no) no.textContent = valor;
  }

  let telaDoStatus = null;

  function sincronizarRelatorio(estado) {
    const ligado = CONTEUDO.debug && CONTEUDO.debug.relatorio === true;
    const temPartida = Boolean(estado.telemetria && estado.telemetria.partidas.length > 0);
    for (const barra of barrasRelatorio) {
      const soComPartida = barra.hasAttribute('data-relatorio-menu');
      visivel(barra, ligado && (!soComPartida || temPartida));
    }
    // O aviso de "baixado" e da tela em que o botao foi apertado; na proxima
    // tela ele mentiria sobre um arquivo que nao e daquela avaliacao.
    if (telaDoStatus !== estado.tela) {
      telaDoStatus = estado.tela;
      for (const no of statusRelatorio) no.textContent = '';
    }
  }

  // As duas telas de fim de avaliacao. Nada e montado aqui: os nos existem
  // desde o index.html e so trocam de texto, como as cartas. O `texto()` ja
  // pula a escrita quando o valor nao mudou, entao redesenhar todo frame e de
  // graca e nao precisa de contador de versao.
  function sincronizarResultado(estado) {
    const r = estado.run.resultado;
    const t = CONTEUDO.textos.resultado;
    texto(el.resultadoPeriodo, r.periodo);
    texto(el.resultadoAvaliacao, nomeDaAvaliacao(r));
    texto(el.resultadoNota, formatarNota(r.nota));
    texto(el.resultadoConceito, `${t.conceito} ${r.conceito}`);
    texto(el.resultadoDecomposicao, decomposicaoDaNota(r));
    texto(el.resultadoCreditos, `${t.simboloCredito} ${r.creditos} ${t.creditos}`);
    sincronizarArmas(el.resultadoArmas, estado);
  }

  function sincronizarJubilado(estado) {
    const r = estado.run.resultado;
    texto(el.jubiladoOnde, textoOndeCaiu(r));
    texto(el.jubiladoFaltava, textoQuantoFaltava(r));
    texto(el.jubiladoResumo, resumoDoJubilado(r));
    sincronizarArmas(el.jubiladoArmas, estado);
  }

  // Linha de debug: vazia com a chave desligada, e vazia = oculta.
  function sincronizarArmas(no, estado) {
    const linha = armasDoBoletim(estado.run.resultado, estado.player.armas);
    texto(no, linha);
    visivel(no, linha !== '');
  }

  function sincronizar(estado) {
    const naCarta = estado.tela === TELAS.CARTA;
    const noResultado = estado.tela === TELAS.RESULTADO;
    const noJubilado = estado.tela === TELAS.JUBILADO;
    const naLoja = estado.tela === TELAS.LOJA;
    const noAnuncio = estado.tela === TELAS.ANUNCIO;
    const emJogo = estado.tela === TELAS.AVALIACAO || estado.tela === TELAS.PAUSA || naCarta;
    visivel(el.menu, estado.tela === TELAS.MENU);
    visivel(el.hud, emJogo);
    visivel(el.pausa, estado.tela === TELAS.PAUSA);
    visivel(el.carta, naCarta);
    visivel(el.resultado, noResultado);
    visivel(el.jubilado, noJubilado);
    visivel(el.loja, naLoja);
    visivel(el.anuncio, noAnuncio);
    visivel(el.tcc, estado.tela === TELAS.TCC);
    const naColacao = estado.tela === TELAS.COLACAO;
    visivel(el.colacao, naColacao);
    if (naCarta) sincronizarCartas(estado);
    if (naLoja) sincronizarLoja(estado);
    if (noAnuncio) sincronizarAnuncio(estado);
    if (noResultado) sincronizarResultado(estado);
    if (noJubilado) sincronizarJubilado(estado);
    if (naColacao) sincronizarColacao(estado);
    sincronizarBanca(estado, emJogo);
    // O recorde no menu, so depois da primeira formatura.
    const textoRecorde = estado.recorde.formaturas > 0 ? textoDoRecordeNoMenu(estado.recorde) : '';
    texto(el.menuRecorde, textoRecorde);
    visivel(el.menuRecorde, textoRecorde !== '');
    sincronizarRelatorio(estado);

    const p = estado.player;
    const hp = p.hpMax > 0 ? p.hp / p.hpMax : 0;
    // As duas com a mesma largura: o CSS da a barra uma transicao curta e ao
    // fantasma uma longa e atrasada (juice.css), e o pedaco perdido aparece
    // entre as duas.
    largura(el.hpBarra, hp);
    largura(el.hpFantasma, hp);
    texto(el.hpTexto, `${Math.ceil(p.hp)}/${p.hpMax}`);
    largura(el.xpBarra, p.xpProximo > 0 ? p.xp / p.xpProximo : 0);
    texto(el.nivel, String(p.nivel));

    const av = estado.run.avaliacao;
    const run = estado.run;
    classe(el.hud, 'translucido', emJogo && hudCobreAlguem(estado));
    const comCoringa = sincronizarChips(chipsCoringas, (i, saida) => chipDoCoringa(run.coringas[i], saida));
    visivel(el.hudGrupoCoringas, comCoringa > 0);
    // A regra `coringas` 0 (Prova sem Consulta) esmaece os coringas no HUD:
    // o jogador ve que continuam dele, e que nao valem nesta prova.
    classe(el.hudCoringas, 'desligados', coringasDesligados(estado));
    const comModificador = sincronizarChips(chipsModificadores, (i, saida) => chipDoModificador(av.modificadores[i], saida));
    visivel(el.hudGrupoModificadores, comModificador > 0);
    // O TCC nao tem cronometro: o relogio conta a defesa para cima.
    texto(el.timer, formatarTempo(av.banca ? av.decorrido : av.restante));
    texto(el.avaliacaoNome, nomeDaAvaliacao(av));
    texto(el.periodoNome, av.periodo);
    // O unico aviso de "esta acabando" que existe sem ficar lendo o numero.
    // Sai do ESTADO (av.restante), como o realce da carta sai de
    // cartas.selecionada — nada de classe pintada por evento.
    classe(el.timer, 'urgente', emJogo && !av.concluida && !av.banca && av.restante <= CONTEUDO.hud.timerUrgente);
    // Com o mundo congelado (pausa, carta) o pulso do timer congela junto.
    classe(el.timer, 'parado', estado.tela !== TELAS.AVALIACAO);
  }

  // Botao de som: a UI so avisa do clique; quem muda e audio.js, via main.js. O
  // foco sai do botao, senao o Enter/Espaco seguinte o clicaria de novo.
  function ligarMudo(alternar) {
    if (!el.botaoMudo) return;
    el.botaoMudo.addEventListener('click', () => {
      alternar();
      soltarFoco(el.botaoMudo);
    });
  }

  function mostrarMudo(mudo) {
    if (!el.botaoMudo) return;
    const t = CONTEUDO.textos.audio;
    texto(el.botaoMudo, mudo ? t.mudo : t.ligado);
    const titulo = mudo ? t.tituloMudo : t.tituloLigado;
    el.botaoMudo.title = titulo;
    el.botaoMudo.setAttribute('aria-label', titulo);
    classe(el.botaoMudo, 'mudo', mudo);
  }

  return { ligarMudo, mostrarMudo, ligarBotoes, ligarCartas, ligarLoja, ligarRelatorio, sincronizar, el };
}

// ------------------------------------------------------ exportar relatorio

// Blob local + <a download>: nenhum servidor, nenhum recurso de fora.
function baixarArquivo(doc, nome, conteudo) {
  const blob = new Blob([conteudo], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = url;
  link.download = nome;
  link.style.display = 'none';
  doc.body.appendChild(link);
  link.click();
  link.remove();
  // Revogar na hora cancela o download em alguns navegadores.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// A API de area de transferencia so existe em contexto seguro (localhost e
// GitHub Pages sao). Falhar aqui nao e erro: o arquivo ja foi baixado.
function copiarTexto(conteudo) {
  const area = typeof navigator !== 'undefined' ? navigator.clipboard : null;
  if (!area || typeof area.writeText !== 'function') return Promise.resolve(false);
  return area.writeText(conteudo).then(
    () => true,
    () => false
  );
}

// ------------------------------------------------ formatacao do resultado
// Funcoes puras: recebem o resultado ja calculado por run.js e devolvem
// texto. Nenhuma conta de nota acontece aqui — a UI so formata o que a
// simulacao decidiu, e e por isso que o smoke consegue testa-las sem DOM.

// "8,4". Virgula porque o jogo esta em portugues; as casas vem de content.js
// (as mesmas que run.js usa para arredondar, senao a tela mostraria mais
// precisao do que a nota tem).
export function formatarNota(valor, casas = CONTEUDO.nota.casasDecimais) {
  const numero = Number.isFinite(valor) ? valor : 0;
  return numero.toFixed(Math.max(0, Math.floor(casas))).replace('.', ',');
}

// "47 mortos (+1,5) · 62% de HP (+2,5) · sem levar dano (+1,0)".
// A parcela perdida aparece como (+0,0) de proposito: e assim que o jogador
// descobre que o bonus de ileso existe.
export function decomposicaoDaNota(resultado, textos = CONTEUDO.textos.resultado) {
  const p = resultado.parcelas;
  const pct = Math.round(Math.max(0, Math.min(1, resultado.hpFracao)) * 100);
  const partes = [
    `${resultado.kills} ${textos.mortos} (+${formatarNota(p.kills)})`,
    `${pct}% ${textos.hp} (+${formatarNota(p.hp)})`,
    `${resultado.ileso ? textos.ileso : textos.feriu} (+${formatarNota(p.ileso)})`,
  ];
  return partes.join(textos.separador);
}

// "47 mortos · sobreviveu 0:42 de 1:00". Sem nota: jubilado nao tem boletim,
// tem o que deu tempo de fazer.
// Sem cronometro (o TCC), sem o "de 1:00": "12 mortos · sobreviveu 1:42".
export function resumoDoJubilado(resultado, textos = CONTEUDO.textos.resultado) {
  const de = resultado.duracao > 0 ? ` ${textos.de} ${formatarTempo(resultado.duracao)}` : '';
  const partes = [`${resultado.kills} ${textos.mortos}`, `${textos.sobreviveu} ${formatarTempo(resultado.tempo)}${de}`];
  return partes.join(textos.separador);
}

// "Nível 7 · ☕ Café nv3 · ✏️ Caneta Bic nv2". Ferramenta de desenvolvimento
// (debug.boletimArmas): com a chave desligada devolve '' e a tela esconde a
// linha. Le as armas do jogador, que so sao zeradas quando a proxima
// avaliacao comeca — no boletim ainda sao as da partida que acabou.
export function armasDoBoletim(resultado, armas, textos = CONTEUDO.textos.resultado, debug = CONTEUDO.debug, catalogo = CONTEUDO.armas) {
  if (!debug || debug.boletimArmas !== true) return '';
  const partes = [`${textos.nivelJogador} ${resultado.nivel}`];
  for (const arma of armas) {
    const dados = catalogo.find((a) => a.id === arma.id);
    const nome = dados ? `${dados.emoji} ${dados.nome}` : arma.id;
    partes.push(`${nome} ${textos.nivelArma}${arma.nivel}`);
  }
  return partes.join(textos.separador);
}

// "vender por ◉ 62", ou "já usado · vender por ◉ 62" para o Atestado gasto.
export function rotuloDeVenda(inst, valor, textos = CONTEUDO.textos.loja, simbolo = CONTEUDO.textos.resultado.simboloCredito) {
  const base = `${textos.vender} ${simbolo} ${valor}`;
  return inst.gasto ? `${textos.gasto}${CONTEUDO.textos.resultado.separador}${base}` : base;
}

// "Rerrolar ◉ 15", ou "Rerrolar grátis" enquanto houver reroll gratis (A).
export function rotuloDoReroll(preco, textos = CONTEUDO.textos.loja, simbolo = CONTEUDO.textos.resultado.simboloCredito) {
  return preco > 0 ? `${textos.rerolar} ${simbolo} ${preco}` : `${textos.rerolar} ${textos.gratis}`;
}

// "Cálculo I · Avaliação 1": a materia e o nome, para o HUD e o boletim (a
// avaliacao e o resultado tem os dois campos).
export function nomeDaAvaliacao(av, textos = CONTEUDO.textos.resultado) {
  return av.materia ? `${av.materia}${textos.separador}${av.nome}` : av.nome;
}

export function dadosDoModificador(id, lista = CONTEUDO.modificadores) {
  if (!id) return null;
  for (let i = 0; i < lista.length; i += 1) if (lista[i].id === id) return lista[i];
  return null;
}


// O chip do HUD de um coringa da run (instancia) ou de um modificador (id):
// preenche `saida` e a devolve, ou devolve null (slot vazio).
export function chipDoCoringa(inst, saida, lista = CONTEUDO.coringas) {
  const dados = inst ? dadosDoCoringa(inst.id, lista) : null;
  if (!dados) return null;
  saida.emoji = dados.emoji;
  saida.nome = dados.nome;
  saida.descricao = dados.descricao;
  saida.gasto = Boolean(inst.gasto);
  return saida;
}

export function chipDoModificador(id, saida, lista = CONTEUDO.modificadores) {
  const dados = dadosDoModificador(id, lista);
  if (!dados) return null;
  saida.emoji = dados.emoji;
  saida.nome = dados.nome;
  saida.descricao = dados.descricao;
  saida.gasto = false;
  return saida;
}

// O topo do HUD esta em cima de alguem? O jogador ou A Banca com a borda de
// cima do emoji na faixa juice.hud.faixaTopo (px do canvas). Pendencias 63/79:
// a arena nao muda, o HUD e que sai da frente.
export function hudCobreAlguem(estado, faixa = CONTEUDO.juice.hud.faixaTopo, v = CONTEUDO.visual) {
  const p = estado.player;
  if (p.vivo && p.y - v.tamanhoEmojiJogador / 2 < faixa) return true;
  const b = estado.run.avaliacao.banca;
  return b !== null && b.estado !== ESTADOS_BANCA.DERROTADA && b.y - v.banca.tamanhoEmoji / 2 < faixa;
}

// "1 · 2 · 3 compram": as teclas que valem NESTA loja (pendencia 57).
export function dicaDaLoja(quantidade, textos = CONTEUDO.textos.loja, separador = CONTEUDO.textos.resultado.separador) {
  const teclas = [];
  for (let i = 1; i <= quantidade; i += 1) teclas.push(String(i));
  return preencher(textos.dicaCompra, { teclas: teclas.join(separador) });
}

// A apresentacao da Banca na tela do TCC, com os numeros de banca.fases: o
// numero de rodadas e o HP (em %) em que ela endurece (pendencia 79).
export function textoDaBancaNoTcc(banca = CONTEUDO.banca, modelo = CONTEUDO.textos.banca.descricao) {
  return preencher(modelo, { fases: banca.fases.length, limiar: Math.round(banca.fases[0].ate * 100) });
}

// Escreve cada variavel de juice.css no :root (style.css so as le). Devolve
// quantas escreveu; sem `style` (node, DOM falso) nao faz nada.
export function aplicarVariaveisCss(raiz, css = CONTEUDO.juice.css) {
  if (!raiz || !raiz.style || typeof raiz.style.setProperty !== 'function') return 0;
  let n = 0;
  for (const nome of Object.keys(css)) {
    raiz.style.setProperty(nome, css[nome]);
    n += 1;
  }
  return n;
}

// "🔋 📚 🏥": os coringas da run, em linha (a tabela da run do smoke).
export function emojisDosCoringas(coringas, lista = CONTEUDO.coringas) {
  const partes = [];
  for (const inst of coringas) {
    const dados = dadosDoCoringa(inst.id, lista);
    if (dados) partes.push(dados.emoji);
  }
  return partes.join(' ');
}

// "Nv. 2 → 3" para quem ja tem a arma, "Nova arma" para quem nao tem, "+25 de
// HP" para o consolo. As palavras vem de content.js; aqui so entra o numero.
export function rotuloDeNivel(carta, textos) {
  if (carta.nivelProximo <= 0) return `+${carta.valor} ${textos.cura}`;
  if (carta.nivelAtual <= 0) return textos.novidade;
  return `${textos.nivel} ${carta.nivelAtual} ${textos.seta} ${carta.nivelProximo}`;
}

// ------------------------------------------------- telas de fim (fase 10)
// Puras, como as do boletim: o smoke as testa sem DOM.

// Troca cada {chave} do modelo (content.js) pelo valor. Chave sem valor fica
// como esta — aparece na tela e ninguem deixa passar.
export function preencher(modelo, valores) {
  return modelo.replace(/\{(\w+)\}/g, (inteiro, chave) => (chave in valores ? String(valores[chave]) : inteiro));
}

// "Caiu em Cálculo I · Avaliação 1 — 1º Período."
export function textoOndeCaiu(resultado, textos = CONTEUDO.textos.jubilado) {
  return preencher(textos.onde, { avaliacao: nomeDaAvaliacao(resultado), periodo: resultado.periodo });
}

// "Faltavam 0:18 para o fim da prova, e ainda 7 avaliações e o TCC até a
// formatura." No TCC: "A Banca ainda tinha 34% de HP — era a última etapa
// antes da formatura." E o "quanto faltava" do contrato: da prova, e da run.
export function textoQuantoFaltava(resultado, textos = CONTEUDO.textos.jubilado) {
  if (resultado.chefe) {
    const hp = Math.max(1, Math.ceil(Math.max(0, Math.min(1, resultado.bancaFracao)) * 100));
    return preencher(textos.faltavaBanca, { hp }) + textos.ultimaEtapa;
  }
  const tempo = formatarTempo(Math.max(0, resultado.duracao - resultado.tempo));
  let resto = textos.soTcc;
  if (resultado.restantes === 1) resto = textos.restaUma;
  else if (resultado.restantes > 1) resto = preencher(textos.restamVarias, { n: resultado.restantes });
  return preencher(textos.faltavaTempo, { tempo }) + resto;
}

// "TCC aprovado pela Banca em 1:42".
export function textoDoTcc(colacao, textos = CONTEUDO.textos.colacao) {
  return preencher(textos.tcc, { tempo: formatarTempo(colacao.tempoTcc) });
}

// A linha de recorde da colacao: o recorde acabou de ser batido, ou o que
// ja estava guardado.
export function textoDoRecorde(recorde, novo, textos = CONTEUDO.textos.colacao) {
  const valores = {
    conceito: recorde.melhorConceito,
    media: formatarNota(recorde.melhorMedia),
    formaturas: recorde.formaturas,
  };
  return preencher(novo ? textos.novoRecorde : textos.recorde, valores);
}

export function textoDoRecordeNoMenu(recorde, textos = CONTEUDO.textos.recorde) {
  return preencher(textos.menu, {
    formaturas: recorde.formaturas,
    conceito: recorde.melhorConceito,
    media: formatarNota(recorde.melhorMedia),
  });
}

// "🔋 Energético · 🏥 Atestado Médico": os coringas da formatura.
export function nomesDosCoringas(coringas, lista = CONTEUDO.coringas, separador = CONTEUDO.textos.resultado.separador) {
  const partes = [];
  for (const inst of coringas) {
    const dados = dadosDoCoringa(inst.id, lista);
    if (dados) partes.push(`${dados.emoji} ${dados.nome}`);
  }
  return partes.join(separador);
}

export function formatarTempo(segundos) {
  const total = Math.max(0, Math.ceil(segundos));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
