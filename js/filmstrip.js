// ===================== filmstrip.js =====================
// Tira de contexto ao redor de um frame suspeito: -N … SUSPEITO … +N.
// Cada miniatura é clicável; o frame suspeito recebe destaque.

export class Filmstrip {
  /**
   * @param {HTMLElement} container
   * @param {(frame:number)=>void} onSelect  callback ao escolher um frame
   */
  constructor(container, onSelect) {
    this.container = container;
    this.onSelect = onSelect;
    this.items = [];       // [{ frame, el }]
    this.selected = -1;    // índice dentro de `items`
  }

  /**
   * @param {Array<{frame:number,url:string,suspect:boolean}>} window
   * @param {number} focusFrame  frame que deve iniciar selecionado
   */
  setWindow(window, focusFrame) {
    this.container.innerHTML = "";
    this.items = [];
    this.selected = -1;

    const frag = document.createDocumentFragment();
    window.forEach((f, i) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "thumb" + (f.suspect ? " thumb--suspect" : "");

      const img = document.createElement("img");
      img.loading = "lazy";
      img.decoding = "async";
      img.src = f.url;
      img.alt = `Frame ${f.frame + 1}`;

      const label = document.createElement("span");
      label.className = "thumb__num";
      label.textContent = `#${f.frame + 1}`;

      item.append(img, label);
      item.addEventListener("click", () => this.selectByItem(i));
      frag.appendChild(item);
      this.items.push({ frame: f.frame, el: item });
    });
    this.container.appendChild(frag);

    const startIdx = Math.max(0, this.items.findIndex((it) => it.frame === focusFrame));
    this.selectByItem(startIdx === -1 ? 0 : startIdx);
  }

  selectByItem(i) {
    if (!this.items.length) return;
    const idx = Math.max(0, Math.min(this.items.length - 1, i));
    if (this.items[this.selected]) this.items[this.selected].el.classList.remove("is-selected");
    this.selected = idx;
    const it = this.items[idx];
    it.el.classList.add("is-selected");
    it.el.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
    this.onSelect(it.frame);
  }

  next() { this.selectByItem(this.selected + 1); }
  prev() { this.selectByItem(this.selected - 1); }

  clear() {
    this.container.innerHTML = "";
    this.items = [];
    this.selected = -1;
  }
}
