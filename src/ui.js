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
    botaoJogar: doc.getElementById('botao-jogar'),
    botaoContinuar: doc.getElementById('botao-continuar'),
    botaoMenu: doc.getElementById('botao-menu'),
  };

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

  function ligarBotoes({ jogar, continuar, menu }) {
    if (el.botaoJogar && jogar) el.botaoJogar.addEventListener('click', jogar);
    if (el.botaoContinuar && continuar) el.botaoContinuar.addEventListener('click', continuar);
    if (el.botaoMenu && menu) el.botaoMenu.addEventListener('click', menu);
  }

  function sincronizar(estado) {
    const naCarta = estado.tela === TELAS.CARTA;
    const emJogo = estado.tela === TELAS.AVALIACAO || estado.tela === TELAS.PAUSA || naCarta;
    visivel(el.menu, estado.tela === TELAS.MENU);
    visivel(el.hud, emJogo);
    visivel(el.pausa, estado.tela === TELAS.PAUSA);
    visivel(el.carta, naCarta);
    if (naCarta) sincronizarCartas(estado);

    const p = estado.player;
    largura(el.hpBarra, p.hpMax > 0 ? p.hp / p.hpMax : 0);
    texto(el.hpTexto, `${Math.ceil(p.hp)}/${p.hpMax}`);
    largura(el.xpBarra, p.xpProximo > 0 ? p.xp / p.xpProximo : 0);
    texto(el.nivel, String(p.nivel));

    const av = estado.run.avaliacao;
    texto(el.timer, formatarTempo(av.restante));
    texto(el.avaliacaoNome, av.nome);
    texto(el.periodoNome, av.periodo);
  }

  return { ligarBotoes, ligarCartas, sincronizar, el };
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
