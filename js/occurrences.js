// ===================== occurrences.js =====================
// Lista de ocorrências suspeitas (frames com split-field provável).
// Cada item: índice (#01, #02…), timecode em destaque e o frame; mais um botão
// "✕ Remover" para descartar um falso positivo. NÃO mostramos % de confiança
// (99% num falso positivo passa segurança que o app não tem). Quando a lista
// esvazia, o `onChange` avisa o app (que mostra a mensagem de "aprovado").

export class Occurrences {
  /**
   * @param {HTMLElement} container
   * @param {(suspect:object, idx:number)=>void} onSelect
   * @param {(frame:number)=>string} timecode  função frame→timecode
   * @param {(count:number, dismissedAll:boolean)=>void} [onChange]
   */
  constructor(container, onSelect, timecode, onChange) {
    this.container = container;
    this.onSelect = onSelect;
    this.timecode = timecode;
    this.onChange = onChange || (() => {});
    this.items = []; // [{ el, suspect, idxEl }]
    this.selected = -1;
  }

  setSuspects(suspects) {
    this.container.innerHTML = "";
    this.items = [];
    this.selected = -1;

    if (!suspects.length) {
      this.onChange(0, false);
      return;
    }

    const frag = document.createDocumentFragment();
    suspects.forEach((s) => {
      const row = document.createElement("div");
      row.className = "occ-item";

      const main = document.createElement("button");
      main.type = "button";
      main.className = "occ-main";

      const idx = document.createElement("span");
      idx.className = "occ-idx"; // preenchido por renumber()

      const tc = document.createElement("span");
      tc.className = "occ-tc";
      tc.textContent = this.timecode(s.frame);

      const fr = document.createElement("span");
      fr.className = "occ-frame";
      fr.textContent = `frame ${s.frame + 1}`;

      main.append(idx, tc, fr);
      main.addEventListener("click", () => this.selectEl(row));

      const x = document.createElement("button");
      x.type = "button";
      x.className = "occ-dismiss";
      x.innerHTML = `<span class="occ-dismiss__x" aria-hidden="true">✕</span> Remover`;
      x.title = "Remover — falso positivo";
      x.setAttribute("aria-label", "Remover ocorrência (falso positivo)");
      x.addEventListener("click", (e) => { e.stopPropagation(); this.dismissEl(row); });

      row.append(main, x);
      frag.appendChild(row);
      this.items.push({ el: row, suspect: s, idxEl: idx });
    });
    this.container.appendChild(frag);
    this.renumber();
    this.onChange(this.items.length, false);
    this.selectIndex(0, true);
  }

  // Atualiza os rótulos #01, #02, … (chamado ao montar e ao remover um item).
  renumber() {
    this.items.forEach((it, i) => {
      it.idxEl.textContent = `#${String(i + 1).padStart(2, "0")}`;
    });
  }

  indexOfEl(el) { return this.items.findIndex((it) => it.el === el); }
  selectEl(el) { this.selectIndex(this.indexOfEl(el)); }

  // i = índice em `items`. force re-dispara mesmo se já for o selecionado.
  selectIndex(i, force = false) {
    if (!this.items.length) { this.selected = -1; return; }
    const idx = Math.max(0, Math.min(this.items.length - 1, i));
    if (idx === this.selected && !force) return;
    if (this.items[this.selected]) this.items[this.selected].el.classList.remove("is-selected");
    this.selected = idx;
    this.items[idx].el.classList.add("is-selected");
    this.items[idx].el.scrollIntoView({ block: "nearest" });
    this.onSelect(this.items[idx].suspect, idx);
  }

  /** Re-dispara a seleção atual (ex.: depois que as imagens carregaram). */
  reselect() { if (this.selected >= 0) this.selectIndex(this.selected, true); }

  /** Remove a ocorrência (o usuário marcou como falso positivo). */
  dismissEl(el) {
    const i = this.indexOfEl(el);
    if (i < 0) return;
    el.remove();
    this.items.splice(i, 1);

    if (!this.items.length) {
      this.selected = -1;
      this.onChange(0, true); // tudo descartado pelo usuário
      return;
    }
    this.renumber();
    if (i <= this.selected) this.selected = Math.max(0, this.selected - 1);
    const keep = Math.min(this.selected, this.items.length - 1);
    this.selected = -1;
    this.selectIndex(keep, true);
    this.onChange(this.items.length, false);
  }

  // Compat. com a navegação por teclado (↑/↓) do main.js.
  select(i) { this.selectIndex(i); }

  count() { return this.items.length; }

  clear() {
    this.container.innerHTML = "";
    this.items = [];
    this.selected = -1;
  }
}
