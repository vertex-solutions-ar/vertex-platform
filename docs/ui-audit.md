# Auditoría UI — Vertex Platform (`vertex-platform`)

Alcance: **solo la app `platform/vertex-platform`** (panel SaaS). No incluye `storefront`
(excepto el flujo de metadata de build descrito en `agent.md` → _Fuente de despliegue_).

Estado: **hallazgos verificados en código**. Las fases 2–4 de refactor cierran los ítems
marcados con su fase. Los ítems sin fase asignada siguen abiertos.

## Progreso

| Fase | Alcance                                                                       | Estado                                                                                      |
| ---- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 0    | Este informe + criterios                                                      | ✅                                                                                          |
| 1    | Fuente de despliegue (release/rama/commit) — no es UI, ver `agent.md`         | ✅                                                                                          |
| 2    | Capa de estilos compartida + `platform-layout` + `stores-list`                | ✅ cierra H-02, H-03 (parcial), H-04, H-05, H-08 (parcial) y H-09 (`layout`, `stores-list`) |
| 3    | `store-detail`: 17 estilos inline → clases                                    | ✅ parcial — falta mover las reglas `dns-*`/`payments-*` y el presupuesto de CSS            |
| 4    | `domains`/`payments`, breakpoints faltantes (H-09) y barrido a11y (H-11…H-16) | ✅                                                                                          |

Superficie auditada: **~6 500 líneas de template (16 `.html` + 4 inline)** y
**~12 100 líneas de SCSS (15 archivos)**, más `styles.scss`.

---

## 1. Causa raíz: la app usa Bootstrap que no está cargado

`vertex-platform` **no depende de `bootstrap`** (`package.json`), `angular.json` sólo carga
`src/styles.scss`, y `index.html` sólo trae `bootstrap-icons` por CDN. Ningún `.scss` hace
`@use`/`@import` de Bootstrap.

Sin embargo los templates están escritos con utilidades de Bootstrap, y **ninguna tiene
definición local** (verificado con `grep` sobre todos los `.scss`):

| Utilidad                                                     | ¿Definida? | Usos en templates |
| ------------------------------------------------------------ | ---------- | ----------------- |
| `.d-flex`, `.align-items-center`, `.justify-content-between` | ❌         | ~90               |
| `.mt-*`, `.mb-*`, `.me-*`, `.ms-*`, `.px-*`, `.py-*`, `.g-*` | ❌         | **185**           |
| `.row`, `.col`, `.col-auto`                                  | ❌         | ~30               |
| `.text-muted`, `.text-danger`, `.text-success`               | ❌         | ~35               |
| `.btn-close`, `.input-group`, `.form-group`                  | ❌         | ~30               |

Consecuencias verificadas:

- **H-01 (alto)** — `store-detail-domains` y `store-detail-payments` **no tienen stylesheet
  propio**: ambos declaran `styleUrl: '../store-detail/store-detail.scss'`, o sea que las dos
  pestañas dependen del stylesheet de 4 831 líneas de su componente hermano. Verificado contra el
  CSS compilado, hay clases usadas **sin ninguna regla**:
  - `domains`: `dns-actions-bar`, `dns-meta-info`.
  - `payments`: `accordion`, `accordion-item`, `accordion-header`, `accordion-body`,
    `accordion-collapse`, `collapse`, `collapsed`, `master-sub-controls-accordion`,
    `btn-link`, `btn-outline-info`, `spinner-border`, `spinner-border-sm`, `bg-black-20`,
    `border-white-10`, `font-weight-bold`, `internal-store-banner`,
    `sub-link-option--monthly`, `text-xxs`, `tracking-wider`.
  - **Variantes de alerta rotas en ambas**: los templates usan `alert--error` /
    `alert--success` y el stylesheet define `.alert-error` / `.alert-success`. (Las variantes
    con `--` existen en otros componentes, así que el defecto sólo se ve en estas dos pestañas.)
  - **Bug funcional**: el acordeón "Gestión y Facturación de la Tienda" usa
    `data-bs-toggle="collapse"` (Bootstrap JS, que no está cargado) con
    `aria-expanded="false"` fijo → **la sección nunca se puede abrir**.
  - Riesgo de mantenimiento: cualquier cambio en `store-detail.scss` puede romper estas dos
    pantallas sin que nada lo detecte.
- **H-02 (crítico)** — Espaciado inconsistente en todo el panel: 185 utilidades de
  margen/padding inertes → separaciones que dependen del `margin` por defecto del navegador.
- **H-03 (alto)** — El `display:flex` faltante se parcheó con `style=""` inline:
  28 en `store-detail.html`, 11 en `store-detail-domains.html`, 7 en
  `subscription-checkout.html`, 6 en `infrastructure.html`, 4 en
  `store-detail-payments.html` y `alerts.html`, 1 en `custom-vertical-modal.html`.
  Caso testigo: `store-detail.html` L433-435 tiene `style="display:flex; gap:.5rem"` al lado
  de `class="... mb-3"` (que no hace nada).

**Decisión de refactor**: se implementa una capa de utilidades propia (subset real usado)
en lugar de agregar el paquete `bootstrap` completo (~200 KB de CSS que además pelearía
con los tokens y las clases por componente). Alternativa descartada documentada en el plan.

---

## 2. Duplicación y falta de sistema de diseño

- **H-04 (alto)** — `.btn`, `.btn-primary`, `.btn-secondary`, `.badge`, `.form-control`,
  `.form-select`, `.modal` están **redeclarados por componente** con valores distintos:
  `stores-list.scss:33/525`, `store-detail.scss:173/204/217/227/352/715`,
  `store-create.scss:154/460/513/526`, `team.scss:83/104/298/462`,
  `subscriptions.scss:70/104/120`, `infrastructure.scss:72/112/138`.
  `.form-select` existe dos veces (team + store-detail) y en ningún scope global.
- **H-05 (medio)** — `styles.scss` define **dos veces** `:focus-visible` (L116, L280),
  `::selection` (L121, L287) y los scrollbars (L99-114 y L293-311). Las versiones `*`
  ganan silenciosamente sobre las específicas. Además 9 `!important`.
- **H-06 (medio)** — 447 literales de color (`#hex`, `rgb()`) en SCSS en lugar de tokens.
  Rompe el theming dual (dark/light) y produce drift entre pantallas.
- **H-07 (medio)** — No existen componentes compartidos para patrones repetidos:
  hay 8 overlays de modal y 3 de ellos son markup distinto; no hay `empty-state`,
  `status-badge` ni `confirm-modal`.
- **H-08 (bajo)** — Incoherencia estructural: `login`, `stores-list`, `app-spinner` usan
  `template` inline; `stores-list` además tiene `.scss` (`stores-list.scss`, 809 líneas)
  pero el template está embebido en el `.ts`. El resto usa `templateUrl` + `styleUrls`.

---

## 3. Responsive

- **H-09 (medio)** — Sólo 8 de 15 stylesheets tenían media queries: `platform-layout`, `team`,
  `subscription-checkout`, `store-create`, `custom-vertical-modal`, `store-detail`,
  `stores-list`, `rubro-selector`. Los otros 6 no tenían ninguna, pero **no todos estaban
  rotos**: las rejillas ya usaban `grid-template-columns: repeat(auto-fit, …)` y las
  dimensiones aparentemente fijas eran `max-width`, así que se reacomodaban solas. Lo que sí
  fallaba, verificado caso por caso:
  - filas flex sin `flex-wrap` que se apretaban en mobile (`.tab-nav`, `.section-controls`,
    `.kpi-card`, `.alerts-item`, `.modal-card__header/__footer`, `.action-buttons`, …);
  - `.store-search-box` con `min-width: 280px`, que desborda en 360 px;
  - modales sin ajuste (`.modal-card` 620 px, `.success-card` 580 px).
    **Cerrado en la fase 4** con bloques `until(md)`/`until(sm)` en esos 6 stylesheets.
- **H-10 (medio)** — Las tablas de datos (`store-detail` deploy history, deployment table,
  `stores-list`, `infrastructure`) no tienen estrategia móvil común: algunas usan scroll
  horizontal, otras desbordan. Falta el patrón tabla↔tarjeta en mobile.

---

## 4. Accesibilidad

| ID   | Severidad | Hallazgo                                                                                                                   | Evidencia             |
| ---- | --------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| H-11 | alto      | 129 `<button>` y sólo **11** declaran `type=`. Los 118 restantes son `type="submit"` implícito (riesgo dentro de `<form>`) | `grep` sobre `*.html` |
| H-12 | alto      | Sólo **18** `aria-label` para 129 botones; no hay patrón para botones icon-only                                            | idem                  |
| H-13 | medio     | Sólo 3 `role="dialog"` para 8 overlays. Sin `aria-modal`, sin focus trap, sin cierre con `Esc`, sin restauración de foco   | idem                  |
| H-14 | medio     | 12 elementos no interactivos con `(click)` (`div.modal-overlay`, `div.logo-dropzone__content`, …) en lugar de `button`/`a` | idem                  |
| H-15 | medio     | 61 controles de formulario y sólo **10** `<label for=…>`                                                                   | idem                  |
| H-16 | bajo      | 3 `<img>` y sólo 1 con `alt`                                                                                               | idem                  |
| H-17 | bajo      | 58 `cursor: pointer` en SCSS sobre selectores que a veces no son interactivos                                              | idem                  |

---

## 5. Inventario por pantalla

LOC = líneas de template; SCSS = líneas de stylesheet del componente. "Fantasma" = utilidades
Bootstrap sin definición.

| Pantalla                                     | LOC    | SCSS   | `style=`     | `@media` | Estado                              |
| -------------------------------------------- | ------ | ------ | ------------ | -------- | ----------------------------------- |
| `layout/platform-layout`                     | 131    | 435    | 0            | 4        | Base del shell; a revisar en fase 2 |
| `stores/stores-list`                         | inline | 809    | 2 (en `.ts`) | 4        | Fase 2                              |
| `stores/store-detail`                        | 1 720  | 4 831  | **28**       | 4        | Fase 3 (mayor esfuerzo)             |
| `stores/store-detail-domains`                | 556    | **0**  | 11           | 0        | Fase 4 — H-01                       |
| `stores/store-detail-payments`               | 1 128  | **0**  | 4            | 0        | Fase 4 — H-01                       |
| `stores/store-create`                        | 453    | 921    | 0            | 9        | Fase 4                              |
| `stores/seed-store-modal`                    | 122    | 198    | 0            | 0        | Fase 4                              |
| `stores/custom-vertical-modal`               | 247    | 553    | 1            | 3        | Fase 4                              |
| `shared/rubro-selector`                      | 195    | 494    | 0            | 2        | Fase 4                              |
| `settings/infrastructure`                    | 599    | 723    | 6            | 0        | Fase 4                              |
| `settings/infrastructure/shard-status-modal` | 258    | 227    | 0            | 0        | Fase 4                              |
| `settings/subscriptions`                     | 346    | 689    | 0            | 0        | Fase 4                              |
| `settings/alerts`                            | 119    | 244    | 4            | 0        | Fase 4                              |
| `settings/team`                              | 280    | 591    | 0            | 1        | Fase 4                              |
| `public-checkout/subscription-checkout`      | 290    | 659    | 7            | 3        | Fase 4                              |
| `public-checkout/subscription-success`       | 75     | 204    | 0            | 0        | Fase 4                              |
| `auth/login`                                 | inline | inline | 1            | 0        | Fase 4                              |
| `shared/app-spinner`                         | inline | 0      | 0            | 0        | OK (tokens en `styles.scss`)        |

---

## 6. Criterios de aceptación del refactor

Una pantalla se considera cerrada cuando:

1. No usa utilidades sin definición (H-01/H-02) ni `style=""` inline (H-03).
2. No redeclara `.btn` / `.badge` / `.card` / `.form-*` / `.modal` (H-04): usa la capa
   compartida de `src/styles/`.
3. Usa tokens de color/espaciado/radio (H-06), sin literales `#hex`/`rgb()` nuevos.
4. Tiene breakpoints explícitos y verificados en **360 / 768 / 1024 / 1440** px (H-09/H-10).
5. Cumple el checklist de accesibilidad (H-11…H-17): `type` explícito, `aria-label` en
   botones icon-only, modales con `role="dialog"` + `aria-modal` + focus trap + `Esc`,
   controles con label asociado, `aria-live` en feedback async.
6. Contraste **WCAG AA (4.5:1)** verificado en tema claro y oscuro.
7. Respeta `prefers-reduced-motion` (ya cubierto globalmente en `styles.scss:226`).
8. Tablas: scroll contenido en desktop y patrón tarjeta en mobile.

---

## 7. Bugs funcionales detectados en la auditoría

Se corrigen en la fase de la pantalla donde aparecen; los que requieran decisión de producto
se reportan, no se cambian en silencio.

| ID   | Fase | Descripción                                                                                                                                                                                                                            |
| ---- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-01 | 1    | `redeployStore` aceptaba un `ref` arbitrario que evadía toda la política de seguridad y no se validaba contra GitHub; la UI y el historial mostraban datos falsos sobre lo desplegado. Detalle en `agent.md` → _Fuente de despliegue_. |
| F-02 | 3    | `Store.templateCommit` (`core/models/store.ts:45`) declarado y nunca escrito ni leído.                                                                                                                                                 |
| F-03 | 3    | `store-detail.html` declara `class="auto-update-toggle mb-3"` (inerte) junto a un `style=""` que lo reemplaza — síntoma directo de H-03.                                                                                               |

---

## 8. Fuera de alcance

- Refactor visual de `storefront` (sólo cambia su metadata de build, ver `agent.md`).
- Rediseño de flujos o cambios de producto (se reportan como hallazgo, no se ejecutan).
- Migración a otra librería de UI.
