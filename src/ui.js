import { CONTEUDO } from '../data/content.js';
import { TELAS } from './state.js';

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

  function ligarBotoes({ jogar, continuar, menu, resultado, jubilado }) {
    if (el.botaoJogar && jogar) el.botaoJogar.addEventListener('click', jogar);
    if (el.botaoContinuar && continuar) el.botaoContinuar.addEventListener('click', continuar);
    if (el.botaoMenu && menu) el.botaoMenu.addEventListener('click', menu);
    if (el.botaoResultado && resultado) el.botaoResultado.addEventListener('click', resultado);
    if (el.botaoJubilado && jubilado) el.botaoJubilado.addEventListener('click', jubilado);
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
    texto(el.resultadoAvaliacao, r.nome);
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
    const emJogo = estado.tela === TELAS.AVALIACAO || estado.tela === TELAS.PAUSA || naCarta;
    visivel(el.menu, estado.tela === TELAS.MENU);
    visivel(el.hud, emJogo);
    visivel(el.pausa, estado.tela === TELAS.PAUSA);
    visivel(el.carta, naCarta);
    visivel(el.resultado, noResultado);
    visivel(el.jubilado, noJubilado);
    if (naCarta) sincronizarCartas(estado);
    if (noResultado) sincronizarResultado(estado);
    if (noJubilado) sincronizarJubilado(estado);
    sincronizarRelatorio(estado);

    const p = estado.player;
    largura(el.hpBarra, p.hpMax > 0 ? p.hp / p.hpMax : 0);
    texto(el.hpTexto, `${Math.ceil(p.hp)}/${p.hpMax}`);
    largura(el.xpBarra, p.xpProximo > 0 ? p.xp / p.xpProximo : 0);
    texto(el.nivel, String(p.nivel));

    const av = estado.run.avaliacao;
    texto(el.timer, formatarTempo(av.restante));
    texto(el.avaliacaoNome, av.nome);
    texto(el.periodoNome, av.periodo);
    // O unico aviso de "esta acabando" que existe sem ficar lendo o numero.
    // Sai do ESTADO (av.restante), como o realce da carta sai de
    // cartas.selecionada — nada de classe pintada por evento.
    classe(el.timer, 'urgente', emJogo && !av.concluida && av.restante <= CONTEUDO.hud.timerUrgente);
    // Com o mundo congelado (pausa, carta) o pulso do timer congela junto.
    classe(el.timer, 'parado', estado.tela !== TELAS.AVALIACAO);
  }

  return { ligarBotoes, ligarCartas, ligarRelatorio, sincronizar, el };
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
