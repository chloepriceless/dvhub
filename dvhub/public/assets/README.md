# Family Dashboard Assets

## family-scene.png (optional)

The family dashboard (`/family`) loads an optional background image from `/assets/family-scene.png`. If the file does not exist, a dark gradient fallback is used automatically (per decision D-20).

### Generate with DALL-E / Midjourney

Prompt:

> Photorealistic aerial 3/4 view of a modern European single-family home at golden hour. The house has a dark slate roof covered with solar panels. A white Tesla-style electric car is parked in the driveway, connected to a wall-mounted charging station. On the left side of the house, a sleek battery storage unit (Tesla Powerwall style) is mounted on the exterior wall. In the background to the right, two high-voltage electricity transmission towers with power lines are visible against a warm sunset sky. Green lawn surrounds the house. Cinematic lighting, shallow depth of field on the background. 16:9 aspect ratio, 4K quality.

Place the resulting image at `dvhub/public/assets/family-scene.png`.

### Tag positioning (D-21)

The 5 main tags (Solar, Haus, Batterie, E-Auto, Netz) are positioned via CSS percentages in `family.html`:

- `.tag-solar { top: 6%; left: 32% }`
- `.tag-home { top: 38%; left: 50% }` (centered)
- `.tag-bat { top: 32%; left: 5% }`
- `.tag-ev { top: 32%; right: 5% }`
- `.tag-grid { top: 10%; right: 6% }`

These positions are tuned for the suggested background composition (house in the centre, battery on the left wall, EV on the right, solar on the roof, transmission towers in the top-right background). If you use a custom image, adjust the tag percentages so each tag overlays the corresponding visual element.

### Mobile tweaks

On viewports ≤ 768px, `family.html` shifts the tag positions via a media query to keep everything on-screen. Adjust the 768px rules in `family.html` if you're tuning for a specific tablet aspect ratio.

### Additional assets

Other files in this directory (`dvhub.jpg`, `favicon-32.png`, `logo-192.png`, `logo-512.png`, `apple-touch-icon.png`) are used by the main DVhub pages and are unrelated to the family dashboard.
