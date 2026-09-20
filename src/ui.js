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

  function ligarBotoes({ jogar, continuar, menu }) {
    if (el.botaoJogar && jogar) el.botaoJogar.addEventListener('click', jogar);
    if (el.botaoContinuar && continuar) el.botaoContinuar.addEventListener('click', continuar);
    if (el.botaoMenu && menu) el.botaoMenu.addEventListener('click', menu);
  }

  function sincronizar(estado) {
    const emJogo = estado.tela === TELAS.AVALIACAO || estado.tela === TELAS.PAUSA;
    visivel(el.menu, estado.tela === TELAS.MENU);
    visivel(el.hud, emJogo);
    visivel(el.pausa, estado.tela === TELAS.PAUSA);

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

  return { ligarBotoes, sincronizar, el };
}

export function formatarTempo(segundos) {
  const total = Math.max(0, Math.ceil(segundos));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
