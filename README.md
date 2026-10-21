# portfolio

Personal portfolio site — published at **[manuel4short.github.io/Portfolio-Test](https://manuel4short.github.io/Portfolio-Test/)**

## Structure

| File | Purpose |
| --- | --- |
| `index.html` | Page markup: intro, projects grid, contact, footer |
| `style.css` | All styling (CSS custom properties for the colour palette) |
| `images/` | Project screenshots used on the project cards |

## Projects

### Web games & utilities (GitHub Pages)

- Rock Paper Scissors
- Digital clock
- E-fifa Soccer Tips
- Temperature-converter
- Random Quote Generator

### Self-hosted · Deployed with Coolify

Production apps running on a self-hosted VPS via [Coolify](https://coolify.io),
with Traefik handling HTTPS and the `sslip.io` wildcard DNS.

| Project | Stack | Link |
| --- | --- | --- |
| PrimeStore HQ | React · Vite · Laravel API | https://primestorehq.com/ |
| GreenRelics | WordPress · WooCommerce | https://wordpress-m15t6cooukqixoyclfmgldrc.167.233.58.57.sslip.io/ |
| Booking Site | WordPress · Amelia | https://wordpress-rpirkr17atrwo9g7hxhj8igg.167.233.58.57.sslip.io/ |

## Features

- **Hide / unhide projects** — every card has an eye toggle; hidden cards are listed in a
  "Hidden projects" tray so they can be brought back.
- **Persistent state** — hidden cards are stored in `localStorage`
  (key `portfolio:hidden-projects`) so the choice survives a reload.
- **Live counter** — the toolbar shows how many projects are currently visible.
- **Hide all / show all** — one button toggles every website at once.
- **Responsive** — the grid, toolbar and tray adapt down to mobile widths.

## Deploying

The site is served by GitHub Pages from the `main` branch. Push to `main` and the
site updates automatically:

```bash
git add .
git commit -m "Update portfolio"
git push origin main
```
