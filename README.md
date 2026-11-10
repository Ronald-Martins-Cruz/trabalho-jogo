# [▶ Jogar Semana de Provas no navegador](https://ronald-martins-cruz.github.io/trabalho-jogo/) — https://ronald-martins-cruz.github.io/trabalho-jogo/

> **Sem internet ou sem o link?** Abra o **`jogar-sem-servidor.html`** (vem no zip
> da entrega, ao lado deste README) **com dois cliques, no Chrome ou no Edge.** É o
> jogo inteiro num arquivo só e roda direto do disco, sem instalar nada.

![A arena: uma página de caderno com as figurinhas dos inimigos em volta do jogador](docs/prints/1-arena.jpg)

![A carta de nível: três post-its para escolher](docs/prints/2-carta.jpg)

## O que é

**Semana de Provas** é um *survivor* (o jogador anda, as armas atiram sozinhas,
os inimigos vêm em hordas) com a estrutura de um *roguelite* de cartas: você tem
**3 períodos para se formar**, e tudo acontece em cima de um caderno. Cada
período tem três avaliações de 60 a 85 segundos, e cada avaliação é uma partida
curta contra o que atrapalha um estudante: 📕 prazos de entrega, 🔔
notificações, 📄 PDFs de 300 páginas e 📱 trabalhos em grupo. Entre uma
avaliação e outra fica a **Loja do Centro Acadêmico**, onde a nota vira
créditos e os créditos viram **coringas** (🔋 Energético, 📚 Caderno
Emprestado, 📱 Grupo de WhatsApp, 🏥 Atestado Médico...) que valem pela
graduação inteira. No fim vem o **TCC**: A Banca, um chefe em duas fases. Se o HP zerar em qualquer
ponto, você é **jubilado** e começa do zero. Uma graduação inteira leva uns
14 minutos.

## Como jogar

- **WASD** ou **setas** para andar. As armas atacam sozinhas; sobreviva até o cronômetro zerar.
- Inimigos mortos deixam 💡 de XP. Ao subir de nível, escolha uma de três cartas (**1 · 2 · 3** ou setas e **Enter**): uma arma nova ou uma arma melhor.
- A nota da avaliação (mortes e o HP que você preservou nela) vira créditos. Na loja, **1 · 2 · 3** compram itens para a mochila e **R** rerrola; para seguir, leve o cursor com as setas até **Seguir →** e aperte **Enter**, ou clique nele (o Enter faz o que o cursor aponta, e a loja abre no 1º item).
- **A vida não enche sozinha entre as provas.** O que você perde numa avaliação continua perdido na seguinte. Na prova caem 🍪 biscoitos (cura pequena); a cura de verdade é a **cantina** da loja, que sempre tem um lanche (**L** compra; dá para comer de novo, cada vez mais caro).
- **Esc** pausa, **M** liga e desliga o som. Cartas, loja e botões também aceitam o mouse.
- Objetivo: passar pelos 3 períodos e vencer A Banca no TCC para colar grau.

![A loja do Centro Acadêmico, num mural de cortiça](docs/prints/3-loja.jpg)

## Por que não é cópia de nenhum jogo

O enunciado só proíbe uma coisa: o jogo ser cópia de outro. As duas
inspirações são declaradas, e o que vem delas é a forma, não o jogo:

- **Vampire Survivors** dá o combate: andar entre hordas com armas automáticas.
- **Balatro** dá o ritmo: rodadas curtas separadas por uma loja, com
  modificadores que valem a run inteira.

O que é próprio deste trabalho:

- **A estrutura de graduação.** A run não é uma partida longa de 30 minutos
  como num survivor: são 9 avaliações curtas, em 3 períodos, mais o TCC. O
  semestre é o "ante"; a Prova Final de cada período é o clímax dele.
- **Armas que zeram contra coringas que ficam.** As armas que você monta numa
  avaliação morrem com ela: cada prova recomeça só com o ☕ Café. O que
  atravessa a graduação são os coringas. A tática é de dentro da prova; a
  estratégia, da loja. É isso que liga 9 partidas numa run só.
- **A nota como economia.** Sobreviver já aprova; jogar bem (matar muito,
  perder pouco HP) dá conceito melhor, que paga mais créditos e abre mais
  itens na loja. Dois estilos (caçar ou se preservar) chegam a notas parecidas.
  E o crédito disputa com a vida: como o HP não enche sozinho, cada visita à
  loja é escolher entre um item novo e o lanche da cantina. Há itens só de
  economia (🐷 Cofrinho rende juros, 💼 Bolsa de IC paga por prova, 🎟️
  Carteirinha dá desconto).
- **Avaliações com modificadores** que mudam as regras da prova: Aula das 7h,
  Sala Lotada (a arena encolhe), Prova sem Consulta (os coringas param),
  Professor Rígido, Sexta às 18h, Controle de Frequência.
- **A Banca**, o chefe do TCC, em duas fases (Arguição e Réplica), com
  perguntas em leque, investida e horda.
- **O tema e o visual.** A vida acadêmica brasileira (jubilar, colar grau,
  Centro Acadêmico, Grupo de WhatsApp) desenhada como **um caderno na mesa do
  estudante**: a arena é uma página pautada, que amarela do 1º ao 3º período
  e vira papel timbrado no TCC; os inimigos são figurinhas coladas nela; as
  armas riscam a página como caneta, lápis e marca-texto; as telas são folhas
  de prova, post-its, carimbos e o mural do Centro Acadêmico.

![O TCC: A Banca, numa folha timbrada](docs/prints/4-banca.jpg)

## Decisões técnicas

- **JavaScript puro (vanilla), sem nenhuma dependência.** Nada de framework,
  biblioteca, CDN ou `npm install` para jogar: o navegador abre os arquivos do
  repositório e pronto.
- **Zero arquivo de imagem, som ou fonte.** Os personagens são **emoji**,
  transformados em **figurinhas** em tempo de execução (contorno branco
  recortado, sombra e brilho, desenhados uma vez e guardados). Tudo o mais, a
  página, a pauta, as manchas de café, os post-its, os carimbos, é desenhado
  com **Canvas 2D** e **CSS**. O som é **sintetizado na hora** pela Web Audio API.
- **Dirigido por dados.** Todo número de jogo (armas, coringas, inimigos,
  modificadores, períodos, durações, cores, textos) mora em
  [`data/content.js`](data/content.js); a lógica não tem número escrito.
- **Simulação separada do desenho**, com passo fixo e aleatoriedade com
  semente: a partida inteira roda no Node sem navegador, e é assim que os
  testes jogam centenas de partidas. `npm run check`, `smoke`, `dom`, `fuzz` e
  `sim` (Node, sem instalar nada) conferem as regras, a fiação da página e o
  balanceamento; `npm run fotos` fotografa cada tela num Chrome (Node 22 ou
  mais novo).

## Como rodar localmente

O `index.html` usa *ES modules*, e o navegador **não carrega módulos por
`file://`**: dar dois cliques no `index.html` só mostra um aviso pedindo
servidor. Três jeitos de jogar fora do link:

1. **Sem nada instalado:** dois cliques no `jogar-sem-servidor.html` (só no zip
   da entrega; o `npm run zip` o gera). Chrome ou Edge.
2. **Com Node:** `npm run serve` na pasta do projeto e abra o endereço que ele
   mostrar (normalmente http://localhost:8080). Não precisa de `npm install`.
3. **Com o VS Code:** a extensão **Live Server**, botão *Go Live*, com o
   `index.html` aberto.

**Fonte de emoji:** o jogo usa a fonte de emoji do sistema. Windows 10/11,
macOS, Android e ChromeOS já têm; no Linux, instale `fonts-noto-color-emoji`
(Debian/Ubuntu) ou `google-noto-emoji-color-fonts` (Fedora).

## Créditos e licença

Feito por **Ronald Martins Cruz** como Trabalho #2 de Jogos Digitais (2026),
com desenvolvimento conduzido por agentes de IA fase a fase; o design, o plano
e o registro de cada fase estão em [`docs/`](docs/). Os emoji são os da fonte
do sistema de quem joga. Código sob a [licença MIT](LICENSE).
