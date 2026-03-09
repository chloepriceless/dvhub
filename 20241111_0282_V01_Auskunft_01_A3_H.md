# DVhub Design System Brief for Codex

## Purpose
Build the DVhub web app in a visual style derived from the current DVhub logo.

The design language should feel like:
- energy-tech
- modern SaaS dashboard
- dark-mode first
- slightly premium
- clean, sharp, luminous
- suitable for dashboards, API tooling, grid / battery / market data, and automation workflows

Do **not** build a playful consumer UI.
Do **not** use random colors outside the palette below.
Do **not** use heavy skeuomorphism.
Do **not** make it look like a crypto casino UI.

---

## Brand Summary
DVhub is a technical platform for Direktvermarktung, interfaces, routing, automation, and energy-related data flows.

The UI should communicate:
- technical competence
- energy context
- flow / connectivity
- reliability
- modern infrastructure
- premium but functional product design

---

## Core Brand Colors

### Primary Palette
- `#0077FF` → Primary Blue
- `#00A8FF` → Electric Blue
- `#39E06F` → Energy Green
- `#A8F000` → Neon Lime
- `#FF9800` → Energy Orange

These colors come from the logo and should define the whole product.

### Background / Surface Palette
- `#071A2F` → App background
- `#0C2545` → Panel background
- `#112E55` → Card background
- `#1F4C7A` → Borders / separators

### Text Palette
- `#FFFFFF` → Primary text
- `#A8C4E8` → Secondary text
- `#6F8FB3` → Muted text

### Semantic Colors
- Success: `#39E06F`
- Info: `#00A8FF`
- Warning: `#FF9800`
- Error: `#FF4D4D`

---

## Gradient Rules

### Main Brand Gradient
Use this gradient frequently for accents, CTA emphasis, active states, chart accents, and selected UI elements:

```css
linear-gradient(90deg, #0077FF 0%, #00C8FF 35%, #39E06F 70%, #A8F000 100%)
```

### Optional Secondary Gradient
Use sparingly for special highlights:

```css
linear-gradient(90deg, #00A8FF 0%, #0077FF 40%, #39E06F 100%)
```

### Rules
- Do not apply gradients to everything.
- Gradients should be used mainly for:
  - primary buttons
  - active nav indicators
  - chart highlights
  - small glow lines
  - status accents
- Most surfaces should remain dark and stable.

---

## Visual Style Rules

### General Style
Use:
- dark background
- luminous accents
- soft but restrained glow
- rounded corners
- crisp borders
- subtle depth
- modern spacing
- dashboard clarity

Avoid:
- oversaturated neon everywhere
- too much blur
- oversized shadows
- cartoonish icons
- generic Bootstrap look
- excessive glassmorphism

### Shadows / Glow
Use subtle glow effects for interactive or important elements.

Example:
```css
box-shadow:
  0 0 10px rgba(0,168,255,0.25),
  0 0 30px rgba(0,168,255,0.12);
```

Use stronger glow only for:
- active buttons
- selected tabs
- focused form fields
- hero stats
- graph highlights

### Borders
Use soft blue-toned borders:
```css
border: 1px solid #1F4C7A;
```

---

## Typography

### Font Strategy
Use:
- **Inter** for body text, labels, UI text
- **Rajdhani** for headings, large stats, product-name-style moments

Fallback if Rajdhani is not available:
- Space Grotesk
- Inter

### Typography Feel
Should feel:
- technical
- clean
- modern
- confident
- not overly futuristic

### Scale Guidance
- Page title: 32–40px
- Section title: 20–24px
- Card title: 16–18px
- Body: 14–16px
- Caption / meta: 12–13px

---

## Layout Principles

### Product Direction
The app should feel like a serious operations platform.

### Layout Rules
Use:
- left sidebar navigation
- top header with context and quick actions
- content area with cards / tables / charts / workflows
- generous spacing
- consistent alignment
- clear hierarchy

### Recommended Spacing System
Use an 8px grid:
- 4
- 8
- 12
- 16
- 24
- 32
- 40
- 48

### Border Radius
- cards: 14px
- inputs: 10px
- buttons: 10px
- large panels: 16px
- chips / pills: 999px

---

## Component Design Guidance

### App Shell
- dark full-screen background in `#071A2F`
- sidebar darker than content area
- content area should feel open and structured
- very subtle radial lighting or top glow is okay

### Sidebar
Style:
- slim but premium
- dark background
- muted labels
- active item highlighted with brand gradient or blue glow
- icons should be simple line icons

Sidebar active item example:
- dark panel surface
- left accent line or pill glow
- text in white
- icon highlighted in electric blue or gradient

### Header
Include:
- product title / page title
- environment or system state
- search / command / quick actions
- user/settings area

Keep it clean and compact.

### Cards
Cards should look like technical dashboard modules.

Style:
- background: `#112E55`
- border: `1px solid #1F4C7A`
- radius: `14px`
- subtle inner contrast
- optional top accent line using gradient

Do not overdo elevation.

### Buttons

#### Primary Button
Use gradient fill.
Text should be white.
Should feel premium and clickable.

Example:
```css
background: linear-gradient(90deg, #0077FF, #39E06F);
color: #FFFFFF;
border-radius: 10px;
```

#### Secondary Button
- dark surface
- blue border
- white or secondary text

#### Ghost Button
- transparent
- soft hover state
- no harsh borders

### Inputs
- dark surface
- subtle border
- focus glow in electric blue
- placeholder text muted
- no bright white input background in dark mode

Focus example:
```css
outline: none;
border-color: #00A8FF;
box-shadow: 0 0 0 3px rgba(0,168,255,0.18);
```

### Tables
Tables should feel like operational data views:
- clear row separation
- muted column labels
- hover highlight
- semantic colors for status
- compact but readable

### Charts
Charts are important for this product.

Use:
- PV: `#A8F000`
- Grid: `#0077FF`
- Battery: `#39E06F`
- Consumption: `#FF9800`
- Neutral/reference: `#A8C4E8`

Charts should feel:
- clean
- slightly luminous
- easy to interpret
- dashboard-grade, not marketing-grade

---

## Workflow Builder / Technical UI Guidance

Because DVhub is about interfaces and routing, the UI can include workflow-related modules.

If building flow elements:
- keep them structured and guided
- avoid messy free-form canvas by default
- support a linear or staged model:
  - Input
  - Processing
  - Output

Flow blocks should visually communicate:
- source systems
- transformations
- destinations
- routing / logic
- health / status

### Node / Block Style
- dark panel
- subtle border
- compact icon
- clear label
- colored status edge or top accent

### Connection / State Indicators
Use color carefully:
- blue = connected
- green = active / healthy
- orange = attention / pending
- red = failed

---

## Motion / Interaction
Use restrained motion.

Good motion:
- fade in
- soft slide up
- hover glow
- active indicator transitions
- chart loading shimmer

Avoid:
- bouncing
- exaggerated spring motion
- flashy marketing animations

Animation timing:
- 120ms to 220ms for hover/focus
- 220ms to 320ms for panel transitions

---

## Iconography
Use simple modern line icons.
Recommended style:
- Lucide-like
- thin to medium stroke
- geometric and clean

Avoid:
- filled cartoon icons
- glossy 3D icon sets
- mixed icon families

---

## Accessibility Rules
Even though the design is dark and luminous:
- maintain readable contrast
- avoid green text on blue where readability drops
- use color + shape / label, not color alone
- buttons and statuses must remain usable for non-perfect vision

---

## Preferred Product Feel
The app should feel like a mix of:
- energy dashboard
- integration platform
- modern infrastructure UI
- enterprise SaaS with startup polish

Keywords:
- dark
- electric
- connected
- reliable
- data-centric
- premium technical

---

## CSS Token Proposal

```css
:root {
  --dvhub-bg: #071A2F;
  --dvhub-panel: #0C2545;
  --dvhub-card: #112E55;
  --dvhub-border: #1F4C7A;

  --dvhub-text: #FFFFFF;
  --dvhub-text-secondary: #A8C4E8;
  --dvhub-text-muted: #6F8FB3;

  --dvhub-blue: #0077FF;
  --dvhub-electric: #00A8FF;
  --dvhub-green: #39E06F;
  --dvhub-lime: #A8F000;
  --dvhub-orange: #FF9800;
  --dvhub-red: #FF4D4D;

  --dvhub-gradient-main: linear-gradient(90deg, #0077FF 0%, #00C8FF 35%, #39E06F 70%, #A8F000 100%);
}
```

---

## Tailwind Theme Proposal

```js
export const dvhubTheme = {
  colors: {
    dvhub: {
      bg: "#071A2F",
      panel: "#0C2545",
      card: "#112E55",
      border: "#1F4C7A",
      text: "#FFFFFF",
      secondary: "#A8C4E8",
      muted: "#6F8FB3",
      blue: "#0077FF",
      electric: "#00A8FF",
      green: "#39E06F",
      lime: "#A8F000",
      orange: "#FF9800",
      red: "#FF4D4D",
    },
  },
};
```

---

## Implementation Instructions for Codex
When generating the web app:

1. Use a **dark-mode-first design**.
2. Use the **DVhub color palette exactly** unless a very close shade adjustment is needed for contrast.
3. Prefer **Inter + Rajdhani**.
4. Create a **clean SaaS dashboard layout** with sidebar + header + main content.
5. Use gradients selectively and professionally.
6. Keep the UI sharp, structured, and technical.
7. Make it suitable for:
   - dashboards
   - market data
   - battery / PV / grid views
   - interface configuration
   - workflow steps
   - API / connector management
8. Ensure components look consistent.
9. Avoid generic template aesthetics.
10. The final product should visually align with the provided DVhub logo.

---

## Optional Nice-to-Have
If useful, generate:
- a reusable theme file
- a shared component library
- chart color presets
- status badges
- sidebar navigation patterns
- empty states matching the DVhub style
- light mode only if explicitly requested later

---

## One-Sentence Creative Direction
Build DVhub like a premium dark energy-tech SaaS platform with electric blue, green, and lime accents, structured dashboards, subtle glow, and a clean modern infrastructure aesthetic.
