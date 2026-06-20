// ===================== player.js =====================
// Player do proxy MP4 (reproduz o MXF transcodado), com passo a passo por frame.
// (O modo pré/pós-roll foi removido — fica para uma fase futura.)

export class Player {
  /**
   * @param {object} els  { video, btnPlay, btnPrev, btnNext, tc }
   * @param {object} opts { fps, timecode, onFrame }
   */
  constructor(els, { fps = 29.97, timecode, onFrame } = {}) {
    this.els = els;
    this.video = els.video;
    this.fps = fps;
    this.timecode = timecode;
    this.onFrame = onFrame;

    const v = this.video;
    v.addEventListener("timeupdate", () => this.update());
    v.addEventListener("seeked", () => this.update());
    v.addEventListener("play", () => this.reflectPlay());
    v.addEventListener("pause", () => this.reflectPlay());

    els.btnPlay.addEventListener("click", () => this.togglePlay());
    els.btnPrev.addEventListener("click", () => this.step(-1));
    els.btnNext.addEventListener("click", () => this.step(1));
  }

  load(url, fps) {
    this.fps = fps || this.fps;
    this.video.src = url;
    this.video.load();
    this.update();
  }

  get loaded() {
    return !!this.video.currentSrc || !!this.video.src;
  }

  currentFrame() {
    return Math.floor(this.video.currentTime * this.fps);
  }

  seekToFrame(n) {
    this.video.currentTime = (Math.max(0, n) + 0.5) / this.fps; // meio do frame n
  }

  togglePlay() {
    if (this.video.paused) this.video.play();
    else this.video.pause();
  }

  step(delta) {
    this.video.pause();
    this.video.currentTime = (Math.max(0, this.currentFrame() + delta) + 0.5) / this.fps;
  }

  reflectPlay() {
    this.els.btnPlay.textContent = this.video.paused ? "▶︎" : "❚❚";
  }

  update() {
    if (this.els.tc) this.els.tc.textContent = this.timecode(this.currentFrame());
    this.onFrame && this.onFrame(this.currentFrame());
  }
}
