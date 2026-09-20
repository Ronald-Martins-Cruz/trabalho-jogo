// Todo sorteio do jogo passa por aqui. Math.random() nao aparece em lugar
// nenhum: com semente, uma partida e reproduzivel e o smoke test e estavel.

// mulberry32. O estado interno fica em `s`, um numero, para que o objeto de
// estado continue serializavel (as funcoes se recriam com criarRng(seed, s)).
export function criarRng(seed = 1, estadoInicial = null) {
  return {
    seed: seed >>> 0,
    s: (estadoInicial === null ? seed : estadoInicial) >>> 0,

    float() {
      this.s = (this.s + 0x6d2b79f5) >>> 0;
      let t = this.s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },

    // Inteiro no intervalo fechado [min, max].
    int(min, max) {
      return min + Math.floor(this.float() * (max - min + 1));
    },

    pick(lista) {
      if (!lista || lista.length === 0) return undefined;
      return lista[Math.floor(this.float() * lista.length)];
    },

    chance(p) {
      return this.float() < p;
    },

    // Float em [min, max).
    range(min, max) {
      return min + this.float() * (max - min);
    },
  };
}
