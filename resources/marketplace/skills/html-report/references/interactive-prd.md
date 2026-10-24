---
name: interactive-prd
description: >
  Structure and visual reference for rendering prototype-centered interactive
  PRDs as self-contained HTML. This is an internal html-report sub-scenario
  reference and must be loaded only after the html-report skill is invoked.
  Owns split-screen HTML architecture, phone/browser frame templates, CSS
  variables, themes, responsive behavior, mode switching, data-link
  implementation, and accessibility.
---

# Interactive PRD HTML Reference

## Relationship to Parent Skill

This reference extends `html-report` for the special prototype-centered PRD scenario. It does not decide requirement content, business rules, product scope, or feature depth. Those belong to `doc-writing-guide/references/interact-prd-document.md`.

## Responsibility Boundary

This file owns:

- split-screen output architecture and HTML shell;
- phone and browser prototype frame templates;
- preview mode and text mode behavior;
- tab switching, prototype navigation, data-link linkage, and resize-handle interaction;
- CSS variables, theme selection, visual hierarchy, spacing, motion, responsive behavior, and accessibility implementation.

This file does not own:

- evidence classification, requirement reasoning, role/object/state modeling, P0/P1/P2 scoping, feature business rules, assumptions, open questions, or requirement-writing depth.

## When to Load

Load this reference only after the `html-report` skill has been invoked for a prototype-centered interactive PRD rendering task. Other skills should invoke `html-report`; they should not read this file directly.

| Reference | Responsibility |
|---|---|
| `doc-writing-guide/references/interact-prd-document.md` | Content logic, PRD tabs, feature depth, business rules, prototype-content mapping |
| This `interactive-prd` reference | HTML structure, layout, visual system, CSS, JavaScript behavior, responsive/accessibility |

## Output Architecture

The deliverable is a single self-contained HTML file with one prototype-centered review surface.

```text
┌─────────────────────────────────────────────────────────┐
│  Top Bar (fixed): Title + Version Tag + Mode Toggle     │
├──────────────────────┬──────────────────────────────────┤
│  Left Panel          │  Right Panel                      │
│  Interactive         │  Tab-based PRD Document           │
│  Prototype           │                                  │
│                      │  Tabs: 概览 | 产品设计 | 需求详情 | 规则 │
│  Phone Frame /       │                                  │
│  Browser Frame       │  Scrollable tab content           │
├──────────────────────┴──────────────────────────────────┤
│  Link Indicator (floating): linkage feedback             │
├─────────────────────────────────────────────────────────┤
│  Text Mode Document (hidden in preview; shown in text)   │
└─────────────────────────────────────────────────────────┘
```

### Prototype Frame Types

| Product Type | Frame Type | Layout Ratio | Frame Style |
|---|---|---|---|
| Mobile app / mini-program | `phone-frame` | 3:7, fixed width around 375-440px | Rounded device shell, status bar, bottom tab bar |
| Web / PC platform | `browser-frame` | 5:5 by default | Browser toolbar, route address, optional sidebar |
| Pad / cross-device | `browser-frame` scaled | 2:5 or adaptive | Larger viewport with app-like controls |

Rules:

- Mobile products use `phone-frame` with physical device border radius, status bar, and bottom tab bar when relevant.
- Web products use `browser-frame` with macOS-style traffic lights and an address bar showing the current route.
- When `browser-frame` uses a 5:5 layout, include a draggable resize handle between panels.
- Do not imitate a phone mockup when the product is clearly desktop-first.

## Mode Switching

### Preview Mode

- `body` has no `.text-mode` class.
- `body` uses `height: 100vh; overflow: hidden`.
- `.main-layout` is visible as split panels.
- `.text-mode-doc` is hidden.

### Text Mode

Text mode must be scrollable. Always include these overrides:

```css
body.text-mode { overflow: auto; height: auto; background: #fff; }
body.text-mode .main-layout { display: none; }
body.text-mode .link-indicator { display: none !important; }
body.text-mode .text-mode-doc { display: block; }
.text-mode-doc { max-width: 960px; margin: 0 auto; padding: 96px 50px 40px; }
.text-mode-doc h2 { font-size: 22px; margin-top: 40px; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 2px solid #333; color: #000; }
.text-mode-doc h3 { font-size: 18px; margin-top: 28px; margin-bottom: 12px; color: #111; }
.text-mode-doc h4 { font-size: 16px; margin-top: 20px; margin-bottom: 10px; color: #222; }
.text-mode-doc p { margin-bottom: 14px; text-align: justify; }
.text-mode-doc table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px; }
.text-mode-doc th, .text-mode-doc td { border: 1px solid #ddd; padding: 10px 14px; text-align: left; vertical-align: top; }
.text-mode-doc th { background: #f5f5f5; font-weight: bold; }
.text-mode-doc ul, .text-mode-doc ol { margin: 12px 0; padding-left: 28px; }
.text-mode-doc li { margin-bottom: 6px; }
.text-mode-doc .section-divider { border: none; border-top: 1px solid #ddd; margin: 30px 0; }
.text-mode-doc .feature-section { background: none; border: none; border-radius: 0; padding: 0; margin-bottom: 24px; box-shadow: none; }
```

Text mode should dynamically assemble title, metadata, and all tab-pane content. In Detail, each `.feature-section` embeds its mapped prototype page at the top. Do not create one bulk "产品原型总览" block.

### Text Mode Prototype Embedding

In text mode, distribute prototype pages into feature sections:

- match each `.feature-section#feature-xxx` with a prototype page or region containing `data-link="feature-xxx"`;
- insert the matched prototype page at the top of the feature section;
- preserve interactive handlers where possible; do not remove `onclick` or set `pointer-events: none`;
- show each prototype page only once, in the first matched feature section;
- constrain long pages with fixed-height frames and internal scrolling instead of stretching the document infinitely.

### Switch Function Pattern

```javascript
function switchMode(mode) {
    const modeBtns = document.querySelectorAll('.mode-toggle .mode-btn');
    modeBtns.forEach(b => b.classList.remove('active'));
    if (mode === 'text') {
        const textDoc = document.getElementById('textModeDoc');
        let html = '<h1>[Title]</h1><p>Version: V1.0 | Date | Status</p>';
        const panes = document.querySelectorAll('.tab-content-wrapper > .tab-pane');
        panes.forEach((pane, i) => {
            if (i > 0) html += '<hr class="section-divider">';
            html += pane.innerHTML;
        });
        textDoc.innerHTML = html;
        injectFeaturePrototypes(textDoc);
        document.body.classList.add('text-mode');
        modeBtns[1].classList.add('active');
    } else {
        document.body.classList.remove('text-mode');
        window.scrollTo(0, 0);
        document.body.scrollTop = 0;
        document.documentElement.scrollTop = 0;
        modeBtns[0].classList.add('active');
    }
}

function injectFeaturePrototypes(container) {
    const proto = document.querySelector('.phone-frame, .browser-frame');
    if (!proto) return;
    const isPhone = proto.classList.contains('phone-frame');
    const pages = proto.querySelectorAll('.page');
    const used = new Set();

    container.querySelectorAll('.feature-section').forEach(section => {
        const featureId = section.id;
        if (!featureId) return;
        let matchedPage = null;
        pages.forEach(page => {
            if (used.has(page.id)) return;
            page.querySelectorAll('[data-link]').forEach(el => {
                if (el.dataset.link === featureId) matchedPage = page;
            });
            if (page.getAttribute('data-link') === featureId) matchedPage = page;
        });
        if (!matchedPage) return;
        used.add(matchedPage.id);

        const clone = matchedPage.cloneNode(true);
        clone.style.position = 'absolute';
        clone.style.top = '0';
        clone.style.left = '0';
        clone.style.right = '0';
        clone.style.bottom = '0';
        clone.style.opacity = '1';
        clone.style.transform = 'none';
        clone.style.display = 'flex';
        clone.style.flexDirection = 'column';

        const frame = document.createElement('div');
        if (isPhone) {
            frame.style.cssText = 'width:375px;height:720px;border-radius:32px;overflow:hidden;position:relative;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,0.08);margin:0 auto;';
        } else {
            frame.style.cssText = 'width:100%;max-width:800px;height:500px;max-height:500px;border-radius:8px;overflow:hidden;position:relative;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,0.08);margin:0 auto;border:1px solid #e5e7eb;';
            clone.style.overflowY = 'auto';
            clone.style.overflowX = 'hidden';
        }
        frame.appendChild(clone);

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'border:1px solid #e8e8e8;border-radius:12px;padding:20px;margin:0 0 16px;background:#fafbfc;';
        wrapper.innerHTML = '<div style="font-size:13px;color:#667085;margin-bottom:12px;font-weight:500;">Interactive Prototype (clickable)</div>';
        wrapper.appendChild(frame);
        section.insertBefore(wrapper, section.children[1] || null);
    });
}
```

## Tab Switching

```javascript
const tabBtns = document.querySelectorAll('.tab-bar .tab-btn');
const tabPanes = document.querySelectorAll('.tab-content-wrapper > .tab-pane');

tabBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    switchTab(btn.dataset.tab);
  });
});

function switchTab(tabId) {
  tabBtns.forEach((btn) => btn.classList.remove('active'));
  tabPanes.forEach((pane) => pane.classList.remove('active'));
  document.querySelector(`.tab-bar [data-tab="${tabId}"]`)?.classList.add('active');
  document.getElementById(tabId)?.classList.add('active');
}
```

## Prototype-Document Linkage

### Mechanism

1. Left-side prototype elements carry `data-link="feature-xxx"` attributes.
2. Right-side detail sections use matching `id="feature-xxx"`.
3. Clicking a prototype area triggers: switch to detail tab, scroll target into view, highlight the section, and show a floating indicator.

### Click Conflict Rules

- The delegated `data-link` listener must never call `e.stopPropagation()` or `e.preventDefault()`.
- Prefer `data-link` on container elements and `onclick` on specific navigation elements.
- If one element needs both navigation and linkage, combine both actions in one `onclick`.

```html
<div class="item-card" data-link="feature-browse">
  <button type="button" onclick="navigate('page-detail')">查看详情</button>
</div>
```

```javascript
document.getElementById('prototypeRoot').addEventListener('click', (event) => {
  const el = event.target.closest('[data-link]');
  if (el) linkToFeature(el.dataset.link);
});

function linkToFeature(featureId) {
  switchTab('tab-detail');
  window.setTimeout(() => {
    const target = document.getElementById(featureId);
    const wrapper = document.getElementById('tabContentWrapper');
    if (!target || !wrapper) return;

    wrapper.scrollTo({
      top: target.offsetTop - wrapper.offsetTop - 20,
      behavior: 'smooth'
    });

    document.querySelectorAll('.feature-section').forEach((section) => {
      section.classList.remove('highlight');
    });
    target.classList.add('highlight');
    window.setTimeout(() => target.classList.remove('highlight'), 2500);

    const indicator = document.getElementById('linkIndicator');
    if (!indicator) return;
    indicator.textContent = '→ ' + (featureNames[featureId] || featureId);
    indicator.classList.add('show');
    window.setTimeout(() => indicator.classList.remove('show'), 2000);
  }, 100);
}
```

## Prototype Navigation

Prototype pages are `.page` elements; only one page is active.

```javascript
function navigate(pageId) {
  document.querySelectorAll('.page').forEach((page) => page.classList.remove('active'));
  document.getElementById(pageId)?.classList.add('active');
  if (addressBar) {
    addressBar.textContent = routeMap[pageId] || pageId;
  }
}
```

## Frame Templates

### Phone Frame

```html
<div class="phone-frame">
  <div class="phone-screen" id="prototypeRoot">
    <div class="page active" id="page-home">
      <header class="page-header">App Name</header>
      <main class="page-body" data-link="feature-home">
        <!-- Prototype content -->
      </main>
      <nav class="page-tabbar" aria-label="Prototype navigation">
        <button class="tab-item active" type="button" data-link="feature-home">首页</button>
      </nav>
    </div>
  </div>
</div>
```

### Browser Frame

```html
<div class="browser-frame">
  <div class="browser-toolbar">
    <div class="browser-dots" aria-hidden="true">
      <span class="dot-red"></span>
      <span class="dot-yellow"></span>
      <span class="dot-green"></span>
    </div>
    <div class="browser-address" id="addressBar">platform.example.com/dashboard</div>
  </div>
  <div class="browser-screen" id="prototypeRoot">
    <div class="page active" id="page-dashboard">
      <header class="page-header">Platform Header</header>
      <div class="page-sidebar-layout">
        <nav class="page-sidebar" aria-label="Prototype navigation">
          <button class="nav-item active" type="button" onclick="navigate('page-dashboard')">Dashboard</button>
        </nav>
        <main class="page-main" data-link="feature-dashboard">
          <!-- Prototype content -->
        </main>
      </div>
    </div>
  </div>
</div>
```

## Resize Handle

Both phone-frame and browser-frame left panels should support drag-to-resize. The handle changes the left panel's available space; the prototype frame adapts via proportional scaling, not horizontal squishing.

```html
<div class="resize-handle" id="resizeHandle" role="separator" aria-orientation="vertical"></div>
```

```css
.left-panel {
  flex: 0 0 40%;
  min-width: 280px;
  max-width: 70%;
  position: relative;
  overflow: hidden;
  background: var(--bg-primary);
}
.left-panel .phone-frame {
  width: 375px;
  height: 720px;
  position: absolute;
  transform-origin: 0 0;
}
.left-panel .browser-frame {
  width: 1200px;
  height: 800px;
  position: absolute;
  transform-origin: 0 0;
}
```

```javascript
(function() {
  const handle = document.getElementById('resizeHandle');
  const left = document.querySelector('.left-panel');
  const container = document.querySelector('.main-layout');
  if (!handle || !left || !container) return;

  let isDragging = false;
  handle.addEventListener('mousedown', () => {
    isDragging = true;
    handle.classList.add('active');
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (event) => {
    if (!isDragging) return;
    const rect = container.getBoundingClientRect();
    const pct = ((event.clientX - rect.left) / rect.width) * 100;
    left.style.flex = `0 0 ${Math.max(25, Math.min(70, pct))}%`;
    scalePrototype();
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
    handle.classList.remove('active');
    document.body.style.userSelect = '';
  });

  function scalePrototype() {
    const frame = left.querySelector('.phone-frame, .browser-frame');
    if (!frame) return;
    const padding = 20;
    const panelW = left.clientWidth - padding * 2;
    const panelH = left.clientHeight - padding * 2;
    const origW = frame.classList.contains('phone-frame') ? 375 : 1200;
    const origH = frame.classList.contains('phone-frame') ? 720 : 800;
    const scale = Math.min(panelW / origW, panelH / origH, 1.2);
    frame.style.transform = `scale(${scale})`;
    frame.style.left = (padding + (panelW - origW * scale) / 2) + 'px';
    frame.style.top = (padding + (panelH - origH * scale) / 2) + 'px';
  }

  window.addEventListener('resize', scalePrototype);
  window.addEventListener('load', scalePrototype);
  setTimeout(scalePrototype, 100);
})();
```

Key constraints:

- Prototype frame keeps fixed design dimensions; only visual size changes through `transform: scale()`.
- Drag handle changes `.left-panel` flex percentage, not the frame width.
- Max scale is capped at 1.2x.
- `overflow: hidden` keeps scaled content inside panel boundaries.

## Visual Design System

### Color System: Derivation First

Do not memorize fixed theme templates. Derive a color set from product context, reference the closest scaffold for structural fill, then fine-tune for product-specific traits.

Primary color source priority:

1. User-specified brand color or hex value.
2. User-specified style keywords such as "techy", "warm", or "professional".
3. Product type and industry context.

Guidelines:

- Do not always fall back to generic Google blue or indigo.
- Education tends toward warm orange/amber; healthcare toward steady teal-green; finance toward deep navy; social toward vivid purple/coral; tools toward neutral grey-blue.
- Within one hue family, tune lightness and saturation to create different product personalities.

### Theme Scaffolds

Scaffolds define layout and visual strategy, not fixed color values.

| Scaffold | Structural Traits | Use Cases | Reference Products |
|---|---|---|---|
| Light-Solid | Solid panels, no glass, ultra-light shadows | Mobile apps, mini-programs, lightweight SaaS | Google Apps, iOS Settings |
| Light-Minimal | Generous whitespace, near-zero shadows, borders and grey levels | B2B platforms, knowledge bases, doc tools | Linear, Notion, Apple Settings |
| Light-Glass | White base, faint ambient gradients, frosted glass | AI products, creative tools, youth-facing | Vercel, Stripe, Arc |
| Dark | Dark base, border layering, bright text | Data dashboards, dev tools, monitoring | Vercel Dark, GitHub Dark |

Fine-tune scaffold output by adjusting primary hue, radius, shadow strength, base warmth, gradient strategy, top bar style, and typography.

### Palette Examples

These examples show variation range, not fixed schemes.

```css
/* Healthcare App */
:root { --primary-color: #0d9488; --primary-light: #ccfbf1; --bg-primary: #f9fafb; --card-radius: 14px; }

/* Finance Backend */
:root { --primary-color: #1e40af; --primary-light: #dbeafe; --bg-primary: #f0f4f8; --card-radius: 8px; }

/* Social Platform */
:root { --primary-color: #f43f5e; --primary-light: #fff1f2; --bg-primary: #faf9f7; --card-radius: 18px; }

/* Design Tool */
:root { --primary-color: #7c3aed; --primary-gradient: linear-gradient(135deg,#7c3aed,#ec4899); --bg-primary: #fff; --card-radius: 16px; }

/* DevOps Platform */
:root { --primary-color: #10b981; --bg-primary: #0a0a0a; --bg-secondary: #171717; --text-main: #f9fafb; --card-radius: 8px; }
```

### CSS Variables

Every theme must define:

```css
:root {
  --primary-color: #2563eb;
  --primary-light: rgba(37, 99, 235, 0.12);
  --bg-primary: #f5f6f8;
  --bg-secondary: #fff;
  --text-main: #172033;
  --text-muted: #667085;
  --border-color: #e4e8ef;
  --card-radius: 14px;
  --card-shadow: 0 8px 24px rgba(23, 32, 51, 0.07);
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
  --font-heading: -apple-system, "SF Pro Display", "PingFang SC", sans-serif;
  --font-body: -apple-system, "SF Pro Text", "PingFang SC", sans-serif;
  --font-size-sm: 12px;
  --font-size-base: 14px;
  --font-size-lg: 16px;
  --font-size-xl: 20px;
  --font-size-2xl: 28px;
  --line-height: 1.6;
  --transition-fast: 150ms ease;
  --transition-normal: 250ms ease;
}
```

### Composition Rules

- The page should feel like a modern tech product: clean whitespace, refined rounded corners, restrained color palette, and breathing room between elements.
- Use no more than one primary color and two accent colors. Large surface areas should be neutral grey/white or disciplined dark surfaces.
- Build one clear focal point per prototype screen.
- Use an 8px spacing rhythm, 14-16px body text, and no more than three text sizes in one component region.
- Reserve the primary color for selected states, primary actions, key links, and linkage highlights.
- Prefer borders and tonal surfaces over heavy shadows.
- Keep radii, elevation, and component density consistent.
- Use inline SVG or CSS shapes for icons; avoid decorative emoji unless the user asks.
- Use motion sparingly: 120-220ms for hover/state changes and 180-300ms for panels.
- The document panel and prototype should feel like one product system while remaining visually distinguishable.
- Right-side tab active state must use a bottom border or light background; do not rely only on font weight.
- Top bar should stay simple: white or light grey background, clear title, and capsule mode toggle buttons.

### Top Bar and Core Containers

The top bar and right-panel containers cannot look plain; they provide the page's first impression and reading affordance.

```css
.top-bar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  background: var(--bg-secondary, #fff);
  box-shadow: 0 1px 3px rgba(0,0,0,0.06);
  border-bottom: 1px solid var(--border-color, #e5e7eb);
  z-index: 1000;
}
.mode-toggle {
  display: flex;
  gap: 4px;
  background: var(--bg-primary, #f3f4f6);
  border-radius: 8px;
  padding: 3px;
}
.mode-btn {
  padding: 6px 16px;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-muted, #6b7280);
  background: transparent;
  transition: all var(--transition-fast, 150ms ease);
}
.mode-btn.active {
  background: var(--primary-color, #2563eb);
  color: #fff;
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}
.tab-bar {
  display: flex;
  padding: 0 24px;
  border-bottom: 1px solid var(--border-color, #e5e7eb);
  background: var(--bg-secondary, #fff);
}
.tab-btn {
  padding: 12px 18px;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-muted, #6b7280);
  border-bottom: 2px solid transparent;
  transition: all var(--transition-fast, 150ms ease);
}
.tab-btn.active {
  color: var(--primary-color, #2563eb);
  border-bottom-color: var(--primary-color, #2563eb);
}
.feature-section {
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 12px;
  padding: 20px 24px;
  margin-bottom: 16px;
  background: var(--bg-secondary, #fff);
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  transition: box-shadow var(--transition-normal, 250ms ease), border-color var(--transition-normal, 250ms ease);
}
.feature-section.highlight {
  border-color: var(--primary-color, #2563eb);
  box-shadow: 0 0 0 3px var(--primary-light, rgba(37,99,235,0.1));
}
```

Key constraints:

- `body` background must use `var(--bg-primary)`, not pure white.
- Mode toggle active state must use primary fill and white text.
- Tab active state must have border-bottom or background marking.
- `.feature-section` must have border, radius, and surface styling.
- Overview and Detail content must use theme variables for visual richness.

### Avoid Generic Template Aesthetics

Do not:

- put every section inside a floating card;
- use purple-blue gradients, glassmorphism, neon glow, or oversized hero typography by default;
- fill dashboards with meaningless KPI cards or charts;
- use gradients for body text or every heading;
- overuse pills, badges, icons, and colored labels.

Dark or expressive themes are allowed only when they fit the product. Even then, preserve readable contrast and quiet surfaces around dense requirement content.

## Responsive Behavior

| Viewport | Behavior |
|---|---|
| `>= 1200px` | Split panels; resizable for desktop products |
| `768-1199px` | Split panels with narrower document or a clear Prototype/Document segment switch |
| `< 768px` | Stack content or use a segment switch; never squeeze two unreadable columns |

At small widths, keep the top bar compact, make tabs horizontally scrollable, remove the drag handle, and preserve a minimum 44px touch target. Phone prototypes may scale down but must not overflow horizontally.

## Accessibility

- Use semantic `button`, `input`, `label`, `nav`, `main`, and heading elements.
- Provide keyboard focus styles and logical tab order.
- Ensure text contrast is at least 4.5:1 and large text/UI graphics at least 3:1.
- Add `aria-label`, `aria-expanded`, `aria-selected`, and dialog semantics where applicable.
- Do not encode status only by color; pair it with text or shape.
- Make all prototype actions usable without a mouse.

## Quality Self-Check

All checks below are **static code reviews** performed by reading the generated HTML/CSS/JS source. Do NOT open the HTML file in a browser, launch a dev server, or use browser_use tools to validate the output.

| # | Check Item | Pass Criteria |
|---|---|---|
| 1 | Text mode embedding structure | The HTML/JS includes per-feature prototype embedding logic; no single bulk prototype overview block |
| 2 | Navigation target integrity | Every `navigate('page-xxx')` reference has a corresponding `.page#page-xxx` or documented state target |
| 3 | Single-file self-contained | No external CSS/JS/image dependencies unless generated under report-local assets according to `html-report` rules |
| 4 | Theme consistent | Colors, borders, highlights, and active states use CSS variables |
| 5 | Visual hierarchy | Each screen has one clear primary task; spacing, type scale, radii, and elevation are consistent |
| 6 | Semantic structure | Controls use semantic HTML where practical, and status is not represented by color alone |
