# Design System Document: The Editorial Intelligence Framework

## 1. Overview & Creative North Star
**Creative North Star: "The Digital Curator"**

This design system moves beyond the utility of a standard PDF tool and into the realm of a high-end editorial workspace. Most PDF tools are cluttered and industrial; this system treats documents as prestigious content. The "Digital Curator" philosophy relies on **intentional asymmetry**, **tonal depth**, and **negative space as a functional element**. We are not building a "software interface"—we are building a focused, quiet environment where the document is the hero and the analysis is the sophisticated guide.

By eschewing traditional borders and harsh grids in favor of layered surfaces and fluid typography, we create an experience that feels "expensive," calm, and profoundly professional.

---

## 2. Colors & Surface Philosophy
The palette is a sophisticated range of atmospheric blues and architectural grays. It is designed to reduce eye strain during long-form reading and deep analysis.

### The "No-Line" Rule
**Strict Mandate:** Designers are prohibited from using 1px solid borders to section off major areas of the UI. Layout boundaries must be defined solely through background color shifts. For example, a side panel in `surface-container-low` should sit directly against a `background` workspace without a dividing line.

### Surface Hierarchy & Nesting
Treat the UI as physical layers of fine paper. Depth is achieved by nesting surface tokens:
- **Base Layer:** `background` (#f7fafc) for the primary workspace.
- **Secondary Tier:** `surface-container-low` (#eff4f7) for navigation or secondary sidebars.
- **Primary Focus:** `surface-container-lowest` (#ffffff) for the document canvas or active cards.
- **Interactive Layers:** `surface-container-high` (#dfeaef) for floating menus or hover states.

### The "Glass & Gradient" Rule
To prevent the UI from feeling flat or "bootstrap-generic," utilize the following:
- **Glassmorphism:** For floating overlays (e.g., a PDF search bar), use `surface-container-lowest` at 80% opacity with a `24px` backdrop-blur.
- **Signature Textures:** Use a subtle linear gradient from `primary` (#3b6090) to `primary-container` (#d4e3ff) on main Action CTAs to give them a "jewel" quality amidst the matte grays.

---

## 3. Typography
We use a dual-sans-serif approach to balance authority with readability.

*   **Display & Headlines (Manrope):** A geometric sans-serif that feels modern and architectural. Use `display-lg` (3.5rem) with tighter letter-spacing (-0.02em) for a bold, editorial look in empty states or landing moments.
*   **Body & Titles (Inter):** The workhorse for readability. `body-md` (0.875rem) is the standard for analysis text.
*   **The Hierarchy of Truth:** Labels (`label-md`) should always be in uppercase with +0.05em tracking when used as category headers to distinguish them from actionable body text.

---

## 4. Elevation & Depth
In this system, elevation is a feeling, not a structure.

*   **The Layering Principle:** Avoid shadows for static elements. Place a `surface-container-lowest` card on a `surface-container-low` background. The subtle shift from #ffffff to #eff4f7 is enough to signify a "lift."
*   **Ambient Shadows:** For floating elements (Modals, Popovers), use an ultra-diffused shadow:
    - *Offset:* 0px 8px | *Blur:* 32px | *Color:* `on-surface` (#283439) at 6% opacity.
*   **The "Ghost Border" Fallback:** If accessibility requires a container boundary, use `outline-variant` (#a7b4ba) at **15% opacity**. It should be felt, not seen.
*   **Verticality:** High-priority analysis insights should "float" using the Glassmorphism rule to sit above the document layer.

---

## 5. Components

### Buttons & CTAs
*   **Primary:** Gradient fill (`primary` to `primary-dim`). `0.5rem` (lg) corner radius. No border.
*   **Secondary:** `primary-container` fill with `on-primary-container` text.
*   **Tertiary:** Ghost style. No background or border. Use `on-surface-variant` text that shifts to `primary` on hover.

### PDF Cards & Document Lists
*   **The "No-Divider" Rule:** Forbid the use of horizontal rules between list items. Use `1.5rem` of vertical white space and a subtle background shift (`surface-container-low`) on hover to define the row.
*   **Thumbnails:** Use `0.375rem` (md) radius with a `surface-dim` soft inner-glow to mimic the edge of paper.

### Input Fields (Search/Analysis Prompt)
*   **Style:** Minimalist. No bottom line or box. Use a `surface-container-highest` background with `0.5rem` radius.
*   **Focus State:** Transition the background to `primary-container` and add a "Ghost Border" of `primary` at 20%.

### Floating Action Chips
*   For PDF annotations. Use `full` (9999px) roundedness. 
*   Background: `surface-container-lowest` with the Ambient Shadow (6% opacity).

---

## 6. Do’s and Don’ts

### Do:
- **Do** embrace "wasteful" white space. It is the hallmark of premium design.
- **Do** use `headline-sm` for sidebar titles to create a strong typographic anchor.
- **Do** use `primary-fixed-dim` for subtle highlights within analyzed text.

### Don’t:
- **Don’t** use a 1px solid black or dark gray border. Ever.
- **Don’t** use standard 400ms easing. Use a custom "Cubic-Bezier (0.2, 0, 0, 1)" for all transitions to give a "weighted" premium feel.
- **Don’t** use pure black (#000) for text. Use `on-surface` (#283439) to maintain the soft-minimalist tonal range.
- **Don’t** crowd the PDF viewer. The document should have at least `4rem` of "breathing room" (padding) on all sides of the viewport.

---

## 7. Contextual Component: The "Insight Rail"
For a PDF analysis tool, we introduce the **Insight Rail**. This is a vertical area using `surface-container-low` where AI-generated insights appear as "floating paper" (`surface-container-lowest`). Each insight should lack a border, instead using the Tonal Layering principle to "pop" against the rail. This maintains the editorial feel of a marginalia note in a high-end journal.