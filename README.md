# Trombinoscope

Répertoire de talents — techniciens audiovisuels, photographes, réalisateurs, stylistes, maquilleurs, et plus encore.

Application web statique, *local-first* : toutes les données et images sont stockées dans le navigateur (IndexedDB) — aucun serveur, aucun compte, aucune dépendance externe.

## Fonctionnalités

- **Profils riches** — nom, métier, statut, Instagram, téléphone, e-mail, site, localisation, tags, notes, images
- **Recherche instantanée** sur tous les champs (nom, métier, tags, notes…)
- **Filtres rapides** par métier (chips) et par statut (À contacter / En discussion / Déjà collaboré / Favori)
- **Tris multiples** (alphabétique, récemment modifiés, récemment ajoutés, par métier, par statut)
- **Vues grille et liste**
- **Thème clair / sombre** (avec préférence système)
- **Drag & drop d'images** (auto-redimensionnées à 1400px max, format WebP)
- **Édition inline** des notes et du statut depuis la fiche profil
- **Import multiple** depuis une liste d'URLs / handles Instagram
- **Sauvegarde / restauration JSON** (avec images embarquées)
- **PWA installable** + offline-first
- **Raccourcis clavier** (⌘K recherche, N nouveau, G/L vues, T thème, ?  aide…)
- **Navigation au clavier** dans la fiche profil (← / →)

## Démarrer en local

```bash
cd trombinoscope
python3 -m http.server 8000
# ou tout autre serveur statique
```

Puis ouvrir http://localhost:8000

## Déploiement

Site statique — déployable n'importe où (GitHub Pages, Netlify, Vercel, S3…).
