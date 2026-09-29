import { CONTEUDO } from '../data/content.js';
import { maxItensLoja, TELAS } from './state.js';
import { coringasDesligados, dadosDoCoringa } from './jokers.js';
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
    loja: doc.getElementById('loja'),
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
    botaoTcc: doc.getElementById('botao-tcc'),
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

  function sincronizarLoja(estado) {
    const loja = estado.loja;
    const run = estado.run;
    const t = CONTEUDO.textos.loja;
    const simbolo = CONTEUDO.textos.resultado.simboloCredito;
    const naVitrine = loja.linha === LINHA_VITRINE;

    texto(el.lojaCreditos, `${simbolo} ${run.creditos}`);
    texto(el.lojaContagem, `${run.coringas.length}/${CONTEUDO.loja.teto}`);
    texto(el.lojaAviso, loja.aviso ? t.avisos[loja.aviso] || '' : '');

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

  function ligarBotoes({ jogar, continuar, menu, resultado, jubilado, comecar, tcc }) {
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
    texto(el.jubiladoResumo, resumoDoJubilado(estado.run.resultado));
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
    if (naCarta) sincronizarCartas(estado);
    if (naLoja) sincronizarLoja(estado);
    if (noAnuncio) sincronizarAnuncio(estado);
    if (noResultado) sincronizarResultado(estado);
    if (noJubilado) sincronizarJubilado(estado);
    sincronizarRelatorio(estado);

    const p = estado.player;
    largura(el.hpBarra, p.hpMax > 0 ? p.hp / p.hpMax : 0);
    texto(el.hpTexto, `${Math.ceil(p.hp)}/${p.hpMax}`);
    largura(el.xpBarra, p.xpProximo > 0 ? p.xp / p.xpProximo : 0);
    texto(el.nivel, String(p.nivel));
    texto(el.hudCoringas, emojisDosCoringas(estado.run.coringas));

    const av = estado.run.avaliacao;
    // A regra `coringas` 0 (Prova sem Consulta) esmaece os coringas no HUD:
    // o jogador ve que continuam dele, e que nao valem nesta prova.
    classe(el.hudCoringas, 'desligados', coringasDesligados(estado));
    texto(el.hudModificadores, emojisDosModificadores(av.modificadores));
    texto(el.timer, formatarTempo(av.restante));
    texto(el.avaliacaoNome, nomeDaAvaliacao(av));
    texto(el.periodoNome, av.periodo);
    // O unico aviso de "esta acabando" que existe sem ficar lendo o numero.
    // Sai do ESTADO (av.restante), como o realce da carta sai de
    // cartas.selecionada — nada de classe pintada por evento.
    classe(el.timer, 'urgente', emJogo && !av.concluida && av.restante <= CONTEUDO.hud.timerUrgente);
    // Com o mundo congelado (pausa, carta) o pulso do timer congela junto.
    classe(el.timer, 'parado', estado.tela !== TELAS.AVALIACAO);
  }

  return { ligarBotoes, ligarCartas, ligarLoja, ligarRelatorio, sincronizar, el };
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
export function resumoDoJubilado(resultado, textos = CONTEUDO.textos.resultado) {
  const partes = [
    `${resultado.kills} ${textos.mortos}`,
    `${textos.sobreviveu} ${formatarTempo(resultado.tempo)} ${textos.de} ${formatarTempo(resultado.duracao)}`,
  ];
  return partes.join(textos.separador);
}

// "Nível 7 · ☕ Café nv3 · ✏️ Caneta Bic nv2". Ferramenta de desenvolvimento
// (debug.boletimArmas): com a chave desligada devolve '' e a tela esconde a
// linha. Le as armas do jogador, que so sao zeradas quando a proxima
// avaliacao comeca — no boletim ainda sao as da partida que acabou.
export function armasDoBoletim(resultado, armas, textos = CONTEUDO.textos.resultado, debug = CONTEUDO.debug) {
  if (!debug || debug.boletimArmas !== true) return '';
  const partes = [`${textos.nivelJogador} ${resultado.nivel}`];
  for (const arma of armas) {
    const dados = CONTEUDO.armas.find((a) => a.id === arma.id);
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

// "🪑 🕕": os modificadores da avaliacao, no HUD.
export function emojisDosModificadores(ids, lista = CONTEUDO.modificadores) {
  const partes = [];
  for (const id of ids) {
    const dados = dadosDoModificador(id, lista);
    if (dados) partes.push(dados.emoji);
  }
  return partes.join(' ');
}

// "🔋 📚 🏥": os coringas da run, no canto do HUD.
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

export function formatarTempo(segundos) {
  const total = Math.max(0, Math.ceil(segundos));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
