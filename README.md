# Trombinoscope

**Répertoire local-first de talents audiovisuels** — techniciens, photographes, réalisateurs, stylistes, maquilleurs, et plus encore.

🌐 **En ligne :** https://dernieretage.github.io/trombinoscope/

Application web statique, sans serveur, sans compte, sans dépendance externe. Toutes les données et images sont stockées dans le navigateur (IndexedDB).

## Fonctionnalités

### Profils riches
- Nom, métier, statut, Instagram, téléphone, e-mail, site, localisation, **tarif/TJM**, **dernier contact**, tags, notes, images
- Photos compressées et redimensionnées automatiquement (1400 px max, format WebP)
- Avatars colorés générés depuis le handle si aucune photo
- Badge **« Nouveau »** sur les profils créés dans la dernière heure

### Recherche & filtres
- **Recherche instantanée** sur tous les champs (nom, métier, tags, notes, contacts)
- **Filtres rapides** par métier (chips) et par statut (À contacter / En discussion / Déjà collaboré / Favori)
- **Filtre par tag** : un clic sur un tag de carte pour filtrer
- **Tris** : Favoris d'abord (défaut), alphabétique, récemment modifiés / ajoutés, par métier, par statut
- Vues **grille** et **liste** densifiée

### Actions rapides
- **Hover** sur une carte : Instagram, appel, e-mail, édition en un clic
- **Clic droit** : menu contextuel complet (favori, copier handle/email/téléphone, dupliquer, supprimer)
- **Bouton WhatsApp** automatique si un téléphone est renseigné
- Édition **inline** du statut et des notes depuis la fiche profil

### Import / export
- **Import multiple Instagram** depuis une liste d'URLs ou de handles, avec attribution d'un métier commun
- **Export JSON** complet (avec images en base64)
- **Export CSV** prêt pour Excel / Numbers / Google Sheets
- **Import JSON** (fusion ou remplacement)
- **Copier les e-mails / handles** des profils filtrés en un clic

### Confort d'utilisation
- **Drag & drop** d'images sur le formulaire d'édition
- **Coller** une image depuis le presse-papier dans un profil ouvert ou en édition
- **Thème clair / sombre** automatique (et toggle manuel)
- **PWA installable**, fonctionne hors-ligne après la première visite
- Bouton **« Retour en haut »** flottant
- **Stats** en temps réel : profils total / affichés / métiers / favoris

### Raccourcis clavier
| Raccourci | Action |
|-----------|--------|
| `⌘K` ou `/` | Recherche |
| `N` | Nouveau profil |
| `G` / `L` | Vue grille / liste |
| `T` | Bascule de thème |
| `?` | Aide raccourcis |
| `Esc` | Fermer modale / menu |
| `1`…`9` | Filtre métier rapide |
| `←` / `→` | Profil précédent / suivant (modale ouverte) |
| `F` | Basculer favori (modale ouverte) |
| `Clic droit` | Menu d'actions sur une carte |

## Architecture technique

- **Vanilla JS modules** (ES2015+), aucun build step
- **IndexedDB** via wrapper léger : profils + blobs images + préférences
- **CSS** pur avec variables (themes), grid/flexbox, animations CSS-only
- **Service Worker** pour cache-first + offline
- **PWA** complète (manifest, theme-color, icons SVG)
- **Accessibility-first** : ARIA, focus visible, keyboard nav, prefers-reduced-motion
- ~120 KB transmis (HTML + CSS + JS, non-minifié, sans dépendances externes hors Google Fonts)

## Démarrer en local

```bash
cd trombinoscope
python3 -m http.server 8000
```

Puis ouvrir http://localhost:8000

## Déploiement

Le site est servi automatiquement par GitHub Pages depuis la branche `gh-pages`.

Pour déployer une mise à jour :
```bash
git checkout main
# … modifications …
git commit -am "votre message"
git push origin main

git checkout gh-pages
git merge main --no-edit
git push origin gh-pages
git checkout main
```

## Licence

Projet personnel pour la production audiovisuelle. Réutilisable librement.
