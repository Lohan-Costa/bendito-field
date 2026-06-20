# Field Cut Detector

## Objetivo

Desenvolver uma aplicação web estática hospedada no GitHub Pages para auxiliar editores a identificar possíveis erros de edição causados por cortes realizados entre fields em fluxos 29.97i (59.94 fields), especialmente em materiais exportados em XDCAM HD422 1080i59.94.

A ferramenta não tem como objetivo substituir um QC profissional nem garantir detecção perfeita. Seu propósito é fornecer uma camada rápida de validação antes da entrega do material para outros departamentos.

Todo processamento deverá ocorrer localmente no navegador do usuário.

---

# Problema

Em determinados fluxos de edição no Avid Media Composer, um corte pode ser realizado em uma posição que gera um frame híbrido:

* Upper Field → imagem A
* Lower Field → imagem B

Como o monitoramento normalmente exibe apenas o campo dominante (Upper Field), o problema pode passar despercebido durante a edição.

Posteriormente, durante reprodução, transcodificação ou desentrelaçamento, pode surgir:

* Flash de 1 frame
* "Rabo de vídeo"
* Frame híbrido
* Imagem que aparece por apenas um field

Exemplo:

```text
A
A
A
AB
C
C
C
```

O frame híbrido torna-se visível como um flash.

---

# Filosofia da Ferramenta

A ferramenta não deve depender exclusivamente da detecção automática.

O foco principal é:

1. Detectar cortes.
2. Destacar possíveis ocorrências.
3. Fornecer ferramentas visuais para inspeção rápida.
4. Permitir que o editor valide manualmente os casos suspeitos.

O valor principal do sistema é acelerar a revisão.

---

# Limitações Conhecidas

A ferramenta poderá gerar falsos positivos em:

* Esportes
* Câmeras com movimento rápido
* Whip pans
* Flashs
* Luzes estroboscópicas
* Explosões
* Mudanças bruscas de iluminação
* Conteúdo musical

A ferramenta poderá deixar passar alguns casos.

Uma mensagem visível na interface deverá informar:

> Esta ferramenta fornece auxílio de análise e pode gerar falsos positivos ou falsos negativos. Sempre valide visualmente ocorrências suspeitas.

---

# Requisitos Funcionais

## Upload

Suportar:

* MXF (XDCAM HD422)
* MOV
* MP4

Métodos:

* Drag and Drop
* Seleção de arquivo

---

## Processamento Local

Todo processamento deverá ocorrer:

* No navegador
* Sem upload
* Sem backend
* Sem banco de dados

Tecnologia:

* FFmpeg.wasm

---

# Estratégia de Análise

## Etapa 1 — Detecção de Cortes

Detectar mudanças de cena em todo o vídeo.

Resultado:

```text
53 cortes encontrados
```

Esses cortes serão utilizados como pontos de navegação e como regiões prioritárias de análise.

---

## Etapa 2 — Detecção de Frames Híbridos

Para cada região próxima aos cortes:

1. Separar os fields.
2. Comparar Upper e Lower.
3. Procurar diferenças significativas.

---

## Etapa 3 — Persistência Temporal

O algoritmo deverá verificar se o conteúdo presente em um field continua existindo nos frames seguintes.

Exemplo considerado normal:

```text
A
AB
B
B
B
```

Exemplo suspeito:

```text
A
AB
C
C
C
```

Neste caso, a imagem "B" aparece apenas durante um único field.

---

## Etapa 4 — Exclusão de Fades

O algoritmo deverá identificar:

* Fade In
* Fade Out
* Dip to Black
* Dissolves simples

Utilizando:

* Luminância média
* Histograma
* Progressão temporal

Regiões classificadas como fade devem reduzir ou eliminar alertas.

---

# Sistema de Confiança

Cada ocorrência recebe uma pontuação.

Exemplo:

| Critério                | Peso |
| ----------------------- | ---- |
| Upper ≠ Lower           | +40  |
| Conteúdo não persiste   | +30  |
| Não parece fade         | +20  |
| Diferença muito elevada | +10  |

Resultado:

```text
Confiança: 95%
```

Classificações:

* Alta
* Média
* Baixa

---

# Interface

## Layout Principal

```text
┌─────────────────────────────┐
│ Player                      │
└─────────────────────────────┘

Timeline

Filmstrip

Fields

Ocorrências
```

---

# Player

O player deverá oferecer:

* Play
* Pause
* Retroceder
* Avançar
* Próximo corte
* Corte anterior
* Frame +1
* Frame -1
* Field +1
* Field -1

---

# Navegação por Field

Embora navegadores trabalhem com frames, a aplicação deverá criar uma representação interna dos fields.

Fluxo:

```text
Frame 100
  Upper
  Lower

Frame 101
  Upper
  Lower
```

Permitindo ao usuário navegar campo por campo.

---

# Timeline

A timeline deverá representar:

* Todos os cortes detectados
* Todas as ocorrências suspeitas

Exemplo:

```text
─────|──────|──────|──────|──────
     ▲      ▲      ▲
```

Legenda:

* Cinza → corte detectado
* Vermelho → suspeita de split-field

---

# Filmstrip de Contexto

Este será um dos principais componentes da aplicação.

Ao selecionar um corte:

```text
-4  -3  -2  -1  CUT  +1  +2  +3  +4
```

Exemplo:

```text
[A] [A] [A] [A] [AB] [C] [C] [C] [C]
```

O frame suspeito deverá receber destaque visual.

Objetivo:

Permitir que o editor identifique rapidamente um frame intruso sem precisar reproduzir o vídeo.

---

# Filmstrip por Field (Modo Avançado)

Opcionalmente:

```text
U98 L98 U99 L99 U100 L100 U101 L101
```

Exemplo:

```text
A  A  A  A   A   B   C   C
```

Facilitando a identificação de imagens que aparecem durante apenas um field.

---

# Painel de Fields

Ao selecionar uma ocorrência:

```text
Upper Field
┌────────────┐
│ imagem A   │
└────────────┘

Lower Field
┌────────────┐
│ imagem B   │
└────────────┘
```

Objetivo:

Comparação direta entre os dois campos.

---

# Lista de Ocorrências

Exemplo:

```text
🔴 00:00:24:08  Confiança 95%
🟠 00:00:12:15  Confiança 81%
🟡 00:00:05:03  Confiança 62%
```

Ao clicar:

* Ir para ocorrência
* Atualizar filmstrip
* Atualizar painel de fields

---

# Fluxo de Uso

1. Abrir arquivo.
2. Detectar cortes.
3. Exibir timeline.
4. Iniciar análise automática.
5. Destacar possíveis ocorrências.
6. Navegar pelos cortes.
7. Validar visualmente utilizando:

   * Filmstrip
   * Navegação por frame
   * Navegação por field
   * Reprodução local

---

# Arquitetura Técnica

## Frontend

Tecnologias:

* HTML5
* CSS3
* JavaScript
* Vite

---

## Processamento

Bibliotecas:

* FFmpeg.wasm

Possíveis complementos:

* Canvas API
* Web Workers

---

## Estrutura

```text
/src

main.js
player.js
timeline.js
filmstrip.js
analyzer.js
ffmpeg.js
ui.js

/public

index.html
```

---

# Hospedagem

Plataforma:

GitHub Pages

Características:

* Site estático
* Sem backend
* Sem autenticação
* Sem armazenamento remoto

---

# Performance Esperada

Material típico:

* 30 segundos
* 1 minuto
* até 2 minutos

Formato principal:

* XDCAM HD422
* 1080i59.94
* 50 Mbps

Meta:

| Duração | Tempo alvo |
| ------- | ---------- |
| 30 s    | < 5 s      |
| 1 min   | < 10 s     |
| 2 min   | < 20 s     |

---

# Evoluções Futuras

* Exportação de relatório TXT
* Exportação de relatório JSON
* Modo lote
* Integração com timecode MXF
* Sensibilidade ajustável
* Comparação visual de ocorrências
* Atalhos de teclado estilo NLE
* Suporte a múltiplos formatos interlaced

---

# Critério de Sucesso

A ferramenta será considerada bem-sucedida se permitir que um editor identifique e valide rapidamente possíveis frames híbridos decorrentes de cortes entre fields, reduzindo significativamente o tempo necessário para revisar um material antes de sua entrega.




# Alterações na Especificação

## Nome da Aplicação

Nome oficial:

```text
Bendito Field
```

Tagline opcional:

```text
Bendito Field
Detecção e revisão de possíveis split-fields em material interlaced
```

---

## Rodapé da Aplicação

Todas as telas deverão exibir um rodapé fixo na parte inferior da interface.

Conteúdo:

```text
Idealizado por Lohan Costa, edt. Criado com Claude Code
```

Requisitos:

* "Lohan Costa, edt." deverá ser um link clicável.
* Destino do link:

https://www.linkedin.com/in/lohan-costa/

* O link deverá abrir em nova aba.
* Estilo discreto e profissional.
* Presente tanto na tela inicial quanto na tela de análise.

Exemplo visual:

```text
────────────────────────────────────────────────────

Idealizado por Lohan Costa, edt. Criado com Claude Code
```

HTML sugerido:

```html
<footer class="app-footer">
  Idealizado por
  <a
    href="https://www.linkedin.com/in/lohan-costa/"
    target="_blank"
    rel="noopener noreferrer"
  >
    Lohan Costa, edt.
  </a>
  Criado com Claude Code
</footer>
```
