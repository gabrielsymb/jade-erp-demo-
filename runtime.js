/**
 * browser.ts — Entry point do bundle para browser
 *
 * Exporta apenas o que roda no browser. APIs server-side (auth, audit)
 * usam Node.js crypto e não entram aqui.
 *
 * Buildado por: npm run build:browser (esbuild)
 * Saída: dist/browser.js (ESM, ~150-200KB)
 */
// Core
export { JadeRuntime } from './core/runtime.js';
export { MemoryManager } from './core/memory_manager.js';
export { EventLoop } from './core/event_loop.js';
// UI
export { UIEngine } from './ui/ui_engine.js';
export { Router } from './ui/router.js';
export { Signal, Store, createEffect } from './ui/reactive.js';
export { aplicarTema, textoContraste } from './ui/theme.js';
export { el, on } from './ui/dom.js';
export { Session, sessao } from './ui/session.js';
export { criarElementoIcone, listarIcones } from './ui/icones.js';
// PWA
export { PWAGenerator } from './pwa/pwa_generator.js';
// Stdlib (seguras para browser)
export * from './stdlib/moeda.js';
export * from './stdlib/texto.js';
export * from './stdlib/matematica.js';
export * from './stdlib/fiscal.js';
export * from './stdlib/wms.js';
// APIs browser-safe
export { HttpClient } from './apis/http_client.js';
export { ConsoleAPI } from './apis/console_api.js';
export { DateTimeAPI } from './apis/datetime_api.js';
// Persistência (IndexedDB + localStorage + sync)
export { LocalDatastore } from './persistence/local_datastore.js';
export { Preferencias, preferencias } from './persistence/preferencias.js';
export { SyncManager } from './persistence/sync_manager.js';
// Entidade e regras
export { EntityManager } from './core/entity_manager.js';
export { RuleEngine } from './core/rule_engine.js';
//# sourceMappingURL=browser.js.map