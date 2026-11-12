# src/custom

This folder is yours. c2c creates it once and never overwrites it.

- `index.tsx` exports the customization: field and component overrides, form and report slots, submit hooks, extra routes and menu changes. The extension points are listed at the top of the file and in `docs/react-target.md` of the c2c repository.
- `theme.css` overrides design tokens.
- Add your own components, pages and hooks next to them and import them from `index.tsx`.

Do not edit `src/generated/` (it is rewritten on every regeneration and its file hashes are checked) or `lib/c2c-ui/` (replaced by a platform upgrade). To change a generated screen, override it from here.
