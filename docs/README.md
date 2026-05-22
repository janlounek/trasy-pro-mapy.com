# Mapy for Chrome — public site

This folder is the source of the public GitHub Pages site:

- `index.html` — landing page (features + how to use)
- `privacy.html` — privacy policy (Czech, matches `PRIVACY.md` at the repo root)
- `style.css` — shared styling, no build step
- `favicon.svg` — green compass favicon

## To enable GitHub Pages

1. Push this repository to GitHub.
2. In the repo on github.com → **Settings** → **Pages**.
3. **Source**: *Deploy from a branch*.
4. **Branch**: `main` and folder `/docs`. Save.
5. Wait ~30 seconds. The URL appears at the top of the Pages settings page:

   ```
   https://<your-github-username>.github.io/<repo-name>/
   ```

6. Use that URL in the Chrome Web Store listing under
   **Privacy practices → Privacy policy URL**, pointing to
   `https://<your-github-username>.github.io/<repo-name>/privacy.html`.

## Editing

No build step — just edit the HTML/CSS and commit. GitHub Pages will rebuild
within a minute.
