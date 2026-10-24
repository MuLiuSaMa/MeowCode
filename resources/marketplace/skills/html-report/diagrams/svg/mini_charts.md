# Lightweight SVG Mini Charts

> ⚠️ **Use ECharts for data visualization first.** The SVG templates in this file are only suitable for extremely simple scenarios. If your chart involves multi-point comparisons, axes, legends, or interactivity, use ECharts instead.

## Purpose

Use hand-written SVG only in these minimal scenarios:
- Single progress bar / donut percentage display
- Single-value gauge inside a card
- Minimal comparison with ≤ 3 data points
- Purely decorative indicators with no axes or legends

**Not suitable (use ECharts instead):**
- Comparisons/rankings with > 3 data points
- Charts requiring axes or legends
- Multi-series data visualization
- Any scenario requiring tooltips or interactivity

## CSS Variables

```css
:root {
  --accent: #6c8dfa;    /* Primary color */
  --accent2: #a78bfa;   /* Secondary color */
  --muted: #64748b;     /* Background track */
  --positive: #34d399;  /* Positive value */
  --negative: #f87171;  /* Negative value */
  --bg2: #1e293b;       /* Container background */
  --fg: #e2e8f0;        /* Text */
  --rule: #334155;      /* Dividers */
}
```

---

## 1. Horizontal Bar Chart

**Suitable for:** Ranking/comparison lists, up to 6 items.

### Calculation

```
bar_width = value / max_value * max_bar_px
```

### Full Example

```svg
<svg width="240" height="120" viewBox="0 0 240 120" xmlns="http://www.w3.org/2000/svg">
  <!-- Item 1 -->
  <text x="0" y="14" font-size="11" fill="var(--fg)">USA</text>
  <rect x="45" y="4" width="180" height="12" rx="3" fill="var(--accent)" opacity="0.9"/>
  <text x="228" y="14" font-size="10" fill="var(--fg)" text-anchor="end">45%</text>

  <!-- Item 2 -->
  <text x="0" y="38" font-size="11" fill="var(--fg)">China</text>
  <rect x="45" y="28" width="120" height="12" rx="3" fill="var(--accent)" opacity="0.75"/>
  <text x="168" y="38" font-size="10" fill="var(--fg)" text-anchor="end">30%</text>

  <!-- Item 3 -->
  <text x="0" y="62" font-size="11" fill="var(--fg)">Germany</text>
  <rect x="45" y="52" width="48" height="12" rx="3" fill="var(--accent2)" opacity="0.7"/>
  <text x="96" y="62" font-size="10" fill="var(--fg)" text-anchor="end">12%</text>

  <!-- Item 4 -->
  <text x="0" y="86" font-size="11" fill="var(--fg)">Japan</text>
  <rect x="45" y="76" width="32" height="12" rx="3" fill="var(--accent2)" opacity="0.6"/>
  <text x="80" y="86" font-size="10" fill="var(--fg)" text-anchor="end">8%</text>

  <!-- Item 5 -->
  <text x="0" y="110" font-size="11" fill="var(--fg)">Other</text>
  <rect x="45" y="100" width="20" height="12" rx="3" fill="var(--muted)" opacity="0.5"/>
  <text x="68" y="110" font-size="10" fill="var(--fg)" text-anchor="end">5%</text>
</svg>
```

---

## 2. Donut Chart

**Suitable for:** Proportional display of 2–4 categories.

### Calculation

Use `stroke-dasharray` and `stroke-dashoffset` to simulate arc segments:

```
circumference = 2 * π * r
dash = percentage / 100 * circumference
offset = -cumulative_percentage / 100 * circumference
```

### Full Example (3 segments)

```svg
<svg width="120" height="120" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
  <!-- Background ring -->
  <circle cx="60" cy="60" r="45" fill="none" stroke="var(--muted)" stroke-width="12" opacity="0.2"/>

  <!-- Segment 1: 55% -->
  <circle cx="60" cy="60" r="45" fill="none"
    stroke="var(--accent)" stroke-width="12"
    stroke-dasharray="155.5 282.7"
    stroke-dashoffset="0"
    transform="rotate(-90 60 60)"
    stroke-linecap="round"/>

  <!-- Segment 2: 30% -->
  <circle cx="60" cy="60" r="45" fill="none"
    stroke="var(--accent2)" stroke-width="12"
    stroke-dasharray="84.8 282.7"
    stroke-dashoffset="-155.5"
    transform="rotate(-90 60 60)"
    stroke-linecap="round"/>

  <!-- Segment 3: 15% -->
  <circle cx="60" cy="60" r="45" fill="none"
    stroke="var(--muted)" stroke-width="12"
    stroke-dasharray="42.4 282.7"
    stroke-dashoffset="-240.3"
    transform="rotate(-90 60 60)"
    stroke-linecap="round"/>

  <!-- Center text -->
  <text x="60" y="56" text-anchor="middle" font-size="18" font-weight="600" fill="var(--fg)">55%</text>
  <text x="60" y="72" text-anchor="middle" font-size="10" fill="var(--muted)">Completion</text>
</svg>
```

---

## 3. Progress Bar

**Suitable for:** Single percentage display (completion rate, achievement rate).

### Full Example

```svg
<svg width="200" height="20" viewBox="0 0 200 20" xmlns="http://www.w3.org/2000/svg">
  <!-- Background track -->
  <rect x="0" y="6" width="200" height="8" rx="4" fill="var(--muted)" opacity="0.2"/>
  <!-- Fill (72%) -->
  <rect x="0" y="6" width="144" height="8" rx="4" fill="var(--accent)"/>
  <!-- Percentage label -->
  <text x="150" y="13" font-size="9" fill="var(--fg)">72%</text>
</svg>
```

### Multi-Segment Progress Bar

```svg
<svg width="200" height="20" viewBox="0 0 200 20" xmlns="http://www.w3.org/2000/svg">
  <!-- Background -->
  <rect x="0" y="6" width="200" height="8" rx="4" fill="var(--muted)" opacity="0.2"/>
  <!-- Segment 1: Complete (40%) -->
  <rect x="0" y="6" width="80" height="8" rx="4" fill="var(--positive)"/>
  <!-- Segment 2: In Progress (25%) -->
  <rect x="80" y="6" width="50" height="8" fill="var(--accent)"/>
  <!-- Segment 3: Failed (10%) -->
  <rect x="130" y="6" width="20" height="8" fill="var(--negative)"/>
</svg>
```

---

## 4. Gauge

**Suitable for:** Displaying a current value within a range (performance score, health rating).

### Calculation

Semi-circular arc uses `stroke-dasharray`; total arc length = π × r:

```
arc_length = π * r
filled = value / max_value * arc_length
```

### Full Example

```svg
<svg width="140" height="80" viewBox="0 0 140 80" xmlns="http://www.w3.org/2000/svg">
  <!-- Background arc -->
  <path d="M 15,70 A 55,55 0 0,1 125,70" fill="none" stroke="var(--muted)" stroke-width="10" opacity="0.2" stroke-linecap="round"/>
  <!-- Filled arc (75%) -->
  <path d="M 15,70 A 55,55 0 0,1 125,70" fill="none" stroke="var(--accent)" stroke-width="10" stroke-linecap="round"
    stroke-dasharray="129.6 172.8"
  />
  <!-- Center value -->
  <text x="70" y="68" text-anchor="middle" font-size="20" font-weight="600" fill="var(--fg)">75</text>
  <text x="70" y="78" text-anchor="middle" font-size="9" fill="var(--muted)">/100</text>
</svg>
```

---

## 5. Stacked Column Chart

**Suitable for:** Showing the composition of individual items.

### Full Example

```svg
<svg width="200" height="100" viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
  <!-- Column 1 -->
  <rect x="10"  y="30" width="28" height="30" fill="var(--accent)"/>
  <rect x="10"  y="60" width="28" height="30" fill="var(--accent2)" opacity="0.7"/>
  <rect x="10"  y="90" width="28" height="5"  fill="var(--muted)" opacity="0.5"/>
  <text x="24" y="98" text-anchor="middle" font-size="8" fill="var(--fg)" dy="8">Q1</text>

  <!-- Column 2 -->
  <rect x="52"  y="15" width="28" height="40" fill="var(--accent)"/>
  <rect x="52"  y="55" width="28" height="25" fill="var(--accent2)" opacity="0.7"/>
  <rect x="52"  y="80" width="28" height="15" fill="var(--muted)" opacity="0.5"/>
  <text x="66" y="98" text-anchor="middle" font-size="8" fill="var(--fg)" dy="8">Q2</text>

  <!-- Column 3 -->
  <rect x="94"  y="10" width="28" height="45" fill="var(--accent)"/>
  <rect x="94"  y="55" width="28" height="30" fill="var(--accent2)" opacity="0.7"/>
  <rect x="94"  y="85" width="28" height="10" fill="var(--muted)" opacity="0.5"/>
  <text x="108" y="98" text-anchor="middle" font-size="8" fill="var(--fg)" dy="8">Q3</text>

  <!-- Column 4 -->
  <rect x="136" y="5"  width="28" height="50" fill="var(--accent)"/>
  <rect x="136" y="55" width="28" height="28" fill="var(--accent2)" opacity="0.7"/>
  <rect x="136" y="83" width="28" height="12" fill="var(--muted)" opacity="0.5"/>
  <text x="150" y="98" text-anchor="middle" font-size="8" fill="var(--fg)" dy="8">Q4</text>
</svg>
```

---

## Container Styling

Add a card container around charts:

```html
<div style="background:var(--bg2); border:1px solid var(--rule); border-radius:8px; padding:16px;">
  <div style="font-size:12px; color:var(--muted); margin-bottom:8px;">Monthly Active User Distribution</div>
  <!-- SVG chart goes here -->
  <div style="display:flex; gap:12px; margin-top:8px; font-size:11px; color:var(--muted);">
    <span><span style="color:var(--accent);">●</span> Product A</span>
    <span><span style="color:var(--accent2);">●</span> Product B</span>
  </div>
</div>
```

## Notes

- **When data exceeds 3 items, use ECharts — do not use SVG**
- All `fill`/`stroke` values use CSS variables for theme compatibility
- The `rx` attribute rounds rectangle corners for a softer appearance
- Use `text-anchor="middle"` to center-align text
