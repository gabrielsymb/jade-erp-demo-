// core/memory_manager.ts
var JadeBuffer = class {
  memory;
  ptr;
  size;
  offset = 0;
  constructor(memory, ptr, size) {
    this.memory = memory;
    this.ptr = ptr;
    this.size = size;
  }
  // Escreve string UTF-8 na posição atual
  escrever(texto) {
    const encoded = new TextEncoder().encode(texto);
    if (this.offset + encoded.length > this.size) {
      throw new RangeError(
        `[JADE Buffer] Overflow: tentou escrever ${encoded.length} bytes mas s\xF3 restam ${this.size - this.offset} bytes.`
      );
    }
    const bytes = new Uint8Array(this.memory.buffer, this.ptr + this.offset, encoded.length);
    bytes.set(encoded);
    this.offset += encoded.length;
  }
  // Lê string UTF-8 a partir do início
  ler() {
    const bytes = new Uint8Array(this.memory.buffer, this.ptr, this.offset);
    return new TextDecoder().decode(bytes);
  }
  // Escreve número i32
  escreverInt(valor) {
    if (this.offset + 4 > this.size) {
      throw new RangeError("[JADE Buffer] Overflow ao escrever inteiro.");
    }
    new DataView(this.memory.buffer).setInt32(this.ptr + this.offset, valor, true);
    this.offset += 4;
  }
  // Escreve número f64
  escreverDecimal(valor) {
    if (this.offset + 8 > this.size) {
      throw new RangeError("[JADE Buffer] Overflow ao escrever decimal.");
    }
    new DataView(this.memory.buffer).setFloat64(this.ptr + this.offset, valor, true);
    this.offset += 8;
  }
  // Reseta cursor para o início (sem apagar dados)
  resetar() {
    this.offset = 0;
  }
  tamanho() {
    return this.size;
  }
  usado() {
    return this.offset;
  }
  disponivel() {
    return this.size - this.offset;
  }
  ponteiro() {
    return this.ptr;
  }
};
var MemoryManager = class {
  memory;
  heapStart;
  // offset onde o heap começa
  nextFree;
  // próximo endereço livre (bump allocator)
  freeList = [];
  allocationSizes = /* @__PURE__ */ new Map();
  allocationsByOwner = /* @__PURE__ */ new Map();
  constructor(initialPages = 1) {
    this.memory = new WebAssembly.Memory({ initial: initialPages, maximum: 256 });
    this.heapStart = 1024;
    this.nextFree = this.heapStart;
  }
  // Retorna a memória para passar como import ao WASM
  getMemory() {
    return this.memory;
  }
  // Conecta a memória exportada pelo módulo WASM ao MemoryManager.
  // Chamado pelo runtime após instanciar o WASM.
  // A partir deste momento, readString/writeString operam no buffer do WASM.
  connectWasmMemory(wasmMemory) {
    this.memory = wasmMemory;
  }
  // Aloca `size` bytes, retorna ponteiro (i32)
  malloc(size) {
    const aligned = Math.ceil(size / 8) * 8;
    const freeIdx = this.freeList.findIndex((b) => b.size >= aligned);
    if (freeIdx !== -1) {
      const block = this.freeList.splice(freeIdx, 1)[0];
      this.allocationSizes.set(block.ptr, aligned);
      return block.ptr;
    }
    const ptr = this.nextFree;
    this.nextFree += aligned;
    const required = Math.ceil(this.nextFree / 65536);
    const current = this.memory.buffer.byteLength / 65536;
    if (required > current) {
      this.memory.grow(required - current);
    }
    this.allocationSizes.set(ptr, aligned);
    return ptr;
  }
  // Libera memória no ponteiro `ptr`
  free(ptr) {
    const size = this.allocationSizes.get(ptr);
    if (size === void 0) {
      return;
    }
    this.freeList.push({ ptr, size });
    this.allocationSizes.delete(ptr);
  }
  // malloc rastreado — use para alocações de componentes UI
  mallocTracked(size, owner) {
    const ptr = this.malloc(size);
    if (!this.allocationsByOwner.has(owner)) {
      this.allocationsByOwner.set(owner, []);
    }
    this.allocationsByOwner.get(owner).push(ptr);
    return ptr;
  }
  // Libera toda memória de um dono de uma vez
  // Chamar quando uma tela/componente for destruído
  freeOwner(owner) {
    const ptrs = this.allocationsByOwner.get(owner) ?? [];
    for (const ptr of ptrs) {
      this.free(ptr);
    }
    this.allocationsByOwner.delete(owner);
  }
  // Retorna estatísticas de uso por dono (para debug)
  getOwnerStats() {
    const stats = {};
    for (const [owner, ptrs] of this.allocationsByOwner.entries()) {
      stats[owner] = ptrs.length;
    }
    return stats;
  }
  createBuffer(ptr, size) {
    return new JadeBuffer(this.memory, ptr, size);
  }
  // Atalho: aloca e já retorna buffer pronto
  allocBuffer(size, owner) {
    const ptr = owner ? this.mallocTracked(size, owner) : this.malloc(size);
    return new JadeBuffer(this.memory, ptr, size);
  }
  // Escreve string UTF-8 na memória, retorna ponteiro
  writeString(str) {
    const encoded = new TextEncoder().encode(str);
    const ptr = this.malloc(encoded.length + 4);
    const view = new DataView(this.memory.buffer);
    view.setUint32(ptr, encoded.length, true);
    const bytes = new Uint8Array(this.memory.buffer, ptr + 4, encoded.length);
    bytes.set(encoded);
    return ptr;
  }
  // Lê string UTF-8 da memória a partir do ponteiro (null-terminated)
  readString(ptr) {
    const view = new DataView(this.memory.buffer);
    let offset = ptr;
    const bytes = [];
    while (true) {
      const byte = view.getUint8(offset);
      if (byte === 0) break;
      bytes.push(byte);
      offset++;
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
  }
  // Versão alternativa para strings com tamanho prefixado (mantida para compatibilidade)
  readStringWithLength(ptr) {
    const view = new DataView(this.memory.buffer);
    const length = view.getUint32(ptr, true);
    const bytes = new Uint8Array(this.memory.buffer, ptr + 4, length);
    return new TextDecoder().decode(bytes);
  }
  // Escreve struct de entidade na memória
  // fields: array de { name, type, value } na mesma ordem dos campos
  writeStruct(fields) {
    const ptr = this.malloc(fields.length * 8);
    const view = new DataView(this.memory.buffer);
    let offset = ptr;
    for (const field of fields) {
      if (field.type === "i32" || field.type === "i1") {
        view.setInt32(offset, Number(field.value), true);
        offset += 8;
      } else if (field.type === "f64") {
        view.setFloat64(offset, Number(field.value), true);
        offset += 8;
      } else {
        const strPtr = typeof field.value === "string" ? this.writeString(field.value) : Number(field.value);
        view.setInt32(offset, strPtr, true);
        offset += 8;
      }
    }
    return ptr;
  }
  // Lê campo de uma struct pelo offset do campo (índice × 8)
  readField(ptr, fieldIndex, type) {
    const view = new DataView(this.memory.buffer);
    const offset = ptr + fieldIndex * 8;
    if (type === "i32" || type === "i1") return view.getInt32(offset, true);
    if (type === "f64") return view.getFloat64(offset, true);
    return view.getInt32(offset, true);
  }
};

// core/event_loop.ts
var MAX_CADEIA = 100;
var EventLoop = class {
  handlers = /* @__PURE__ */ new Map();
  queue = [];
  running = false;
  _fromHandler = false;
  // Registra handler para um evento
  on(event, handler) {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    this.handlers.get(event).push(handler);
  }
  // Remove handler
  off(event, handler) {
    const handlers = this.handlers.get(event);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx !== -1) handlers.splice(idx, 1);
    }
  }
  // Emite evento — coloca na fila (não bloqueia)
  emit(event, ...args) {
    this.queue.push({ event, args, fromHandler: this._fromHandler });
    if (!this.running) {
      this.running = true;
      this.processQueue().catch((e) => console.error("[JADE EventLoop]", e));
    }
  }
  // Emite evento de forma síncrona (para uso interno do runtime)
  emitSync(event, ...args) {
    const handlers = this.handlers.get(event) || [];
    for (const handler of handlers) {
      handler(...args);
    }
  }
  async processQueue() {
    let cadeia = 0;
    while (this.queue.length > 0) {
      const { event, args, fromHandler } = this.queue.shift();
      if (!fromHandler) {
        cadeia = 0;
      } else if (++cadeia > MAX_CADEIA) {
        this.queue = [];
        this.running = false;
        throw new Error(
          `[JADE EventLoop] Poss\xEDvel loop infinito: mais de ${MAX_CADEIA} eventos gerados em cadeia por handlers`
        );
      }
      const handlers = this.handlers.get(event) || [];
      for (const handler of handlers) {
        this._fromHandler = true;
        let result;
        try {
          result = handler(...args);
        } catch (e) {
          this._fromHandler = false;
          console.error(`Erro no handler do evento '${event}':`, e);
          continue;
        }
        this._fromHandler = false;
        try {
          await (result ?? Promise.resolve());
        } catch (e) {
          console.error(`Erro no handler do evento '${event}':`, e);
        }
      }
    }
    this.running = false;
  }
};

// core/runtime.ts
var JadeRuntime = class {
  memory;
  events;
  wasmInstance = null;
  exports = {};
  debug;
  constructor(config = {}) {
    this.memory = new MemoryManager();
    this.events = new EventLoop();
    this.debug = config.debug ?? false;
  }
  // Carrega e instancia um módulo WASM.
  // Aceita: BufferSource (Uint8Array), Response (streaming), ou WebAssembly.Module
  // eventHandlers: lista gerada pelo compilador mapeando evento → função WASM exportada
  async load(wasmSource, eventHandlers) {
    const imports = this.buildImports();
    let instance;
    if (wasmSource instanceof WebAssembly.Module) {
      instance = await WebAssembly.instantiate(wasmSource, imports);
    } else if (wasmSource instanceof Response) {
      const result = await WebAssembly.instantiateStreaming(wasmSource, imports);
      instance = result.instance;
    } else {
      const result = await WebAssembly.instantiate(wasmSource, imports);
      instance = result.instance;
    }
    this.wasmInstance = instance;
    this.exports = instance.exports;
    if (instance.exports.memory instanceof WebAssembly.Memory) {
      this.memory.connectWasmMemory(instance.exports.memory);
    }
    if (eventHandlers) {
      for (const { eventName, functionName } of eventHandlers) {
        const exportName = functionName.startsWith("@") ? functionName.slice(1) : functionName;
        const fn = this.exports[exportName];
        if (typeof fn === "function") {
          this.events.on(eventName, fn);
          if (this.debug) console.log(`[JADE Runtime] Handler registrado: ${eventName} \u2192 ${exportName}`);
        }
      }
    }
    if (this.debug) {
      console.log("[JADE Runtime] M\xF3dulo carregado. Exports:", Object.keys(this.exports));
    }
  }
  // Chama uma função exportada pelo WASM
  call(funcName, ...args) {
    if (!this.exports[funcName]) {
      throw new Error(`Fun\xE7\xE3o '${funcName}' n\xE3o encontrada no m\xF3dulo WASM`);
    }
    return this.exports[funcName](...args);
  }
  // Registra handler para evento JADE
  on(event, handler) {
    this.events.on(event, handler);
  }
  // Acesso ao gerenciador de memória (para testes e integração)
  getMemory() {
    return this.memory;
  }
  // Constrói o objeto de imports que o WASM recebe
  buildImports() {
    return {
      jade: {
        log_i32: (value) => {
          if (this.debug) console.log("[JADE]", value);
        },
        log_f64: (value) => {
          if (this.debug) console.log("[JADE]", value);
        },
        log_str: (ptr) => {
          const str = this.memory.readString(ptr);
          if (this.debug) console.log("[JADE]", str);
        },
        malloc: (size) => {
          return this.memory.malloc(size);
        },
        free: (ptr) => {
          this.memory.free(ptr);
        },
        erro: (msgPtr) => {
          const msg = this.memory.readString(msgPtr);
          throw new Error(`[JADE Erro] ${msg}`);
        },
        emitir_evento: (nomePtr, dadosPtr) => {
          const nome = this.memory.readString(nomePtr);
          this.events.emit(nome, dadosPtr);
          if (this.debug) console.log(`[JADE Evento] ${nome}`);
        },
        lista_tamanho: (listaPtr) => {
          const view = new DataView(this.memory.getMemory().buffer);
          return view.getInt32(listaPtr, true);
        },
        lista_obter: (listaPtr, index) => {
          const view = new DataView(this.memory.getMemory().buffer);
          return view.getInt32(listaPtr + 4 + index * 4, true);
        },
        concat: (ptrA, ptrB) => {
          const strA = this.memory.readString(ptrA);
          const strB = this.memory.readString(ptrB);
          const result = strA + strB;
          const encoded = new TextEncoder().encode(result);
          const ptr = this.memory.malloc(encoded.length + 1);
          const bytes = new Uint8Array(this.memory.getMemory().buffer, ptr, encoded.length + 1);
          bytes.set(encoded);
          bytes[encoded.length] = 0;
          return ptr;
        }
      }
    };
  }
};

// ui/reactive.ts
var currentEffect = null;
var effectsByOwner = /* @__PURE__ */ new Map();
var currentOwner = null;
function setEffectOwner(owner) {
  currentOwner = owner;
}
function disposeOwner(owner) {
  for (const h of effectsByOwner.get(owner) ?? []) {
    h.disposed = true;
  }
  effectsByOwner.delete(owner);
}
var Signal = class {
  _value;
  subs = /* @__PURE__ */ new Set();
  constructor(initialValue) {
    this._value = initialValue;
  }
  /** Lê o valor e registra o efeito atual como dependente. */
  get() {
    if (currentEffect) this.subs.add(currentEffect);
    return this._value;
  }
  /** Atualiza o valor e re-executa todos os efeitos dependentes. */
  set(newValue) {
    if (newValue === this._value) return;
    this._value = newValue;
    for (const h of [...this.subs]) {
      if (h.disposed) {
        this.subs.delete(h);
      } else {
        h.fn();
      }
    }
  }
  /** Lê o valor sem registrar dependência. */
  peek() {
    return this._value;
  }
};
function createEffect(fn) {
  const handle = { fn: () => {
  }, disposed: false };
  const wrapped = () => {
    if (handle.disposed) return;
    const prev = currentEffect;
    currentEffect = handle;
    try {
      fn();
    } finally {
      currentEffect = prev;
    }
  };
  handle.fn = wrapped;
  if (currentOwner !== null) {
    const arr = effectsByOwner.get(currentOwner) ?? [];
    arr.push(handle);
    effectsByOwner.set(currentOwner, arr);
  }
  wrapped();
  return () => {
    handle.disposed = true;
  };
}
var Store = class {
  signals = /* @__PURE__ */ new Map();
  set(key, value) {
    if (this.signals.has(key)) {
      this.signals.get(key).set(value);
    } else {
      this.signals.set(key, new Signal(value));
    }
  }
  get(key, defaultValue) {
    if (!this.signals.has(key)) {
      this.signals.set(key, new Signal(defaultValue));
    }
    return this.signals.get(key);
  }
  has(key) {
    return this.signals.has(key);
  }
  /**
   * Remove todas as chaves com o prefixo indicado.
   * CORREÇÃO: evita acúmulo de dados de telas antigas na memória.
   * Exemplo: clearNamespace('tela-produtos.') remove só os dados dessa tela.
   */
  clearNamespace(prefix) {
    for (const key of this.signals.keys()) {
      if (key.startsWith(prefix)) this.signals.delete(key);
    }
  }
  clear() {
    this.signals.clear();
  }
  size() {
    return this.signals.size;
  }
};

// ui/binding.ts
function bind(signal, node, property) {
  createEffect(() => {
    const value = signal.get();
    if (property === "textContent") {
      node.textContent = String(value ?? "");
    } else if (node instanceof HTMLElement) {
      if (property === "style.display") {
        node.style.display = value ? "" : "none";
      } else if (property.startsWith("style.")) {
        node.style[property.slice(6)] = String(value);
      } else if (property === "disabled") {
        node.disabled = Boolean(value);
      } else if (property === "class") {
        node.className = String(value ?? "");
      } else {
        node[property] = value;
      }
    }
  });
}
function bindInput(node, signal) {
  bind(signal, node, "value");
  node.addEventListener("input", () => signal.set(node.value));
}

// ui/refs.ts
var RefManager = class {
  refs = /* @__PURE__ */ new Map();
  registrar(nome, elemento) {
    this.refs.set(nome, elemento);
  }
  obter(nome) {
    return this.refs.get(nome) ?? null;
  }
  focar(nome) {
    const el2 = this.refs.get(nome);
    if (!el2) return;
    if (el2 instanceof HTMLInputElement || el2 instanceof HTMLTextAreaElement) {
      el2.focus();
      el2.select();
    } else {
      el2.focus();
    }
  }
  rolar(nome, comportamento = "smooth") {
    this.refs.get(nome)?.scrollIntoView({ behavior: comportamento, block: "nearest" });
  }
  limpar() {
    this.refs.clear();
  }
};

// ui/theme.ts
var temaDefault = {
  cor_primaria: "#2563eb",
  cor_secundaria: "#64748b",
  cor_fundo: "#f8fafc",
  cor_texto: "#1e293b",
  cor_borda: "#e2e8f0",
  fonte_principal: "system-ui, -apple-system, sans-serif",
  raio_borda: "6px",
  espacamento_pequeno: "4px",
  espacamento_medio: "12px",
  espacamento_grande: "24px"
};
function aplicarTema(tema = {}) {
  const t = { ...temaDefault, ...tema };
  document.getElementById("jade-theme")?.remove();
  const style = document.createElement("style");
  style.id = "jade-theme";
  style.textContent = `
    :root {
      --jade-primaria:   ${t.cor_primaria};
      --jade-secundaria: ${t.cor_secundaria};
      --jade-fundo:      ${t.cor_fundo};
      --jade-texto:      ${t.cor_texto};
      --jade-borda:      ${t.cor_borda};
      --jade-fonte:      ${t.fonte_principal};
      --jade-raio:       ${t.raio_borda};
      --jade-esp-p:      ${t.espacamento_pequeno};
      --jade-esp-m:      ${t.espacamento_medio};
      --jade-esp-g:      ${t.espacamento_grande};
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--jade-fonte); color: var(--jade-texto); background: var(--jade-fundo); }

    /* Layout principal */
    .jade-app     { display: flex; flex-direction: column; min-height: 100vh; }
    .jade-layout  { display: flex; flex: 1; }
    .jade-menu    { width: 220px; background: #fff; border-right: 1px solid var(--jade-borda);
                    padding: var(--jade-esp-m); flex-shrink: 0; }
    .jade-conteudo { flex: 1; padding: var(--jade-esp-g); overflow-y: auto; }

    /* Menu lateral */
    .jade-menu-item { display: block; padding: 8px var(--jade-esp-m); border-radius: var(--jade-raio);
      text-decoration: none; color: var(--jade-texto); font-size: 14px; cursor: pointer;
      transition: background 0.15s; }
    .jade-menu-item:hover { background: var(--jade-fundo); }
    .jade-menu-item.ativo { background: var(--jade-primaria); color: #fff; }

    /* Tela */
    .jade-tela       { max-width: 1200px; }
    .jade-tela-titulo { font-size: 22px; font-weight: 500; margin-bottom: var(--jade-esp-g);
                        color: var(--jade-texto); }

    /* Tabela */
    .jade-tabela-wrapper { width: 100%; }
    .jade-tabela-controles { display: flex; gap: var(--jade-esp-m); margin-bottom: var(--jade-esp-m);
      align-items: center; flex-wrap: wrap; }
    .jade-tabela-busca { padding: 7px 12px; border: 1px solid var(--jade-borda);
      border-radius: var(--jade-raio); font-size: 14px; font-family: var(--jade-fonte);
      outline: none; min-width: 200px; }
    .jade-tabela-busca:focus { border-color: var(--jade-primaria); }
    .jade-tabela { width: 100%; border: 1px solid var(--jade-borda); border-radius: var(--jade-raio);
      overflow: hidden; }
    .jade-tabela table { width: 100%; border-collapse: collapse; }
    .jade-tabela th { background: #f1f5f9; padding: 10px 14px; text-align: left; font-size: 13px;
      font-weight: 500; color: var(--jade-secundaria); border-bottom: 1px solid var(--jade-borda);
      white-space: nowrap; }
    .jade-tabela th.ordenavel { cursor: pointer; user-select: none; }
    .jade-tabela th.ordenavel:hover { background: #e2e8f0; }
    .jade-tabela th .jade-sort-icon { margin-left: 4px; opacity: 0.4; }
    .jade-tabela th.sort-asc .jade-sort-icon,
    .jade-tabela th.sort-desc .jade-sort-icon { opacity: 1; }
    .jade-tabela td { padding: 10px 14px; font-size: 14px; border-bottom: 1px solid var(--jade-borda); }
    .jade-tabela tr:last-child td { border-bottom: none; }
    .jade-tabela tr:hover td { background: #f8fafc; }
    .jade-tabela-paginacao { display: flex; gap: var(--jade-esp-p); align-items: center;
      padding: var(--jade-esp-m); justify-content: flex-end; border-top: 1px solid var(--jade-borda);
      font-size: 13px; color: var(--jade-secundaria); }
    .jade-pag-btn { padding: 4px 10px; border: 1px solid var(--jade-borda); border-radius: var(--jade-raio);
      background: #fff; cursor: pointer; font-size: 13px; }
    .jade-pag-btn:hover:not(:disabled) { background: var(--jade-fundo); }
    .jade-pag-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .jade-pag-btn.ativo { background: var(--jade-primaria); color: #fff; border-color: var(--jade-primaria); }
    .jade-tabela-vazio { padding: 32px; text-align: center; color: var(--jade-secundaria);
      font-size: 14px; }

    /* Formul\xE1rio */
    .jade-formulario { display: flex; flex-direction: column; gap: var(--jade-esp-m); max-width: 600px; }
    .jade-campo { display: flex; flex-direction: column; gap: 4px; }
    .jade-campo label { font-size: 13px; font-weight: 500; color: var(--jade-secundaria); }
    .jade-campo input, .jade-campo select, .jade-campo textarea {
      padding: 8px 12px; border: 1px solid var(--jade-borda); border-radius: var(--jade-raio);
      font-size: 14px; font-family: var(--jade-fonte); outline: none;
      transition: border-color 0.15s, box-shadow 0.15s; }
    .jade-campo input:focus, .jade-campo select:focus, .jade-campo textarea:focus {
      border-color: var(--jade-primaria); box-shadow: 0 0 0 3px rgba(37,99,235,0.1); }
    .jade-campo-erro input, .jade-campo-erro select, .jade-campo-erro textarea {
      border-color: #dc2626; }
    .jade-campo-msg-erro { font-size: 12px; color: #dc2626; margin-top: 2px; }

    /* Bot\xF5es */
    .jade-botao { padding: 8px 18px; border-radius: var(--jade-raio); font-size: 14px;
      font-family: var(--jade-fonte); cursor: pointer; border: none; font-weight: 500;
      transition: background 0.15s; display: inline-flex; align-items: center; gap: 6px; }
    .jade-botao-primario   { background: var(--jade-primaria); color: #fff; }
    .jade-botao-primario:hover:not(:disabled) { background: #1d4ed8; }
    .jade-botao-secundario { background: #fff; color: var(--jade-texto); border: 1px solid var(--jade-borda); }
    .jade-botao-secundario:hover:not(:disabled) { background: var(--jade-fundo); }
    .jade-botao-perigo  { background: #dc2626; color: #fff; }
    .jade-botao-perigo:hover:not(:disabled) { background: #b91c1c; }
    .jade-botao:disabled { opacity: 0.5; cursor: not-allowed; }
    .jade-botoes { display: flex; gap: var(--jade-esp-m); margin-top: var(--jade-esp-m); flex-wrap: wrap; }

    /* Card de m\xE9trica */
    .jade-card { background: #fff; border: 1px solid var(--jade-borda); border-radius: var(--jade-raio);
      padding: var(--jade-esp-g); }
    .jade-card-titulo { font-size: 14px; font-weight: 500; color: var(--jade-secundaria); margin-bottom: 8px; }
    .jade-card-valor  { font-size: 28px; font-weight: 500; color: var(--jade-texto); }

    /* Grid responsivo */
    .jade-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: var(--jade-esp-m); margin-bottom: var(--jade-esp-g); }

    /* Badge de status */
    .jade-badge { display: inline-block; padding: 2px 8px; border-radius: 9999px;
      font-size: 12px; font-weight: 500; }
    .jade-badge-sucesso { background: #dcfce7; color: #166534; }
    .jade-badge-aviso   { background: #fef9c3; color: #854d0e; }
    .jade-badge-erro    { background: #fee2e2; color: #991b1b; }
    .jade-badge-info    { background: #dbeafe; color: #1e40af; }

    /* Acesso negado */
    .jade-acesso-negado { padding: 40px; text-align: center; color: #dc2626; font-size: 16px; }

    /* \u2500\u2500 Skeleton / Loading \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
    /* Anima\xE7\xE3o de "brilho" para indicar conte\xFAdo carregando */
    @keyframes jade-shimmer {
      0%   { background-position: -400px 0; }
      100% { background-position:  400px 0; }
    }
    .jade-skeleton {
      background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%);
      background-size: 400px 100%;
      animation: jade-shimmer 1.4s ease-in-out infinite;
      border-radius: var(--jade-raio);
    }
    .jade-skeleton-linha { height: 16px; margin-bottom: 8px; }
    .jade-skeleton-titulo { height: 24px; width: 40%; margin-bottom: var(--jade-esp-m); }
    .jade-skeleton-tabela-linha { height: 41px; margin-bottom: 1px; }
    .jade-carregando { display: flex; flex-direction: column; gap: 8px; padding: var(--jade-esp-m); }

    /* \u2500\u2500 Toast / Notifica\xE7\xF5es \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
    #jade-toasts { position: fixed; top: 20px; right: 20px; z-index: 9999;
      display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
    .jade-toast { padding: 12px 16px; border-radius: var(--jade-raio); font-size: 14px;
      font-family: var(--jade-fonte); color: #fff; max-width: 340px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      pointer-events: auto; display: flex; align-items: center; gap: 8px;
      animation: jade-toast-in 0.25s ease; }
    @keyframes jade-toast-in { from { transform: translateX(20px); opacity: 0; }
                                to   { transform: translateX(0);    opacity: 1; } }
    .jade-toast-saindo { animation: jade-toast-out 0.25s ease forwards; }
    @keyframes jade-toast-out { to { transform: translateX(20px); opacity: 0; } }
    .jade-toast-sucesso { background: #16a34a; }
    .jade-toast-erro    { background: #dc2626; }
    .jade-toast-aviso   { background: #d97706; }
    .jade-toast-info    { background: var(--jade-primaria); }

    /* Responsivo */
    @media (max-width: 768px) {
      .jade-menu     { display: none; }
      .jade-conteudo { padding: var(--jade-esp-m); }
      .jade-grid     { grid-template-columns: 1fr; }
      .jade-tela-titulo { font-size: 18px; }
    }
  `;
  document.head.appendChild(style);
}

// ui/router.ts
var Router = class {
  constructor(store, memory) {
    this.store = store;
    this.memory = memory;
  }
  rotas = /* @__PURE__ */ new Map();
  handlers = /* @__PURE__ */ new Map();
  telaAtiva = null;
  container = null;
  usuarioAtual = null;
  caminhoLogin = null;
  /**
   * Define o usuário logado. Necessário para verificar permissões de tela.
   * Passar null para fazer logout (sem usuário = sem acesso a rotas protegidas).
   */
  setUsuario(usuario) {
    this.usuarioAtual = usuario;
  }
  /**
   * Define a rota da tela de login.
   * Quando uma rota protegida é acessada sem usuário, redireciona para esta rota
   * em vez de exibir "acesso negado".
   */
  setTelaLogin(caminho) {
    this.caminhoLogin = caminho;
  }
  /** Registra uma rota com seu handler de renderização. */
  registrar(caminho, tela, handler, requerPapel) {
    this.rotas.set(caminho, { caminho, tela, requerPapel });
    this.handlers.set(tela, handler);
  }
  /**
   * Monta o router em um container e renderiza a rota atual.
   * CORREÇÃO: o briefing original só escutava `popstate` mas não renderizava
   * a rota inicial — a tela aparecia em branco ao abrir o app.
   */
  montar(container) {
    this.container = container;
    window.addEventListener("popstate", () => this.renderRota(location.pathname));
    this.renderRota(location.pathname);
  }
  /** Navega para uma rota via History API. */
  navegar(caminho) {
    history.pushState({}, "", caminho);
    this.renderRota(caminho);
  }
  renderRota(caminho) {
    const rota = this.rotas.get(caminho);
    if (!rota || !this.container) return;
    if (rota.requerPapel) {
      if (!this.usuarioAtual) {
        if (this.caminhoLogin && caminho !== this.caminhoLogin) {
          this.navegar(this.caminhoLogin);
        } else {
          this.container.innerHTML = "";
          const p = document.createElement("p");
          p.className = "jade-acesso-negado";
          p.textContent = "Acesso negado: fa\xE7a login para continuar.";
          this.container.appendChild(p);
        }
        return;
      }
      if (!this.usuarioAtual.roles.includes(rota.requerPapel)) {
        this.container.innerHTML = "";
        const p = document.createElement("p");
        p.className = "jade-acesso-negado";
        p.textContent = "Acesso negado: voc\xEA n\xE3o tem permiss\xE3o para acessar esta tela.";
        this.container.appendChild(p);
        return;
      }
    }
    if (this.telaAtiva) {
      disposeOwner(this.telaAtiva);
      this.memory.freeOwner(this.telaAtiva);
    }
    this.telaAtiva = rota.tela;
    this.store.set("rota.ativa", caminho);
    const handler = this.handlers.get(rota.tela);
    if (handler) {
      setEffectOwner(rota.tela);
      this.container.innerHTML = "";
      this.container.appendChild(handler());
      setEffectOwner(null);
    }
  }
  rotaAtiva() {
    return this.telaAtiva;
  }
};

// ui/responsive.ts
var BP_MOBILE = 640;
var CSS_ID = "jade-mobile-first";
var CSS_BASE = `
/* \u2500\u2500 Reset e base mobile-first \u2500\u2500 */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  font-size: 16px;
  line-height: 1.5;
  background: var(--jade-fundo, #f9fafb);
  color: var(--jade-texto, #111827);
  -webkit-text-size-adjust: 100%;
}

/* \u2500\u2500 Tela \u2500\u2500 */
.jade-tela {
  padding: 16px;
  max-width: 100%;
}
.jade-tela-titulo {
  font-size: 1.25rem;
  font-weight: 700;
  margin-bottom: 16px;
  color: var(--jade-texto, #111827);
}

/* \u2500\u2500 Toque m\xEDnimo 44px (briefing \xA72.1) \u2500\u2500 */
.jade-botao,
button,
[role="button"],
input[type="submit"],
input[type="button"] {
  min-height: 44px;
  min-width: 44px;
  padding: 10px 20px;
  font-size: 1rem;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  touch-action: manipulation;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.jade-botao-primario   { background: var(--jade-primaria, #2563eb); color: #fff; }
.jade-botao-secundario { background: transparent; border: 2px solid var(--jade-primaria, #2563eb); color: var(--jade-primaria, #2563eb); }
.jade-botao-perigo     { background: #dc2626; color: #fff; }
.jade-botao-sucesso    { background: #16a34a; color: #fff; }
.jade-botao:disabled   { opacity: 0.5; cursor: not-allowed; }
.jade-botao-carregando::after {
  content: '';
  display: inline-block;
  width: 14px; height: 14px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: jade-spin 0.6s linear infinite;
  margin-left: 8px;
}
@keyframes jade-spin { to { transform: rotate(360deg); } }

/* \u2500\u2500 Lista de cards (mobile \u2014 padr\xE3o base) \u2500\u2500 */
.jade-lista-cards {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.jade-card-item {
  background: #fff;
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 1px 3px rgba(0,0,0,.08);
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}
.jade-card-campo {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  font-size: 0.9375rem;
}
.jade-campo-label {
  font-weight: 600;
  color: var(--jade-texto-suave, #6b7280);
  white-space: nowrap;
}
.jade-campo-valor {
  color: var(--jade-texto, #111827);
  text-align: right;
  word-break: break-word;
}

/* \u2500\u2500 Grid de tabela (oculto no mobile \u2014 mostrado no desktop) \u2500\u2500 */
.jade-tabela-grid { display: none; }

/* \u2500\u2500 Controles de tabela \u2500\u2500 */
.jade-tabela-controles { margin-bottom: 12px; }
.jade-tabela-busca {
  width: 100%;
  min-height: 44px;
  padding: 10px 14px;
  border: 1.5px solid var(--jade-borda, #d1d5db);
  border-radius: 8px;
  font-size: 1rem;
  background: #fff;
}

/* \u2500\u2500 Pagina\xE7\xE3o \u2500\u2500 */
.jade-tabela-paginacao {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 0;
  flex-wrap: wrap;
}
.jade-pag-btn {
  min-height: 44px;
  min-width: 44px;
  padding: 8px 14px;
  border: 1.5px solid var(--jade-borda, #d1d5db);
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
  font-size: 0.9375rem;
}
.jade-pag-btn.ativo { background: var(--jade-primaria, #2563eb); color: #fff; border-color: transparent; }
.jade-pag-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* \u2500\u2500 Formul\xE1rio \u2500\u2500 */
.jade-formulario { display: flex; flex-direction: column; gap: 16px; }
.jade-campo { display: flex; flex-direction: column; gap: 6px; }
.jade-campo label { font-weight: 600; font-size: 0.9375rem; }
.jade-campo input,
.jade-campo select,
.jade-campo textarea {
  min-height: 44px;
  padding: 10px 14px;
  border: 1.5px solid var(--jade-borda, #d1d5db);
  border-radius: 8px;
  font-size: 1rem;
  background: #fff;
  width: 100%;
}
.jade-campo-msg-erro { font-size: 0.875rem; color: #dc2626; min-height: 1.25em; }

/* \u2500\u2500 Card de m\xE9trica \u2500\u2500 */
.jade-card {
  background: #fff;
  border-radius: 12px;
  padding: 20px;
  box-shadow: 0 1px 3px rgba(0,0,0,.08);
  margin-bottom: 12px;
}
.jade-card-titulo { font-size: 0.875rem; color: var(--jade-texto-suave, #6b7280); margin-bottom: 8px; }
.jade-card-valor  { font-size: 1.75rem; font-weight: 700; }

/* Variantes sem\xE2nticas de cart\xE3o */
.jade-card-destaque { border-left: 4px solid var(--jade-cor-primaria, #2563eb); background: var(--jade-cor-destaque, #dbeafe); }
.jade-card-sucesso  { border-left: 4px solid var(--jade-cor-sucesso, #16a34a);  background: #dcfce7; }
.jade-card-alerta   { border-left: 4px solid var(--jade-cor-aviso,   #d97706);  background: #fef9c3; }
.jade-card-perigo   { border-left: 4px solid var(--jade-cor-erro,    #dc2626);  background: #fee2e2; }

/* \u2500\u2500 Banner de notifica\xE7\xE3o (push) \u2500\u2500 */
.jade-banner-inner {
  height: 48px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 16px;
  border-left: 4px solid transparent;
  font-size: 0.875rem;
  font-weight: 500;
}
.jade-banner-sucesso { background: #f0fdf4; border-left-color: #16a34a; color: #15803d; }
.jade-banner-erro    { background: #fef2f2; border-left-color: #dc2626; color: #b91c1c; }
.jade-banner-aviso   { background: #fffbeb; border-left-color: #d97706; color: #b45309; }
.jade-banner-info    { background: #eff6ff; border-left-color: #2563eb; color: #1d4ed8; }
.jade-banner-msg { flex: 1; min-width: 0; }
.jade-banner-fechar {
  display: flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; flex-shrink: 0;
  border: none; background: transparent;
  cursor: pointer; border-radius: 4px;
  color: currentColor; opacity: 0.6;
  transition: opacity 0.15s, background 0.15s;
}
.jade-banner-fechar:hover { opacity: 1; background: rgba(0,0,0,0.06); }

/* \u2500\u2500 Skeleton \u2500\u2500 */
.jade-skeleton {
  background: linear-gradient(90deg, #f3f4f6 25%, #e5e7eb 50%, #f3f4f6 75%);
  background-size: 200% 100%;
  animation: jade-shimmer 1.4s infinite;
  border-radius: 6px;
}
.jade-skeleton-titulo { height: 28px; width: 40%; margin-bottom: 16px; }
.jade-skeleton-linha  { height: 56px; margin-bottom: 8px; }
@keyframes jade-shimmer { to { background-position: -200% 0; } }

/* \u2500\u2500 Vazio \u2500\u2500 */
.jade-tabela-vazio { text-align: center; padding: 32px; color: var(--jade-texto-suave, #6b7280); }

/* \u2500\u2500 Acorde\xE3o \u2500\u2500 */
.jade-acordeao {
  display: flex;
  flex-direction: column;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--jade-borda, #e5e7eb);
}
.jade-acordeao-item { border-bottom: 1px solid var(--jade-borda, #e5e7eb); }
.jade-acordeao-item:last-child { border-bottom: none; }
.jade-acordeao-header {
  width: 100%;
  min-height: 52px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  background: #fff;
  border: none;
  border-radius: 0;
  font-size: 0.9375rem;
  font-family: inherit;
  font-weight: 500;
  color: var(--jade-texto, #111827);
  cursor: pointer;
  text-align: left;
  transition: background 0.15s;
}
.jade-acordeao-header:hover { background: #f9fafb; }
.jade-acordeao-header-ativo { background: #f9fafb; color: var(--jade-primaria, #2563eb); }
.jade-acordeao-label { flex: 1; }
.jade-acordeao-chevron {
  font-size: 1.25rem;
  line-height: 1;
  color: var(--jade-texto-suave, #6b7280);
  transition: transform 0.25s ease;
  flex-shrink: 0;
}
.jade-acordeao-header-ativo .jade-acordeao-chevron { transform: rotate(90deg); }
/* Anima\xE7\xE3o de altura via CSS grid (funciona com altura desconhecida) */
.jade-acordeao-panel {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.25s ease;
  background: #fafafa;
}
.jade-acordeao-aberto { grid-template-rows: 1fr; }
.jade-acordeao-panel-inner {
  overflow: hidden;
  padding: 0 16px;
}
.jade-acordeao-aberto .jade-acordeao-panel-inner { padding: 16px; }

/* \u2500\u2500 Abas \u2500\u2500 */
.jade-abas { display: flex; flex-direction: column; }
.jade-abas-barra {
  display: flex;
  overflow-x: auto;
  border-bottom: 2px solid var(--jade-borda, #e5e7eb);
  scrollbar-width: none;
  -webkit-overflow-scrolling: touch;
  gap: 4px;
}
.jade-abas-barra::-webkit-scrollbar { display: none; }
.jade-aba-btn {
  flex-shrink: 0;
  min-height: 44px;
  padding: 10px 16px;
  background: none;
  border: none;
  border-bottom: 3px solid transparent;
  margin-bottom: -2px;
  font-size: 0.9375rem;
  font-family: inherit;
  color: var(--jade-texto-suave, #6b7280);
  cursor: pointer;
  white-space: nowrap;
  border-radius: 0;
  transition: color 0.15s, border-color 0.15s;
}
.jade-aba-btn:hover { color: var(--jade-primaria, #2563eb); }
.jade-aba-ativa {
  color: var(--jade-primaria, #2563eb) !important;
  border-bottom-color: var(--jade-primaria, #2563eb);
  font-weight: 600;
}
.jade-abas-conteudo { padding-top: 16px; }

/* \u2500\u2500 Lista com swipe \u2500\u2500 */
.jade-lista {
  display: flex;
  flex-direction: column;
  gap: 1px;
  background: var(--jade-borda, #e5e7eb);
  border-radius: 12px;
  overflow: hidden;
}
.jade-lista-row { position: relative; overflow: hidden; background: #fff; }
.jade-lista-inner {
  display: flex;
  align-items: center;
  padding: 14px 16px;
  background: #fff;
  transition: transform 0.25s ease;
  will-change: transform;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
  gap: 12px;
}
.jade-lista-content { flex: 1; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.jade-lista-label {
  font-size: 0.9375rem;
  font-weight: 500;
  color: var(--jade-texto, #111827);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.jade-lista-sub { font-size: 0.8125rem; color: var(--jade-texto-suave, #6b7280); }
.jade-lista-hint { font-size: 1rem; color: var(--jade-borda, #d1d5db); flex-shrink: 0; }
.jade-lista-vazio { text-align: center; padding: 32px; color: var(--jade-texto-suave, #6b7280); }
/* A\xE7\xF5es reveladas pelo swipe */
.jade-lista-acoes {
  position: absolute;
  right: 0; top: 0; bottom: 0;
  display: flex;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s;
}
.jade-lista-acoes-visivel { opacity: 1; pointer-events: auto; }
.jade-lista-acao {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border: none;
  cursor: pointer;
  color: #fff;
  font-size: 0;
  gap: 4px;
}
.jade-lista-acao-icone { font-size: 1.25rem; line-height: 1; }

/* \u2500\u2500 Gr\xE1fico \u2500\u2500 */
.jade-grafico-wrapper {
  background: #fff;
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 1px 3px rgba(0,0,0,.08);
  overflow: hidden;
}

/* \u2500\u2500 Modal \u2500\u2500 */
.jade-modal {
  border: none;
  border-radius: 16px;
  padding: 0;
  max-width: min(480px, calc(100vw - 32px));
  width: 100%;
  box-shadow: 0 20px 60px rgba(0,0,0,.2);
  outline: none;
}
.jade-modal::backdrop {
  background: rgba(0,0,0,.45);
  backdrop-filter: blur(2px);
}
.jade-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 20px 16px;
  border-bottom: 1px solid #f3f4f6;
}
.jade-modal-titulo {
  font-size: 1.125rem;
  font-weight: 700;
  color: #111827;
  margin: 0;
}

/* Variantes sem\xE2nticas de modal */
.jade-modal-header-alerta { background: #fef9c3; border-bottom-color: #fde68a; }
.jade-modal-header-alerta .jade-modal-titulo { color: #92400e; }
.jade-modal-header-perigo  { background: #fee2e2; border-bottom-color: #fecaca; }
.jade-modal-header-perigo  .jade-modal-titulo { color: #991b1b; }
.jade-modal-fechar {
  min-height: 32px;
  min-width: 32px;
  padding: 0;
  background: transparent;
  border: none;
  font-size: 1rem;
  color: #6b7280;
  cursor: pointer;
  border-radius: 6px;
}
.jade-modal-fechar:hover { background: #f3f4f6; color: #111827; }
.jade-modal-corpo {
  padding: 20px;
  font-size: 0.9375rem;
  color: #374151;
  line-height: 1.6;
}
.jade-modal-rodape {
  padding: 16px 20px 20px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* \u2500\u2500 Barra de navega\xE7\xE3o inferior (navegar) \u2500\u2500 */
.jade-navegar {
  position: fixed;
  bottom: 0; left: 0; right: 0;
  background: #fff;
  border-top: 1px solid var(--jade-borda, #e5e7eb);
  display: flex;
  z-index: 200;
  padding-bottom: env(safe-area-inset-bottom, 0px);
  box-shadow: 0 -1px 8px rgba(0,0,0,.06);
}
.jade-navegar-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 56px;
  padding: 6px 4px;
  font-size: 0.6875rem;
  font-weight: 500;
  color: var(--jade-texto-suave, #6b7280);
  gap: 3px;
  background: none;
  border: none;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
  transition: color 0.15s;
}
.jade-navegar-item.jade-navegar-ativa {
  color: var(--jade-primaria, #2563eb);
}
.jade-navegar-icone { display: flex; }
.jade-navegar-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
  text-align: center;
}

/* \u2500\u2500 Gaveta lateral (gaveta) \u2500\u2500 */
.jade-gaveta-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,.45);
  z-index: 300;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.25s;
}
.jade-gaveta-overlay-visivel {
  opacity: 1;
  pointer-events: auto;
}
.jade-gaveta {
  position: fixed;
  top: 0; left: 0; bottom: 0;
  width: min(280px, 85vw);
  background: #fff;
  z-index: 301;
  display: flex;
  flex-direction: column;
  box-shadow: 4px 0 24px rgba(0,0,0,.15);
  transform: translateX(-100%);
  transition: transform 0.25s cubic-bezier(.4,0,.2,1);
}
.jade-gaveta-aberta { transform: translateX(0); }
.jade-gaveta-cabecalho {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 16px 16px;
  border-bottom: 1px solid var(--jade-borda, #e5e7eb);
}
.jade-gaveta-titulo {
  font-size: 1rem;
  font-weight: 700;
  color: var(--jade-texto, #111827);
}
.jade-gaveta-fechar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px; height: 36px;
  border: none;
  background: none;
  color: var(--jade-texto-suave, #6b7280);
  cursor: pointer;
  border-radius: 6px;
}
.jade-gaveta-fechar:hover { background: var(--jade-fundo, #f3f4f6); }
.jade-gaveta-lista {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
  list-style: none;
}
.jade-gaveta-item {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 14px 20px;
  font-size: 0.9375rem;
  font-weight: 500;
  color: var(--jade-texto, #111827);
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  -webkit-tap-highlight-color: transparent;
  transition: background 0.15s;
}
.jade-gaveta-item:hover { background: var(--jade-fundo, #f3f4f6); }
.jade-gaveta-icone { color: var(--jade-texto-suave, #6b7280); flex-shrink: 0; }
.jade-gaveta-separador {
  height: 1px;
  background: var(--jade-borda, #e5e7eb);
  margin: 6px 0;
}
.jade-gaveta-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px; height: 40px;
  border: none;
  background: none;
  color: var(--jade-texto, #111827);
  cursor: pointer;
  border-radius: 8px;
  -webkit-tap-highlight-color: transparent;
}
.jade-gaveta-toggle:hover { background: var(--jade-fundo, #f3f4f6); }

/* \u2500\u2500 Desktop: a partir de 640px \u2500\u2500 */
@media (min-width: 640px) {
  .jade-tela { padding: 24px; max-width: 1200px; margin: 0 auto; }
  .jade-tela-titulo { font-size: 1.5rem; }

  /* Tabela: oculta lista de cards, mostra grid */
  .jade-lista-cards { display: none; }
  .jade-tabela-grid {
    display: table;
    width: 100%;
    border-collapse: collapse;
    background: #fff;
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 1px 3px rgba(0,0,0,.08);
  }
  .jade-tabela-grid th,
  .jade-tabela-grid td {
    padding: 12px 16px;
    text-align: left;
    border-bottom: 1px solid var(--jade-borda, #f3f4f6);
    font-size: 0.9375rem;
  }
  .jade-tabela-grid th {
    background: #f9fafb;
    font-weight: 600;
    color: var(--jade-texto-suave, #6b7280);
    white-space: nowrap;
  }
  .jade-tabela-grid th.ordenavel { cursor: pointer; user-select: none; }
  .jade-tabela-grid th.ordenavel:hover { background: #f3f4f6; }
  .jade-tabela-grid tbody tr:hover { background: #fafafa; }
  .jade-tabela-grid .jade-sort-icon { margin-left: 4px; opacity: 0.5; }

  /* Bottom nav oculta no desktop */
  .jade-navegar { display: none; }

  /* Formul\xE1rio em grid */
  .jade-formulario { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; }
}
`;
var Responsivo = class {
  mql;
  callbacks = [];
  constructor() {
    this.mql = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(`(max-width: ${BP_MOBILE - 1}px)`) : null;
    this.mql?.addEventListener("change", (e) => {
      this.callbacks.forEach((cb) => cb(e.matches));
    });
  }
  isMobile() {
    return this.mql?.matches ?? false;
  }
  /** Registra callback para mudança de breakpoint. Retorna função de cleanup. */
  observar(cb) {
    this.callbacks.push(cb);
    return () => {
      this.callbacks = this.callbacks.filter((c) => c !== cb);
    };
  }
  /**
   * Adapta uma tabela automaticamente:
   *   mobile  → lista de cards empilhados
   *   desktop → grid com colunas
   * Troca automaticamente quando o viewport muda.
   */
  adaptarTabela(config, wrapper, dados, termoBusca, paginaAtual) {
    const renderMobile = () => this._renderLista(config, wrapper, dados, termoBusca, paginaAtual);
    const renderDesktop = () => this._renderGrid(config, wrapper, dados, termoBusca, paginaAtual);
    const render = () => this.isMobile() ? renderMobile() : renderDesktop();
    render();
    this.observar(() => render());
  }
  /** Cria navegação adaptativa:
   *   mobile  → bottom navigation bar
   *   desktop → sidebar ou topbar (hidden, gerenciado pelo Router)
   */
  criarNavegacao(container, itens) {
    const nav = document.createElement("nav");
    nav.className = "jade-nav-bottom";
    nav.setAttribute("role", "navigation");
    nav.setAttribute("aria-label", "Navega\xE7\xE3o principal");
    for (const item of itens) {
      const a = document.createElement("a");
      a.className = "jade-nav-item" + (item.ativo ? " ativo" : "");
      a.href = item.caminho;
      a.addEventListener("click", (e) => {
        e.preventDefault();
        nav.querySelectorAll(".jade-nav-item").forEach((el2) => el2.classList.remove("ativo"));
        a.classList.add("ativo");
        window.history.pushState({}, "", item.caminho);
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      if (item.icone) {
        const icone = document.createElement("span");
        icone.className = "jade-nav-icone";
        icone.textContent = item.icone;
        a.appendChild(icone);
      }
      const label = document.createElement("span");
      label.textContent = item.label;
      a.appendChild(label);
      nav.appendChild(a);
    }
    container.appendChild(nav);
    return nav;
  }
  /** Injeta o CSS mobile-first base no <head> (idempotente). */
  injetarEstilos() {
    if (typeof document === "undefined") return;
    if (document.getElementById(CSS_ID)) return;
    const style = document.createElement("style");
    style.id = CSS_ID;
    style.textContent = CSS_BASE;
    document.head.appendChild(style);
  }
  // ── Renderização interna ────────────────────────────────────────────────────
  _renderLista(config, wrapper, dados, termoBusca, paginaAtual) {
    wrapper.querySelector(".jade-tabela-grid-wrapper")?.remove();
    let listaEl = wrapper.querySelector(".jade-lista-cards");
    if (!listaEl) {
      listaEl = document.createElement("div");
      listaEl.className = "jade-lista-cards";
      wrapper.appendChild(listaEl);
    }
    createEffect(() => {
      const termo = termoBusca.get();
      paginaAtual.get();
      const linhas = this._filtrarOrdenar(dados, config, termo, null, "asc");
      listaEl.innerHTML = "";
      if (linhas.length === 0) {
        const vazio = document.createElement("p");
        vazio.className = "jade-tabela-vazio";
        vazio.textContent = "Nenhum registro encontrado.";
        listaEl.appendChild(vazio);
        return;
      }
      linhas.forEach((item) => {
        const card = document.createElement("div");
        card.className = "jade-card-item";
        config.colunas.forEach((col) => {
          const campo = document.createElement("div");
          campo.className = "jade-card-campo";
          const labelEl = document.createElement("span");
          labelEl.className = "jade-campo-label";
          labelEl.textContent = col.titulo;
          const valorEl = document.createElement("span");
          valorEl.className = "jade-campo-valor";
          valorEl.textContent = String(item[col.campo] ?? "");
          campo.appendChild(labelEl);
          campo.appendChild(valorEl);
          card.appendChild(campo);
        });
        listaEl.appendChild(card);
      });
    });
  }
  _renderGrid(config, wrapper, dados, termoBusca, paginaAtual) {
    wrapper.querySelector(".jade-lista-cards")?.remove();
    let gridWrapper = wrapper.querySelector(".jade-tabela-grid-wrapper");
    if (gridWrapper) return;
    gridWrapper = document.createElement("div");
    gridWrapper.className = "jade-tabela-grid-wrapper";
    const campOrdem = new Signal(null);
    const direcaoOrdem = new Signal("asc");
    const table = document.createElement("table");
    table.className = "jade-tabela-grid";
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    config.colunas.forEach((col) => {
      const th = document.createElement("th");
      th.textContent = col.titulo;
      th.className = "ordenavel";
      const sortIcon = document.createElement("span");
      sortIcon.className = "jade-sort-icon";
      sortIcon.textContent = "\u2195";
      th.appendChild(sortIcon);
      th.addEventListener("click", () => {
        if (campOrdem.peek() === col.campo) {
          direcaoOrdem.set(direcaoOrdem.peek() === "asc" ? "desc" : "asc");
        } else {
          campOrdem.set(col.campo);
          direcaoOrdem.set("asc");
        }
        headerRow.querySelectorAll("th").forEach((t) => t.classList.remove("sort-asc", "sort-desc"));
        th.classList.add(direcaoOrdem.peek() === "asc" ? "sort-asc" : "sort-desc");
        sortIcon.textContent = direcaoOrdem.peek() === "asc" ? "\u2191" : "\u2193";
        paginaAtual.set(0);
      });
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    table.appendChild(tbody);
    gridWrapper.appendChild(table);
    const linhasPorPagina = config.paginacao === true ? 20 : typeof config.paginacao === "number" ? config.paginacao : 0;
    let paginacaoDiv = null;
    if (linhasPorPagina > 0) {
      paginacaoDiv = document.createElement("div");
      paginacaoDiv.className = "jade-tabela-paginacao";
      gridWrapper.appendChild(paginacaoDiv);
    }
    wrapper.appendChild(gridWrapper);
    createEffect(() => {
      const termo = termoBusca.get();
      const pagAtual = paginaAtual.get();
      campOrdem.get();
      direcaoOrdem.get();
      let linhas = this._filtrarOrdenar(dados, config, termo, campOrdem.peek(), direcaoOrdem.peek());
      if (linhasPorPagina > 0 && paginacaoDiv) {
        const total = Math.max(1, Math.ceil(linhas.length / linhasPorPagina));
        const pag = Math.min(pagAtual, total - 1);
        if (pag !== pagAtual) paginaAtual.set(pag);
        linhas = linhas.slice(pag * linhasPorPagina, (pag + 1) * linhasPorPagina);
        this._renderPaginacao(paginacaoDiv, pag, total, paginaAtual, () => {
        });
      }
      tbody.innerHTML = "";
      linhas.forEach((item) => {
        const tr = document.createElement("tr");
        config.colunas.forEach((col) => {
          const td = document.createElement("td");
          td.textContent = String(item[col.campo] ?? "");
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
    });
  }
  _filtrarOrdenar(dados, config, termo, campo, direcao) {
    let linhas = [...dados];
    if (termo) {
      linhas = linhas.filter(
        (item) => config.colunas.some(
          (col) => String(item[col.campo] ?? "").toLowerCase().includes(termo)
        )
      );
    }
    if (campo) {
      const dir = direcao === "asc" ? 1 : -1;
      linhas.sort((a, b) => {
        const va = a[campo] ?? "", vb = b[campo] ?? "";
        if (va < vb) return -1 * dir;
        if (va > vb) return 1 * dir;
        return 0;
      });
    }
    return linhas;
  }
  _renderPaginacao(container, paginaAtual, total, paginaSignal, atualizar) {
    container.innerHTML = "";
    const btn = (texto, pagina, desabilitado = false) => {
      const b = document.createElement("button");
      b.textContent = texto;
      b.className = `jade-pag-btn${pagina === paginaAtual ? " ativo" : ""}`;
      b.disabled = desabilitado;
      b.addEventListener("click", () => {
        paginaSignal.set(pagina);
        atualizar();
      });
      container.appendChild(b);
    };
    const info = document.createElement("span");
    info.textContent = `${paginaAtual + 1} / ${total}`;
    container.appendChild(info);
    btn("\u2190", paginaAtual - 1, paginaAtual === 0);
    const inicio = Math.max(0, paginaAtual - 2);
    const fim = Math.min(total, inicio + 5);
    for (let p = inicio; p < fim; p++) btn(String(p + 1), p);
    btn("\u2192", paginaAtual + 1, paginaAtual >= total - 1);
  }
};

// ui/grafico.ts
var SVG_NS = "http://www.w3.org/2000/svg";
var CORES = [
  "#2563eb",
  "#7c3aed",
  "#059669",
  "#d97706",
  "#dc2626",
  "#0891b2",
  "#65a30d",
  "#9333ea"
];
function el(tag, attrs = {}) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}
function txt(conteudo, attrs = {}) {
  const e = el("text", attrs);
  e.textContent = conteudo;
  return e;
}
function fmtNum(v) {
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + "k";
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}
function fmtLabel(s, maxLen = 7) {
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const [, m, d] = s.split("-");
    return `${d}/${m}`;
  }
  return s.length > maxLen ? s.slice(0, maxLen - 1) + "\u2026" : s;
}
var W = 400;
var H = 260;
var PAD = { top: 24, right: 20, bottom: 64, left: 54 };
var CW = W - PAD.left - PAD.right;
var CH = H - PAD.top - PAD.bottom;
function eixosGrid(vb, maxVal, minVal = 0) {
  const tickCount = 5;
  const range = maxVal - minVal || 1;
  for (let i = 0; i <= tickCount; i++) {
    const val = minVal + range * (i / tickCount);
    const y = PAD.top + CH - CH * i / tickCount;
    vb.appendChild(el("line", {
      x1: PAD.left,
      y1: y,
      x2: PAD.left + CW,
      y2: y,
      stroke: "#e5e7eb",
      "stroke-width": 1
    }));
    vb.appendChild(txt(fmtNum(val), {
      x: PAD.left - 6,
      y: y + 4,
      "font-size": 11,
      "text-anchor": "end",
      fill: "#6b7280"
    }));
  }
  vb.appendChild(el("line", {
    x1: PAD.left,
    y1: PAD.top + CH,
    x2: PAD.left + CW,
    y2: PAD.top + CH,
    stroke: "#d1d5db",
    "stroke-width": 1.5
  }));
  vb.appendChild(el("line", {
    x1: PAD.left,
    y1: PAD.top,
    x2: PAD.left,
    y2: PAD.top + CH,
    stroke: "#d1d5db",
    "stroke-width": 1.5
  }));
}
function renderBarras(dados, config, vb) {
  const campoX = config.eixoX ?? Object.keys(dados[0] ?? {})[0] ?? "nome";
  const campoY = config.eixoY ?? Object.keys(dados[0] ?? {})[1] ?? "valor";
  const valores = dados.map((d) => Number(d[campoY] ?? 0));
  const maxVal = Math.max(...valores, 0) || 1;
  eixosGrid(vb, maxVal);
  const n = dados.length;
  const barGap = CW / n;
  const barW = Math.min(barGap * 0.65, 52);
  dados.forEach((d, i) => {
    const val = Number(d[campoY] ?? 0);
    const bh = Math.max(val / maxVal * CH, 0);
    const cx = PAD.left + barGap * i + barGap / 2;
    const by = PAD.top + CH - bh;
    const label = String(d[campoX] ?? i);
    vb.appendChild(el("rect", {
      x: cx - barW / 2,
      y: by,
      width: barW,
      height: bh,
      rx: 4,
      fill: CORES[i % CORES.length],
      opacity: 0.85
    }));
    const labelFmt = fmtLabel(label);
    const labelEl = txt(labelFmt, {
      x: cx,
      y: PAD.top + CH + (n > 5 ? 6 : 14),
      "font-size": 10,
      "text-anchor": n > 5 ? "end" : "middle",
      fill: "#6b7280"
    });
    if (n > 5) labelEl.setAttribute("transform", `rotate(-40 ${cx} ${PAD.top + CH + 6})`);
    vb.appendChild(labelEl);
    if (bh > 18) {
      vb.appendChild(txt(fmtNum(val), {
        x: cx,
        y: by - 5,
        "font-size": 10,
        "text-anchor": "middle",
        fill: "#374151",
        "font-weight": 600
      }));
    }
  });
}
function renderLinha(dados, config, vb) {
  const campoX = config.eixoX ?? Object.keys(dados[0] ?? {})[0] ?? "nome";
  const campoY = config.eixoY ?? Object.keys(dados[0] ?? {})[1] ?? "valor";
  const valores = dados.map((d) => Number(d[campoY] ?? 0));
  const maxVal = Math.max(...valores, 0) || 1;
  const minVal = Math.min(...valores, 0);
  eixosGrid(vb, maxVal, minVal);
  const range = maxVal - minVal || 1;
  const n = dados.length;
  const pts = dados.map((d, i) => ({
    x: PAD.left + CW * i / Math.max(n - 1, 1),
    y: PAD.top + CH - (Number(d[campoY] ?? 0) - minVal) / range * CH,
    val: Number(d[campoY] ?? 0),
    label: String(d[campoX] ?? i)
  }));
  vb.appendChild(el("polygon", {
    points: [
      `${PAD.left},${PAD.top + CH}`,
      ...pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`),
      `${pts[n - 1].x.toFixed(1)},${PAD.top + CH}`
    ].join(" "),
    fill: CORES[0],
    opacity: 0.08
  }));
  vb.appendChild(el("polyline", {
    points: pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "),
    fill: "none",
    stroke: CORES[0],
    "stroke-width": 2.5,
    "stroke-linejoin": "round",
    "stroke-linecap": "round"
  }));
  pts.forEach((p) => {
    vb.appendChild(el("circle", {
      cx: p.x.toFixed(1),
      cy: p.y.toFixed(1),
      r: 4,
      fill: "#fff",
      stroke: CORES[0],
      "stroke-width": 2
    }));
    const labelFmt = fmtLabel(p.label);
    const labelEl = txt(labelFmt, {
      x: p.x.toFixed(1),
      y: PAD.top + CH + (n > 5 ? 6 : 14),
      "font-size": 10,
      "text-anchor": n > 5 ? "end" : "middle",
      fill: "#6b7280"
    });
    if (n > 5) labelEl.setAttribute("transform", `rotate(-40 ${p.x.toFixed(1)} ${PAD.top + CH + 6})`);
    vb.appendChild(labelEl);
  });
}
function renderPizza(dados, config, vb) {
  const campoX = config.eixoX ?? Object.keys(dados[0] ?? {})[0] ?? "nome";
  const campoY = config.eixoY ?? Object.keys(dados[0] ?? {})[1] ?? "valor";
  const CX = 140, CY = 130, R = 100;
  const itens = dados.map((d, i) => ({
    label: String(d[campoX] ?? i),
    val: Math.abs(Number(d[campoY] ?? 0)),
    cor: CORES[i % CORES.length]
  }));
  const total = itens.reduce((s, it) => s + it.val, 0) || 1;
  let angulo = -Math.PI / 2;
  itens.forEach((it) => {
    const slice = it.val / total * Math.PI * 2;
    const x1 = CX + R * Math.cos(angulo);
    const y1 = CY + R * Math.sin(angulo);
    const x2 = CX + R * Math.cos(angulo + slice);
    const y2 = CY + R * Math.sin(angulo + slice);
    const large = slice > Math.PI ? 1 : 0;
    vb.appendChild(el("path", {
      d: `M${CX},${CY} L${x1.toFixed(1)},${y1.toFixed(1)} A${R},${R} 0 ${large},1 ${x2.toFixed(1)},${y2.toFixed(1)} Z`,
      fill: it.cor,
      stroke: "#fff",
      "stroke-width": 2
    }));
    angulo += slice;
  });
  const LX = 262, LY0 = 28, LH = 22;
  itens.slice(0, 8).forEach((it, i) => {
    const y = LY0 + i * LH;
    const pct = (it.val / total * 100).toFixed(1) + "%";
    vb.appendChild(el("rect", { x: LX, y: y - 10, width: 12, height: 12, rx: 2, fill: it.cor }));
    const label = it.label.length > 14 ? it.label.slice(0, 13) + "\u2026" : it.label;
    vb.appendChild(txt(`${label} (${pct})`, {
      x: LX + 16,
      y,
      "font-size": 11,
      fill: "#374151"
    }));
  });
}
var MSG_SEM_DADOS = "Sem dados para exibir";
function criarGraficoSVG(config, dados) {
  const wrapper = document.createElement("div");
  wrapper.className = "jade-grafico-wrapper";
  const svgEl = document.createElementNS(SVG_NS, "svg");
  svgEl.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svgEl.setAttribute("role", "img");
  svgEl.setAttribute("aria-label", `Gr\xE1fico ${config.tipo}`);
  svgEl.style.cssText = "width:100%;height:auto;display:block;";
  svgEl.appendChild(el("rect", { width: W, height: H, rx: 0, fill: "transparent" }));
  if (dados.length === 0) {
    svgEl.appendChild(txt(MSG_SEM_DADOS, {
      x: W / 2,
      y: H / 2,
      "font-size": 14,
      "text-anchor": "middle",
      fill: "#9ca3af"
    }));
  } else {
    switch (config.tipo) {
      case "barras":
        renderBarras(dados, config, svgEl);
        break;
      case "linha":
        renderLinha(dados, config, svgEl);
        break;
      case "pizza":
        renderPizza(dados, config, svgEl);
        break;
    }
  }
  wrapper.appendChild(svgEl);
  return wrapper;
}

// ui/modal.ts
var ModalManager = class {
  modais = /* @__PURE__ */ new Map();
  /**
   * Cria um <dialog> oculto no body e o registra pelo nome do elemento.
   * O modal só abre quando `abrir(nome)` for chamado.
   */
  criar(nome, config, telaAtiva) {
    const dialog = document.createElement("dialog");
    dialog.className = "jade-modal";
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", `jade-modal-titulo-${nome}`);
    if (telaAtiva) dialog.dataset.tela = telaAtiva;
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog.close();
    });
    const header = document.createElement("div");
    header.className = "jade-modal-header";
    const titulo = document.createElement("h2");
    titulo.id = `jade-modal-titulo-${nome}`;
    titulo.className = "jade-modal-titulo";
    titulo.textContent = config.titulo;
    const btnFechar = document.createElement("button");
    btnFechar.className = "jade-modal-fechar";
    btnFechar.setAttribute("aria-label", "Fechar");
    btnFechar.textContent = "\u2715";
    btnFechar.addEventListener("click", () => dialog.close());
    if (config.variante && config.variante !== "info") {
      header.classList.add(`jade-modal-header-${config.variante}`);
    }
    header.appendChild(titulo);
    header.appendChild(btnFechar);
    dialog.appendChild(header);
    if (config.mensagem) {
      const corpo = document.createElement("div");
      corpo.className = "jade-modal-corpo";
      corpo.textContent = config.mensagem;
      dialog.appendChild(corpo);
    }
    const rodape = document.createElement("div");
    rodape.className = "jade-modal-rodape";
    const btnOk = document.createElement("button");
    btnOk.className = "jade-botao jade-botao-primario";
    btnOk.textContent = "OK";
    btnOk.addEventListener("click", () => dialog.close());
    rodape.appendChild(btnOk);
    dialog.appendChild(rodape);
    document.body.appendChild(dialog);
    this.modais.set(nome, dialog);
    return dialog;
  }
  abrir(nome) {
    const dialog = this.modais.get(nome);
    if (dialog) dialog.showModal();
    else console.warn(`[JADE] Modal '${nome}' n\xE3o encontrado.`);
  }
  fechar(nome) {
    this.modais.get(nome)?.close();
  }
  /** Remove todos os modais do DOM e limpa o registro. */
  limpar() {
    for (const dialog of this.modais.values()) {
      if (dialog.open) dialog.close();
      dialog.remove();
    }
    this.modais.clear();
  }
};

// ui/abas.ts
function criarAbas(config, container) {
  const wrapper = document.createElement("div");
  wrapper.className = "jade-abas";
  const barra = document.createElement("div");
  barra.className = "jade-abas-barra";
  barra.setAttribute("role", "tablist");
  barra.setAttribute("aria-label", config.nome);
  const conteudo = document.createElement("div");
  conteudo.className = "jade-abas-conteudo";
  conteudo.id = `jade-abas-${config.nome}`;
  const ativar = (index) => {
    barra.querySelectorAll(".jade-aba-btn").forEach((btn, i) => {
      const ativo = i === index;
      btn.classList.toggle("jade-aba-ativa", ativo);
      btn.setAttribute("aria-selected", String(ativo));
      btn.setAttribute("tabindex", ativo ? "0" : "-1");
    });
    conteudo.innerHTML = "";
    window.dispatchEvent(new CustomEvent("jade:aba", {
      detail: {
        nome: config.nome,
        aba: config.abas[index],
        index,
        tela: config.tela,
        container: conteudo
      }
    }));
  };
  config.abas.forEach((aba, i) => {
    const btn = document.createElement("button");
    btn.className = "jade-aba-btn" + (i === 0 ? " jade-aba-ativa" : "");
    btn.textContent = aba;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", String(i === 0));
    btn.setAttribute("tabindex", i === 0 ? "0" : "-1");
    btn.addEventListener("click", () => ativar(i));
    btn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") {
        const next = (i + 1) % config.abas.length;
        ativar(next);
        barra.querySelectorAll(".jade-aba-btn")[next]?.focus();
      } else if (e.key === "ArrowLeft") {
        const prev = (i - 1 + config.abas.length) % config.abas.length;
        ativar(prev);
        barra.querySelectorAll(".jade-aba-btn")[prev]?.focus();
      }
    });
    barra.appendChild(btn);
  });
  wrapper.appendChild(barra);
  wrapper.appendChild(conteudo);
  container.appendChild(wrapper);
  if (config.abas.length > 0) ativar(0);
  return conteudo;
}

// ui/icones.ts
var CATALOGO = {
  // ── Navegação ────────────────────────────────────────────────────────────
  casa: `<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>`,
  voltar: `<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>`,
  proximo: `<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>`,
  acima: `<polyline points="18 15 12 9 6 15"/>`,
  abaixo: `<polyline points="6 9 12 15 18 9"/>`,
  menu: `<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>`,
  fechar: `<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>`,
  busca: `<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>`,
  // ── Pessoas ──────────────────────────────────────────────────────────────
  usuario: `<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>`,
  usuarios: `<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>`,
  // ── Dados e conteúdo ─────────────────────────────────────────────────────
  grafico: `<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>`,
  relatorio: `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>`,
  tabela_icone: `<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/>`,
  lista_icone: `<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>`,
  pasta: `<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>`,
  imagem: `<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>`,
  // ── Ações CRUD ───────────────────────────────────────────────────────────
  mais: `<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>`,
  menos: `<line x1="5" y1="12" x2="19" y2="12"/>`,
  editar: `<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>`,
  excluir: `<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>`,
  salvar: `<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>`,
  copiar: `<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>`,
  compartilhar: `<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>`,
  atualizar: `<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>`,
  // ── Estoque / Negócio ────────────────────────────────────────────────────
  caixa: `<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>`,
  carrinho: `<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>`,
  dinheiro: `<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>`,
  cartao_credito: `<rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/>`,
  etiqueta: `<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>`,
  // ── Sistema ──────────────────────────────────────────────────────────────
  configuracoes: `<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>`,
  notificacao: `<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>`,
  cadeado: `<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>`,
  sair: `<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>`,
  // ── Tempo e localização ──────────────────────────────────────────────────
  calendario: `<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>`,
  relogio: `<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>`,
  localizacao: `<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>`,
  // ── Comunicação ──────────────────────────────────────────────────────────
  telefone: `<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.15 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9a16 16 0 0 0 6.91 6.91l.35-.35a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>`,
  email: `<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>`,
  // ── Feedback / Status ────────────────────────────────────────────────────
  info: `<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>`,
  aviso: `<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>`,
  sucesso_icone: `<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>`,
  erro_icone: `<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>`,
  estrela: `<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>`,
  favorito: `<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>`
};
function criarElementoIcone(nome, tamanho = 20) {
  const conteudo = CATALOGO[nome.toLowerCase()];
  if (!conteudo) return null;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(tamanho));
  svg.setAttribute("height", String(tamanho));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = conteudo;
  return svg;
}
function listarIcones() {
  return Object.keys(CATALOGO).sort();
}

// ui/lista.ts
var ICONE_ACAO = {
  excluir: "excluir",
  editar: "editar",
  arquivar: "caixa",
  duplicar: "copiar",
  compartilhar: "compartilhar",
  salvar: "salvar"
};
var COR_ACAO = {
  excluir: "#dc2626",
  editar: "#2563eb",
  arquivar: "#d97706",
  duplicar: "#059669"
};
var LARGURA_ACAO = 72;
function criarLista(config, dados, container, tela) {
  const wrapper = document.createElement("div");
  wrapper.className = "jade-lista";
  if (dados.length === 0) {
    const vazio = document.createElement("p");
    vazio.className = "jade-lista-vazio";
    vazio.textContent = "Nenhum registro encontrado.";
    wrapper.appendChild(vazio);
    container.appendChild(wrapper);
    return;
  }
  const campoLabel = config.campo ?? Object.keys(dados[0] ?? {}).find((k) => k !== "id" && k !== "_id") ?? "id";
  const maxOffset = LARGURA_ACAO * (config.deslizar?.length ?? 0);
  dados.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "jade-lista-row";
    if (config.deslizar && config.deslizar.length > 0) {
      const acoes = document.createElement("div");
      acoes.className = "jade-lista-acoes";
      acoes.style.width = `${maxOffset}px`;
      config.deslizar.forEach((acao) => {
        const btn = document.createElement("button");
        btn.className = "jade-lista-acao";
        btn.style.background = COR_ACAO[acao] ?? "#6b7280";
        btn.style.width = `${LARGURA_ACAO}px`;
        const iconeWrapper = document.createElement("span");
        iconeWrapper.className = "jade-lista-acao-icone";
        const nomeIcone = ICONE_ACAO[acao];
        const iconeEl = nomeIcone ? criarElementoIcone(nomeIcone, 20) : null;
        if (iconeEl) {
          iconeWrapper.appendChild(iconeEl);
        } else {
          iconeWrapper.textContent = acao.slice(0, 3);
        }
        btn.appendChild(iconeWrapper);
        btn.setAttribute("aria-label", acao);
        btn.addEventListener("click", () => {
          _fecharSwipe(inner, acoes);
          window.dispatchEvent(new CustomEvent("jade:acao", {
            detail: { acao, entidade: config.entidade, item, index, tela }
          }));
        });
        acoes.appendChild(btn);
      });
      row.appendChild(acoes);
    }
    const inner = document.createElement("div");
    inner.className = "jade-lista-inner";
    const content = document.createElement("div");
    content.className = "jade-lista-content";
    const labelEl = document.createElement("span");
    labelEl.className = "jade-lista-label";
    labelEl.textContent = String(item[campoLabel] ?? "");
    content.appendChild(labelEl);
    if (config.subcampo) {
      const sub = document.createElement("span");
      sub.className = "jade-lista-sub";
      sub.textContent = String(item[config.subcampo] ?? "");
      content.appendChild(sub);
    }
    inner.appendChild(content);
    if (maxOffset > 0) {
      const hint = document.createElement("span");
      hint.className = "jade-lista-hint";
      hint.textContent = "\u2039";
      hint.setAttribute("aria-hidden", "true");
      inner.appendChild(hint);
      _aplicarSwipe(inner, row.querySelector(".jade-lista-acoes"), maxOffset);
    }
    row.appendChild(inner);
    wrapper.appendChild(row);
  });
  container.appendChild(wrapper);
}
function _fecharSwipe(inner, acoes) {
  inner.style.transition = "transform 0.25s ease";
  inner.style.transform = "";
  acoes.classList.remove("jade-lista-acoes-visivel");
}
function _aplicarSwipe(inner, acoes, maxOffset) {
  let startX = 0;
  let currentX = 0;
  let swiping = false;
  let aberto = false;
  const onStart = (x) => {
    startX = x;
    swiping = true;
    inner.style.transition = "none";
  };
  const onMove = (x) => {
    if (!swiping) return;
    const dx = x - startX;
    const base = aberto ? -maxOffset : 0;
    currentX = Math.max(-maxOffset, Math.min(0, base + dx));
    inner.style.transform = `translateX(${currentX}px)`;
    acoes.classList.toggle("jade-lista-acoes-visivel", currentX < -8);
  };
  const onEnd = () => {
    if (!swiping) return;
    swiping = false;
    inner.style.transition = "transform 0.25s ease";
    if (currentX < -(maxOffset / 2)) {
      inner.style.transform = `translateX(${-maxOffset}px)`;
      acoes.classList.add("jade-lista-acoes-visivel");
      aberto = true;
    } else {
      inner.style.transform = "";
      acoes.classList.remove("jade-lista-acoes-visivel");
      aberto = false;
    }
  };
  inner.addEventListener("touchstart", (e) => onStart(e.touches[0].clientX), { passive: true });
  inner.addEventListener("touchmove", (e) => onMove(e.touches[0].clientX), { passive: true });
  inner.addEventListener("touchend", onEnd);
  inner.addEventListener("mousedown", (e) => {
    e.preventDefault();
    onStart(e.clientX);
  });
  const onMouseMove = (e) => {
    if (swiping) onMove(e.clientX);
  };
  const onMouseUp = () => {
    if (swiping) onEnd();
  };
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
}

// ui/acordeao.ts
function criarAcordeao(config, container) {
  const wrapper = document.createElement("div");
  wrapper.className = "jade-acordeao";
  let secaoAberta = null;
  config.secoes.forEach((titulo, i) => {
    const item = document.createElement("div");
    item.className = "jade-acordeao-item";
    const header = document.createElement("button");
    header.className = "jade-acordeao-header";
    header.setAttribute("aria-expanded", "false");
    header.setAttribute("aria-controls", `jade-acordeao-${config.nome}-${i}`);
    const labelEl = document.createElement("span");
    labelEl.className = "jade-acordeao-label";
    labelEl.textContent = titulo;
    const chevron = document.createElement("span");
    chevron.className = "jade-acordeao-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "\u203A";
    header.appendChild(labelEl);
    header.appendChild(chevron);
    const panel = document.createElement("div");
    panel.className = "jade-acordeao-panel";
    panel.id = `jade-acordeao-${config.nome}-${i}`;
    panel.setAttribute("role", "region");
    const inner = document.createElement("div");
    inner.className = "jade-acordeao-panel-inner";
    panel.appendChild(inner);
    const abrir = () => {
      inner.innerHTML = "";
      panel.classList.add("jade-acordeao-aberto");
      header.setAttribute("aria-expanded", "true");
      header.classList.add("jade-acordeao-header-ativo");
      window.dispatchEvent(new CustomEvent("jade:acordeao", {
        detail: {
          nome: config.nome,
          secao: titulo,
          index: i,
          tela: config.tela,
          container: inner,
          aberto: true
        }
      }));
    };
    const fechar = () => {
      panel.classList.remove("jade-acordeao-aberto");
      header.setAttribute("aria-expanded", "false");
      header.classList.remove("jade-acordeao-header-ativo");
      window.dispatchEvent(new CustomEvent("jade:acordeao", {
        detail: { nome: config.nome, secao: titulo, index: i, tela: config.tela, aberto: false }
      }));
    };
    header.addEventListener("click", () => {
      const estaAberto = secaoAberta === i;
      if (secaoAberta !== null && secaoAberta !== i) {
        const itemAnterior = wrapper.children[secaoAberta];
        itemAnterior?.querySelector(".jade-acordeao-panel")?.classList.remove("jade-acordeao-aberto");
        itemAnterior?.querySelector(".jade-acordeao-header")?.setAttribute("aria-expanded", "false");
        itemAnterior?.querySelector(".jade-acordeao-header")?.classList.remove("jade-acordeao-header-ativo");
      }
      if (estaAberto) {
        fechar();
        secaoAberta = null;
      } else {
        abrir();
        secaoAberta = i;
      }
    });
    item.appendChild(header);
    item.appendChild(panel);
    wrapper.appendChild(item);
  });
  container.appendChild(wrapper);
}

// ui/navegar.ts
function criarNavegacao(config, telaAtiva) {
  const id = `jade-nav-${config.nome}`;
  const existente = document.getElementById(id);
  if (existente) {
    if (telaAtiva) ativarNavAba(existente, telaAtiva);
    return existente;
  }
  const nav = document.createElement("nav");
  nav.id = id;
  nav.className = "jade-navegar";
  nav.setAttribute("role", "tablist");
  nav.setAttribute("aria-label", "Navega\xE7\xE3o principal");
  config.abas.forEach((aba, index) => {
    const btn = document.createElement("button");
    btn.className = "jade-navegar-item";
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", index === 0 ? "true" : "false");
    btn.setAttribute("aria-label", aba.label);
    btn.dataset.tela = aba.tela;
    if (aba.icone) {
      const iconeEl = criarElementoIcone(aba.icone, 22);
      if (iconeEl) {
        iconeEl.classList.add("jade-navegar-icone");
        btn.appendChild(iconeEl);
      }
    }
    const labelEl = document.createElement("span");
    labelEl.className = "jade-navegar-label";
    labelEl.textContent = aba.label;
    btn.appendChild(labelEl);
    if (index === 0) btn.classList.add("jade-navegar-ativa");
    btn.addEventListener("click", () => {
      nav.querySelectorAll(".jade-navegar-item").forEach((el2) => {
        el2.classList.remove("jade-navegar-ativa");
        el2.setAttribute("aria-selected", "false");
      });
      btn.classList.add("jade-navegar-ativa");
      btn.setAttribute("aria-selected", "true");
      window.dispatchEvent(new CustomEvent("jade:navegar", {
        detail: { tela: aba.tela, nome: config.nome }
      }));
    });
    nav.appendChild(btn);
  });
  document.body.appendChild(nav);
  return nav;
}
function ativarNavAba(nav, tela) {
  nav.querySelectorAll(".jade-navegar-item").forEach((btn) => {
    const ativa = btn.dataset.tela === tela;
    btn.classList.toggle("jade-navegar-ativa", ativa);
    btn.setAttribute("aria-selected", String(ativa));
  });
}

// ui/gaveta.ts
function criarGaveta(config) {
  const id = `jade-gaveta-${config.nome}`;
  const painelExistente = document.getElementById(id);
  if (painelExistente) {
    const overlayExistente = document.getElementById(`${id}-overlay`);
    const novoToggle = document.createElement("button");
    novoToggle.id = `${id}-toggle`;
    novoToggle.className = "jade-gaveta-toggle";
    novoToggle.setAttribute("aria-label", "Abrir menu");
    novoToggle.setAttribute("aria-expanded", "false");
    novoToggle.setAttribute("aria-controls", id);
    const iconeMenuReutilizado = criarElementoIcone("menu", 22);
    if (iconeMenuReutilizado) novoToggle.appendChild(iconeMenuReutilizado);
    const handleReutilizado = _handle(painelExistente, overlayExistente, novoToggle);
    novoToggle.addEventListener("click", handleReutilizado.toggle);
    return handleReutilizado;
  }
  const overlay = document.createElement("div");
  overlay.id = `${id}-overlay`;
  overlay.className = "jade-gaveta-overlay";
  overlay.setAttribute("aria-hidden", "true");
  const painel = document.createElement("aside");
  painel.id = id;
  painel.className = "jade-gaveta";
  painel.setAttribute("role", "dialog");
  painel.setAttribute("aria-modal", "true");
  painel.setAttribute("aria-label", config.nome);
  painel.setAttribute("hidden", "");
  const cabecalho = document.createElement("div");
  cabecalho.className = "jade-gaveta-cabecalho";
  const titulo = document.createElement("span");
  titulo.className = "jade-gaveta-titulo";
  titulo.textContent = config.nome;
  cabecalho.appendChild(titulo);
  const btnFechar = document.createElement("button");
  btnFechar.className = "jade-gaveta-fechar";
  btnFechar.setAttribute("aria-label", "Fechar menu");
  const iconeFechar = criarElementoIcone("fechar", 20);
  if (iconeFechar) btnFechar.appendChild(iconeFechar);
  cabecalho.appendChild(btnFechar);
  painel.appendChild(cabecalho);
  const lista = document.createElement("ul");
  lista.className = "jade-gaveta-lista";
  lista.setAttribute("role", "list");
  config.itens.forEach((item) => {
    if (item.tipo === "separador") {
      const sep = document.createElement("li");
      sep.className = "jade-gaveta-separador";
      sep.setAttribute("role", "separator");
      lista.appendChild(sep);
      return;
    }
    const li = document.createElement("li");
    li.setAttribute("role", "listitem");
    const btn = document.createElement("button");
    btn.className = "jade-gaveta-item";
    if (item.icone) {
      const iconeEl = criarElementoIcone(item.icone, 20);
      if (iconeEl) {
        iconeEl.classList.add("jade-gaveta-icone");
        btn.appendChild(iconeEl);
      }
    }
    const labelEl = document.createElement("span");
    labelEl.textContent = item.label ?? "";
    btn.appendChild(labelEl);
    btn.addEventListener("click", () => {
      fechar();
      if (item.acao) {
        window.dispatchEvent(new CustomEvent("jade:acao", {
          detail: { acao: item.acao, nome: config.nome }
        }));
      } else if (item.tela) {
        window.dispatchEvent(new CustomEvent("jade:navegar", {
          detail: { tela: item.tela, nome: config.nome }
        }));
      }
    });
    li.appendChild(btn);
    lista.appendChild(li);
  });
  painel.appendChild(lista);
  const btnToggle = document.createElement("button");
  btnToggle.id = `${id}-toggle`;
  btnToggle.className = "jade-gaveta-toggle";
  btnToggle.setAttribute("aria-label", "Abrir menu");
  btnToggle.setAttribute("aria-expanded", "false");
  btnToggle.setAttribute("aria-controls", id);
  const iconeMenu = criarElementoIcone("menu", 22);
  if (iconeMenu) btnToggle.appendChild(iconeMenu);
  document.body.appendChild(overlay);
  document.body.appendChild(painel);
  const handle = _handle(painel, overlay, btnToggle);
  btnToggle.addEventListener("click", handle.toggle);
  btnFechar.addEventListener("click", handle.fechar);
  overlay.addEventListener("click", handle.fechar);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !painel.hasAttribute("hidden")) handle.fechar();
  });
  return handle;
  function fechar() {
    handle.fechar();
  }
}
function _handle(painel, overlay, btnToggle) {
  const abrir = () => {
    painel.removeAttribute("hidden");
    painel.classList.add("jade-gaveta-aberta");
    overlay.classList.add("jade-gaveta-overlay-visivel");
    btnToggle.setAttribute("aria-expanded", "true");
    const primeiro = painel.querySelector("button, [href], [tabindex]");
    primeiro?.focus();
  };
  const fechar = () => {
    painel.classList.remove("jade-gaveta-aberta");
    overlay.classList.remove("jade-gaveta-overlay-visivel");
    btnToggle.setAttribute("aria-expanded", "false");
    painel.addEventListener("transitionend", () => {
      if (!painel.classList.contains("jade-gaveta-aberta")) {
        painel.setAttribute("hidden", "");
      }
    }, { once: true });
    btnToggle.focus();
  };
  const toggle = () => {
    painel.hasAttribute("hidden") || !painel.classList.contains("jade-gaveta-aberta") ? abrir() : fechar();
  };
  return { abrir, fechar, toggle, botaoToggle: btnToggle };
}

// ui/ui_engine.ts
var UIEngine = class {
  store;
  refs;
  memory;
  router;
  responsivo;
  modais;
  telaAtiva = null;
  bannerTimer = null;
  filtrosPorTela = /* @__PURE__ */ new Map();
  acoesPendentes = /* @__PURE__ */ new Map();
  constructor(memory, tema) {
    this.memory = memory;
    this.store = new Store();
    this.refs = new RefManager();
    this.router = new Router(this.store, memory);
    this.responsivo = new Responsivo();
    this.modais = new ModalManager();
    if (typeof document !== "undefined") {
      aplicarTema(tema);
      this.responsivo.injetarEstilos();
    }
    window.addEventListener("jade:acao:concluido", ((e) => {
      if (e.detail?.acao) this.concluirAcao(e.detail.acao);
    }));
  }
  // ── Gestão de telas ───────────────────────────────────────────────────────
  /**
   * Monta uma nova tela no container.
   * CORREÇÃO: ao trocar de tela, os efeitos reativos e dados da tela anterior
   * são descartados para evitar vazamento de memória e atualizações fantasma.
   */
  montarTela(config, container) {
    if (this.telaAtiva) {
      disposeOwner(this.telaAtiva);
      this.memory.freeOwner(this.telaAtiva);
      this.store.clearNamespace(this.telaAtiva + ".");
      this.refs.limpar();
      this.modais.limpar();
      this.acoesPendentes.clear();
    }
    this.telaAtiva = config.nome;
    container.innerHTML = "";
    container.dataset.tela = config.nome;
    const div = document.createElement("div");
    div.className = "jade-tela";
    if (config.titulo) {
      const h1 = document.createElement("h1");
      h1.className = "jade-tela-titulo";
      h1.textContent = config.titulo;
      div.appendChild(h1);
    }
    container.appendChild(div);
    return div;
  }
  // ── Tabela ────────────────────────────────────────────────────────────────
  /**
   * Cria uma tabela com layout adaptativo mobile-first.
   *   mobile  → lista de cards empilhados (responsivo.ts)
   *   desktop → grid com colunas, ordenação, paginação (responsivo.ts)
   * O runtime decide automaticamente — o usuário não controla o layout.
   */
  /** Retorna o Signal de filtro de busca para uma tela, se ela tiver tabela filtrável. */
  getFiltroPorTela(nome) {
    return this.filtrosPorTela.get(nome);
  }
  criarTabela(config, container, dados, filtroBusca) {
    setEffectOwner(this.telaAtiva);
    const wrapper = document.createElement("div");
    wrapper.className = "jade-tabela-wrapper";
    if (config.altura) wrapper.style.maxHeight = config.altura;
    const termoBusca = filtroBusca ?? new Signal("");
    const paginaAtual = new Signal(0);
    if (config.filtravel && !filtroBusca) {
      const controles = document.createElement("div");
      controles.className = "jade-tabela-controles";
      const busca = document.createElement("input");
      busca.type = "search";
      busca.placeholder = "Buscar...";
      busca.className = "jade-tabela-busca";
      busca.setAttribute("aria-label", "Buscar na tabela");
      busca.addEventListener("input", () => {
        termoBusca.set(busca.value.toLowerCase());
        paginaAtual.set(0);
      });
      controles.appendChild(busca);
      wrapper.appendChild(controles);
    }
    container.appendChild(wrapper);
    this.responsivo.adaptarTabela(config, wrapper, dados, termoBusca, paginaAtual);
    setEffectOwner(null);
  }
  // ── Formulário ────────────────────────────────────────────────────────────
  criarFormulario(config, container) {
    setEffectOwner(this.telaAtiva);
    const form = document.createElement("form");
    form.className = "jade-formulario";
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (config.enviar) {
        window.dispatchEvent(new CustomEvent("jade:acao", { detail: { acao: config.enviar, tela: this.telaAtiva } }));
      }
    });
    const signals = {};
    config.campos.forEach((campo) => {
      const wrapper = document.createElement("div");
      wrapper.className = "jade-campo";
      const label = document.createElement("label");
      label.textContent = campo.titulo + (campo.obrigatorio ? " *" : "");
      wrapper.appendChild(label);
      let input;
      if (campo.tipo === "select" && campo.opcoes) {
        input = document.createElement("select");
        campo.opcoes.forEach((op) => {
          const option = document.createElement("option");
          option.value = op.valor;
          option.textContent = op.label;
          input.appendChild(option);
        });
      } else {
        const inp = document.createElement("input");
        inp.type = campo.tipo === "numero" || campo.tipo === "decimal" ? "number" : campo.tipo === "booleano" ? "checkbox" : campo.tipo === "data" ? "date" : campo.tipo === "hora" ? "time" : campo.tipo === "senha" ? "password" : "text";
        if (campo.placeholder) inp.placeholder = campo.placeholder;
        inp.required = campo.obrigatorio ?? false;
        input = inp;
      }
      const signal = new Signal("");
      signals[campo.nome] = signal;
      bindInput(input, signal);
      if (campo.ref) this.refs.registrar(campo.ref, input);
      wrapper.appendChild(input);
      const msgErro = document.createElement("span");
      msgErro.className = "jade-campo-msg-erro";
      wrapper.appendChild(msgErro);
      form.appendChild(wrapper);
    });
    container.appendChild(form);
    setEffectOwner(null);
    return signals;
  }
  // ── Botão ─────────────────────────────────────────────────────────────────
  criarBotao(texto, handler, container, opcoes) {
    setEffectOwner(this.telaAtiva);
    const btn = document.createElement("button");
    btn.className = `jade-botao jade-botao-${opcoes?.tipo ?? "primario"}`;
    if (opcoes?.icone) {
      const iconeEl = criarElementoIcone(opcoes.icone, 18);
      if (iconeEl) {
        btn.appendChild(iconeEl);
      } else {
        const span = document.createElement("span");
        span.textContent = opcoes.icone;
        btn.appendChild(span);
      }
    }
    const label = document.createTextNode(texto);
    btn.appendChild(label);
    btn.addEventListener("click", handler);
    if (opcoes?.desabilitado) {
      bind(opcoes.desabilitado, btn, "disabled");
    }
    container.appendChild(btn);
    setEffectOwner(null);
    return btn;
  }
  // ── Card de métrica ────────────────────────────────────────────────────────
  criarCard(titulo, valorSignal, container, opcoes) {
    setEffectOwner(this.telaAtiva);
    const card = document.createElement("div");
    card.className = "jade-card";
    if (opcoes?.variante && opcoes.variante !== "neutro") {
      card.classList.add(`jade-card-${opcoes.variante}`);
    }
    const t = document.createElement("div");
    t.className = "jade-card-titulo";
    t.textContent = titulo;
    const v = document.createElement("div");
    v.className = "jade-card-valor";
    bind(valorSignal, v, "textContent");
    card.appendChild(t);
    card.appendChild(v);
    container.appendChild(card);
    setEffectOwner(null);
  }
  // ── Atualização cirúrgica ─────────────────────────────────────────────────
  /** Atualiza um único campo de uma entidade: só o nó DOM daquele campo é re-renderizado. */
  atualizarCampo(entidade, index, campo, valor) {
    this.store.set(`${entidade}.${index}.${campo}`, valor);
  }
  // ── Skeleton / Loading ────────────────────────────────────────────────────
  /**
   * Exibe um skeleton animado enquanto os dados carregam.
   * Retorna o elemento para que `ocultarCarregando` possa removê-lo.
   */
  mostrarCarregando(container, linhas = 5) {
    const skeleton = document.createElement("div");
    skeleton.className = "jade-carregando";
    skeleton.setAttribute("aria-label", "Carregando...");
    const titulo = document.createElement("div");
    titulo.className = "jade-skeleton jade-skeleton-titulo";
    skeleton.appendChild(titulo);
    for (let i = 0; i < linhas; i++) {
      const linha = document.createElement("div");
      linha.className = `jade-skeleton jade-skeleton-${i === 0 ? "tabela" : ""}linha`;
      skeleton.appendChild(linha);
    }
    container.appendChild(skeleton);
    return skeleton;
  }
  ocultarCarregando(skeleton) {
    skeleton.remove();
  }
  // ── Banner de notificação (push) ─────────────────────────────────────────
  /**
   * Exibe um banner no topo da tela que empurra o header e o conteúdo para baixo.
   * Tipo 'erro' permanece até o usuário fechar. Os demais somem após `duracao` ms.
   */
  mostrarNotificacao(mensagem, tipo = "info", duracao = 4e3) {
    const banner = document.getElementById("jade-banner");
    if (!banner) return;
    if (this.bannerTimer) {
      clearTimeout(this.bannerTimer);
      this.bannerTimer = null;
    }
    const iconesNomes = {
      sucesso: "sucesso_icone",
      erro: "erro_icone",
      aviso: "aviso",
      info: "info"
    };
    const inner = document.createElement("div");
    inner.className = `jade-banner-inner jade-banner-${tipo}`;
    const iconeEl = criarElementoIcone(iconesNomes[tipo], 18);
    if (iconeEl) inner.appendChild(iconeEl);
    const msg = document.createElement("span");
    msg.className = "jade-banner-msg";
    msg.textContent = mensagem;
    inner.appendChild(msg);
    const fechar = document.createElement("button");
    fechar.className = "jade-banner-fechar";
    fechar.setAttribute("aria-label", "Fechar notifica\xE7\xE3o");
    const xIcon = criarElementoIcone("fechar", 16);
    if (xIcon) fechar.appendChild(xIcon);
    inner.appendChild(fechar);
    banner.innerHTML = "";
    banner.appendChild(inner);
    banner.classList.add("jade-banner-visivel");
    document.body.classList.add("jade-com-banner");
    const dismiss = () => {
      banner.classList.remove("jade-banner-visivel");
      document.body.classList.remove("jade-com-banner");
    };
    fechar.addEventListener("click", dismiss);
    if (tipo !== "erro") {
      this.bannerTimer = setTimeout(dismiss, duracao);
    }
  }
  // ── Bridge: descriptor do compilador → componentes ───────────────────────
  /**
   * Recebe o descriptor gerado pelo compilador (.jade-ui.json) e renderiza
   * automaticamente cada elemento declarado na tela.
   * É aqui que "usuário descreve O QUE, sistema decide COMO" se concretiza.
   */
  /**
   * dadosMap: mapa de entidade → registros, carregado pelo bootstrap antes de chamar este método.
   * Ex: { 'Produto': [{nome:'...', preco:...}, ...], 'Cliente': [...] }
   */
  renderizarTela(descriptor, container, dadosMap = {}) {
    const div = this.montarTela({ nome: descriptor.nome, titulo: descriptor.titulo }, container);
    for (const el2 of descriptor.elementos) {
      const props = Object.fromEntries(el2.propriedades.map((p) => [p.chave, p.valor]));
      const propsConhecidas = {
        tabela: /* @__PURE__ */ new Set(["entidade", "colunas", "filtravel", "ordenavel", "paginacao", "altura"]),
        formulario: /* @__PURE__ */ new Set(["entidade", "campos", "enviar"]),
        botao: /* @__PURE__ */ new Set(["acao", "clique", "icone", "tipo"]),
        cartao: /* @__PURE__ */ new Set(["titulo", "conteudo", "variante"]),
        modal: /* @__PURE__ */ new Set(["titulo", "mensagem", "variante"]),
        grafico: /* @__PURE__ */ new Set(["tipo", "entidade", "eixoX", "eixoY"]),
        abas: /* @__PURE__ */ new Set(["aba"]),
        lista: /* @__PURE__ */ new Set(["entidade", "campo", "subcampo", "deslizar"]),
        acordeao: /* @__PURE__ */ new Set(["secao"]),
        login: /* @__PURE__ */ new Set(["enviar", "titulo"]),
        toolbar: /* @__PURE__ */ new Set(["botao"]),
        divisor: /* @__PURE__ */ new Set(["rotulo"]),
        busca: /* @__PURE__ */ new Set(["acao", "placeholder", "modo"])
      };
      const conhecidas = propsConhecidas[el2.tipo];
      if (conhecidas) {
        for (const chave of Object.keys(props)) {
          if (!conhecidas.has(chave)) {
            console.warn(`[JADE] ${el2.tipo} '${el2.nome}': propriedade desconhecida '${chave}' \u2014 ser\xE1 ignorada.`);
          }
        }
      }
      switch (el2.tipo) {
        case "tabela": {
          const entidade = String(props["entidade"] ?? el2.nome);
          const colunas = Array.isArray(props["colunas"]) ? props["colunas"].map((c) => ({ campo: c, titulo: c })) : [];
          const filtravel = props["filtravel"] === "verdadeiro";
          let filtroBusca;
          if (filtravel) {
            filtroBusca = new Signal("");
            this.filtrosPorTela.set(descriptor.nome, filtroBusca);
          }
          this.criarTabela(
            {
              entidade,
              colunas,
              filtravel,
              ordenavel: props["ordenavel"] === "verdadeiro",
              paginacao: props["paginacao"] === "verdadeiro" ? true : Number(props["paginacao"]) || false,
              altura: props["altura"] ? String(props["altura"]) : void 0
            },
            div,
            dadosMap[entidade] ?? [],
            filtroBusca
          );
          break;
        }
        case "formulario": {
          const campos = Array.isArray(props["campos"]) ? props["campos"].map((c) => ({ nome: c, titulo: c, tipo: "texto" })) : [];
          this.criarFormulario({
            entidade: String(props["entidade"] ?? el2.nome),
            campos,
            enviar: props["enviar"] ? String(props["enviar"]) : void 0
          }, div);
          break;
        }
        case "botao": {
          const acao = String(props["acao"] ?? props["clique"] ?? "");
          const tiposValidos = ["primario", "secundario", "perigo", "sucesso"];
          const btn = this.criarBotao(el2.nome, () => {
            btn.disabled = true;
            btn.classList.add("jade-botao-carregando");
            if (acao) this.acoesPendentes.set(acao, btn);
            window.dispatchEvent(new CustomEvent("jade:acao", { detail: { acao, tela: descriptor.nome } }));
          }, div, {
            tipo: tiposValidos.includes(String(props["tipo"])) ? String(props["tipo"]) : "primario",
            icone: props["icone"] ? String(props["icone"]) : void 0
          });
          break;
        }
        case "cartao": {
          const conteudo = new Signal(props["conteudo"] ?? "");
          this.criarCard(
            String(props["titulo"] ?? el2.nome),
            conteudo,
            div,
            { variante: props["variante"] ? String(props["variante"]) : void 0 }
          );
          break;
        }
        case "grafico": {
          const entidade = String(props["entidade"] ?? el2.nome);
          const graficoConfig = {
            tipo: ["linha", "barras", "pizza"].includes(String(props["tipo"])) ? String(props["tipo"]) : "barras",
            entidade,
            eixoX: props["eixoX"] ? String(props["eixoX"]) : void 0,
            eixoY: props["eixoY"] ? String(props["eixoY"]) : void 0
          };
          div.appendChild(criarGraficoSVG(graficoConfig, dadosMap[entidade] ?? []));
          break;
        }
        case "modal": {
          const titulo = String(props["titulo"] ?? el2.nome);
          const mensagem = props["mensagem"] ? String(props["mensagem"]) : void 0;
          const variante = ["info", "alerta", "perigo"].includes(String(props["variante"])) ? String(props["variante"]) : void 0;
          this.modais.criar(el2.nome, { titulo, mensagem, variante }, this.telaAtiva);
          break;
        }
        case "abas": {
          const nomes = el2.propriedades.filter((p) => p.chave === "aba").map((p) => String(p.valor));
          if (nomes.length > 0) {
            const abasConfig = { nome: el2.nome, abas: nomes, tela: descriptor.nome };
            criarAbas(abasConfig, div);
          }
          break;
        }
        case "lista": {
          const entidade = String(props["entidade"] ?? el2.nome);
          const listaConfig = {
            entidade,
            campo: props["campo"] ? String(props["campo"]) : void 0,
            subcampo: props["subcampo"] ? String(props["subcampo"]) : void 0,
            deslizar: Array.isArray(props["deslizar"]) ? props["deslizar"] : props["deslizar"] ? [String(props["deslizar"])] : void 0
          };
          criarLista(listaConfig, dadosMap[entidade] ?? [], div, descriptor.nome);
          break;
        }
        case "acordeao": {
          const secoes = el2.propriedades.filter((p) => p.chave === "secao").map((p) => String(p.valor));
          if (secoes.length > 0) {
            const acordeaoConfig = { nome: el2.nome, secoes, tela: descriptor.nome };
            criarAcordeao(acordeaoConfig, div);
          }
          break;
        }
        case "navegar": {
          const abas = el2.propriedades.filter((p) => p.chave === "aba").map((p) => {
            const partes = String(p.valor).split("|");
            return { label: partes[0] ?? "", icone: partes[1] || void 0, tela: partes[2] ?? "" };
          });
          if (abas.length > 0) {
            criarNavegacao({ nome: el2.nome, abas }, this.telaAtiva ?? void 0);
          }
          break;
        }
        case "toolbar": {
          const tiposValidos = /* @__PURE__ */ new Set(["primario", "secundario", "perigo", "sucesso"]);
          const wrapper = document.createElement("div");
          wrapper.className = "jade-toolbar";
          wrapper.setAttribute("role", "toolbar");
          wrapper.setAttribute("aria-label", el2.nome);
          el2.propriedades.filter((p) => p.chave === "botao").forEach((p) => {
            const partes = String(p.valor).split("|");
            const label = partes[0] ?? "";
            const acao = partes[1] ?? "";
            const icone = partes[2] || void 0;
            const tipo = tiposValidos.has(partes[3] ?? "") ? partes[3] : "primario";
            const btn = this.criarBotao(label, () => {
              window.dispatchEvent(new CustomEvent("jade:acao", { detail: { acao, tela: descriptor.nome } }));
            }, wrapper, { tipo, icone });
            if (acao) this.acoesPendentes.set(acao, btn);
          });
          div.appendChild(wrapper);
          break;
        }
        case "login": {
          const acao = props["enviar"] ? String(props["enviar"]) : "login";
          const titulo = props["titulo"] ? String(props["titulo"]) : void 0;
          this.criarTelaLogin(div, ({ usuario, senha, lembrarMe }) => {
            return new Promise((resolve, reject) => {
              const chave = `${acao}:${Date.now()}`;
              const onResposta = (e) => {
                const ev = e;
                if (ev.detail?.chave !== chave) return;
                window.removeEventListener("jade:acao:resultado", onResposta);
                if (ev.detail.erro) reject(new Error(ev.detail.erro));
                else resolve();
              };
              window.addEventListener("jade:acao:resultado", onResposta);
              window.dispatchEvent(new CustomEvent("jade:acao", {
                detail: { acao, tela: descriptor.nome, chave, credenciais: { usuario, senha, lembrarMe } }
              }));
            });
          }, { titulo });
          break;
        }
        case "gaveta": {
          const itens = el2.propriedades.map((p) => {
            if (p.chave === "separador") return { tipo: "separador" };
            if (p.chave === "item") {
              const partes = String(p.valor).split("|");
              const destino = partes[2] ?? "";
              return {
                tipo: "item",
                label: partes[0] ?? "",
                icone: partes[1] || void 0,
                tela: destino.startsWith("acao:") ? void 0 : destino || void 0,
                acao: destino.startsWith("acao:") ? destino.slice(5) : void 0
              };
            }
            return null;
          }).filter((x) => x !== null);
          if (itens.length > 0) {
            const handle = criarGaveta({ nome: el2.nome, itens });
            div.insertBefore(handle.botaoToggle, div.firstChild);
          }
          break;
        }
        case "divisor": {
          const hr = document.createElement("hr");
          hr.className = "jade-divisor";
          if (props["rotulo"]) {
            const wrapper = document.createElement("div");
            wrapper.className = "jade-divisor-rotulo";
            wrapper.setAttribute("data-rotulo", String(props["rotulo"]));
            wrapper.appendChild(hr);
            div.appendChild(wrapper);
          } else {
            div.appendChild(hr);
          }
          break;
        }
        case "busca": {
          const acao = props["acao"] ? String(props["acao"]) : "";
          const ph = props["placeholder"] ? String(props["placeholder"]) : "Buscar...";
          const tempoReal = String(props["modo"] ?? "") === "tempo-real";
          const modo = tempoReal ? "input" : "submit";
          const wrapper = document.createElement("div");
          wrapper.className = "jade-busca-wrapper";
          wrapper.setAttribute("role", "search");
          const input = document.createElement("input");
          input.type = "search";
          input.placeholder = ph;
          input.className = "jade-busca-input";
          input.setAttribute("aria-label", ph);
          input.setAttribute("autocomplete", "off");
          const btn = document.createElement("button");
          btn.type = "submit";
          btn.className = "jade-busca-btn";
          btn.setAttribute("aria-label", "Buscar");
          btn.innerHTML = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
            <circle cx="8.5" cy="8.5" r="5.5"/><path d="M13.5 13.5L18 18"/>
          </svg>`;
          let debounceTimer;
          const disparar = () => {
            if (acao) {
              window.dispatchEvent(new CustomEvent("jade:acao", {
                detail: { acao, tela: descriptor.nome, query: input.value }
              }));
            }
          };
          if (tempoReal) {
            input.addEventListener("input", () => {
              clearTimeout(debounceTimer);
              debounceTimer = setTimeout(disparar, 300);
            });
          }
          const form = document.createElement("form");
          form.className = "jade-busca-form";
          form.addEventListener("submit", (e) => {
            e.preventDefault();
            disparar();
          });
          form.appendChild(input);
          form.appendChild(btn);
          wrapper.appendChild(form);
          div.appendChild(wrapper);
          break;
        }
        default:
          break;
      }
    }
    return div;
  }
  // ── Tela de login ─────────────────────────────────────────────────────────
  /**
   * Renderiza uma tela de login completa no container.
   * Ao submeter, chama `onLogin` com as credenciais informadas.
   * Se `onLogin` rejeitar, exibe a mensagem de erro abaixo do formulário.
   */
  criarTelaLogin(container, onLogin, opcoes) {
    container.innerHTML = "";
    const wrapper = document.createElement("div");
    wrapper.className = "jade-login-wrapper";
    const card = document.createElement("div");
    card.className = "jade-login-card";
    const titulo = document.createElement("h2");
    titulo.className = "jade-login-titulo";
    titulo.textContent = opcoes?.titulo ?? "Entrar";
    card.appendChild(titulo);
    const form = document.createElement("form");
    form.className = "jade-formulario";
    form.noValidate = true;
    const campoUsuario = document.createElement("div");
    campoUsuario.className = "jade-campo";
    const lblUsuario = document.createElement("label");
    lblUsuario.textContent = "Usu\xE1rio *";
    const inputUsuario = document.createElement("input");
    inputUsuario.type = "text";
    inputUsuario.required = true;
    inputUsuario.autocomplete = "username";
    inputUsuario.placeholder = "Seu usu\xE1rio";
    inputUsuario.className = "jade-campo-input";
    campoUsuario.appendChild(lblUsuario);
    campoUsuario.appendChild(inputUsuario);
    form.appendChild(campoUsuario);
    const campoSenha = document.createElement("div");
    campoSenha.className = "jade-campo";
    const lblSenha = document.createElement("label");
    lblSenha.textContent = "Senha *";
    const inputSenha = document.createElement("input");
    inputSenha.type = "password";
    inputSenha.required = true;
    inputSenha.autocomplete = "current-password";
    inputSenha.placeholder = "Sua senha";
    inputSenha.className = "jade-campo-input";
    campoSenha.appendChild(lblSenha);
    campoSenha.appendChild(inputSenha);
    form.appendChild(campoSenha);
    const campoLembrar = document.createElement("div");
    campoLembrar.className = "jade-campo jade-campo-inline";
    const inputLembrar = document.createElement("input");
    inputLembrar.type = "checkbox";
    inputLembrar.id = "jade-login-lembrar";
    const lblLembrar = document.createElement("label");
    lblLembrar.htmlFor = "jade-login-lembrar";
    lblLembrar.textContent = "Lembrar-me por 7 dias";
    campoLembrar.appendChild(inputLembrar);
    campoLembrar.appendChild(lblLembrar);
    form.appendChild(campoLembrar);
    const msgErro = document.createElement("p");
    msgErro.className = "jade-login-erro";
    msgErro.setAttribute("role", "alert");
    msgErro.hidden = true;
    form.appendChild(msgErro);
    const btn = document.createElement("button");
    btn.type = "submit";
    btn.className = "jade-botao jade-botao-primario jade-login-btn";
    btn.textContent = "Entrar";
    form.appendChild(btn);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const usuario = inputUsuario.value.trim();
      const senha = inputSenha.value;
      if (!usuario || !senha) {
        msgErro.textContent = "Preencha usu\xE1rio e senha.";
        msgErro.hidden = false;
        return;
      }
      btn.disabled = true;
      btn.classList.add("jade-botao-carregando");
      msgErro.hidden = true;
      try {
        await onLogin({ usuario, senha, lembrarMe: inputLembrar.checked });
      } catch (err) {
        msgErro.textContent = err?.message ?? "Erro ao entrar. Tente novamente.";
        msgErro.hidden = false;
      } finally {
        btn.disabled = false;
        btn.classList.remove("jade-botao-carregando");
      }
    });
    card.appendChild(form);
    wrapper.appendChild(card);
    container.appendChild(wrapper);
    setTimeout(() => inputUsuario.focus(), 0);
  }
  // ── Estado de botões ──────────────────────────────────────────────────────
  /**
   * Reabilita o botão associado à ação após a operação concluir.
   * Chamado automaticamente via evento `jade:acao:concluido` ou manualmente.
   */
  concluirAcao(nome) {
    const btn = this.acoesPendentes.get(nome);
    if (!btn) return;
    btn.disabled = false;
    btn.classList.remove("jade-botao-carregando");
    this.acoesPendentes.delete(nome);
  }
  // ── Acessores ─────────────────────────────────────────────────────────────
  focar(nomeRef) {
    this.refs.focar(nomeRef);
  }
  abrirModal(nome) {
    this.modais.abrir(nome);
  }
  fecharModal(nome) {
    this.modais.fechar(nome);
  }
  getStore() {
    return this.store;
  }
  getRefs() {
    return this.refs;
  }
  getRouter() {
    return this.router;
  }
  getResponsivo() {
    return this.responsivo;
  }
  /**
   * Emite o resultado de uma ação de login para o formulário que está aguardando.
   * Chame isso dentro da função JADE de login após AuthService.login():
   *   sucesso → emitirResultadoAcao(chave)
   *   falha   → emitirResultadoAcao(chave, 'Usuário ou senha inválidos')
   */
  emitirResultadoAcao(chave, erro) {
    const detail = { chave };
    if (erro !== void 0) detail.erro = erro;
    window.dispatchEvent(new CustomEvent("jade:acao:resultado", { detail }));
  }
};

// ui/session.ts
var CHAVE_SESSAO = "jade:sessao";
var Session = class {
  /**
   * Salva os tokens após login bem-sucedido.
   * @param expiresIn segundos até o token expirar
   */
  definir(token, refreshToken, expiresIn) {
    if (typeof localStorage === "undefined") return;
    const dados = {
      token,
      refreshToken,
      expiraEm: Date.now() + expiresIn * 1e3
    };
    try {
      localStorage.setItem(CHAVE_SESSAO, JSON.stringify(dados));
    } catch {
    }
  }
  /**
   * Retorna o access token se existir e não estiver expirado.
   * Remove automaticamente se estiver expirado.
   */
  obterToken() {
    const dados = this.obterDados();
    if (!dados) return null;
    if (Date.now() > dados.expiraEm) {
      this.limpar();
      return null;
    }
    return dados.token;
  }
  /** Retorna o refresh token (para renovação automática). */
  obterRefreshToken() {
    return this.obterDados()?.refreshToken ?? null;
  }
  /** Retorna true se há um token válido (não expirado) na sessão. */
  estaAutenticado() {
    return this.obterToken() !== null;
  }
  /**
   * Decodifica o payload do JWT sem verificar a assinatura.
   * Use apenas para leitura de dados não-sensíveis (username, roles, etc.)
   * A verificação real da assinatura deve ser feita pelo AuthService.
   */
  obterPayload() {
    const token = this.obterToken();
    if (!token) return null;
    try {
      const [, payloadB64] = token.split(".");
      const json = atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"));
      return JSON.parse(json);
    } catch {
      return null;
    }
  }
  /** Retorna o username do usuário logado, ou null. */
  obterUsuario() {
    return this.obterPayload()?.username ?? null;
  }
  /** Retorna os papéis (roles) do usuário logado. */
  obterPapeis() {
    return this.obterPayload()?.roles ?? [];
  }
  /** Remove todos os dados da sessão (usar no logout). */
  limpar() {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(CHAVE_SESSAO);
  }
  obterDados() {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(CHAVE_SESSAO);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
};
var sessao = new Session();

// pwa/pwa_generator.ts
var PWAGenerator = class {
  gerarManifest(config) {
    return JSON.stringify({
      name: config.nome,
      short_name: config.nomeAbreviado ?? config.nome.slice(0, 12),
      description: config.descricao ?? "",
      display: "standalone",
      start_url: "/",
      scope: "/",
      theme_color: config.cor_tema ?? "#2563eb",
      background_color: config.cor_fundo ?? "#ffffff",
      icons: [
        {
          src: config.icone ?? "/icon-192.png",
          sizes: "192x192",
          type: "image/png"
        },
        {
          src: config.icone ?? "/icon-512.png",
          sizes: "512x512",
          type: "image/png"
        }
      ]
    }, null, 2);
  }
  gerarServiceWorker(config) {
    const cacheName = `jade-${config.nome.toLowerCase().replace(/\s+/g, "-")}-v1`;
    const arquivos = config.arquivosCache ?? ["/", "/index.html", "/app.wasm", "/manifest.json"];
    return `const CACHE_NAME = '${cacheName}';
const ARQUIVOS_CACHE = ${JSON.stringify(arquivos)};

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ARQUIVOS_CACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k.startsWith('jade-') && k !== CACHE_NAME)
            .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (!res || res.status !== 200 || res.type !== 'basic') return res;
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        return res;
      }).catch(() =>
        caches.match('/offline.html') ??
        new Response('<h1>Sem conex\xE3o</h1>', { headers: { 'Content-Type': 'text/html' } })
      );
    })
  );
});

// Background sync: notifica o app quando conex\xE3o retorna
self.addEventListener('sync', e => {
  if (e.tag === 'jade-sync') {
    e.waitUntil(
      self.clients.matchAll().then(clients =>
        clients.forEach(c => c.postMessage({ tipo: 'sync-requisitado' }))
      )
    );
  }
});`;
  }
  gerarIndexHTML(config) {
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${config.nome}</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="${config.cor_tema ?? "#2563eb"}">
  <meta name="description" content="${config.descricao ?? ""}">
</head>
<body>
  <div id="app"></div>
  <script type="module">
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/service_worker.js')
        .then(() => console.log('[JADE] Service Worker registrado'))
        .catch(e => console.warn('[JADE] SW falhou:', e));
    }
    navigator.serviceWorker?.addEventListener('message', e => {
      if (e.data?.tipo === 'sync-requisitado') {
        window.dispatchEvent(new CustomEvent('jade:sync'));
      }
    });
  <\/script>
</body>
</html>`;
  }
};

// stdlib/moeda.ts
var MoedaStdlib = class _MoedaStdlib {
  // ── Conversão interna ─────────────────────────────────────
  /**
   * Converte reais para centavos inteiros
   * 1234.50 → 123450
   */
  static toCentavos(valor) {
    return Math.round(valor * 100);
  }
  /**
   * Converte centavos inteiros para reais
   * 123450 → 1234.50
   */
  static fromCentavos(centavos) {
    return centavos / 100;
  }
  // ── Formatação ────────────────────────────────────────────
  /**
   * Formata valor como moeda brasileira
   * 1234.5   → "R$ 1.234,50"
   * -500     → "-R$ 500,00"
   * 0        → "R$ 0,00"
   */
  static formatarBRL(valor) {
    const negativo = valor < 0;
    const centavos = Math.round(Math.abs(valor) * 100);
    const reais = Math.floor(centavos / 100);
    const cents = centavos % 100;
    const reaisStr = reais.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    const resultado = `R$ ${reaisStr},${cents.toString().padStart(2, "0")}`;
    return negativo ? "-" + resultado : resultado;
  }
  /**
   * Formata valor em formato compacto para dashboards
   * 1_500_000  → "R$ 1,5mi"
   * 45_000     → "R$ 45mil"
   * 1_500      → "R$ 1,5mil"
   * 500        → "R$ 500,00"
   */
  static formatarCompacto(valor) {
    const negativo = valor < 0;
    const abs = Math.abs(valor);
    let resultado;
    if (abs >= 1e6) {
      const mi = abs / 1e6;
      resultado = `R$ ${_MoedaStdlib._compactarNumero(mi)}mi`;
    } else if (abs >= 1e3) {
      const mil = abs / 1e3;
      resultado = `R$ ${_MoedaStdlib._compactarNumero(mil)}mil`;
    } else {
      resultado = _MoedaStdlib.formatarBRL(abs);
    }
    return negativo ? "-" + resultado : resultado;
  }
  static _compactarNumero(n) {
    const arredondado = Math.round(n * 10) / 10;
    return arredondado % 1 === 0 ? arredondado.toFixed(0) : arredondado.toFixed(1).replace(".", ",");
  }
  // ── Parsing ───────────────────────────────────────────────
  /**
   * Converte texto de moeda brasileira para número
   * "R$ 1.234,50"  → 1234.50
   * "1.234,50"     → 1234.50
   * "1234,50"      → 1234.50
   * "-R$ 500,00"   → -500.00
   * Retorna NaN se o formato não for reconhecido
   */
  static parseBRL(texto) {
    const limpo = texto.trim().replace(/R\$\s?/g, "").trim();
    const negativo = limpo.startsWith("-");
    const sem_sinal = limpo.replace(/^-/, "").trim();
    const br = sem_sinal.replace(/\./g, "").replace(",", ".");
    const valor = parseFloat(br);
    if (isNaN(valor)) return NaN;
    return negativo ? -valor : valor;
  }
  // ── Aritmética segura (via centavos) ──────────────────────
  /**
   * Soma monetária sem erro de ponto flutuante
   * somar(0.1, 0.2) === 0.30  (não 0.30000000000000004)
   */
  static somar(a, b) {
    return _MoedaStdlib.fromCentavos(
      _MoedaStdlib.toCentavos(a) + _MoedaStdlib.toCentavos(b)
    );
  }
  /**
   * Subtração monetária sem erro de ponto flutuante
   */
  static subtrair(a, b) {
    return _MoedaStdlib.fromCentavos(
      _MoedaStdlib.toCentavos(a) - _MoedaStdlib.toCentavos(b)
    );
  }
  /**
   * Multiplica um valor monetário por um fator (ex: preço × quantidade)
   * O fator pode ser decimal (ex: 1.5 unidades)
   */
  static multiplicar(valor, fator) {
    return _MoedaStdlib.fromCentavos(
      Math.round(_MoedaStdlib.toCentavos(valor) * fator)
    );
  }
  /**
   * Divide um valor monetário por um divisor
   * Arredonda para centavos (sem distribuição do resto — veja distribuir())
   */
  static dividir(valor, divisor) {
    if (divisor === 0) return NaN;
    return _MoedaStdlib.fromCentavos(
      Math.round(_MoedaStdlib.toCentavos(valor) / divisor)
    );
  }
  // ── Comparações seguras ───────────────────────────────────
  /**
   * Compara dois valores monetários com precisão de centavos
   * Evita problemas de 0.1 + 0.2 !== 0.3
   */
  static igual(a, b) {
    return _MoedaStdlib.toCentavos(a) === _MoedaStdlib.toCentavos(b);
  }
  static maior(a, b) {
    return _MoedaStdlib.toCentavos(a) > _MoedaStdlib.toCentavos(b);
  }
  static menor(a, b) {
    return _MoedaStdlib.toCentavos(a) < _MoedaStdlib.toCentavos(b);
  }
  static maiorOuIgual(a, b) {
    return _MoedaStdlib.toCentavos(a) >= _MoedaStdlib.toCentavos(b);
  }
  static menorOuIgual(a, b) {
    return _MoedaStdlib.toCentavos(a) <= _MoedaStdlib.toCentavos(b);
  }
  // ── Operações de negócio ──────────────────────────────────
  /**
   * Aplica desconto percentual sobre um valor
   * descontar(100, 10) → 90.00  (10% de desconto)
   */
  static descontar(valor, percentual) {
    return _MoedaStdlib.fromCentavos(
      Math.round(_MoedaStdlib.toCentavos(valor) * (1 - percentual / 100))
    );
  }
  /**
   * Acrescenta percentual sobre um valor
   * acrescentar(100, 10) → 110.00  (10% de acréscimo)
   */
  static acrescentar(valor, percentual) {
    return _MoedaStdlib.fromCentavos(
      Math.round(_MoedaStdlib.toCentavos(valor) * (1 + percentual / 100))
    );
  }
  /**
   * Calcula o valor de um percentual sobre um montante
   * porcentagem(200, 15) → 30.00  (15% de R$200)
   */
  static porcentagem(valor, percentual) {
    return _MoedaStdlib.fromCentavos(
      Math.round(_MoedaStdlib.toCentavos(valor) * percentual / 100)
    );
  }
  /**
   * Distribui um valor em N partes iguais, resolvendo o problema do centavo
   * Os centavos restantes são distribuídos nas primeiras parcelas
   *
   * distribuir(10, 3) → [3.34, 3.33, 3.33]  (não [3.33, 3.33, 3.33] = 9.99)
   * distribuir(100, 4) → [25, 25, 25, 25]
   */
  static distribuir(total, partes) {
    if (partes <= 0) return [];
    const totalCentavos = _MoedaStdlib.toCentavos(total);
    const baseCentavos = Math.floor(totalCentavos / partes);
    const resto = totalCentavos % partes;
    return Array.from(
      { length: partes },
      (_, i) => _MoedaStdlib.fromCentavos(i < resto ? baseCentavos + 1 : baseCentavos)
    );
  }
  /**
   * Calcula valor total de uma lista de itens (quantidade × preço unitário)
   * Seguro contra ponto flutuante
   */
  static totalItens(itens) {
    const centavos = itens.reduce(
      (acc, item) => acc + Math.round(_MoedaStdlib.toCentavos(item.precoUnitario) * item.quantidade),
      0
    );
    return _MoedaStdlib.fromCentavos(centavos);
  }
};
var MoedaMetodos = {
  toCentavos: MoedaStdlib.toCentavos,
  fromCentavos: MoedaStdlib.fromCentavos,
  formatarBRL: MoedaStdlib.formatarBRL,
  formatarCompacto: MoedaStdlib.formatarCompacto,
  parseBRL: MoedaStdlib.parseBRL,
  somar: MoedaStdlib.somar,
  subtrair: MoedaStdlib.subtrair,
  multiplicar: MoedaStdlib.multiplicar,
  dividir: MoedaStdlib.dividir,
  igual: MoedaStdlib.igual,
  maior: MoedaStdlib.maior,
  menor: MoedaStdlib.menor,
  maiorOuIgual: MoedaStdlib.maiorOuIgual,
  menorOuIgual: MoedaStdlib.menorOuIgual,
  descontar: MoedaStdlib.descontar,
  acrescentar: MoedaStdlib.acrescentar,
  porcentagem: MoedaStdlib.porcentagem,
  distribuir: MoedaStdlib.distribuir,
  totalItens: MoedaStdlib.totalItens
};

// stdlib/texto.ts
var TextoStdlib = class _TextoStdlib {
  /**
   * Converts string to uppercase
   */
  static maiusculo(texto) {
    return texto.toUpperCase();
  }
  /**
   * Converts string to lowercase
   */
  static minusculo(texto) {
    return texto.toLowerCase();
  }
  /**
   * Trims whitespace from both ends of string
   */
  static aparar(texto) {
    return texto.trim();
  }
  /**
   * Returns the length of the string (counts Unicode characters correctly)
   */
  static tamanho(texto) {
    return Array.from(texto).length;
  }
  /**
   * Remove acentos e diacríticos de uma string
   * Ex: "João" → "Joao", "São Paulo" → "Sao Paulo"
   */
  static semAcentos(texto) {
    return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }
  /**
   * Checks if string contains the specified substring
   * @param ignorarAcentos  Se verdadeiro, "Joao" encontra "João" (default: false)
   */
  static contem(texto, busca, ignorarAcentos = false) {
    if (!ignorarAcentos) return texto.includes(busca);
    const norm = (s) => _TextoStdlib.semAcentos(s).toLowerCase();
    return norm(texto).includes(norm(busca));
  }
  /**
   * Checks if string starts with the specified substring
   */
  static comecaCom(texto, prefixo) {
    return texto.startsWith(prefixo);
  }
  /**
   * Checks if string ends with the specified substring
   */
  static terminaCom(texto, sufixo) {
    return texto.endsWith(sufixo);
  }
  /**
   * Replaces all occurrences of a substring with another substring
   */
  static substituir(texto, busca, substituto) {
    return texto.split(busca).join(substituto);
  }
  /**
   * Splits string by a delimiter into an array of strings
   */
  static dividir(texto, delimitador) {
    return texto.split(delimitador);
  }
  /**
   * Normalizes Unicode string to NFC form
   */
  static normalizar(texto) {
    return texto.normalize("NFC");
  }
  /**
   * Aplica uma máscara de formatação a uma string de dígitos
   * Use '#' para cada dígito esperado; demais caracteres são inseridos como literais
   *
   * Exemplos:
   *   aplicarMascara("12345678901",   "###.###.###-##")  → "123.456.789-01"
   *   aplicarMascara("00360305000104","##.###.###/####-##") → "00.360.305/0001-04"
   *   aplicarMascara("01310100",      "#####-###")        → "01310-100"
   *   aplicarMascara("11987654321",   "(##) #####-####")  → "(11) 98765-4321"
   */
  static aplicarMascara(valor, mascara) {
    const digits = valor.replace(/\D/g, "");
    let resultado = "";
    let di = 0;
    for (const ch of mascara) {
      if (di >= digits.length) break;
      if (ch === "#") {
        resultado += digits[di++];
      } else {
        resultado += ch;
      }
    }
    return resultado;
  }
  // ── Validações e formatações brasileiras ─────────────────
  /**
   * Validates Brazilian CPF (Cadastro de Pessoas Físicas)
   * Aceita CPF formatado (123.456.789-01) ou apenas dígitos
   */
  static validarCPF(cpf) {
    const cpfLimpo = cpf.replace(/\D/g, "");
    if (cpfLimpo.length !== 11) return false;
    if (/^(\d)\1{10}$/.test(cpfLimpo)) return false;
    let soma = 0;
    let resto;
    for (let i = 1; i <= 9; i++) {
      soma += parseInt(cpfLimpo.substring(i - 1, i)) * (11 - i);
    }
    resto = soma * 10 % 11;
    if (resto === 10 || resto === 11) resto = 0;
    if (resto !== parseInt(cpfLimpo.substring(9, 10))) return false;
    soma = 0;
    for (let i = 1; i <= 10; i++) {
      soma += parseInt(cpfLimpo.substring(i - 1, i)) * (12 - i);
    }
    resto = soma * 10 % 11;
    if (resto === 10 || resto === 11) resto = 0;
    if (resto !== parseInt(cpfLimpo.substring(10, 11))) return false;
    return true;
  }
  /**
   * Validates Brazilian CNPJ (Cadastro Nacional da Pessoa Jurídica)
   * Aceita CNPJ formatado (00.360.305/0001-04) ou apenas dígitos
   */
  static validarCNPJ(cnpj) {
    const cnpjLimpo = cnpj.replace(/\D/g, "");
    if (cnpjLimpo.length !== 14) return false;
    if (/^(\d)\1{13}$/.test(cnpjLimpo)) return false;
    let soma = 0;
    let peso = 5;
    for (let i = 0; i < 12; i++) {
      soma += parseInt(cnpjLimpo[i]) * peso;
      peso = peso === 2 ? 9 : peso - 1;
    }
    let resto = soma % 11;
    const digito1 = resto < 2 ? 0 : 11 - resto;
    soma = 0;
    peso = 6;
    for (let i = 0; i < 13; i++) {
      soma += parseInt(cnpjLimpo[i]) * peso;
      peso = peso === 2 ? 9 : peso - 1;
    }
    resto = soma % 11;
    const digito2 = resto < 2 ? 0 : 11 - resto;
    return parseInt(cnpjLimpo[12]) === digito1 && parseInt(cnpjLimpo[13]) === digito2;
  }
  /**
   * Formats Brazilian CEP (Código de Endereçamento Postal)
   */
  static formatarCEP(cep) {
    const cepLimpo = cep.replace(/\D/g, "");
    if (cepLimpo.length !== 8) return cep;
    return `${cepLimpo.substring(0, 5)}-${cepLimpo.substring(5)}`;
  }
  /**
   * Formats Brazilian phone number
   * Returns (XX) XXXXX-XXXX for mobile or (XX) XXXX-XXXX for landline
   */
  static formatarTelefone(telefone) {
    const telLimpo = telefone.replace(/\D/g, "");
    if (telLimpo.length === 11) {
      return `(${telLimpo.substring(0, 2)}) ${telLimpo.substring(2, 7)}-${telLimpo.substring(7)}`;
    } else if (telLimpo.length === 10) {
      return `(${telLimpo.substring(0, 2)}) ${telLimpo.substring(2, 6)}-${telLimpo.substring(6)}`;
    }
    return telefone;
  }
};
var TextoMetodos = {
  maiusculo: TextoStdlib.maiusculo,
  minusculo: TextoStdlib.minusculo,
  aparar: TextoStdlib.aparar,
  tamanho: TextoStdlib.tamanho,
  semAcentos: TextoStdlib.semAcentos,
  contem: TextoStdlib.contem,
  comecaCom: TextoStdlib.comecaCom,
  terminaCom: TextoStdlib.terminaCom,
  substituir: TextoStdlib.substituir,
  dividir: TextoStdlib.dividir,
  normalizar: TextoStdlib.normalizar,
  aplicarMascara: TextoStdlib.aplicarMascara,
  validarCPF: TextoStdlib.validarCPF,
  validarCNPJ: TextoStdlib.validarCNPJ,
  formatarCEP: TextoStdlib.formatarCEP,
  formatarTelefone: TextoStdlib.formatarTelefone
};

// stdlib/matematica.ts
var MatematicaStdlib = class _MatematicaStdlib {
  // ── Básico ────────────────────────────────────────────────
  static soma(lista) {
    return lista.reduce((acc, v) => acc + v, 0);
  }
  static media(lista) {
    if (lista.length === 0) return NaN;
    return _MatematicaStdlib.soma(lista) / lista.length;
  }
  static mediana(lista) {
    if (lista.length === 0) return NaN;
    const sorted = [...lista].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  static desvioPadrao(lista) {
    if (lista.length === 0) return NaN;
    const m = _MatematicaStdlib.media(lista);
    const variancia = lista.reduce((acc, v) => acc + Math.pow(v - m, 2), 0) / lista.length;
    return Math.sqrt(variancia);
  }
  static variancia(lista) {
    if (lista.length === 0) return NaN;
    const m = _MatematicaStdlib.media(lista);
    return lista.reduce((acc, v) => acc + Math.pow(v - m, 2), 0) / lista.length;
  }
  // reduce evita estouro de pilha com listas grandes (Math.min/max(...lista) quebra ~100k+ itens)
  static minimo(lista) {
    if (lista.length === 0) return NaN;
    return lista.reduce((min, v) => v < min ? v : min, lista[0]);
  }
  static maximo(lista) {
    if (lista.length === 0) return NaN;
    return lista.reduce((max, v) => v > max ? v : max, lista[0]);
  }
  static arredondar(valor, casas = 2) {
    return Math.round(valor * Math.pow(10, casas)) / Math.pow(10, casas);
  }
  static abs(valor) {
    return Math.abs(valor);
  }
  static potencia(base, expoente) {
    return Math.pow(base, expoente);
  }
  static raiz(valor) {
    return Math.sqrt(valor);
  }
  // ── Análise estatística ───────────────────────────────────
  /**
   * Curva ABC (classificação de Pareto)
   * Retorna cada item com sua classe (A, B ou C) baseado em percentual acumulado
   * Classe A: 0–80%, Classe B: 80–95%, Classe C: 95–100%
   */
  static curvaABC(itens) {
    const total = itens.reduce((acc, i) => acc + i.valor, 0);
    if (total === 0) return [];
    const sorted = [...itens].sort((a, b) => b.valor - a.valor);
    let acumulado = 0;
    return sorted.map((item) => {
      const percentual = item.valor / total * 100;
      acumulado += percentual;
      const classe = acumulado <= 80 ? "A" : acumulado <= 95 ? "B" : "C";
      return {
        id: item.id,
        valor: item.valor,
        percentual: Math.round(percentual * 100) / 100,
        acumulado: Math.round(acumulado * 100) / 100,
        classe
      };
    });
  }
  /**
   * Percentil — retorna o valor no percentil p (0–100) da lista
   */
  static percentil(lista, p) {
    if (lista.length === 0) return NaN;
    const sorted = [...lista].sort((a, b) => a - b);
    const index = p / 100 * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (index - lower) * (sorted[upper] - sorted[lower]);
  }
  /**
   * Correlação de Pearson entre dois conjuntos de dados
   */
  static correlacao(x, y) {
    if (x.length !== y.length || x.length === 0) return NaN;
    const mx = _MatematicaStdlib.media(x);
    const my = _MatematicaStdlib.media(y);
    const num = x.reduce((acc, xi, i) => acc + (xi - mx) * (y[i] - my), 0);
    const denX = Math.sqrt(x.reduce((acc, xi) => acc + Math.pow(xi - mx, 2), 0));
    const denY = Math.sqrt(y.reduce((acc, yi) => acc + Math.pow(yi - my, 2), 0));
    if (denX === 0 || denY === 0) return 0;
    return num / (denX * denY);
  }
  /**
   * Média móvel simples (SMA) — O(n) com janela deslizante
   */
  static mediaM\u00F3vel(lista, janela) {
    if (janela <= 0 || janela > lista.length) return [];
    const resultado = [];
    let somaJanela = 0;
    for (let i = 0; i < janela; i++) somaJanela += lista[i];
    resultado.push(somaJanela / janela);
    for (let i = janela; i < lista.length; i++) {
      somaJanela += lista[i] - lista[i - janela];
      resultado.push(somaJanela / janela);
    }
    return resultado;
  }
  /**
   * Taxa de crescimento percentual entre dois valores
   */
  static taxaCrescimento(valorInicial, valorFinal) {
    if (valorInicial === 0) return 0;
    return (valorFinal - valorInicial) / Math.abs(valorInicial) * 100;
  }
  // ── Análise preditiva ─────────────────────────────────────
  /**
   * Regressão linear simples — ajusta a reta y = a·x + b aos dados
   * @returns { a, b, r2 }
   *   a  = inclinação (tendência por período)
   *   b  = intercepto (valor inicial projetado)
   *   r2 = coeficiente de determinação 0–1 (1 = ajuste perfeito)
   *
   * Uso típico: prever demanda futura a partir do histórico de vendas
   *   const { a, b } = Matematica.regressaoLinear(vendas)
   *   previsao = a * proximoPeriodo + b
   */
  static regressaoLinear(y) {
    const n = y.length;
    if (n < 2) return { a: NaN, b: NaN, r2: NaN };
    const somaX = n * (n - 1) / 2;
    const somaX2 = n * (n - 1) * (2 * n - 1) / 6;
    const somaY = _MatematicaStdlib.soma(y);
    const somaXY = y.reduce((acc, yi, i) => acc + i * yi, 0);
    const den = n * somaX2 - somaX * somaX;
    if (den === 0) return { a: 0, b: somaY / n, r2: 0 };
    const a = (n * somaXY - somaX * somaY) / den;
    const b = (somaY - a * somaX) / n;
    const mediaY = somaY / n;
    const ss_tot = y.reduce((acc, yi) => acc + Math.pow(yi - mediaY, 2), 0);
    const ss_res = y.reduce((acc, yi, i) => acc + Math.pow(yi - (a * i + b), 2), 0);
    const r2 = ss_tot === 0 ? 1 : 1 - ss_res / ss_tot;
    return { a, b, r2 };
  }
  /**
   * Detecta outliers usando o método IQR (Intervalo Interquartil)
   * Outlier: valor abaixo de Q1 − 1.5×IQR  ou  acima de Q3 + 1.5×IQR
   * @returns { normais, outliers, q1, q3, iqr, limiteInferior, limiteSuperior }
   *
   * Uso típico: filtrar picos atípicos de venda antes de projetar estoque
   */
  static detectarOutliers(lista) {
    if (lista.length === 0) {
      return { normais: [], outliers: [], q1: NaN, q3: NaN, iqr: NaN, limiteInferior: NaN, limiteSuperior: NaN };
    }
    const q1 = _MatematicaStdlib.percentil(lista, 25);
    const q3 = _MatematicaStdlib.percentil(lista, 75);
    const iqr = q3 - q1;
    const limiteInferior = q1 - 1.5 * iqr;
    const limiteSuperior = q3 + 1.5 * iqr;
    const normais = [];
    const outliers = [];
    for (const v of lista) {
      if (v < limiteInferior || v > limiteSuperior) {
        outliers.push(v);
      } else {
        normais.push(v);
      }
    }
    return { normais, outliers, q1, q3, iqr, limiteInferior, limiteSuperior };
  }
  // ── Matemática Financeira ─────────────────────────────────
  /**
   * Juros compostos — retorna o montante final
   * @param principal  Valor inicial (ex: 10000)
   * @param taxa       Taxa por período como decimal (ex: 0.12 = 12% a.a.)
   * @param tempo      Número de períodos (ex: 5 anos)
   * @returns          Montante: principal × (1 + taxa)^tempo
   */
  static jurosCompostos(principal, taxa, tempo) {
    return principal * Math.pow(1 + taxa, tempo);
  }
  /**
   * Valor Presente Líquido (VPL / NPV)
   * @param fluxoCaixa  Array de fluxos de caixa — índice 0 = t=0 (investimento inicial, geralmente negativo)
   * @param taxa        Taxa de desconto por período como decimal (ex: 0.1 = 10%)
   * @returns           VPL — positivo indica projeto viável
   *
   * Exemplo: VPL de -10000 hoje, +4000 nos próximos 4 anos com taxa 10%:
   *   valorPresenteLiquido([-10000, 4000, 4000, 4000, 4000], 0.10)
   */
  static valorPresenteLiquido(fluxoCaixa, taxa) {
    if (fluxoCaixa.length === 0) return NaN;
    return fluxoCaixa.reduce((vpl, fc, t) => vpl + fc / Math.pow(1 + taxa, t), 0);
  }
};
var MatematicaMetodos = {
  soma: MatematicaStdlib.soma,
  media: MatematicaStdlib.media,
  mediana: MatematicaStdlib.mediana,
  desvioPadrao: MatematicaStdlib.desvioPadrao,
  variancia: MatematicaStdlib.variancia,
  minimo: MatematicaStdlib.minimo,
  maximo: MatematicaStdlib.maximo,
  arredondar: MatematicaStdlib.arredondar,
  abs: MatematicaStdlib.abs,
  potencia: MatematicaStdlib.potencia,
  raiz: MatematicaStdlib.raiz,
  curvaABC: MatematicaStdlib.curvaABC,
  percentil: MatematicaStdlib.percentil,
  correlacao: MatematicaStdlib.correlacao,
  mediaM\u00F3vel: MatematicaStdlib.mediaM\u00F3vel,
  taxaCrescimento: MatematicaStdlib.taxaCrescimento,
  regressaoLinear: MatematicaStdlib.regressaoLinear,
  detectarOutliers: MatematicaStdlib.detectarOutliers,
  jurosCompostos: MatematicaStdlib.jurosCompostos,
  valorPresenteLiquido: MatematicaStdlib.valorPresenteLiquido
};

// stdlib/fiscal.ts
function calcularICMS(baseCalculo, aliquota) {
  validarPositivo(baseCalculo, "baseCalculo");
  validarAliquota(aliquota);
  const valor = arredondar(baseCalculo * aliquota);
  return {
    baseCalculo,
    aliquota,
    valor,
    valorLiquido: arredondar(baseCalculo - valor)
  };
}
function calcularICMSST(valorProduto, aliquotaInterna, aliquotaInterestadual, mva) {
  validarPositivo(valorProduto, "valorProduto");
  validarAliquota(aliquotaInterna);
  validarAliquota(aliquotaInterestadual);
  if (mva < 0) throw new Error("MVA n\xE3o pode ser negativo");
  const icmsPropio = arredondar(valorProduto * aliquotaInterestadual);
  const baseCalculoST = arredondar(valorProduto * (1 + mva));
  const icmsST = arredondar(baseCalculoST * aliquotaInterna - icmsPropio);
  return { icmsPropio, baseCalculoST, icmsST: Math.max(0, icmsST) };
}
function calcularPISCOFINS(baseCalculo, aliquotaPIS = 65e-4, aliquotaCOFINS = 0.03) {
  validarPositivo(baseCalculo, "baseCalculo");
  validarAliquota(aliquotaPIS);
  validarAliquota(aliquotaCOFINS);
  const valorPIS = arredondar(baseCalculo * aliquotaPIS);
  const valorCOFINS = arredondar(baseCalculo * aliquotaCOFINS);
  return {
    baseCalculo,
    aliquotaPIS,
    aliquotaCOFINS,
    valorPIS,
    valorCOFINS,
    totalPISCOFINS: arredondar(valorPIS + valorCOFINS)
  };
}
function calcularPISCOFINSNaoCumulativo(baseCalculo, creditos = 0, aliquotaPIS = 0.0165, aliquotaCOFINS = 0.076) {
  const base = calcularPISCOFINS(baseCalculo, aliquotaPIS, aliquotaCOFINS);
  const totalLiquido = arredondar(Math.max(0, base.totalPISCOFINS - creditos));
  return { ...base, creditos, totalLiquido };
}
function calcularISS(baseCalculo, aliquota) {
  validarPositivo(baseCalculo, "baseCalculo");
  if (aliquota < 0.02 || aliquota > 0.05) {
    throw new Error(`Al\xEDquota ISS inv\xE1lida: ${(aliquota * 100).toFixed(2)}%. Deve estar entre 2% e 5%`);
  }
  const valor = arredondar(baseCalculo * aliquota);
  return {
    baseCalculo,
    aliquota,
    valor,
    valorLiquido: arredondar(baseCalculo - valor)
  };
}
function calcularIPI(valorProduto, aliquota) {
  validarPositivo(valorProduto, "valorProduto");
  validarAliquota(aliquota);
  const valorIPI = arredondar(valorProduto * aliquota);
  return {
    valorProduto,
    aliquota,
    valorIPI,
    valorTotal: arredondar(valorProduto + valorIPI)
  };
}
function calcularTotaisNF(itens, aliquotaPIS = 65e-4, aliquotaCOFINS = 0.03) {
  if (itens.length === 0) throw new Error("Nota fiscal sem itens");
  let totalProdutosCentavos = 0;
  let totalICMSCentavos = 0;
  let totalIPICentavos = 0;
  for (const item of itens) {
    validarPositivo(item.quantidade, "quantidade");
    validarPositivo(item.valorUnitario, "valorUnitario");
    const subtotal = MoedaStdlib.multiplicar(item.valorUnitario, item.quantidade);
    totalProdutosCentavos += MoedaStdlib.toCentavos(subtotal);
    if (item.aliquotaICMS !== void 0) {
      totalICMSCentavos += MoedaStdlib.toCentavos(calcularICMS(subtotal, item.aliquotaICMS).valor);
    }
    if (item.aliquotaIPI !== void 0) {
      totalIPICentavos += MoedaStdlib.toCentavos(calcularIPI(subtotal, item.aliquotaIPI).valorIPI);
    }
  }
  const totalProdutos = MoedaStdlib.fromCentavos(totalProdutosCentavos);
  const totalICMS = MoedaStdlib.fromCentavos(totalICMSCentavos);
  const totalIPI = MoedaStdlib.fromCentavos(totalIPICentavos);
  const pisCofins = calcularPISCOFINS(totalProdutos, aliquotaPIS, aliquotaCOFINS);
  return {
    totalProdutos,
    totalICMS,
    totalIPI,
    totalPIS: pisCofins.valorPIS,
    totalCOFINS: pisCofins.valorCOFINS,
    totalNF: MoedaStdlib.fromCentavos(totalProdutosCentavos + totalIPICentavos)
  };
}
function arredondar(valor) {
  return Math.round(valor * 100) / 100;
}
function validarPositivo(valor, nome) {
  if (typeof valor !== "number" || isNaN(valor) || valor < 0) {
    throw new Error(`'${nome}' deve ser um n\xFAmero n\xE3o-negativo`);
  }
}
function validarAliquota(aliquota) {
  if (typeof aliquota !== "number" || isNaN(aliquota) || aliquota < 0 || aliquota > 1) {
    throw new Error(`Al\xEDquota inv\xE1lida: ${aliquota}. Deve ser um decimal entre 0 e 1`);
  }
}

// stdlib/wms.ts
function validarEAN13(codigo) {
  const limpo = codigo.replace(/\D/g, "");
  if (limpo.length !== 13) {
    return { valido: false, formato: "EAN-13", mensagem: `EAN-13 deve ter 13 d\xEDgitos, recebeu ${limpo.length}` };
  }
  const digito = calcularDigitoEAN(limpo.slice(0, 12));
  const valido = digito === parseInt(limpo[12], 10);
  return {
    valido,
    formato: "EAN-13",
    mensagem: valido ? void 0 : `D\xEDgito verificador inv\xE1lido: esperado ${digito}, recebeu ${limpo[12]}`
  };
}
function validarEAN8(codigo) {
  const limpo = codigo.replace(/\D/g, "");
  if (limpo.length !== 8) {
    return { valido: false, formato: "EAN-8", mensagem: `EAN-8 deve ter 8 d\xEDgitos, recebeu ${limpo.length}` };
  }
  const digito = calcularDigitoEAN(limpo.slice(0, 7));
  const valido = digito === parseInt(limpo[7], 10);
  return {
    valido,
    formato: "EAN-8",
    mensagem: valido ? void 0 : `D\xEDgito verificador inv\xE1lido: esperado ${digito}, recebeu ${limpo[7]}`
  };
}
function gerarEAN13(base12) {
  const limpo = base12.replace(/\D/g, "");
  if (limpo.length !== 12) {
    throw new Error(`Base EAN-13 deve ter 12 d\xEDgitos, recebeu ${limpo.length}`);
  }
  const digito = calcularDigitoEAN(limpo);
  return limpo + digito;
}
function gerarEAN8(base7) {
  const limpo = base7.replace(/\D/g, "");
  if (limpo.length !== 7) {
    throw new Error(`Base EAN-8 deve ter 7 d\xEDgitos, recebeu ${limpo.length}`);
  }
  const digito = calcularDigitoEAN(limpo);
  return limpo + digito;
}
function validarCode128(codigo) {
  if (!codigo || codigo.length === 0) {
    return { valido: false, formato: "Code128", mensagem: "C\xF3digo vazio" };
  }
  if (codigo.length > 80) {
    return { valido: false, formato: "Code128", mensagem: `Code128 m\xE1ximo 80 caracteres, recebeu ${codigo.length}` };
  }
  const invalido = [...codigo].find((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) > 126);
  if (invalido) {
    return { valido: false, formato: "Code128", mensagem: `Caractere inv\xE1lido: '${invalido}' (ASCII ${invalido.charCodeAt(0)})` };
  }
  return { valido: true, formato: "Code128" };
}
function validarCodigoBarras(codigo) {
  const limpo = codigo.replace(/\D/g, "");
  if (limpo.length === 13) return validarEAN13(codigo);
  if (limpo.length === 8) return validarEAN8(codigo);
  return validarCode128(codigo);
}
function criarGrade(corredores, prateleiras, niveis, capacidadeKg, capacidadeM3) {
  if (corredores.length === 0) throw new Error("Armaz\xE9m deve ter ao menos 1 corredor");
  if (prateleiras < 1) throw new Error("Prateleiras deve ser >= 1");
  if (niveis < 1) throw new Error("N\xEDveis deve ser >= 1");
  if (capacidadeKg <= 0) throw new Error("capacidadeKg deve ser positivo");
  if (capacidadeM3 <= 0) throw new Error("capacidadeM3 deve ser positivo");
  const posicoes = /* @__PURE__ */ new Map();
  for (const corredor of corredores) {
    for (let p = 1; p <= prateleiras; p++) {
      for (let n = 1; n <= niveis; n++) {
        const codigo = formatarEndereco({ corredor, prateleira: p, nivel: n });
        posicoes.set(codigo, {
          corredor,
          prateleira: p,
          nivel: n,
          codigo,
          capacidadeKg,
          capacidadeM3,
          ocupadoKg: 0,
          ocupadoM3: 0,
          disponivel: true
        });
      }
    }
  }
  return {
    corredores,
    prateleirasPorCorredor: prateleiras,
    niveisPorPrateleira: niveis,
    capacidadePadraoKg: capacidadeKg,
    capacidadePadraoM3: capacidadeM3,
    posicoes
  };
}
function formatarEndereco(end) {
  return `${end.corredor}-${String(end.prateleira).padStart(3, "0")}-${end.nivel}`;
}
function parsearEndereco(codigo) {
  const partes = codigo.split("-");
  if (partes.length !== 3) throw new Error(`Endere\xE7o inv\xE1lido: '${codigo}'. Formato: CORREDOR-PRATELEIRA-NIVEL`);
  const corredor = partes[0];
  const prateleira = parseInt(partes[1], 10);
  const nivel = parseInt(partes[2], 10);
  if (!corredor || isNaN(prateleira) || isNaN(nivel)) {
    throw new Error(`Endere\xE7o inv\xE1lido: '${codigo}'`);
  }
  return { corredor, prateleira, nivel };
}
function alocarPosicao(grade, codigo, pesoKg, volumeM3) {
  const pos = grade.posicoes.get(codigo);
  if (!pos) return { sucesso: false, mensagem: `Posi\xE7\xE3o '${codigo}' n\xE3o existe` };
  if (pos.ocupadoKg + pesoKg > pos.capacidadeKg) {
    return {
      sucesso: false,
      mensagem: `Peso excede capacidade: ${pos.ocupadoKg + pesoKg}kg > ${pos.capacidadeKg}kg`
    };
  }
  if (pos.ocupadoM3 + volumeM3 > pos.capacidadeM3) {
    return {
      sucesso: false,
      mensagem: `Volume excede capacidade: ${(pos.ocupadoM3 + volumeM3).toFixed(3)}m\xB3 > ${pos.capacidadeM3}m\xB3`
    };
  }
  pos.ocupadoKg += pesoKg;
  pos.ocupadoM3 += volumeM3;
  pos.disponivel = pos.ocupadoKg < pos.capacidadeKg && pos.ocupadoM3 < pos.capacidadeM3;
  return { sucesso: true };
}
function liberarPosicao(grade, codigo) {
  const pos = grade.posicoes.get(codigo);
  if (!pos) throw new Error(`Posi\xE7\xE3o '${codigo}' n\xE3o existe`);
  pos.ocupadoKg = 0;
  pos.ocupadoM3 = 0;
  pos.disponivel = true;
}
function sugerirPosicao(grade, pesoKg, volumeM3) {
  let melhor = null;
  for (const pos of grade.posicoes.values()) {
    if (!pos.disponivel) continue;
    if (pos.ocupadoKg + pesoKg > pos.capacidadeKg) continue;
    if (pos.ocupadoM3 + volumeM3 > pos.capacidadeM3) continue;
    if (!melhor || pos.nivel < melhor.nivel || pos.nivel === melhor.nivel && pos.prateleira < melhor.prateleira) {
      melhor = pos;
    }
  }
  return melhor;
}
function estatisticasArmazem(grade) {
  let totalKgOcupado = 0;
  let totalM3Ocupado = 0;
  let totalKgCapacidade = 0;
  let totalM3Capacidade = 0;
  let posicoesDisponiveis = 0;
  for (const pos of grade.posicoes.values()) {
    totalKgOcupado += pos.ocupadoKg;
    totalM3Ocupado += pos.ocupadoM3;
    totalKgCapacidade += pos.capacidadeKg;
    totalM3Capacidade += pos.capacidadeM3;
    if (pos.disponivel) posicoesDisponiveis++;
  }
  const totalPosicoes = grade.posicoes.size;
  const posicoesOcupadas = totalPosicoes - posicoesDisponiveis;
  return {
    totalPosicoes,
    posicoesDisponiveis,
    posicoesOcupadas,
    ocupacaoPercent: totalPosicoes > 0 ? Math.round(posicoesOcupadas / totalPosicoes * 100) : 0,
    totalKgOcupado: Math.round(totalKgOcupado * 100) / 100,
    totalM3Ocupado: Math.round(totalM3Ocupado * 1e3) / 1e3,
    totalKgCapacidade,
    totalM3Capacidade
  };
}
function calcularDigitoEAN(digits) {
  let soma = 0;
  for (let i = 0; i < digits.length; i++) {
    const d = parseInt(digits[i], 10);
    soma += i % 2 === 0 ? d : d * 3;
  }
  return (10 - soma % 10) % 10;
}

// apis/http_client.ts
function gerarUUID() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : r & 3 | 8).toString(16);
  });
}
var HttpClient = class {
  defaultHeaders = {
    "Content-Type": "application/json"
  };
  interceptors = [];
  // Define headers padrão (ex: Authorization)
  setDefaultHeaders(headers) {
    this.defaultHeaders = { ...this.defaultHeaders, ...headers };
  }
  // Adiciona interceptor de request
  addInterceptor(fn) {
    this.interceptors.push(fn);
  }
  async get(url, options) {
    return this.request({ method: "GET", url, ...options });
  }
  async post(url, data, options) {
    return this.request({ method: "POST", url, data, ...options });
  }
  async put(url, data, options) {
    return this.request({ method: "PUT", url, data, ...options });
  }
  async delete(url, options) {
    return this.request({ method: "DELETE", url, ...options });
  }
  async request(config) {
    this.validateUrl(config.url);
    let finalConfig = { ...config };
    for (const interceptor of this.interceptors) {
      finalConfig = interceptor(finalConfig);
    }
    let url = finalConfig.url;
    if (finalConfig.params) {
      const query = new URLSearchParams(
        Object.fromEntries(
          Object.entries(finalConfig.params).map(([k, v]) => [k, String(v)])
        )
      ).toString();
      url += (url.includes("?") ? "&" : "?") + query;
    }
    const headers = { ...this.defaultHeaders, ...finalConfig.headers || {} };
    headers["X-Correlation-ID"] = gerarUUID();
    const ehMutacao = ["POST", "PUT", "PATCH", "DELETE"].includes(finalConfig.method.toUpperCase());
    if (ehMutacao && !finalConfig.semIdempotencia && !headers["Idempotency-Key"]) {
      headers["Idempotency-Key"] = gerarUUID();
    }
    const retries = finalConfig.retries ?? 0;
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutMs = finalConfig.timeout ?? 3e4;
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const response = await fetch(url, {
          method: finalConfig.method,
          headers,
          body: finalConfig.data ? JSON.stringify(finalConfig.data) : void 0,
          signal: controller.signal
        });
        clearTimeout(timer);
        const responseHeaders = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });
        let data;
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          data = await response.json();
        } else {
          data = await response.text();
        }
        return {
          data,
          status: response.status,
          headers: responseHeaders,
          ok: response.ok
        };
      } catch (e) {
        lastError = e;
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 100));
        }
      }
    }
    throw lastError ?? new Error("Requisi\xE7\xE3o falhou");
  }
  validateUrl(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`URL inv\xE1lida: ${url}`);
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`Protocolo n\xE3o permitido: ${parsed.protocol}`);
    }
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host === "::1" || host.endsWith(".localhost")) {
      throw new Error("Requisi\xE7\xE3o bloqueada: destino interno n\xE3o permitido");
    }
    const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipv4) {
      const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
      const privado = a === 127 || // 127.0.0.0/8 loopback
      a === 10 || // 10.0.0.0/8
      a === 0 || // 0.0.0.0/8
      a === 172 && b >= 16 && b <= 31 || // 172.16.0.0/12
      a === 192 && b === 168 || // 192.168.0.0/16
      a === 169 && b === 254;
      if (privado) {
        throw new Error("Requisi\xE7\xE3o bloqueada: endere\xE7o IP privado n\xE3o permitido");
      }
    }
    if (/^(::1$|fc|fd|fe80)/i.test(host)) {
      throw new Error("Requisi\xE7\xE3o bloqueada: endere\xE7o IPv6 privado n\xE3o permitido");
    }
  }
};

// apis/console_api.ts
var ConsoleAPI = class {
  minLevel = "debug";
  currentGroup = null;
  timers = /* @__PURE__ */ new Map();
  counters = /* @__PURE__ */ new Map();
  history = [];
  maxHistory = 1e3;
  levels = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3
  };
  setLevel(level) {
    this.minLevel = level;
  }
  getHistory() {
    return [...this.history];
  }
  // ── Métodos em português (API pública JADE) ──────────────────
  escrever(...args) {
    this.log("info", ...args);
  }
  avisar(...args) {
    this.log("warn", ...args);
  }
  erro(...args) {
    this.log("error", ...args);
  }
  informar(...args) {
    this.log("info", ...args);
  }
  depurar(...args) {
    this.log("debug", ...args);
  }
  // ── Aliases em inglês (uso interno / interop) ─────────────────
  debug(...args) {
    this.log("debug", ...args);
  }
  info(...args) {
    this.log("info", ...args);
  }
  warn(...args) {
    this.log("warn", ...args);
  }
  error(...args) {
    this.log("error", ...args);
  }
  log(level, ...args) {
    if (this.levels[level] < this.levels[this.minLevel]) return;
    const message = args.map(
      (a) => typeof a === "object" ? JSON.stringify(a) : String(a)
    ).join(" ");
    const indent = this.currentGroup ? "  " : "";
    const prefix = this.currentGroup ? `[${this.currentGroup}] ` : "";
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const entry = {
      level,
      message: `${prefix}${message}`,
      args,
      timestamp,
      group: this.currentGroup ?? void 0
    };
    this.history.push(entry);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
    const consoleFn = level === "debug" ? console.debug : level === "warn" ? console.warn : level === "error" ? console.error : console.log;
    consoleFn(`[JADE ${level.toUpperCase()}] ${indent}${prefix}${message}`);
  }
  // ── Métodos de visualização (português) ──────────────────────
  tabela(dados) {
    this.table(dados);
  }
  grupo(rotulo) {
    this.group(rotulo);
  }
  fimGrupo() {
    this.groupEnd();
  }
  tempo(rotulo = "padr\xE3o") {
    this.time(rotulo);
  }
  fimTempo(rotulo = "padr\xE3o") {
    return this.timeEnd(rotulo);
  }
  contar(rotulo = "padr\xE3o") {
    return this.count(rotulo);
  }
  resetarContador(rotulo = "padr\xE3o") {
    this.countReset(rotulo);
  }
  afirmar(condicao, mensagem) {
    this.assert(condicao, mensagem);
  }
  limpar() {
    this.clear();
  }
  // ── Aliases em inglês (interop) ──────────────────────────────
  table(data) {
    console.table(data);
  }
  group(label) {
    this.currentGroup = label ?? "grupo";
    console.group(label);
  }
  groupEnd() {
    this.currentGroup = null;
    console.groupEnd();
  }
  time(label = "default") {
    this.timers.set(label, Date.now());
  }
  timeEnd(label = "default") {
    const start = this.timers.get(label);
    if (start === void 0) {
      this.warn(`Timer '${label}' n\xE3o iniciado`);
      return 0;
    }
    const elapsed = Date.now() - start;
    this.timers.delete(label);
    this.info(`${label}: ${elapsed}ms`);
    return elapsed;
  }
  count(label = "default") {
    const current = (this.counters.get(label) ?? 0) + 1;
    this.counters.set(label, current);
    this.info(`${label}: ${current}`);
    return current;
  }
  countReset(label = "default") {
    this.counters.delete(label);
  }
  assert(condition, message) {
    if (!condition) {
      this.error("Assertion falhou:", message ?? "sem mensagem");
      throw new Error(`[JADE Assert] ${message ?? "Assertion falhou"}`);
    }
  }
  clear() {
    this.history = [];
    console.clear();
  }
};

// apis/datetime_api.ts
var DateTimeAPI = class {
  // Data e hora atual
  agora() {
    return /* @__PURE__ */ new Date();
  }
  hoje() {
    const d = /* @__PURE__ */ new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }
  // Formata data — suporta dd/MM/yyyy HH:mm:ss e variações
  formatar(date, formato) {
    const pad = (n, len = 2) => String(n).padStart(len, "0");
    return formato.replace("yyyy", String(date.getFullYear())).replace("MM", pad(date.getMonth() + 1)).replace("dd", pad(date.getDate())).replace("HH", pad(date.getHours())).replace("mm", pad(date.getMinutes())).replace("ss", pad(date.getSeconds())).replace("SSS", pad(date.getMilliseconds(), 3));
  }
  // Parseia string de data
  parsear(str, formato) {
    const tokens = {};
    const fmtParts = formato.match(/yyyy|MM|dd|HH|mm|ss/g) ?? [];
    let regex = formato.replace(/yyyy|MM|dd|HH|mm|ss/g, "(\\d+)");
    const match = str.match(new RegExp(regex));
    if (!match) throw new Error(`N\xE3o foi poss\xEDvel parsear '${str}' com formato '${formato}'`);
    fmtParts.forEach((part, i) => {
      tokens[part] = parseInt(match[i + 1]);
    });
    return new Date(
      tokens["yyyy"] ?? 0,
      (tokens["MM"] ?? 1) - 1,
      tokens["dd"] ?? 1,
      tokens["HH"] ?? 0,
      tokens["mm"] ?? 0,
      tokens["ss"] ?? 0
    );
  }
  // Adiciona unidade de tempo
  adicionar(date, quantidade, unidade) {
    const d = new Date(date);
    switch (unidade) {
      case "anos":
        d.setFullYear(d.getFullYear() + quantidade);
        break;
      case "meses":
        d.setMonth(d.getMonth() + quantidade);
        break;
      case "dias":
        d.setDate(d.getDate() + quantidade);
        break;
      case "horas":
        d.setHours(d.getHours() + quantidade);
        break;
      case "minutos":
        d.setMinutes(d.getMinutes() + quantidade);
        break;
      case "segundos":
        d.setSeconds(d.getSeconds() + quantidade);
        break;
      case "milissegundos":
        d.setMilliseconds(d.getMilliseconds() + quantidade);
        break;
    }
    return d;
  }
  // Subtrai unidade de tempo
  subtrair(date, quantidade, unidade) {
    return this.adicionar(date, -quantidade, unidade);
  }
  // Diferença entre datas na unidade especificada
  diferenca(data1, data2, unidade = "dias") {
    const ms = Math.abs(data2.getTime() - data1.getTime());
    switch (unidade) {
      case "milissegundos":
        return ms;
      case "segundos":
        return Math.floor(ms / 1e3);
      case "minutos":
        return Math.floor(ms / 6e4);
      case "horas":
        return Math.floor(ms / 36e5);
      case "dias":
        return Math.floor(ms / 864e5);
      case "meses":
        return Math.floor(ms / (864e5 * 30));
      case "anos":
        return Math.floor(ms / (864e5 * 365));
      default:
        return ms;
    }
  }
  eValida(valor) {
    return valor instanceof Date && !isNaN(valor.getTime());
  }
  eAnoBissexto(ano) {
    return ano % 4 === 0 && ano % 100 !== 0 || ano % 400 === 0;
  }
};

// persistence/local_datastore.ts
var LocalDatastore = class {
  db = null;
  dbName;
  tables;
  constructor(dbName, tables) {
    this.dbName = dbName;
    this.tables = tables;
  }
  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        for (const table of this.tables) {
          if (!db.objectStoreNames.contains(table)) {
            db.createObjectStore(table, { keyPath: "id" });
          }
        }
      };
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  }
  async insert(table, record) {
    if (!record.id) {
      record.id = this.generateUUID();
    }
    if (!record._rev) {
      record._rev = this.generateRev(0);
    }
    return this.runTransaction(table, "readwrite", (store) => store.add(record));
  }
  async find(table, query) {
    const all = await this.runTransaction(
      table,
      "readonly",
      (store) => store.getAll()
    );
    let results = all;
    if (query?.where) {
      results = results.filter(
        (record) => Object.entries(query.where).every(([key, val]) => record[key] === val)
      );
    }
    if (query?.orderBy) {
      const { field, direction } = query.orderBy;
      results.sort((a, b) => {
        const cmp = a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0;
        return direction === "asc" ? cmp : -cmp;
      });
    }
    if (query?.limit) {
      results = results.slice(0, query.limit);
    }
    return results;
  }
  async findById(table, id) {
    const result = await this.runTransaction(
      table,
      "readonly",
      (store) => store.get(id)
    );
    return result ?? null;
  }
  // Retorna o registro atualizado, o _rev anterior (baseRev) e os
  // deltas por campo — necessários para o SyncManager detectar conflitos.
  async update(table, id, changes) {
    const record = await this.findById(table, id);
    if (!record) throw new Error(`Registro '${id}' n\xE3o encontrado em '${table}'`);
    const baseRev = record._rev ?? this.generateRev(0);
    const deltas = {};
    for (const [campo, novoValor] of Object.entries(changes)) {
      if (campo !== "_rev" && record[campo] !== novoValor) {
        deltas[campo] = { de: record[campo], para: novoValor };
      }
    }
    const newRev = this.bumpRev(baseRev);
    const updated = { ...record, ...changes, _rev: newRev };
    await this.runTransaction(table, "readwrite", (store) => store.put(updated));
    return { record: updated, baseRev, deltas };
  }
  async delete(table, id) {
    return this.runTransaction(table, "readwrite", (store) => store.delete(id));
  }
  runTransaction(table, mode, operation) {
    return new Promise((resolve, reject) => {
      if (!this.db) throw new Error("Datastore n\xE3o inicializado");
      const tx = this.db.transaction(table, mode);
      const store = tx.objectStore(table);
      const request = operation(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  generateUUID() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === "x" ? r : r & 3 | 8).toString(16);
    });
  }
  // Gera hash de 7 bytes criptograficamente seguro (browser + Node 14.17+)
  randomHash() {
    const buf = new Uint8Array(4);
    crypto.getRandomValues(buf);
    return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 7);
  }
  // Gera _rev inicial: '1-xxxxxxx'
  generateRev(seq) {
    return `${seq + 1}-${this.randomHash()}`;
  }
  // Incrementa a sequência do _rev: '2-xxxxxxx' → '3-xxxxxxx'
  bumpRev(rev) {
    const seq = parseInt(rev.split("-")[0] ?? "0", 10);
    return `${seq + 1}-${this.randomHash()}`;
  }
};

// persistence/preferencias.ts
var Preferencias = class {
  prefixo;
  constructor(opcoes = {}) {
    this.prefixo = opcoes.prefixo ?? "jade";
  }
  chave(nome) {
    return `${this.prefixo}:${nome}`;
  }
  /** Salva um valor. Aceita strings, números, booleanos e objetos serializáveis. */
  definir(nome, valor, ttl) {
    if (typeof localStorage === "undefined") return;
    const entrada = { valor };
    if (ttl != null) entrada.expira = Date.now() + ttl;
    try {
      localStorage.setItem(this.chave(nome), JSON.stringify(entrada));
    } catch {
    }
  }
  /** Lê um valor. Retorna undefined se não existir ou tiver expirado. */
  obter(nome) {
    if (typeof localStorage === "undefined") return void 0;
    const raw = localStorage.getItem(this.chave(nome));
    if (raw == null) return void 0;
    try {
      const entrada = JSON.parse(raw);
      if (entrada.expira != null && Date.now() > entrada.expira) {
        localStorage.removeItem(this.chave(nome));
        return void 0;
      }
      return entrada.valor;
    } catch {
      return void 0;
    }
  }
  /** Remove uma preferência. */
  remover(nome) {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(this.chave(nome));
  }
  /** Retorna true se a preferência existe e não está expirada. */
  existe(nome) {
    return this.obter(nome) !== void 0;
  }
  /** Remove todas as preferências deste app (com este prefixo). */
  limpar() {
    if (typeof localStorage === "undefined") return;
    const chaves = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(this.prefixo + ":")) chaves.push(k);
    }
    chaves.forEach((k) => localStorage.removeItem(k));
  }
  /** Lista todas as chaves armazenadas (sem o prefixo). */
  listar() {
    if (typeof localStorage === "undefined") return [];
    const resultado = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(this.prefixo + ":")) {
        resultado.push(k.slice(this.prefixo.length + 1));
      }
    }
    return resultado;
  }
};
var preferencias = new Preferencias();

// persistence/sync_manager.ts
var ConflictManager = class {
  conflitos = [];
  // Tenta merge automático campo a campo.
  //
  // Para cada campo em `deltas`:
  //   - Se o servidor não mexeu nesse campo (valor atual == delta.de) → aplica delta.para
  //   - Se é numérico e ambos mexeram → aplica o delta relativo (soma-delta correta)
  //   - Se é não-numérico e ambos mexeram → conflito real, precisa resolução humana
  //
  // Retorna o registro mesclado e a lista de campos que não puderam ser resolvidos.
  mergeFields(serverRecord, deltas) {
    const merged = { ...serverRecord };
    const conflitantes = [];
    for (const [campo, delta] of Object.entries(deltas)) {
      const valorServidorAtual = serverRecord[campo];
      if (valorServidorAtual === delta.de) {
        merged[campo] = delta.para;
      } else if (typeof valorServidorAtual === "number" && typeof delta.de === "number" && typeof delta.para === "number") {
        const deltaNominal = delta.para - delta.de;
        merged[campo] = valorServidorAtual + deltaNominal;
      } else {
        conflitantes.push(campo);
      }
    }
    return { merged, conflitantes };
  }
  registrar(tabela, registroId, deltasLocais, valorLocal, valorServidor, camposConflitantes) {
    const conflito = {
      id: `conflict_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      tabela,
      registroId,
      camposConflitantes,
      deltasLocais,
      valorLocal,
      valorServidor,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      resolvido: false
    };
    this.conflitos.push(conflito);
    return conflito;
  }
  // Resolve um conflito pendente com a estratégia escolhida.
  // Retorna o valor final a ser reenviado ao servidor.
  resolver(conflito, strategy) {
    switch (strategy) {
      case "last-write-wins":
        const resultLww = { ...conflito.valorServidor };
        for (const [campo, delta] of Object.entries(conflito.deltasLocais)) {
          resultLww[campo] = delta.para;
        }
        return resultLww;
      case "soma-delta":
        const resultDelta = { ...conflito.valorServidor };
        for (const [campo, delta] of Object.entries(conflito.deltasLocais)) {
          const srv = conflito.valorServidor[campo];
          if (typeof srv === "number" && typeof delta.de === "number" && typeof delta.para === "number") {
            resultDelta[campo] = srv + (delta.para - delta.de);
          } else {
            resultDelta[campo] = delta.para;
          }
        }
        return resultDelta;
      case "manual":
        return null;
    }
  }
  pendentes() {
    return this.conflitos.filter((c) => !c.resolvido);
  }
  resolverManualmente(conflitoid, valorEscolhido) {
    const conflito = this.conflitos.find((c) => c.id === conflitoid);
    if (conflito) conflito.resolvido = true;
  }
  total() {
    return this.conflitos.length;
  }
  totalResolvidos() {
    return this.conflitos.filter((c) => c.resolvido).length;
  }
};
var SyncManager = class {
  queue = [];
  isOnline = typeof navigator !== "undefined" ? navigator.onLine : true;
  serverUrl;
  token = null;
  intervalId = null;
  syncing = false;
  // Público para que o código da aplicação possa consultar conflitos pendentes
  conflicts = new ConflictManager();
  constructor(serverUrl = "/api/sync") {
    this.serverUrl = serverUrl;
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => {
        this.isOnline = true;
        this.processQueue();
      });
      window.addEventListener("offline", () => {
        this.isOnline = false;
      });
    }
  }
  /**
   * Configura o SyncManager em tempo de execução.
   * Deve ser chamado após o login para passar o token JWT.
   *
   * @example
   * syncManager.configurar({
   *   url: 'https://meu-servidor.com/api/sync',
   *   token: sessao.obterToken(),
   *   intervalo: 30000
   * })
   */
  configurar(config) {
    if (config.url) this.serverUrl = config.url;
    if (config.token !== void 0) this.token = config.token ?? null;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (config.intervalo && config.intervalo > 0 && typeof setInterval !== "undefined") {
      this.intervalId = setInterval(() => {
        if (this.isOnline) this.processQueue();
      }, config.intervalo);
    }
  }
  /** Remove o token (chamar no logout para parar de enviar requests autenticados). */
  limparToken() {
    this.token = null;
  }
  async queueChange(change) {
    this.queue.push({ ...change, timestamp: Date.now() });
    if (this.isOnline) {
      await this.processQueue();
    }
  }
  pendingCount() {
    return this.queue.length;
  }
  async processQueue() {
    if (this.syncing || this.queue.length === 0) return;
    this.syncing = true;
    while (this.queue.length > 0 && this.isOnline) {
      const change = this.queue[0];
      try {
        await this.sendToServer(change);
        this.queue.shift();
      } catch (err) {
        if (err?.status === 409 && err?.serverRecord && change.deltas) {
          const { merged, conflitantes } = this.conflicts.mergeFields(
            err.serverRecord,
            change.deltas
          );
          if (conflitantes.length === 0) {
            this.queue[0] = {
              ...change,
              baseRev: err.serverRecord._rev,
              deltas: Object.fromEntries(
                Object.entries(change.deltas).map(([campo, delta]) => [
                  campo,
                  { de: err.serverRecord[campo], para: merged[campo] }
                ])
              )
            };
            continue;
          } else {
            this.conflicts.registrar(
              change.table,
              change.id,
              change.deltas,
              Object.fromEntries(
                Object.entries(change.deltas).map(([k, d]) => [k, d.para])
              ),
              err.serverRecord,
              conflitantes
            );
            this.queue.shift();
          }
        } else {
          break;
        }
      }
    }
    this.syncing = false;
  }
  async sendToServer(change) {
    const headers = { "Content-Type": "application/json" };
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    const response = await fetch(this.serverUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(change)
    });
    if (response.status === 409) {
      const body = await response.json();
      const err = new Error("Conflito de vers\xE3o detectado");
      err.status = 409;
      err.serverRecord = body.serverRecord;
      throw err;
    }
    if (!response.ok) {
      throw new Error(`Sync falhou: ${response.statusText}`);
    }
  }
};

// core/entity_manager.ts
var EntityManager = class {
  entityName;
  store;
  events;
  constructor(entityName, store, events) {
    this.entityName = entityName;
    this.store = store;
    this.events = events;
  }
  /** Cria uma nova entidade e emite evento '<Entidade>Criado' */
  async criar(dados) {
    const record = await this.store.insert(this.entityName, { ...dados });
    this.events.emit(`${this.entityName}Criado`, record);
    return record;
  }
  /** Busca entidades com filtro opcional */
  async buscar(query) {
    return await this.store.find(this.entityName, query);
  }
  /** Busca uma entidade pelo ID */
  async buscarPorId(id) {
    return await this.store.findById(this.entityName, id);
  }
  /** Atualiza campos de uma entidade e emite evento '<Entidade>Atualizado' */
  async atualizar(id, mudancas) {
    const { record } = await this.store.update(this.entityName, id, mudancas);
    this.events.emit(`${this.entityName}Atualizado`, record);
    return record;
  }
  /** Remove uma entidade e emite evento '<Entidade>Removido' */
  async remover(id) {
    const record = await this.store.findById(this.entityName, id);
    await this.store.delete(this.entityName, id);
    this.events.emit(`${this.entityName}Removido`, record ?? { id });
  }
  /** Conta entidades (com filtro opcional) */
  async contar(query) {
    const results = await this.buscar(query);
    return results.length;
  }
};

// core/rule_engine.ts
var RuleEngine = class {
  regras = /* @__PURE__ */ new Map();
  events;
  constructor(events) {
    this.events = events;
  }
  /** Registra uma regra no engine. */
  registrar(regra) {
    if (this.regras.has(regra.nome)) {
      throw new Error(`Regra '${regra.nome}' j\xE1 registrada`);
    }
    this.regras.set(regra.nome, regra);
  }
  /** Remove uma regra registrada. */
  remover(nome) {
    this.regras.delete(nome);
  }
  /**
   * Dispara uma regra específica com o contexto fornecido.
   * Retorna o resultado indicando se a regra disparou.
   */
  async disparar(nome, contexto) {
    const regra = this.regras.get(nome);
    if (!regra) {
      throw new Error(`Regra '${nome}' n\xE3o encontrada`);
    }
    return this.avaliar(regra, contexto);
  }
  /**
   * Avalia todas as regras registradas contra o contexto.
   * Útil para disparar regras em lote após uma mudança de estado.
   */
  async dispararTodas(contexto) {
    const resultados = [];
    for (const regra of this.regras.values()) {
      resultados.push(await this.avaliar(regra, contexto));
    }
    return resultados;
  }
  /**
   * Registra uma regra que é avaliada automaticamente quando um evento ocorre.
   * O payload do evento é passado como contexto para a regra.
   */
  atrelarEvento(nomeEvento, nomeRegra) {
    this.events.on(nomeEvento, async (payload) => {
      const regra = this.regras.get(nomeRegra);
      if (regra) {
        await this.avaliar(regra, payload);
      }
    });
  }
  async avaliar(regra, contexto) {
    const erros = [];
    let disparou = false;
    try {
      const condicao = regra.quando(contexto);
      if (condicao) {
        disparou = true;
        await regra.entao(contexto);
        this.events.emit(`regra:${regra.nome}:disparou`, contexto);
      } else if (regra.senao) {
        await regra.senao(contexto);
        this.events.emit(`regra:${regra.nome}:ignorou`, contexto);
      }
    } catch (err) {
      erros.push(err?.message ?? String(err));
      this.events.emit(`regra:${regra.nome}:erro`, { contexto, erro: err?.message });
    }
    return { nome: regra.nome, disparou, erros };
  }
};
export {
  ConsoleAPI,
  DateTimeAPI,
  EntityManager,
  EventLoop,
  HttpClient,
  JadeRuntime,
  LocalDatastore,
  MatematicaMetodos,
  MatematicaStdlib,
  MemoryManager,
  MoedaMetodos,
  MoedaStdlib,
  PWAGenerator,
  Preferencias,
  Router,
  RuleEngine,
  Session,
  Signal,
  Store,
  SyncManager,
  TextoMetodos,
  TextoStdlib,
  UIEngine,
  alocarPosicao,
  aplicarTema,
  calcularICMS,
  calcularICMSST,
  calcularIPI,
  calcularISS,
  calcularPISCOFINS,
  calcularPISCOFINSNaoCumulativo,
  calcularTotaisNF,
  createEffect,
  criarElementoIcone,
  criarGrade,
  estatisticasArmazem,
  formatarEndereco,
  gerarEAN13,
  gerarEAN8,
  liberarPosicao,
  listarIcones,
  parsearEndereco,
  preferencias,
  sessao,
  sugerirPosicao,
  validarCode128,
  validarCodigoBarras,
  validarEAN13,
  validarEAN8
};
