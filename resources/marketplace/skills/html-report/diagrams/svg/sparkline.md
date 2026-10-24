# SVG Mini Trend Chart (Sparkline)

## Purpose

Display data trends in minimal space, suitable for:
- Trend indicators within table cells
- Historical trend lines in KPI cards
- Inline value changes embedded in text

## Types

| Type | Use Case |
|------|---------|
| Line | Trend changes in continuous data |
| Area | Emphasize cumulative value/range |
| Bar | Discrete segment data comparison |

## Recommended Sizes

| Use Case | Width | Height |
|---------|------|------|
| Inside table cell | 60px | 16px |
| KPI card | 80-100px | 20-24px |
| Inline text | 50-60px | 14-16px |

## CSS Variable Integration

```css
:root {
  --accent: #6c8dfa;    /* Default line color */
  --accent2: #a78bfa;   /* Area fill color */
  --positive: #34d399;  /* Upward trend */
  --negative: #f87171;  /* Downward trend */
  --muted: #64748b;     /* Neutral/background */
}
```

## Data Point Conversion

Convert data arrays to SVG coordinates:

```
x = index / (count - 1) * viewBox_width
y = viewBox_height - (value - min) / (max - min) * viewBox_height
```

For `viewBox="0 0 60 20"`, 5 data points `[3, 7, 4, 8, 6]`:
- x coordinates: `0, 15, 30, 45, 60`
- y coordinates (min=3, max=8): `20, 4, 16, 0, 12`
- points: `"0,20 15,4 30,16 45,0 60,12"`

---

## Example 1: Basic Line Sparkline

```svg
<svg width="60" height="20" viewBox="0 0 60 20" xmlns="http://www.w3.org/2000/svg">
  <polyline
    points="0,18 10,12 20,14 30,6 40,8 50,2 60,5"
    fill="none"
    stroke="var(--accent)"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
  />
</svg>
```

## Example 2: Area Sparkline (with gradient fill)

```svg
<svg width="80" height="24" viewBox="0 0 80 24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="spark-grad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0.02"/>
    </linearGradient>
  </defs>
  <!-- Area fill -->
  <polygon
    points="0,20 0,18 13,10 26,14 40,6 53,8 66,3 80,7 80,20"
    fill="url(#spark-grad)"
  />
  <!-- Line -->
  <polyline
    points="0,18 13,10 26,14 40,6 53,8 66,3 80,7"
    fill="none"
    stroke="var(--accent)"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
  />
</svg>
```

## Example 3: Bar Sparkline

```svg
<svg width="60" height="20" viewBox="0 0 60 20" xmlns="http://www.w3.org/2000/svg">
  <!-- 7 bars, each 6px wide, 2.5px spacing -->
  <rect x="1"  y="10" width="6" height="10" rx="1" fill="var(--accent)" opacity="0.6"/>
  <rect x="9.5"  y="4"  width="6" height="16" rx="1" fill="var(--accent)" opacity="0.8"/>
  <rect x="18" y="8"  width="6" height="12" rx="1" fill="var(--accent)" opacity="0.7"/>
  <rect x="26.5" y="2"  width="6" height="18" rx="1" fill="var(--accent)"/>
  <rect x="35" y="6"  width="6" height="14" rx="1" fill="var(--accent)" opacity="0.75"/>
  <rect x="43.5" y="12" width="6" height="8"  rx="1" fill="var(--accent)" opacity="0.5"/>
  <rect x="52" y="3"  width="6" height="17" rx="1" fill="var(--accent)" opacity="0.9"/>
</svg>
```

## Example 4: Line Sparkline with Endpoint Highlights

```svg
<svg width="80" height="20" viewBox="0 0 80 20" xmlns="http://www.w3.org/2000/svg">
  <polyline
    points="0,16 13,12 26,14 40,8 53,10 66,4 80,6"
    fill="none"
    stroke="var(--positive)"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
  />
  <!-- Start point (faded) -->
  <circle cx="0" cy="16" r="2" fill="var(--positive)" opacity="0.4"/>
  <!-- End point (highlighted) -->
  <circle cx="80" cy="6" r="2.5" fill="var(--positive)"/>
</svg>
```

## Automatic Trend Direction Coloring

Determine color based on first vs. last value:

```
color = lastValue > firstValue ? var(--positive) : var(--negative)
```

Use `var(--positive)` for upward trends, `var(--negative)` for downward trends, and `var(--muted)` for flat trends.

## Usage in HTML

### Table Cell

```html
<td style="white-space:nowrap;">
  $1,234
  <svg width="50" height="14" viewBox="0 0 50 14" style="vertical-align:middle; margin-left:6px;">
    <polyline points="0,12 10,8 20,10 30,4 40,6 50,2" fill="none" stroke="var(--positive)" stroke-width="1.2" stroke-linecap="round"/>
  </svg>
  <span style="color:var(--positive); font-size:11px;">+12%</span>
</td>
```

### KPI Card

```html
<div style="display:flex; align-items:flex-end; gap:8px;">
  <span style="font-size:24px; font-weight:600;">8,421</span>
  <svg width="80" height="24" viewBox="0 0 80 24">
    <polyline points="0,20 13,16 26,18 40,10 53,12 66,4 80,6" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round"/>
  </svg>
</div>
```

## Notes

- `stroke-linecap="round"` and `stroke-linejoin="round"` make lines smoother
- When there are too many data points (>15), consider sampling or smoothing
- Keep `viewBox` aspect ratio consistent with actual rendered dimensions to avoid distortion
- Do not add axes or tick marks — sparklines only show trends
