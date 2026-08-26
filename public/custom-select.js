class CustomSelect {
  /**
   * @param {string|HTMLElement} contenedor - selector o elemento donde montar el dropdown
   * @param {Object} opciones
   * @param {string} [opciones.placeholder] - texto cuando no hay selección
   * @param {boolean} [opciones.buscador] - si true, agrega input de búsqueda/filtro
   * @param {string} [opciones.name] - atributo name (útil si el form lee por name)
   */
  constructor(contenedor, opciones = {}) {
    this.root =
      typeof contenedor === 'string'
        ? document.querySelector(contenedor)
        : contenedor;

    if (!this.root) {
      throw new Error(`CustomSelect: no se encontró el contenedor "${contenedor}"`);
    }

    this.placeholder = opciones.placeholder || 'Seleccionar...';
    this.conBuscador = !!opciones.buscador;
    this.name = opciones.name || '';

    this._opciones = []; // [{value, text}]
    this._valorSeleccionado = '';
    this._abierto = false;
    this._listeners = { change: [] };
    this._indiceActivo = -1; // para navegación con teclado

    this._render();
    this._bindEventosGlobales();
  }

  // ---------- Render inicial ----------
  _render() {
    this.root.classList.add('csel');
    this.root.innerHTML = `
      <button type="button" class="csel-trigger" aria-haspopup="listbox" aria-expanded="false">
        <span class="csel-trigger-texto">${this._escapar(this.placeholder)}</span>
        <span class="csel-flecha" aria-hidden="true"></span>
      </button>
      <div class="csel-panel" role="listbox" hidden>
        ${this.conBuscador ? '<input type="text" class="csel-buscador" placeholder="Buscar...">' : ''}
        <ul class="csel-lista"></ul>
        <div class="csel-vacio" hidden>Sin opciones</div>
      </div>
    `;

    this.trigger = this.root.querySelector('.csel-trigger');
    this.triggerTexto = this.root.querySelector('.csel-trigger-texto');
    this.panel = this.root.querySelector('.csel-panel');
    this.lista = this.root.querySelector('.csel-lista');
    this.vacio = this.root.querySelector('.csel-vacio');
    this.inputBuscador = this.root.querySelector('.csel-buscador');

    this.trigger.addEventListener('click', () => this.toggle());
    this.trigger.addEventListener('keydown', (e) => this._manejarTecladoTrigger(e));

    if (this.inputBuscador) {
      this.inputBuscador.addEventListener('input', () => this._filtrar(this.inputBuscador.value));
      this.inputBuscador.addEventListener('keydown', (e) => this._manejarTecladoLista(e));
    }

    this.lista.addEventListener('keydown', (e) => this._manejarTecladoLista(e));
  }

  // ---------- Cargar opciones (equivalente a llenar un <select>) ----------
  /**
   * @param {Array<{value:string, text:string}>} opciones
   */
  setOptions(opciones) {
    this._opciones = Array.isArray(opciones) ? opciones : [];
    this._pintarLista(this._opciones);

    // Si el valor seleccionado ya no existe en las nuevas opciones, se limpia
    const existe = this._opciones.some((o) => String(o.value) === String(this._valorSeleccionado));
    if (!existe) {
      this._valorSeleccionado = '';
      this.triggerTexto.textContent = this.placeholder;
      this.triggerTexto.classList.add('csel-placeholder');
    }
  }

  _pintarLista(opciones) {
    const fragment = document.createDocumentFragment();
    this.lista.innerHTML = '';

    if (opciones.length === 0) {
      this.vacio.hidden = false;
    } else {
      this.vacio.hidden = true;
      opciones.forEach((op, idx) => {
        const li = document.createElement('li');
        li.className = 'csel-opcion';
        li.setAttribute('role', 'option');
        li.dataset.value = op.value;
        li.textContent = op.text;
        if (String(op.value) === String(this._valorSeleccionado)) {
          li.setAttribute('aria-selected', 'true');
          li.classList.add('csel-opcion-activa');
        }
        li.addEventListener('click', () => this._seleccionar(op.value, op.text));
        fragment.appendChild(li);
      });
      this.lista.appendChild(fragment);
    }
    this._indiceActivo = -1;
  }

  _filtrar(texto) {
    const t = texto.trim().toLowerCase();
    const filtradas = t
      ? this._opciones.filter((o) => o.text.toLowerCase().includes(t))
      : this._opciones;
    this._pintarLista(filtradas);
  }

  // ---------- Selección ----------
  _seleccionar(value, text) {
    this._valorSeleccionado = value;
    this.triggerTexto.textContent = text;
    this.triggerTexto.classList.remove('csel-placeholder');
    this.cerrar();
    this.trigger.focus();
    this._emitirChange();
  }

  _emitirChange() {
    const evento = { target: this, value: this._valorSeleccionado };
    this._listeners.change.forEach((cb) => cb(evento));
  }

  // ---------- API pública tipo <select> ----------
  get value() {
    return this._valorSeleccionado;
  }

  set value(v) {
    const opcion = this._opciones.find((o) => String(o.value) === String(v));
    if (opcion) {
      this._valorSeleccionado = opcion.value;
      this.triggerTexto.textContent = opcion.text;
      this.triggerTexto.classList.remove('csel-placeholder');
    } else {
      this._valorSeleccionado = '';
      this.triggerTexto.textContent = this.placeholder;
      this.triggerTexto.classList.add('csel-placeholder');
    }
    // marcar visualmente la opción activa si el panel está pintado
    this._pintarLista(this._opciones);
  }

  get disabled() {
    return this.trigger.disabled;
  }

  set disabled(val) {
    this.trigger.disabled = !!val;
    this.root.classList.toggle('csel-disabled', !!val);
    if (val) this.cerrar();
  }

  addEventListener(tipo, cb) {
    if (!this._listeners[tipo]) this._listeners[tipo] = [];
    this._listeners[tipo].push(cb);
  }

  removeEventListener(tipo, cb) {
    if (!this._listeners[tipo]) return;
    this._listeners[tipo] = this._listeners[tipo].filter((f) => f !== cb);
  }

  destroy() {
    document.removeEventListener('click', this._clickFueraHandler);
    document.removeEventListener('keydown', this._escHandler);
    this.root.innerHTML = '';
    this.root.classList.remove('csel');
  }

  // ---------- Abrir / cerrar ----------
  toggle() {
    this._abierto ? this.cerrar() : this.abrir();
  }

  abrir() {
    if (this.disabled) return;
    this.panel.hidden = false;
    this.trigger.setAttribute('aria-expanded', 'true');
    this.root.classList.add('csel-abierto');
    this._abierto = true;

    if (this.inputBuscador) {
      this.inputBuscador.value = '';
      this._pintarLista(this._opciones);
      setTimeout(() => this.inputBuscador.focus(), 0);
    }
  }

  cerrar() {
    this.panel.hidden = true;
    this.trigger.setAttribute('aria-expanded', 'false');
    this.root.classList.remove('csel-abierto');
    this._abierto = false;
    this._indiceActivo = -1;
  }

  // ---------- Teclado ----------
  _manejarTecladoTrigger(e) {
    if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
      e.preventDefault();
      this.abrir();
      this._moverActivo(1);
    } else if (e.key === 'Escape') {
      this.cerrar();
    }
  }

  _manejarTecladoLista(e) {
    const opciones = this.lista.querySelectorAll('.csel-opcion');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this._moverActivo(1, opciones);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this._moverActivo(-1, opciones);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const activa = opciones[this._indiceActivo];
      if (activa) activa.click();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.cerrar();
      this.trigger.focus();
    }
  }

  _moverActivo(direccion, opcionesParam) {
    const opciones = opcionesParam || this.lista.querySelectorAll('.csel-opcion');
    if (opciones.length === 0) return;
    opciones.forEach((o) => o.classList.remove('csel-opcion-hover'));
    this._indiceActivo = Math.min(
      Math.max(this._indiceActivo + direccion, 0),
      opciones.length - 1
    );
    const activa = opciones[this._indiceActivo];
    activa.classList.add('csel-opcion-hover');
    activa.scrollIntoView({ block: 'nearest' });
  }

  // ---------- Cerrar al hacer click afuera / Esc global ----------
  _bindEventosGlobales() {
    this._clickFueraHandler = (e) => {
      if (this._abierto && !this.root.contains(e.target)) {
        this.cerrar();
      }
    };
    this._escHandler = (e) => {
      if (e.key === 'Escape' && this._abierto) this.cerrar();
    };
    document.addEventListener('click', this._clickFueraHandler);
    document.addEventListener('keydown', this._escHandler);
  }

  _escapar(texto) {
    const div = document.createElement('div');
    div.textContent = texto;
    return div.innerHTML;
  }
}

// Exportar para Node/CommonJS (Electron renderer con require) y también dejarlo global
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CustomSelect;
}
if (typeof window !== 'undefined') {
  window.CustomSelect = CustomSelect;
}