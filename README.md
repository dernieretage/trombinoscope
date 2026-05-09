# Trombinoscope

**Répertoire local-first de talents audiovisuels** — techniciens, photographes, réalisateurs, stylistes, maquilleurs, et plus encore.

🌐 **En ligne :** https://dernieretage.github.io/trombinoscope/

Application web statique : par défaut tout est stocké dans le navigateur (IndexedDB).
Optionnellement, **synchronisation cross-device via GitHub Gist** et **scan IA via Claude API**.

## Fonctionnalités

### Profils riches
- Nom, **plusieurs métiers**, statut, Instagram, téléphone, e-mail, site, localisation, **tarif/TJM**, **dernier contact**, **bio**, tags, notes, images
- Photos compressées et redimensionnées automatiquement (1400 px max, format WebP)
- Avatars colorés générés depuis le handle si aucune photo

### 📸 Récupération Instagram (auto)
Bouton **« Importer Instagram »** sur chaque fiche :
- Télécharge la **photo de profil**
- Récupère les **9 dernières images publiques**
- Utilise Microlink + proxys CORS publics avec fallbacks gracieux
- Les images sont stockées localement (IndexedDB) et compressées

> ⚠️ Dépend de la disponibilité des proxys publics et de l'accessibilité du profil IG. Si IG bloque, vous pouvez toujours faire un drag-and-drop manuel.

### ☁️ Synchronisation cross-device (optionnelle)
Sync via un **Gist GitHub privé** (pas besoin de serveur) :
1. Réglages → onglet « Synchronisation »
2. Créer un PAT GitHub avec scope `gist`
3. Coller le token, cliquer « Tester »
4. Sync auto à chaque modification (debounced 4s) + pull au démarrage si distant plus récent

> Vos données restent privées : elles vivent dans VOTRE compte GitHub, dans un gist privé.

### 🤖 Scan IA expérimental (optionnel)
Bouton **« Scan IA »** sur chaque fiche pour compléter automatiquement les infos :
1. Réglages → onglet « Scan IA »
2. Coller votre clé API Anthropic (`sk-ant-…`)
3. Choisir un modèle (Sonnet 4.6 par défaut, équilibré)
4. Cliquer ⭐ sur une fiche → l'IA cherche site, e-mail public, bio, métiers, tags
5. Cocher les champs à appliquer

> Coût : ~0,02-0,05$ par scan selon le modèle. Aucune donnée ne quitte votre navigateur sauf vers `api.anthropic.com`.

### Recherche & filtres
- **Recherche instantanée** sur tous les champs (nom, métiers, tags, notes, contacts, bio)
- **Filtres rapides** par métier (chips) et par statut (À contacter / En discussion / Déjà collaboré / Favori)
- **Filtre par tag** : un clic sur un tag de carte pour filtrer
- **Tris** : Favoris d'abord (défaut), alphabétique, récemment modifiés / ajoutés, par métier, par statut
- Vues **grille** et **liste**

### Actions rapides
- **Hover** sur une carte : Instagram, appel, e-mail, édition en un clic
- **Clic droit** : menu contextuel (favori, copier handle/email/téléphone, dupliquer, supprimer)
- **Bouton WhatsApp** automatique si un téléphone est renseigné
- Édition **inline** du statut et des notes depuis la fiche profil

### Import / export
- **Import multiple Instagram** depuis une liste d'URLs ou de handles
- **Export JSON** complet (avec images en base64)
- **Export CSV** prêt pour Excel / Numbers / Google Sheets
- **Import JSON** (fusion ou remplacement)
- **Copier les e-mails / handles** des profils filtrés en un clic

### Confort d'utilisation
- **Drag & drop** d'images sur le formulaire d'édition
- **Coller** une image depuis le presse-papier dans un profil ouvert ou en édition
- **Thème clair / sombre**
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
- **IndexedDB** : profils + blobs images + préférences
- **Sync optionnelle** : GitHub REST API + Gist
- **IA optionnelle** : Anthropic Messages API + tool `web_search`
- **CSS** pur avec variables (themes), grid/flexbox, animations CSS-only
- **Service Worker** pour cache-first + offline
- **PWA** (manifest, theme-color, icons SVG)
- **Accessibility-first** : ARIA, focus visible, keyboard nav, `prefers-reduced-motion`

## Démarrer en local

```bash
cd trombinoscope
python3 -m http.server 8000
```

Puis ouvrir http://localhost:8000

## Déploiement

Le site est servi automatiquement par GitHub Pages depuis la branche `gh-pages`.

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

## Sécurité

- Tokens et clés API sont stockés dans IndexedDB (jamais transmis ailleurs que sur les services concernés)
- Sync : requêtes uniquement vers `api.github.com` (avec votre PAT)
- Scan IA : requêtes uniquement vers `api.anthropic.com` (avec votre clé)
- Récupération IG : requêtes vers proxys publics gratuits (Microlink, corsproxy.io, allorigins)
- Aucune télémétrie, aucun tracker, aucun cookie tiers

## Licence

Projet personnel pour la production audiovisuelle. Réutilisable librement.
