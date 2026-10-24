# SVG World Map Component

## Purpose

Display geographic distribution data in HTML reports, suitable for:
- User/audience geographic distribution
- Regional metric comparisons (latency, traffic, revenue)
- Server/CDN node location markers
- Market coverage visualization

## SVG Structure

```
<svg>
  <g>              <!-- Continent outline layer -->
    <path/>        <!-- Simplified continent polygons -->
  </g>
  <g>              <!-- Data point layer -->
    <circle/>      <!-- Geographic location markers -->
    <animate/>     <!-- Optional: pulse animation -->
  </g>
  <g>              <!-- Label layer (optional) -->
    <text/>
  </g>
</svg>
```

## Configuration Parameters

| Parameter | Description | Default |
|------|------|--------|
| `viewBox` | SVG viewport | `0 0 400 200` |
| `width` | Container width | `100%` |
| `height` | Container height | `200` |
| Continent `fill` | Land fill color | `currentColor` |
| Continent `opacity` | Land opacity | `0.15` |
| Continent `stroke-width` | Land stroke width | `0.6` |

### Data Point Parameters

| Parameter | Description | Example |
|------|------|------|
| `cx`, `cy` | Circle center coordinates (based on 400×200 viewport) | `cx="78" cy="72"` |
| `r` | Radius, used to encode value magnitude | `4`-`10` |
| `fill` | Point color | `var(--accent)` |

### Key Coordinate Reference (viewBox 400×200)

| Region | Approximate Coordinates (cx, cy) |
|------|-------------------|
| Eastern North America | 90, 70 |
| Western North America | 55, 65 |
| South America | 120, 140 |
| Western Europe | 192, 62 |
| Eastern Europe | 220, 58 |
| Africa | 210, 115 |
| Middle East | 240, 80 |
| South Asia | 270, 85 |
| East Asia | 310, 65 |
| Southeast Asia | 300, 100 |
| Australia | 325, 150 |

## CSS Variable Integration

```css
:root {
  --accent: #6c8dfa;   /* Primary data point */
  --accent2: #a78bfa;  /* Secondary data point */
  --muted: #64748b;    /* Continent fill */
  --positive: #34d399; /* Growth indicator */
  --negative: #f87171; /* Decline indicator */
}
```

Continents use `currentColor` (inheriting parent text color) with low opacity, or directly use `var(--muted)`.

## Full Example: World Map with 6 Data Points

```svg
<svg width="100%" height="200" viewBox="0 0 400 200" xmlns="http://www.w3.org/2000/svg">
  <!-- Continent outlines -->
  <g fill="var(--muted, currentColor)" opacity="0.15" stroke="var(--muted, currentColor)" stroke-opacity="0.4" stroke-width="0.6">
    <!-- North America -->
    <path d="M 38,52 L 56,46 L 78,44 L 96,50 L 108,58 L 112,72 L 102,86 L 90,92 L 78,90 L 70,98 L 58,104 L 48,98 L 40,84 L 34,68 Z"/>
    <!-- South America -->
    <path d="M 110,118 L 122,120 L 130,134 L 134,150 L 130,164 L 122,176 L 114,168 L 110,150 L 108,134 Z"/>
    <!-- Europe -->
    <path d="M 178,52 L 196,48 L 212,52 L 220,60 L 216,72 L 204,76 L 190,72 L 180,66 Z"/>
    <!-- Africa -->
    <path d="M 196,82 L 218,80 L 230,90 L 234,108 L 230,128 L 220,142 L 208,148 L 196,140 L 188,124 L 186,104 L 192,90 Z"/>
    <!-- Asia -->
    <path d="M 220,52 L 248,46 L 280,44 L 308,48 L 326,58 L 332,72 L 322,84 L 304,88 L 286,84 L 268,82 L 250,76 L 232,68 L 222,60 Z"/>
    <!-- Australia -->
    <path d="M 308,138 L 332,136 L 346,144 L 344,156 L 328,162 L 314,158 L 306,150 Z"/>
  </g>

  <!-- Data points (with pulse animation) -->
  <circle cx="78" cy="72" r="6" fill="var(--accent)" opacity="0.9">
    <animate attributeName="r" values="6;8;6" dur="2s" repeatCount="indefinite"/>
    <animate attributeName="opacity" values="0.9;0.5;0.9" dur="2s" repeatCount="indefinite"/>
  </circle>
  <circle cx="200" cy="62" r="8" fill="var(--accent)" opacity="0.9"/>
  <circle cx="276" cy="68" r="5" fill="var(--accent2)" opacity="0.85"/>
  <circle cx="310" cy="60" r="7" fill="var(--accent)" opacity="0.9"/>
  <circle cx="120" cy="140" r="4" fill="var(--accent2)" opacity="0.85"/>
  <circle cx="325" cy="148" r="4" fill="var(--accent2)" opacity="0.85"/>

  <!-- Labels (optional) -->
  <text x="78" y="64" text-anchor="middle" font-size="7" fill="var(--accent)">US</text>
  <text x="200" y="54" text-anchor="middle" font-size="7" fill="var(--accent)">EU</text>
  <text x="310" y="52" text-anchor="middle" font-size="7" fill="var(--accent)">CN</text>
</svg>
```

## Legend/Stats Bar Pattern

Add a stats legend below the map:

```html
<div style="display:flex; gap:16px; margin-top:8px; font-size:12px;">
  <span style="display:flex; align-items:center; gap:4px;">
    <svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="var(--accent)"/></svg>
    Primary Regions
  </span>
  <span style="display:flex; align-items:center; gap:4px;">
    <svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="var(--accent2)"/></svg>
    Secondary Regions
  </span>
</div>
```

## Data Point Size Encoding

Map values to radius:

```
r = min_r + (value - min_value) / (max_value - min_value) * (max_r - min_r)
```

Recommended range: `min_r=3`, `max_r=10`.

## Notes

- Keep `viewBox="0 0 400 200"` unchanged to ensure coordinate alignment
- Recommended 3–8 data points; too many will look cluttered
- Pulse animation should only emphasize 1–2 key points; do not animate all points
- Use `opacity` to differentiate priority levels
