import { CONTEUDO } from '../data/content.js';
import { criarRng } from './rng.js';

// Audio procedural. Le a fila de eventos do estado DEPOIS do passo de
// simulacao (main.js, no fim de cada quadro) e nunca e chamado de dentro de um
// update: e o que deixa o smoke rodar no node, onde nao ha Web Audio.
//
// Duas metades:
//   - o PLANO (criarLimitador, planejarSons): puro, sem Web Audio. Decide quais
//     sons da fila realmente tocam. Roda no node e e testado pelo smoke;
//   - o SINTETIZADOR (criarAudio): recebe uma fabrica de AudioContext, que so o
//     navegador tem, e transforma o plano em osciladores e ruido.

// ------------------------------------------------------------------- plano

// Duracao total de um som: o fim da ultima camada.
export function duracaoDoSom(som) {
  let fim = 0;
  for (const c of som.camadas) fim = Math.max(fim, c.inicio + c.duracao);
  return fim;
}

// O limitador de vozes. Tres regras, todas por tipo de som e todas em
// content.js (audio.sons[nome]):
//   1. maxPorQuadro: de N eventos do mesmo tipo no quadro, so os N primeiros
//      tocam. Matar 30 inimigos num quadro nao vira um estalo distorcido;
//   2. intervaloMin: dois disparos do mesmo tipo nao se aproximam mais que isso
//      no relogio do audio, nem entre quadros (a regra 1 sozinha deixaria 2
//      estalos por quadro, 120 por segundo);
//   3. maxVozesSimultaneas: com o teto de vozes vivas, o som comum e cortado.
//      O prioritario (nivel, dano, fanfarras, aviso) passa sempre.
// A regra 1 olha o que o consumidor ve, nao o que aconteceu: se emitir() cortou
// a fila em 256, o limite continua valendo sobre o que sobrou (pendencia 35).
export function criarLimitador(cfg = CONTEUDO.audio) {
  return {
    cfg,
    ultimo: Object.create(null), // nome do som -> relogio do ultimo disparo
    fins: [], // quando cada voz viva termina (relogio do audio)
  };
}

// Devolve os nomes dos sons que tocam, na ordem da fila. `agora` e o relogio
// do audio (currentTime) e so avanca.
export function planejarSons(eventos, limitador, agora) {
  const { cfg } = limitador;
  const tocar = [];
  const noQuadro = Object.create(null);

  limitador.fins = limitador.fins.filter((fim) => fim > agora);

  for (let i = 0; i < eventos.length; i += 1) {
    const nome = cfg.eventos[eventos[i].tipo];
    if (nome === undefined) continue;
    const som = cfg.sons[nome];
    if ((noQuadro[nome] || 0) >= som.maxPorQuadro) continue;
    // O intervalo vale entre quadros: dentro do quadro quem manda e maxPorQuadro.
    const anterior = limitador.ultimo[nome];
    if (noQuadro[nome] === undefined && anterior !== undefined && agora - anterior < som.intervaloMin) continue;
    if (!som.prioritario && limitador.fins.length >= cfg.maxVozesSimultaneas) continue;

    noQuadro[nome] = (noQuadro[nome] || 0) + 1;
    limitador.ultimo[nome] = agora;
    limitador.fins.push(agora + duracaoDoSom(som));
    tocar.push(nome);
  }
  return tocar;
}

// ------------------------------------------------------------ sintetizador

// `criarContexto()` devolve um AudioContext (ou lanca, se o navegador nao tem).
// Nada de Web Audio e tocado antes de destravar(): o navegador so deixa criar o
// contexto depois de um gesto do usuario.
export function criarAudio({ criarContexto, mudoInicial = false, aoMudar = null, cfg = CONTEUDO.audio }) {
  let ctx = null;
  let mestre = null;
  let bufferRuido = null;
  let indisponivel = false;
  let mudo = !!mudoInicial;
  const limitador = criarLimitador(cfg);
  const tocados = Object.create(null);

  function volumeAlvo() {
    return mudo ? 0 : cfg.volumeGeral;
  }

  function aplicarVolume() {
    if (!mestre) return;
    const t = ctx.currentTime;
    mestre.gain.cancelScheduledValues(t);
    mestre.gain.setTargetAtTime(volumeAlvo(), t, cfg.rampaGeral);
  }

  function montar() {
    ctx = criarContexto();
    mestre = ctx.createGain();
    mestre.gain.value = volumeAlvo();
    // Rede de seguranca contra distorcao: se varias vozes somarem alto, o
    // compressor segura em vez de estourar.
    if (ctx.createDynamicsCompressor) {
      const compressor = ctx.createDynamicsCompressor();
      mestre.connect(compressor);
      compressor.connect(ctx.destination);
    } else {
      mestre.connect(ctx.destination);
    }
    // Ruido branco de um rng a parte: o audio nunca consome o da simulacao.
    const rng = criarRng(cfg.sementeRuido);
    const n = Math.max(1, Math.floor(ctx.sampleRate * cfg.duracaoBufferRuido));
    bufferRuido = ctx.createBuffer(1, n, ctx.sampleRate);
    const dados = bufferRuido.getChannelData(0);
    for (let i = 0; i < n; i += 1) dados[i] = rng.range(-1, 1);
  }

  // Chamado em todo gesto (clique, tecla): cria o contexto na primeira vez e
  // acorda um contexto `suspended` nas seguintes. Nunca lanca.
  function destravar() {
    if (indisponivel) return false;
    try {
      if (!ctx) montar();
      if (ctx.state === 'suspended' && ctx.resume) {
        const promessa = ctx.resume();
        if (promessa && promessa.catch) promessa.catch(() => {});
      }
      return true;
    } catch {
      ctx = null;
      mestre = null;
      indisponivel = true; // sem Web Audio: o jogo segue mudo
      return false;
    }
  }

  function camada(c, t0) {
    const fim = t0 + c.inicio + c.duracao;
    const ini = t0 + c.inicio;
    let fonte;
    if (c.onda === 'ruido') {
      fonte = ctx.createBufferSource();
      fonte.buffer = bufferRuido;
      fonte.loop = c.duracao > cfg.duracaoBufferRuido;
    } else {
      fonte = ctx.createOscillator();
      fonte.type = c.onda;
      fonte.frequency.setValueAtTime(c.freq, ini);
      if (c.freqFim !== undefined) fonte.frequency.exponentialRampToValueAtTime(c.freqFim, fim);
    }
    const ganho = ctx.createGain();
    ganho.gain.setValueAtTime(0.0001, ini);
    ganho.gain.linearRampToValueAtTime(c.volume, ini + c.ataque);
    ganho.gain.exponentialRampToValueAtTime(0.0001, fim);

    let saida = fonte;
    if (c.filtro) {
      const filtro = ctx.createBiquadFilter();
      filtro.type = c.filtro.tipo;
      filtro.frequency.value = c.filtro.freq;
      fonte.connect(filtro);
      saida = filtro;
    }
    saida.connect(ganho);
    ganho.connect(mestre);
    fonte.start(ini);
    fonte.stop(fim + 0.02);
  }

  function tocar(nome) {
    const t0 = ctx.currentTime;
    for (const c of cfg.sons[nome].camadas) camada(c, t0);
    tocados[nome] = (tocados[nome] || 0) + 1;
  }

  // A fila inteira do quadro. Chamado por main.js antes de esvaziar `eventos`.
  // Mudo, sem contexto ou suspenso: ignora, e o limitador nao anda.
  function consumir(eventos) {
    if (mudo || !ctx || ctx.state === 'suspended' || eventos.length === 0) return 0;
    const nomes = planejarSons(eventos, limitador, ctx.currentTime);
    for (const nome of nomes) tocar(nome);
    return nomes.length;
  }

  function definirMudo(valor) {
    mudo = !!valor;
    aplicarVolume();
    if (aoMudar) aoMudar(mudo);
    return mudo;
  }

  return {
    destravar,
    consumir,
    definirMudo,
    alternarMudo: () => definirMudo(!mudo),
    estaMudo: () => mudo,
    // Para o smoke: o que ja tocou, por nome, e se o contexto nasceu.
    diagnostico: () => ({ criado: ctx !== null, indisponivel, tocados: { ...tocados }, vozes: limitador.fins.length }),
  };
}
